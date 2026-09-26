import { describe, expect, it } from 'vitest';
import type {
  Classifier,
  ClassificationResult,
  DocType,
  DocumentPayload,
  Extractor,
  ExtractionResult,
  OcrProvider,
  OcrResult,
} from '@recouple/extraction';
import { buildExtractionResult } from '@recouple/extraction';
import { sha256, UnscannedDocumentError } from '@recouple/ingest';
import { RenditionError } from '@recouple/ingest/rendition';
import { ingestDocument, processUpload, readDocument } from '../src/steps';
import type { PipelineDeps } from '../src/ports';
import { AlwaysCleanScanner, AlwaysInfectedScanner, InMemoryStore } from '../src/testing/memory-store';
import { faxPage, headerOnlyTiff, realTiff } from '../../ingest/test/tiff-builders';

/**
 * A TIFF through the pipeline (ADR 0054). The stored document is the file that
 * arrived — its type, its hash, its dedupe — and every reader is sent a
 * rendition of it they can take: PNG for one page, PDF for several. Never
 * `image/tiff`, and never before the scan gate.
 */

const ORG = '11111111-1111-1111-1111-111111111111';
const PAGE_TEXT = 'Claim FX-2210  Deduction $410.00  Retailer Harbor Foods';

interface Seen {
  readonly mimeType: string;
  readonly filename: string;
}

class RecordingOcr implements OcrProvider {
  readonly name = 'recording-ocr';
  readonly seen: Seen[] = [];
  async ocr(document: DocumentPayload): Promise<OcrResult> {
    this.seen.push({ mimeType: document.mimeType, filename: document.filename });
    return {
      provider: this.name,
      pages: [{ page: 1, text: PAGE_TEXT }],
      blocks: [],
      call: {
        purpose: 'extract',
        provider: 'reducto',
        modelVersion: 'fake-1',
        documentId: document.documentId,
        costMicros: 4_000,
        latencyMs: 1,
        outcome: 'ok',
      },
    };
  }
}

class RecordingClassifier implements Classifier {
  readonly seen: Seen[] = [];
  async classify(document: DocumentPayload): Promise<ClassificationResult> {
    this.seen.push({ mimeType: document.mimeType, filename: document.filename });
    return {
      docType: 'deduction_notice',
      confidence: 0.97,
      call: {
        purpose: 'classify',
        provider: 'anthropic',
        modelVersion: 'fixture',
        documentId: document.documentId,
        costMicros: 1_000,
        latencyMs: 1,
        outcome: 'ok',
      },
    };
  }
}

class RecordingExtractor implements Extractor {
  readonly name = 'recording';
  readonly seen: Seen[] = [];
  async extract(document: DocumentPayload, docType: DocType): Promise<ExtractionResult> {
    this.seen.push({ mimeType: document.mimeType, filename: document.filename });
    return buildExtractionResult({
      docType,
      extractor: this.name,
      pageText: document.pageText,
      document: {
        claim_id: { value: 'FX-2210', confidence: 0.99, source_page: 1, source_quote: 'FX-2210' },
        retailer_name: { value: 'Harbor Foods', confidence: 0.98, source_page: 1, source_quote: 'Retailer Harbor Foods' },
        deduction_amount: { value: '$410.00', confidence: 0.99, source_page: 1, source_quote: '$410.00' },
      },
      call: {
        purpose: 'extract',
        provider: 'anthropic',
        modelVersion: 'fixture',
        documentId: document.documentId,
        costMicros: 9_000,
        latencyMs: 1,
        outcome: 'ok',
      },
    });
  }
}

function setup(scanner: PipelineDeps['scanner'] = new AlwaysCleanScanner()) {
  const store = new InMemoryStore();
  const ocr = new RecordingOcr();
  const classifier = new RecordingClassifier();
  const extractor = new RecordingExtractor();
  const deps: PipelineDeps = {
    store,
    scanner,
    classifier,
    extractor,
    ocr,
    now: () => new Date('2026-09-26T00:00:00Z'),
  };
  return { store, ocr, classifier, extractor, deps };
}

function upload(bytes: Uint8Array, filename = 'fax.tif') {
  return { orgId: ORG, filename, bytes, declaredMimeType: 'image/tiff', source: 'web_upload' as const };
}

describe('a TIFF through the pipeline', () => {
  it('stores the file that arrived and sends every reader a PNG of its one page', async () => {
    const { deps, store, ocr, classifier, extractor } = setup();
    const tiff = await faxPage();
    const result = await processUpload(upload(tiff), deps);

    const stored = result.ingest.document;
    expect(stored).toMatchObject({ mimeType: 'image/tiff', sha256: sha256(tiff), byteSize: tiff.byteLength });
    expect((await store.findDocumentByHash(ORG, sha256(tiff)))?.bytes).toEqual(tiff);

    for (const reader of [ocr, classifier, extractor]) {
      expect(reader.seen).toEqual([{ mimeType: 'image/png', filename: 'fax.png' }]);
    }
    expect(result.case).toBeDefined();
  });

  it('sends a multi-page TIFF as a PDF, and says so on every model call', async () => {
    const { deps, store, ocr, classifier, extractor } = setup();
    const tiff = await realTiff([
      { width: 200, height: 260, colour: 'white' },
      { width: 200, height: 260, colour: 'white' },
      { width: 200, height: 260, colour: 'white' },
    ]);
    await processUpload(upload(tiff, 'remit.tiff'), deps);

    for (const reader of [ocr, classifier, extractor]) {
      expect(reader.seen).toEqual([{ mimeType: 'application/pdf', filename: 'remit.pdf' }]);
    }
    expect(store.modelCalls).toHaveLength(3);
    for (const call of store.modelCalls) {
      expect(call.detail).toMatch(/^rendition image\/tiff→application\/pdf 3p/);
    }
  });

  it('leaves a PDF’s reads exactly as they were: its own bytes, no rendition on any call', async () => {
    const { deps, store, classifier } = setup();
    const pdf = new TextEncoder().encode('%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n%%EOF\n');
    await processUpload({ ...upload(pdf, 'notice.pdf'), declaredMimeType: 'application/pdf' }, deps);
    expect(classifier.seen).toEqual([{ mimeType: 'application/pdf', filename: 'notice.pdf' }]);
    for (const call of store.modelCalls) {
      expect(call.detail ?? '').not.toMatch(/rendition/);
    }
  });

  it('deduplicates the same TIFF uploaded again, by the hash of the file that arrived', async () => {
    const { deps } = setup();
    const tiff = await faxPage();
    const first = await ingestDocument(upload(tiff), deps);
    const second = await ingestDocument(upload(tiff, 'again.tif'), deps);
    expect(second.deduplicated).toBe(true);
    expect(second.document.documentId).toBe(first.document.documentId);
    expect(second.document.mimeType).toBe('image/tiff');
  });

  it('decodes nothing the scanner did not call clean', async () => {
    const { deps, classifier, ocr } = setup(new AlwaysInfectedScanner());
    // Undecodable as well as infected: the gate's refusal is what comes back,
    // so the file was never handed to libvips.
    const ingest = await ingestDocument(upload(headerOnlyTiff([{ width: 100, length: 100 }])), deps);
    await expect(readDocument(ingest.document, deps)).rejects.toBeInstanceOf(UnscannedDocumentError);
    expect(classifier.seen).toEqual([]);
    expect(ocr.seen).toEqual([]);
  });

  it('refuses a clean TIFF that will not decode before anything is spent', async () => {
    const { deps, store, classifier, ocr } = setup();
    const ingest = await ingestDocument(upload(headerOnlyTiff([{ width: 100, length: 100 }])), deps);
    await expect(readDocument(ingest.document, deps)).rejects.toBeInstanceOf(RenditionError);
    expect(classifier.seen).toEqual([]);
    expect(ocr.seen).toEqual([]);
    expect(store.modelCalls).toEqual([]);
  });
});

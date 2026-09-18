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
import { processUpload } from '../src/steps';
import type { PipelineDeps } from '../src/ports';
import { AlwaysCleanScanner, InMemoryStore } from '../src/testing/memory-store';

/**
 * A scan has no text layer, so everything a reviewer can check comes from OCR:
 * the page text a quote is verified against, and the boxes drawn over the image.
 * These assert that both survive the whole of `processUpload` — not just the one
 * step that happens to call OCR.
 */

const PAGE_TEXT = 'Claim APDP-99812  Deduction $3,120.00  Retailer Walmart';

class FakeOcr implements OcrProvider {
  readonly name = 'fake-ocr';
  calls = 0;
  async ocr(document: DocumentPayload): Promise<OcrResult> {
    this.calls += 1;
    return {
      provider: this.name,
      pages: [{ page: 1, text: PAGE_TEXT }],
      blocks: [
        { text: 'APDP-99812', page: 1, bbox: [0.1, 0.1, 0.3, 0.14], kind: 'text', confidence: 0.99 },
        { text: '$3,120.00', page: 1, bbox: [0.5, 0.2, 0.7, 0.24], kind: 'text', confidence: 0.98 },
      ],
      call: {
        // The real Reducto provider records its read the same way: an OCR pass is
        // told apart by its provider, not by a purpose of its own.
        purpose: 'extract',
        provider: 'reducto',
        modelVersion: 'fake-1',
        documentId: document.documentId,
        costMicros: 4_000,
        latencyMs: 120,
        outcome: 'ok',
      },
    };
  }
}

class NoticeClassifier implements Classifier {
  async classify(document: DocumentPayload): Promise<ClassificationResult> {
    return {
      docType: 'deduction_notice',
      confidence: 0.97,
      call: {
        purpose: 'classify',
        provider: 'anthropic',
        modelVersion: 'fixture',
        documentId: document.documentId,
        costMicros: 1_300,
        latencyMs: 10,
        outcome: 'ok',
      },
    };
  }
}

/** Quotes exactly what the OCR text says, which is what a real reader must do. */
class QuotingExtractor implements Extractor {
  readonly name = 'quoting';
  async extract(document: DocumentPayload, docType: DocType): Promise<ExtractionResult> {
    return buildExtractionResult({
      docType,
      extractor: this.name,
      pageText: document.pageText,
      document: {
        claim_id: { value: 'APDP-99812', confidence: 0.99, source_page: 1, source_quote: 'APDP-99812' },
        retailer_name: { value: 'Walmart', confidence: 0.98, source_page: 1, source_quote: 'Retailer Walmart' },
        deduction_amount: { value: 312_000, confidence: 0.99, source_page: 1, source_quote: '$3,120.00' },
      },
      call: {
        purpose: 'extract',
        provider: 'anthropic',
        modelVersion: 'fixture',
        documentId: document.documentId,
        costMicros: 12_700,
        latencyMs: 40,
        outcome: 'ok',
      },
    });
  }
}

function deps(): { deps: PipelineDeps; store: InMemoryStore; ocr: FakeOcr } {
  const store = new InMemoryStore();
  const ocr = new FakeOcr();
  return {
    store,
    ocr,
    deps: {
      store,
      scanner: new AlwaysCleanScanner(),
      classifier: new NoticeClassifier(),
      extractor: new QuotingExtractor(),
      ocr,
      now: () => new Date('2026-09-18T00:00:00Z'),
    },
  };
}

const scanUpload = {
  orgId: '11111111-1111-1111-1111-111111111111',
  filename: 'notice-scan.jpg',
  // A minimal JPEG: magic bytes are what the ingest gate checks.
  bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]),
  declaredMimeType: 'image/jpeg',
  source: 'web_upload' as const,
};

describe('a scanned notice through the whole of processUpload', () => {
  it('reads the page once, however many steps need it', async () => {
    const { deps: d, ocr } = deps();
    await processUpload(scanUpload, d);
    // Classification and extraction both need the page text. Paying twice for it
    // would be a silent bill, so the read is shared.
    expect(ocr.calls).toBe(1);
  });

  it('keeps the boxes OCR found, so a reviewer can follow a field to the page', async () => {
    const { deps: d } = deps();
    const result = await processUpload(scanUpload, d);
    const boxed = result.extraction?.fields.filter((f) => f.sourceBbox !== null) ?? [];
    expect(boxed.map((f) => f.fieldPath).sort()).toEqual(['claim_id', 'deduction_amount']);
  });

  it('verifies each quote against the OCR text', async () => {
    const { deps: d } = deps();
    const result = await processUpload(scanUpload, d);
    expect(result.extraction?.fields.every((f) => f.quoteVerified)).toBe(true);
  });

  it('attributes every field and every model call to the case the notice opened', async () => {
    const { deps: d, store } = deps();
    const result = await processUpload(scanUpload, d);
    const deductionId = result.case?.deductionId;
    expect(deductionId).toBeDefined();

    // A field nobody can tie to a case cannot be shown on that case's review
    // page — and the notice is the document the case exists because of.
    for (const row of store.extractions) {
      expect(row.deductionId).toBe(deductionId);
    }
    // And the cost, because a contingency fee is charged against a recovery on a
    // case, so the spend has to land on the same case.
    for (const call of store.modelCalls) {
      expect(call.deductionId).toBe(deductionId);
    }
  });
});

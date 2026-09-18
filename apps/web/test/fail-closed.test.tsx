import { afterEach, describe, expect, it } from 'vitest';
import { processUpload } from '@recouple/pipeline';
import { AlwaysCleanScanner, InMemoryStore } from '@recouple/pipeline/testing';
import {
  buildExtractionResult,
  type ClassificationResult,
  type DocType,
  type DocumentPayload,
  type ExtractionResult,
} from '@recouple/extraction';
import { allFixtureDocuments, expectedExtraction } from '@recouple/fixtures';
import { pipelineDepsFor } from '../lib/pipeline';

/**
 * What the app does when it is not fully configured.
 *
 * The answer that matters is that it refuses rather than guesses. An environment
 * with no malware scanner must not be able to read a stranger's file, and the
 * way to be sure is to run the real assembly with the variable unset.
 */
const notice = allFixtureDocuments().find((d) => d.filename === 'walmart-apdp-notice.pdf');

if (notice === undefined) throw new Error('the walmart notice fixture is missing');

const upload = {
  orgId: '11111111-1111-1111-1111-111111111111',
  filename: notice.filename,
  bytes: notice.bytes,
  source: 'web_upload' as const,
  pageText: notice.pageText,
};

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe('an unconfigured environment', () => {
  it('refuses to read a file when no malware scanner is configured', async () => {
    delete process.env.CLAMAV_HOST;
    const store = new InMemoryStore();
    const deps = pipelineDepsFor(store);
    expect(deps.scanner.name).toBe('none');

    const result = await processUpload(upload, deps);

    // Invariant 4: no verdict is not a pass. The file is stored and scanned —
    // the scan is what reports the error — and nothing reads it after that.
    expect(result.haltedBecause).toMatch(/not scanned clean/);
    expect(result.classification).toBeUndefined();
    expect(result.extraction).toBeUndefined();
    expect(result.case).toBeUndefined();
    // And it cost nothing: no model was called on an unscanned file.
    expect(store.modelCalls).toEqual([]);
  });

  it('constructs no OCR provider without a key, rather than one that throws', () => {
    delete process.env.REDUCTO_API_KEY;
    const deps = pipelineDepsFor(new InMemoryStore());
    expect(deps.ocr).toBeUndefined();
  });

  it('uses clamd when it is configured', () => {
    process.env.CLAMAV_HOST = 'clamd.internal';
    expect(pipelineDepsFor(new InMemoryStore()).scanner.name).toBe('clamav');
  });

  it('still reads a file once something declares it clean', async () => {
    // The gate is the scan verdict, not the scanner's identity. The readers are
    // stubbed here on purpose: `pipelineDepsFor` builds the real Claude ones, and
    // a test that calls a model is a test that costs money and needs a network.
    const store = new InMemoryStore();
    const deps = {
      ...pipelineDepsFor(store),
      scanner: new AlwaysCleanScanner(),
      classifier: {
        async classify(document: DocumentPayload): Promise<ClassificationResult> {
          return {
            docType: 'deduction_notice',
            confidence: 0.99,
            call: {
              purpose: 'classify', provider: 'anthropic', modelVersion: 'stub',
              documentId: document.documentId, costMicros: 0, latencyMs: 0, outcome: 'ok',
            },
          };
        },
      },
      extractor: {
        name: 'stub',
        async extract(document: DocumentPayload, docType: DocType): Promise<ExtractionResult> {
          return buildExtractionResult({
            docType, extractor: 'stub', document: expectedExtraction(notice),
            pageText: document.pageText,
            call: {
              purpose: 'extract', provider: 'anthropic', modelVersion: 'stub',
              documentId: document.documentId, costMicros: 0, latencyMs: 0, outcome: 'ok',
            },
          });
        },
      },
    };
    const result = await processUpload(upload, deps);
    expect(result.haltedBecause).toBeUndefined();
    expect(result.case?.claimId).toBe('APDP-99812');
  });
});

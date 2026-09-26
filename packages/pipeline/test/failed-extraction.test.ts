/**
 * A read whose extraction failed still spent money, and `model_calls` says so.
 *
 * A dense document refused as too large (ADR 0053) carries every call it made
 * on its error — a paged read's parts included, which can be a dollar. Before
 * this, `readDocument` let the error go by and recorded nothing: the job
 * logged a class name and `model_calls` never saw the spend.
 */

import { describe, expect, it } from 'vitest';
import {
  DocumentTooLargeError,
  type ClassificationResult,
  type Classifier,
  type DocumentPayload,
  type ExtractionResult,
  type Extractor,
  type ModelCallRecord,
} from '@recouple/extraction';
import { everyDocument } from '@recouple/fixtures';
import { processUpload } from '../src/steps';
import { AlwaysCleanScanner, InMemoryStore } from '../src/testing/memory-store';

const ORG = 'org-1';
const USER = 'user-7';

const remittance = everyDocument().find((d) => d.key === 'lakeshore-dense-paged-remittance');
if (remittance === undefined) throw new Error('the dense_paged fixture is missing');

const classifier: Classifier = {
  async classify(document: DocumentPayload): Promise<ClassificationResult> {
    return {
      docType: 'remittance_advice',
      confidence: 0.99,
      call: {
        purpose: 'classify',
        provider: 'anthropic',
        modelVersion: 'scripted',
        documentId: document.documentId,
        costMicros: 20_000,
        latencyMs: 1,
        outcome: 'ok',
      },
    };
  },
};

function refusing(error: (document: DocumentPayload) => Error): Extractor {
  return {
    name: 'scripted',
    async extract(document: DocumentPayload): Promise<ExtractionResult> {
      throw error(document);
    },
  };
}

function harness(extractor: Extractor) {
  const store = new InMemoryStore();
  store.addMember(ORG, USER, 'analyst');
  return {
    store,
    deps: {
      store,
      scanner: new AlwaysCleanScanner(),
      classifier,
      extractor,
      now: () => new Date('2026-09-26T12:00:00Z'),
    },
  };
}

const upload = {
  orgId: ORG,
  filename: remittance.filename,
  bytes: remittance.bytes,
  source: 'web_upload' as const,
  uploadedBy: USER,
  pageText: remittance.pageText,
};

describe('a read whose extraction fails', () => {
  it('records the classification and every call the refused extraction made, then fails loudly', async () => {
    const spent = (document: DocumentPayload): ModelCallRecord => ({
      purpose: 'extract',
      provider: 'anthropic',
      modelVersion: 'claude-sonnet-5',
      documentId: document.documentId,
      inputTokens: 27_000,
      outputTokens: 33_000,
      costMicros: 384_000,
      latencyMs: 212_000,
      outcome: 'timeout',
      detail: 'paged up front: …; refused 1 more batch(es) at 212 s',
    });
    const { store, deps } = harness(
      refusing(
        (document) =>
          new DocumentTooLargeError(
            'a paged read of 5 pages would pass its 240 s budget: split the document and retry',
            spent(document),
          ),
      ),
    );

    await expect(processUpload(upload, deps)).rejects.toBeInstanceOf(DocumentTooLargeError);

    expect(store.modelCalls.map((c) => [c.purpose, c.costMicros, c.outcome])).toEqual([
      ['classify', 20_000, 'ok'],
      ['extract', 384_000, 'timeout'],
    ]);
    // Nothing else of the read: no classification row, no fields, no case.
    expect(store.classifications).toEqual([]);
    expect(store.extractions).toEqual([]);
    expect(store.cases.size).toBe(0);
  });

  it('records the classification it paid for when the extractor fails some other way', async () => {
    const { store, deps } = harness(refusing(() => new TypeError('a bug, not a read')));
    await expect(processUpload(upload, deps)).rejects.toBeInstanceOf(TypeError);
    expect(store.modelCalls.map((c) => c.purpose)).toEqual(['classify']);
  });
});

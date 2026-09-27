/**
 * A portal capture enters through ingest as `portal_fetch` (ADR 0057 §9–§10):
 * a page snapshot as `text/html` through its own door, a download through the
 * ordinary one, the arrival recorded with no member behind it, and a notice or
 * remittance held `by_portal` for a person rather than opening a case.
 */
import { describe, expect, it } from 'vitest';
import {
  buildExtractionResult,
  type Classifier,
  type ClassificationResult,
  type DocType,
  type DocumentPayload,
  type Extractor,
  type ExtractionResult,
} from '@recouple/extraction';
import { allFixtureDocuments, expectedExtraction, type FixtureDocument } from '@recouple/fixtures';
import { RejectedUploadError } from '@recouple/ingest';
import { readDocumentJob, type JobDeps } from '../src/jobs';
import type { StoredDocument } from '../src/ports';
import { ingestDocument } from '../src/steps';
import { AlwaysCleanScanner, InMemoryStore } from '../src/testing/memory-store';

const ORG = '11111111-1111-1111-1111-111111111111';
const OWNER = '22222222-2222-2222-2222-222222222222';
const SNAPSHOT = new TextEncoder().encode(
  '<!doctype html>\n<html><body><h1>Deductions</h1><table><tr><td>DN-1001</td><td>$1,200.00</td></tr></table></body></html>\n',
);

function fixtureFor(filename: string): FixtureDocument {
  const found = allFixtureDocuments().find((d) => d.filename === filename);
  if (found === undefined) throw new Error(`no fixture ${filename}`);
  return found;
}
const NOTICE = fixtureFor('walmart-apdp-notice.pdf');

class FixtureReader implements Classifier, Extractor {
  readonly name = 'fixture';
  async classify(document: DocumentPayload): Promise<ClassificationResult> {
    return {
      docType: fixtureFor(document.filename).docType as DocType,
      confidence: 0.99,
      call: { purpose: 'classify', provider: 'anthropic', modelVersion: 'fixture',
              documentId: document.documentId, costMicros: 1, latencyMs: 1, outcome: 'ok' },
    };
  }
  async extract(document: DocumentPayload, docType: DocType): Promise<ExtractionResult> {
    return buildExtractionResult({
      docType, extractor: this.name,
      document: expectedExtraction(fixtureFor(document.filename)),
      pageText: document.pageText,
      call: { purpose: 'extract', provider: 'anthropic', modelVersion: 'fixture',
              documentId: document.documentId, costMicros: 1, latencyMs: 1, outcome: 'ok' },
    });
  }
}

class JobTestStore extends InMemoryStore {
  override async getDocument(documentId: string): Promise<StoredDocument | undefined> {
    return this.documents.get(documentId);
  }
}

function harness() {
  const store = new JobTestStore();
  store.addMember(ORG, OWNER, 'owner');
  const reader = new FixtureReader();
  return { store, deps: { store, scanner: new AlwaysCleanScanner(), classifier: reader, extractor: reader, now: () => new Date('2026-09-27T12:00:00Z') } as JobDeps };
}

describe('portal_fetch at the door', () => {
  it('stores a page snapshot as text/html with an uploads row of portal_fetch and no member', async () => {
    const { store, deps } = harness();
    const r = await ingestDocument({ orgId: ORG, filename: 'list.html', bytes: SNAPSHOT, declaredMimeType: 'text/html', source: 'portal_fetch' }, deps);
    expect(r.document.mimeType).toBe('text/html');
    expect([...store.uploads.values()]).toEqual([expect.objectContaining({ source: 'portal_fetch', orgId: ORG })]);
    expect([...store.uploads.values()][0]?.createdBy).toBeUndefined();
    expect(await store.uploadSourceFor(r.document.documentId)).toBe('portal_fetch');
  });

  it('refuses the same HTML through a web upload', async () => {
    const { store, deps } = harness();
    await expect(ingestDocument({ orgId: ORG, filename: 'list.html', bytes: SNAPSHOT, declaredMimeType: 'text/html', source: 'web_upload', uploadedBy: OWNER }, deps))
      .rejects.toBeInstanceOf(RejectedUploadError);
    expect(store.uploads.size).toBe(0);
  });

  it('refuses a snapshot carrying a script, even from a portal', async () => {
    const { deps } = harness();
    const bad = new TextEncoder().encode('<html><body><script>x()</script></body></html>');
    await expect(ingestDocument({ orgId: ORG, filename: 'p.html', bytes: bad, declaredMimeType: 'text/html', source: 'portal_fetch' }, deps))
      .rejects.toBeInstanceOf(RejectedUploadError);
  });

  it('keeps the first arrival when the same bytes are captured again', async () => {
    const { store, deps } = harness();
    const first = await ingestDocument({ orgId: ORG, filename: 'list.html', bytes: SNAPSHOT, declaredMimeType: 'text/html', source: 'portal_fetch' }, deps);
    const again = await ingestDocument({ orgId: ORG, filename: 'list.html', bytes: SNAPSHOT, declaredMimeType: 'text/html', source: 'portal_fetch' }, deps);
    expect(again.deduplicated).toBe(true);
    expect(again.document.uploadId).toBe(first.document.uploadId);
    expect(store.uploads.size).toBe(1);
  });
});

describe('a notice captured from a portal', () => {
  it('is held by_portal and opens no case, however sure the reading', async () => {
    const { store, deps } = harness();
    const r = await ingestDocument({ orgId: ORG, filename: NOTICE.filename, bytes: NOTICE.bytes, source: 'portal_fetch', pageText: NOTICE.pageText }, deps);
    expect(r.document.mimeType).toBe('application/pdf');
    const read = await readDocumentJob(deps, { documentId: r.document.documentId, orgId: ORG, actor: { userId: OWNER }, allowCaseOpen: true });
    expect(read).toMatchObject({ held: 'by_portal', deductionId: null });
    expect(store.cases.size).toBe(0);
  });
});

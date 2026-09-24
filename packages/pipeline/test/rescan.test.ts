import { describe, expect, it } from 'vitest';
import { allFixtureDocuments } from '@recouple/fixtures';
import type { ScanVerdict } from '@recouple/ingest';
import { ingestDocument, type IngestInput } from '../src/steps';
import type { PipelineDeps } from '../src/ports';
import { AlwaysCleanScanner, InMemoryStore } from '../src/testing/memory-store';

/**
 * A document stored without a verdict is scanned again (ADR 0047 §10).
 *
 * Every scanner answers `error` rather than throwing when it cannot reach
 * clamd, so an outage used to leave a stored document with an `error` verdict
 * that every later arrival of the same bytes was answered from: no retry, on
 * any door, could ever get it read.
 */
const ORG = '11111111-1111-1111-1111-111111111111';
const NOTICE = allFixtureDocuments().find((d) => d.key === 'walmart-apdp-notice')!;

const input: IngestInput = {
  orgId: ORG,
  filename: NOTICE.filename,
  bytes: NOTICE.bytes,
  source: 'web_upload',
  uploadedBy: '22222222-2222-2222-2222-222222222222',
  pageText: NOTICE.pageText,
};

class CountingScanner {
  readonly name = 'counting';
  calls = 0;
  constructor(private readonly verdict: ScanVerdict['status']) {}
  async scan(): Promise<ScanVerdict> {
    this.calls += 1;
    return { status: this.verdict, scanner: this.name };
  }
}

function deps(store: InMemoryStore, scanner: PipelineDeps['scanner']): PipelineDeps {
  return {
    store,
    scanner,
    classifier: { classify: async () => { throw new Error('not read here'); } },
    extractor: { extract: async () => { throw new Error('not read here'); } },
  } as unknown as PipelineDeps;
}

describe('the same bytes arriving again', () => {
  it('scans again when the first scan gave no verdict, and appends the new one', async () => {
    const store = new InMemoryStore();
    const outage = new CountingScanner('error');
    const first = await ingestDocument(input, deps(store, outage));
    expect(first.verdict.status).toBe('error');

    const recovered = new CountingScanner('clean');
    const second = await ingestDocument(input, deps(store, recovered));

    expect(second.deduplicated).toBe(true);
    expect(second.document.documentId).toBe(first.document.documentId);
    expect(recovered.calls).toBe(1);
    expect(second.verdict.status).toBe('clean');
    expect(await store.latestScan(first.document.documentId)).toMatchObject({ status: 'clean' });
  });

  it('does not scan a clean document again', async () => {
    const store = new InMemoryStore();
    await ingestDocument(input, deps(store, new AlwaysCleanScanner()));
    const again = new CountingScanner('infected');
    const second = await ingestDocument(input, deps(store, again));
    expect(again.calls).toBe(0);
    expect(second.verdict.status).toBe('clean');
  });

  it('does not scan an infected document again: a verdict of infected is final', async () => {
    const store = new InMemoryStore();
    await ingestDocument(input, deps(store, new CountingScanner('infected')));
    const again = new CountingScanner('clean');
    const second = await ingestDocument(input, deps(store, again));
    expect(again.calls).toBe(0);
    expect(second.verdict.status).toBe('infected');
  });
});

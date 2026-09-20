/**
 * The job halves of an upload, against the synchronous path they came out of.
 *
 * The claim ADR 0021 makes is that moving the read off the request path changes
 * where it runs and nothing else: the same steps, the same records, in the same
 * order. So the central test here does not check a list of fields — it runs both
 * paths over the same fixture and compares everything either one wrote.
 */

import { describe, expect, it } from 'vitest';
import { UnscannedDocumentError } from '@recouple/ingest';
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
import {
  CaseNotFoundError,
  DuplicateCaseError,
  processUpload,
  type IngestInput,
} from '../src/steps';
import {
  DocumentNotFoundError,
  InvalidJobPayloadError,
  assertCaseAttachable,
  ingestForJob,
  readDocumentJob,
  type JobDeps,
} from '../src/jobs';
import type { StoredDocument } from '../src/ports';
import {
  AlwaysCleanScanner,
  AlwaysInfectedScanner,
  InMemoryStore,
} from '../src/testing/memory-store';

function fixtureFor(filename: string): FixtureDocument {
  const found = allFixtureDocuments().find((d) => d.filename === filename);
  if (found === undefined) throw new Error(`no fixture ${filename}`);
  return found;
}

/**
 * The in-memory store plus the one method a job owes itself: a document by id.
 *
 * `PostgresStore` already answers it, under the tenant's claims. The in-memory
 * one has the map in the open, so this is the whole implementation.
 */
class JobTestStore extends InMemoryStore {
  async getDocument(documentId: string): Promise<StoredDocument | undefined> {
    return this.documents.get(documentId);
  }
}

class FixtureClassifier implements Classifier {
  async classify(document: DocumentPayload): Promise<ClassificationResult> {
    const fixture = fixtureFor(document.filename);
    return {
      docType: fixture.docType as DocType,
      confidence: 0.99,
      call: {
        purpose: 'classify',
        provider: 'anthropic',
        modelVersion: 'fixture',
        documentId: document.documentId,
        costMicros: 1_300,
        latencyMs: 12,
        outcome: 'ok',
      },
    };
  }
}

class FixtureExtractor implements Extractor {
  readonly name = 'fixture';
  async extract(document: DocumentPayload, docType: DocType): Promise<ExtractionResult> {
    const fixture = fixtureFor(document.filename);
    return buildExtractionResult({
      docType,
      extractor: this.name,
      document: expectedExtraction(fixture),
      pageText: document.pageText,
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

function harness(scanner: JobDeps['scanner'] = new AlwaysCleanScanner()): {
  store: JobTestStore;
  deps: JobDeps;
} {
  const store = new JobTestStore();
  // The member the events below name. A job checks this before it reads
  // anything, so a harness with no memberships is a harness where every job
  // refuses — which is what the test below the refusals asserts deliberately.
  store.addMember(ORG, ACTOR.userId, 'analyst');
  return {
    store,
    deps: {
      store,
      scanner,
      classifier: new FixtureClassifier(),
      extractor: new FixtureExtractor(),
      now: () => new Date(0),
    },
  };
}

const ORG = 'org-1';
const ACTOR = { userId: 'user-7' };

function upload(fixture: FixtureDocument): IngestInput {
  return {
    orgId: ORG,
    filename: fixture.filename,
    bytes: fixture.bytes,
    source: 'web_upload' as const,
    pageText: fixture.pageText,
  };
}

/**
 * Everything a store was told, with the ids it minted replaced by their
 * position, so two runs that differ only in their UUIDs compare equal.
 *
 * Deliberately everything rather than a chosen few fields: the point of the
 * comparison is to catch a difference nobody thought to look for.
 */
function ledgerOf(store: InMemoryStore): unknown {
  const labels = new Map<string, string>();
  [...store.documents.keys()].forEach((id, index) => labels.set(id, `document-${index}`));
  [...store.cases.keys()].forEach((id, index) => labels.set(id, `case-${index}`));

  const scrub = (value: unknown): unknown => {
    if (typeof value === 'string') return labels.get(value) ?? value;
    if (value instanceof Uint8Array) return `${value.byteLength} bytes`;
    if (Array.isArray(value)) return value.map(scrub);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, inner]) => [key, scrub(inner)]),
      );
    }
    return value;
  };

  return scrub({
    documents: [...store.documents.values()],
    scans: store.scans,
    classifications: store.classifications,
    extractions: store.extractions,
    modelCalls: store.modelCalls,
    events: store.events,
    cases: [...store.cases.values()],
    links: store.links,
    pages: [...store.pages.entries()],
  });
}

describe('the job path and the request path are the same path', () => {
  it('records the same things, in the same order, and opens the same case', async () => {
    const notice = fixtureFor('walmart-apdp-notice.pdf');

    const inline = harness();
    const synchronous = await processUpload(upload(notice), inline.deps);

    const job = harness();
    const ingested = await ingestForJob(job.deps, upload(notice));
    expect(ingested.haltedBecause).toBeUndefined();
    const read = await readDocumentJob(job.deps, {
      documentId: ingested.documentId,
      orgId: ingested.orgId,
      actor: ACTOR,
    });

    // The whole ledger: documents, scans, classifications, extractions, model
    // calls, events, cases, links and pages — in order.
    expect(ledgerOf(job.store)).toEqual(ledgerOf(inline.store));

    // And the two agree about what happened, in the words each one answers in.
    expect(read.docType).toBe(synchronous.classification?.docType);
    expect(read.deductionId).toBe([...job.store.cases.keys()][0]);
    expect(read.haltedBecause).toBeNull();
    expect([...job.store.cases.values()][0]?.claimId).toBe('APDP-99812');
  });

  it('attaches evidence to a case the same way either path does', async () => {
    const notice = fixtureFor('walmart-apdp-notice.pdf');
    const invoice = fixtureFor('harborline-invoice.pdf');

    const inline = harness();
    const opened = await processUpload(upload(notice), inline.deps);
    const deductionId = opened.case?.deductionId as string;
    await processUpload(upload(invoice), inline.deps, { attachToCase: deductionId });

    const job = harness();
    await processUpload(upload(notice), job.deps);
    const jobCaseId = [...job.store.cases.keys()][0] as string;
    const ingested = await ingestForJob(job.deps, upload(invoice));
    await readDocumentJob(job.deps, {
      documentId: ingested.documentId,
      orgId: ingested.orgId,
      actor: ACTOR,
      attachToCase: jobCaseId,
    });

    expect(ledgerOf(job.store)).toEqual(ledgerOf(inline.store));
    expect(job.store.events.map((e) => e.eventType)).toContain('evidence.uploaded');
  });
});

describe('what a request hands to a job', () => {
  it('carries ids and no document content', async () => {
    const { deps } = harness();
    const ingested = await ingestForJob(deps, upload(fixtureFor('walmart-apdp-notice.pdf')));

    // The event this becomes goes to a third party. A claim id, a total or a
    // line of the page would be document content leaving the building
    // (invariant 4) — so the payload is checked as a whole, not field by field.
    const asSent = JSON.stringify(ingested);
    expect(asSent).not.toContain('APDP-99812');
    expect(asSent).not.toContain('Walmart');
    expect(asSent).not.toContain('3,120');
    expect(Object.keys(ingested).sort()).toEqual([
      'deduplicated',
      'documentId',
      'filename',
      'orgId',
      'sha256',
      'warnings',
    ]);
  });

  it('stops a file that did not scan clean at the door, and reads nothing', async () => {
    const { store, deps } = harness(new AlwaysInfectedScanner());
    const ingested = await ingestForJob(deps, upload(fixtureFor('walmart-apdp-notice.pdf')));

    expect(ingested.haltedBecause).toMatch(/not scanned clean: infected/);
    expect(store.modelCalls).toEqual([]);
    expect(store.cases.size).toBe(0);

    // And a caller that ignores that and asks for the read anyway does not get
    // one: the gate is the recorded verdict, and it throws here rather than
    // answering. A job that failed loudly is the correct outcome.
    await expect(
      readDocumentJob(deps, {
        documentId: ingested.documentId,
        orgId: ingested.orgId,
        actor: ACTOR,
      }),
    ).rejects.toBeInstanceOf(UnscannedDocumentError);
    expect(store.modelCalls).toEqual([]);
  });
});

describe('a read job that cannot trust its payload', () => {
  it('refuses a payload with no document, org or actor, before reading anything', async () => {
    const { store, deps } = harness();
    const ingested = await ingestForJob(deps, upload(fixtureFor('walmart-apdp-notice.pdf')));
    const good = { documentId: ingested.documentId, orgId: ORG, actor: ACTOR };

    await expect(readDocumentJob(deps, { ...good, documentId: '' })).rejects.toBeInstanceOf(
      InvalidJobPayloadError,
    );
    await expect(readDocumentJob(deps, { ...good, orgId: '  ' })).rejects.toBeInstanceOf(
      InvalidJobPayloadError,
    );
    await expect(
      readDocumentJob(deps, { ...good, actor: { userId: '' } }),
    ).rejects.toBeInstanceOf(InvalidJobPayloadError);
    // An event with no org id must not read as "any org".
    await expect(
      readDocumentJob(deps, { ...good, actor: undefined as unknown as { userId: string } }),
    ).rejects.toBeInstanceOf(InvalidJobPayloadError);

    expect(store.modelCalls).toEqual([]);
  });

  it('refuses a document the payload says belongs to another tenant', async () => {
    // Under RLS the document would simply not be found. The in-memory store has
    // no policies, so this is the check that keeps the two ids from disagreeing
    // silently wherever the store is not the referee.
    const { store, deps } = harness();
    // A real member of the other tenant, so this is the org mismatch being
    // refused rather than the membership check firing first.
    store.addMember('org-2', ACTOR.userId, 'analyst');
    const ingested = await ingestForJob(deps, upload(fixtureFor('walmart-apdp-notice.pdf')));

    await expect(
      readDocumentJob(deps, {
        documentId: ingested.documentId,
        orgId: 'org-2',
        actor: ACTOR,
      }),
    ).rejects.toBeInstanceOf(InvalidJobPayloadError);
    expect(store.modelCalls).toEqual([]);
  });

  it('refuses an actor who is not a member of the org the event names', async () => {
    // `tenant_read` is `org_id = app.current_org_id()` and nothing more
    // (migration 0010), so a validly signed event pairing a victim's org with
    // any user id would be read — and paid for — and only refused at the first
    // write. The membership is checked before the document is even fetched.
    const { store, deps } = harness();
    const ingested = await ingestForJob(deps, upload(fixtureFor('walmart-apdp-notice.pdf')));

    await expect(
      readDocumentJob(deps, {
        documentId: ingested.documentId,
        orgId: ORG,
        actor: { userId: 'stranger-1' },
      }),
    ).rejects.toBeInstanceOf(InvalidJobPayloadError);

    // Nothing read, nothing spent, no case.
    expect(store.modelCalls).toEqual([]);
    expect(store.extractions).toEqual([]);
    expect(store.cases.size).toBe(0);
  });

  it('refuses a member who may read but may not add documents', async () => {
    // The same three roles `app.member_may_write()` accepts. A `read_only`
    // member's own upload could not have produced this event, so one that names
    // them is not a job to run.
    const { store, deps } = harness();
    store.addMember(ORG, 'reader-1', 'read_only');
    const ingested = await ingestForJob(deps, upload(fixtureFor('walmart-apdp-notice.pdf')));

    await expect(
      readDocumentJob(deps, {
        documentId: ingested.documentId,
        orgId: ORG,
        actor: { userId: 'reader-1' },
      }),
    ).rejects.toBeInstanceOf(InvalidJobPayloadError);
    expect(store.modelCalls).toEqual([]);
  });

  it('refuses a document id it cannot see at all', async () => {
    const { store, deps } = harness();
    await expect(
      readDocumentJob(deps, {
        documentId: '11111111-1111-1111-1111-111111111111',
        orgId: ORG,
        actor: ACTOR,
      }),
    ).rejects.toBeInstanceOf(DocumentNotFoundError);
    expect(store.modelCalls).toEqual([]);
  });

  it('refuses a case the tenant cannot attach to — in the job and before it', async () => {
    const { store, deps } = harness();
    const stranger = '44444444-4444-4444-4444-444444444444';

    // Before the bytes are stored, which is where the reviewer finds out.
    await expect(assertCaseAttachable(deps, stranger)).rejects.toBeInstanceOf(CaseNotFoundError);
    expect(store.documents.size).toBe(0);

    const ingested = await ingestForJob(deps, upload(fixtureFor('harborline-invoice.pdf')));
    await expect(
      readDocumentJob(deps, {
        documentId: ingested.documentId,
        orgId: ORG,
        actor: ACTOR,
        attachToCase: stranger,
      }),
    ).rejects.toBeInstanceOf(CaseNotFoundError);
    // Still nothing read: the refusal is before the first model call.
    expect(store.modelCalls).toEqual([]);
  });

  it('lets a case through when there is one to attach to', async () => {
    const { deps } = harness();
    const opened = await processUpload(upload(fixtureFor('walmart-apdp-notice.pdf')), deps);
    await expect(assertCaseAttachable(deps, opened.case?.deductionId)).resolves.toBeUndefined();
    await expect(assertCaseAttachable(deps, undefined)).resolves.toBeUndefined();
  });
});

describe('a redelivered event', () => {
  it('does not open a second case for a claim that already has one', async () => {
    // Inngest is asked for idempotency on the document id, and this is the
    // backstop behind it: the same claim, for a debtor the tenant has named,
    // is refused by the store itself (ADR 0019).
    const { store, deps } = harness();
    store.debtors.push({ debtorId: 'debtor-walmart', names: ['Walmart'] });

    const notice = fixtureFor('walmart-apdp-notice.pdf');
    const ingested = await ingestForJob(deps, upload(notice));
    const payload = { documentId: ingested.documentId, orgId: ORG, actor: ACTOR };
    const first = await readDocumentJob(deps, payload);

    // The same document again — the event redelivered — is answered from what
    // was recorded, before the read that would have raised the duplicate.
    const redelivered = await readDocumentJob(deps, payload);
    expect(redelivered.alreadyRead).toBe(true);
    expect(redelivered.deductionId).toBe(first.deductionId);
    expect(store.modelCalls).toHaveLength(2);

    // And the backstop itself, on the case it is actually for: the same claim
    // arriving as a *different* document — the notice as a PDF and then as a
    // scan, which are different bytes and so are not deduplicated by hash. That
    // read happens, and the store refuses the second case (ADR 0019).
    const rescanned = await ingestForJob(deps, {
      ...upload(notice),
      bytes: new Uint8Array([...notice.bytes, 0x0a]),
    });
    expect(rescanned.documentId).not.toBe(ingested.documentId);
    await expect(
      readDocumentJob(deps, { ...payload, documentId: rescanned.documentId }),
    ).rejects.toBeInstanceOf(DuplicateCaseError);

    expect(store.cases.size).toBe(1);
    expect([...store.cases.keys()][0]).toBe(first.deductionId);
  });

  it('reads once for a document nobody has linked a retailer to yet', async () => {
    // No debtor, which is every tenant's starting state: `debtor_id` is null
    // until a human links the retailer, and `unique (org_id, debtor_id,
    // claim_id)` never fires on a null. So the constraint above is no backstop
    // at all here, and a redelivered event — Inngest retrying a run whose
    // response was lost, say — would classify, extract and open a second case
    // for the same document, paying for the read twice.
    const { store, deps } = harness();
    expect(store.debtors).toEqual([]);

    const ingested = await ingestForJob(deps, upload(fixtureFor('walmart-apdp-notice.pdf')));
    const payload = { documentId: ingested.documentId, orgId: ORG, actor: ACTOR };

    const first = await readDocumentJob(deps, payload);
    const again = await readDocumentJob(deps, payload);

    // One of everything, and the second delivery says what it found rather than
    // reporting work it did not do.
    expect(store.cases.size).toBe(1);
    expect(store.extractions).toHaveLength(1);
    expect(store.classifications).toHaveLength(1);
    expect(store.modelCalls).toHaveLength(2);
    expect(store.totalCostMicros()).toBe(14_000);
    expect(store.events.map((e) => e.eventType)).toEqual(['case.discovered', 'case.classified']);

    expect(again.deductionId).toBe(first.deductionId);
    expect(again.docType).toBe(first.docType);
    expect(again.haltedBecause).toBeNull();
    expect(first.alreadyRead).toBe(false);
    expect(again.alreadyRead).toBe(true);
  });

  it('still files an already-read document against a case it is not on yet', async () => {
    // The guard above must not swallow the one thing a second read of the same
    // document is for: the same BOL is evidence for two deductions, and the
    // second upload dedupes to the same document id. Skipping that read would
    // lose the reviewer's attachment silently.
    const { store, deps } = harness();
    const first = await processUpload(upload(fixtureFor('walmart-apdp-notice.pdf')), deps);
    const other = await store.openCase({ orgId: ORG, claimId: 'SECOND-CLAIM' });

    const ingested = await ingestForJob(deps, upload(fixtureFor('carrier-bol.pdf')));
    await readDocumentJob(deps, {
      documentId: ingested.documentId,
      orgId: ORG,
      actor: ACTOR,
      attachToCase: first.case?.deductionId as string,
    });
    const second = await readDocumentJob(deps, {
      documentId: ingested.documentId,
      orgId: ORG,
      actor: ACTOR,
      attachToCase: other.deductionId,
    });

    expect(second.alreadyRead).toBe(false);
    expect(second.deductionId).toBe(other.deductionId);
    expect(
      store.links.filter((l) => l.documentId === ingested.documentId).map((l) => l.deductionId),
    ).toEqual([first.case?.deductionId, other.deductionId]);

    // And a third delivery of the event that already landed does nothing.
    const again = await readDocumentJob(deps, {
      documentId: ingested.documentId,
      orgId: ORG,
      actor: ACTOR,
      attachToCase: other.deductionId,
    });
    expect(again.alreadyRead).toBe(true);
    expect(store.links.filter((l) => l.documentId === ingested.documentId)).toHaveLength(2);
  });

  it('stores one document for the same bytes, however many times they arrive', async () => {
    const { store, deps } = harness();
    const notice = upload(fixtureFor('walmart-apdp-notice.pdf'));

    const first = await ingestForJob(deps, notice);
    const second = await ingestForJob(deps, notice);

    expect(second.documentId).toBe(first.documentId);
    expect(second.deduplicated).toBe(true);
    expect(store.documents.size).toBe(1);
  });
});

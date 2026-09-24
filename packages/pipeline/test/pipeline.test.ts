import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  UnscannedDocumentError,
  type ScanVerdict,
} from '@recouple/ingest';
import {
  buildExtractionResult,
  type Classifier,
  type ClassificationResult,
  type DocType,
  type DocumentPayload,
  type Extractor,
  type ExtractionResult,
} from '@recouple/extraction';
import {
  WALMART_CODE_24,
  allFixtureDocuments,
  expectedExtraction,
  type FixtureDocument,
} from '@recouple/fixtures';
import { CaseMergedAwayError } from '../src/ports';
import {
  CaseNotFoundError,
  DuplicateCaseError,
  RejectedUploadError,
  classifyDocument,
  ingestDocument,
  processUpload,
  reconcileCase,
} from '../src/steps';
import type { PipelineDeps } from '../src/ports';
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
 * The fixture readers key on the filename, which a document that arrived as an
 * email body does not have. It stands in for the Walmart notice, whose text it
 * carries: the point of those tests is the path a body takes, not the reading.
 */
function fixtureForPayload(document: DocumentPayload): FixtureDocument {
  if (document.mimeType === 'text/plain') return fixtureFor('walmart-apdp-notice.pdf');
  return fixtureFor(document.filename);
}

/**
 * Deterministic stand-ins for the reader models: they return exactly what a
 * perfect extraction would be. These test the pipeline's behaviour, not the
 * model's accuracy — that is what the eval suite and its cassettes are for.
 */
class FixtureClassifier implements Classifier {
  calls = 0;
  async classify(document: DocumentPayload): Promise<ClassificationResult> {
    this.calls += 1;
    const fixture = fixtureForPayload(document);
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
  calls = 0;
  async extract(document: DocumentPayload, docType: DocType): Promise<ExtractionResult> {
    this.calls += 1;
    const fixture = fixtureForPayload(document);
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

/**
 * A fixture extractor with one field overridden, for the cases that are about
 * what the pipeline does with a value rather than about the corpus.
 */
class PatchedExtractor extends FixtureExtractor {
  constructor(private readonly patch: Record<string, unknown>) {
    super();
  }
  override async extract(document: DocumentPayload, docType: DocType): Promise<ExtractionResult> {
    const fixture = fixtureForPayload(document);
    return buildExtractionResult({
      docType,
      extractor: this.name,
      document: { ...(expectedExtraction(fixture) as object), ...this.patch },
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

function harness(scanner: PipelineDeps['scanner'] = new AlwaysCleanScanner()) {
  const store = new InMemoryStore();
  const classifier = new FixtureClassifier();
  const extractor = new FixtureExtractor();
  const deps: PipelineDeps = { store, scanner, classifier, extractor, now: () => new Date(0) };
  return { store, classifier, extractor, deps };
}

const upload = (fixture: FixtureDocument) => ({
  orgId: 'org-1',
  filename: fixture.filename,
  bytes: fixture.bytes,
  source: 'web_upload' as const,
  pageText: fixture.pageText,
});

describe('a notice becomes a case', () => {
  it('ingests, classifies, extracts and opens the case', async () => {
    const { store, deps } = harness();
    const notice = fixtureFor('walmart-apdp-notice.pdf');

    const result = await processUpload(upload(notice), deps);

    expect(result.classification?.docType).toBe('deduction_notice');
    expect(result.case?.state).toBe('classified');
    expect(result.case?.claimId).toBe('APDP-99812');
    expect(result.case?.retailerName).toBe('Walmart');
    // The amount is the number the whole case is about: what the retailer took.
    // A case that does not carry it cannot be prioritised, costed or billed.
    expect(result.case?.deductionAmountCents).toBe(312_000);
    expect(result.extraction?.fields.length).toBeGreaterThan(10);

    // Every extracted field was checked against the page it cites.
    expect(result.extraction?.fields.every((f) => f.quoteVerified === true)).toBe(true);

    expect(store.events.map((e) => e.eventType)).toEqual(['case.discovered', 'case.classified']);
    expect(store.extractions).toHaveLength(1);
    expect(store.modelCalls.map((c) => c.purpose)).toEqual(['classify', 'extract']);
    expect(store.totalCostMicros()).toBe(14_000);
  });

  it('parses the printed dates onto the case, month-first', async () => {
    const { store, deps } = harness();
    const result = await processUpload(upload(fixtureFor('walmart-apdp-notice.pdf')), deps);

    // The notice prints 08/14/2026 and 11/12/2026 and says 90 days; read
    // month-first those are 90 days apart, which is why there is no day-first
    // fallback (ADR 0019 §6).
    expect(result.case?.deductionDate).toBe('2026-08-14');
    expect(result.case?.disputeDeadline).toBe('2026-11-12');

    const discovered = store.events.find((e) => e.eventType === 'case.discovered');
    expect(discovered?.payload.deduction_date).toBe('2026-08-14');
    expect(discovered?.payload.dispute_deadline).toBe('2026-11-12');
    // Null, not absent: the projection has to be rebuildable from the events.
    expect(discovered?.payload.debtor_id).toBeNull();
  });

  it('opens the case anyway when a deadline is a retailer rule, and says why', async () => {
    // "60 days of deduction date" is a window a playbook computes in Phase 2,
    // not a date. Losing the case over it would be worse; losing it silently
    // would be worse still.
    const { store, deps } = harness();
    const result = await processUpload(upload(fixtureFor('walmart-apdp-notice.pdf')), {
      ...deps,
      extractor: new PatchedExtractor({
        dispute_deadline: {
          value: '60 days of deduction date',
          confidence: 0.9,
          source_page: 1,
          source_quote: 'Dispute Deadline: 11/12/2026',
        },
      }),
    });

    expect(result.case?.deductionId).toBeTruthy();
    expect(result.case?.disputeDeadline).toBeUndefined();

    const discovered = store.events.find((e) => e.eventType === 'case.discovered');
    expect(discovered?.payload.dispute_deadline).toBeNull();
    expect(discovered?.payload.dispute_deadline_unread).toMatch(/60 days of deduction date/);
    // The date that *did* read is unaffected.
    expect(discovered?.payload.deduction_date).toBe('2026-08-14');
  });

  it('resolves a debtor only when exactly one of the tenant’s debtors matches', async () => {
    const { store, deps } = harness();
    store.debtors.push({ debtorId: 'debtor-walmart', names: ['Walmart (APDP)', 'Walmart'] });

    const result = await processUpload(upload(fixtureFor('walmart-apdp-notice.pdf')), deps);
    expect(result.case?.debtorId).toBe('debtor-walmart');
    expect(store.events.find((e) => e.eventType === 'case.discovered')?.payload.debtor_id).toBe(
      'debtor-walmart',
    );
  });

  it('never invents a debtor for a name nobody has claimed', async () => {
    const { store, deps } = harness();
    store.debtors.push({ debtorId: 'debtor-kehe', names: ['KeHE'] });

    const result = await processUpload(upload(fixtureFor('walmart-apdp-notice.pdf')), deps);
    expect(result.case?.debtorId).toBeUndefined();
    // The name still reaches the case; it is display, not identity.
    expect(result.case?.retailerName).toBe('Walmart');
    expect(store.debtors).toHaveLength(1);
  });

  it('reads a blank retailer name as a notice that named nobody', async () => {
    // A whitespace reading is absence, not a value. Stored as one it becomes a
    // blank cell on the case list, which says the notice named a retailer whose
    // name is nothing — and it is not unreadable either, so nothing is reported.
    const { store, deps } = harness();
    const result = await processUpload(upload(fixtureFor('walmart-apdp-notice.pdf')), {
      ...deps,
      extractor: new PatchedExtractor({
        retailer_name: {
          value: '   ',
          confidence: 0.4,
          source_page: 1,
          source_quote: 'WALMART STORES, INC.',
        },
      }),
    });

    expect(result.case?.deductionId).toBeTruthy();
    expect(result.case?.retailerName).toBeUndefined();
    const discovered = store.events.find((e) => e.eventType === 'case.discovered');
    expect(discovered?.payload.retailer_name).toBeNull();
    expect(discovered?.payload.retailer_name_unread).toBeUndefined();
  });

  it('trims the padding a layout put around a name', async () => {
    const { deps } = harness();
    const result = await processUpload(upload(fixtureFor('walmart-apdp-notice.pdf')), {
      ...deps,
      extractor: new PatchedExtractor({
        retailer_name: {
          value: '  Walmart  ',
          confidence: 0.98,
          source_page: 1,
          source_quote: 'WALMART STORES, INC.',
        },
      }),
    });
    expect(result.case?.retailerName).toBe('Walmart');
  });

  it('refuses a retailer name longer than a case can hold, and never truncates it', async () => {
    // The column is capped at 500 characters (migration 0015), so a reading that
    // swallowed a paragraph used to come back as a raw constraint violation out
    // of the store. Truncating it would be worse than refusing it: half a name
    // is not what the page said, and it would go on to select a debtor the page
    // never named.
    const { store, deps } = harness();
    const swallowedParagraph = 'Walmart Stores of the United States, '.repeat(20).trim();
    expect(swallowedParagraph.length).toBeGreaterThan(500);

    const result = await processUpload(upload(fixtureFor('walmart-apdp-notice.pdf')), {
      ...deps,
      extractor: new PatchedExtractor({
        retailer_name: {
          value: swallowedParagraph,
          confidence: 0.6,
          source_page: 1,
          source_quote: 'WALMART STORES, INC.',
        },
      }),
    });

    // Better a case with no retailer than no case — the same rule the dates get.
    expect(result.case?.deductionId).toBeTruthy();
    expect(result.case?.retailerName).toBeUndefined();

    const discovered = store.events.find((e) => e.eventType === 'case.discovered');
    expect(discovered?.payload.retailer_name).toBeNull();
    expect(discovered?.payload.retailer_name_unread).toMatch(/longer than the 500/);
    // Nothing shortened was stored anywhere on the way past.
    expect([...store.cases.values()].every((c) => c.retailerName === undefined)).toBe(true);
  });

  it('names the existing case when the same claim arrives twice for one debtor', async () => {
    // The in-memory store models `unique (org_id, debtor_id, claim_id)` the way
    // Postgres applies it, nulls and all, so the duplicate path is the same
    // answer here and there rather than a behaviour only the database has.
    const { store, deps } = harness();
    store.debtors.push({ debtorId: 'debtor-walmart', names: ['Walmart'] });
    const notice = fixtureFor('walmart-apdp-notice.pdf');

    const first = await processUpload(upload(notice), deps);
    expect(first.case?.debtorId).toBe('debtor-walmart');

    // A scan of the same notice: different bytes, so the hash does not dedupe
    // it, and it is read before the store can say the claim is already a case.
    const rescan = { ...upload(notice), bytes: new Uint8Array([...notice.bytes, 0x0a]) };
    const again = processUpload(rescan, deps);
    await expect(again).rejects.toThrow(DuplicateCaseError);
    await expect(again).rejects.toMatchObject({
      existingDeductionId: first.case?.deductionId,
      claimId: 'APDP-99812',
    });

    expect(store.cases.size).toBe(1);
  });

  it('records what the read cost even when the case cannot be opened', async () => {
    // The document was read, and reading it spent money and produced fields we
    // can check against the page. `openCase` failing afterwards is a fact about
    // the case, not about the read: losing the model call would understate spend
    // and losing the extraction would throw away a page we paid for.
    const { store, deps } = harness();
    store.debtors.push({ debtorId: 'debtor-walmart', names: ['Walmart'] });
    const notice = fixtureFor('walmart-apdp-notice.pdf');

    await processUpload(upload(notice), deps);
    const afterFirst = store.totalCostMicros();
    expect(afterFirst).toBe(14_000);

    const rescan = { ...upload(notice), bytes: new Uint8Array([...notice.bytes, 0x0a]) };
    await expect(processUpload(rescan, deps)).rejects.toThrow(DuplicateCaseError);

    expect(store.modelCalls.map((c) => c.purpose)).toEqual([
      'classify',
      'extract',
      'classify',
      'extract',
    ]);
    expect(store.totalCostMicros()).toBe(afterFirst * 2);
    expect(store.extractions).toHaveLength(2);
    expect(store.classifications).toHaveLength(2);
    // Recorded against no case, because there is no case they belong to: the
    // second reading is not evidence for the first one until a person says so.
    expect(store.modelCalls.slice(2).every((c) => c.deductionId === undefined)).toBe(true);
    expect(store.extractions[1]?.deductionId).toBeUndefined();
    // And the failure was not swallowed to make room for the recording.
    expect(store.cases.size).toBe(1);
  });

  it('walks the case through the state machine rather than assigning a state', async () => {
    const { store, deps } = harness();
    await processUpload(upload(fixtureFor('walmart-apdp-notice.pdf')), deps);
    const [record] = [...store.cases.values()];
    expect(record?.state).toBe('classified');
    // discovered → classified is a legal edge; nothing jumped ahead.
    expect(store.events.at(-1)?.eventType).toBe('case.classified');
  });

  it('attaches evidence to the case it was uploaded against', async () => {
    const { store, deps } = harness();
    const opened = await processUpload(upload(fixtureFor('walmart-apdp-notice.pdf')), deps);
    const deductionId = opened.case?.deductionId as string;

    for (const filename of ['walmart-po.pdf', 'harborline-invoice.pdf', 'carrier-bol.pdf']) {
      const result = await processUpload(upload(fixtureFor(filename)), deps, {
        attachToCase: deductionId,
      });
      expect(result.case?.deductionId).toBe(deductionId);
    }

    expect(await store.documentsForCase(deductionId)).toHaveLength(4);
    expect(store.events.filter((e) => e.eventType === 'evidence.uploaded')).toHaveLength(3);
    // One case, not four: evidence does not open cases of its own.
    expect(store.cases.size).toBe(1);
  });

  it('refuses a case it cannot resolve, before it reads or spends anything', async () => {
    // `getCase` answers `undefined` both for a case that does not exist and for
    // one belonging to another tenant — it must, or it would leak the second.
    // The pipeline used to read that as "no case was named": a notice would
    // open a *new* case, and evidence would be filed against nothing, and the
    // reviewer was told neither. Now it says so.
    const { store, classifier, extractor, deps } = harness();
    const stranger = '99999999-9999-9999-9999-999999999999';

    await expect(
      processUpload(upload(fixtureFor('walmart-po.pdf')), deps, { attachToCase: stranger }),
    ).rejects.toThrow(CaseNotFoundError);

    // Before anything was read, which is the part that costs money: not a
    // classify, not an extract, not a micro-dollar.
    expect(classifier.calls).toBe(0);
    expect(extractor.calls).toBe(0);
    expect(store.modelCalls).toHaveLength(0);
    expect(store.totalCostMicros()).toBe(0);
    // And before anything was stored, so a refused attachment leaves no trace.
    expect(store.documents.size).toBe(0);
    expect(store.cases.size).toBe(0);
    expect(store.extractions).toHaveLength(0);
  });

  it('refuses evidence for a case merged into another, before it reads or stores anything', async () => {
    // The database would refuse the link (ADR 0042 §9) — after the read had
    // been paid for, and on every retry. So it is refused here, at the same
    // point an unknown case is.
    const { store, classifier, deps } = harness();
    const opened = await processUpload(upload(fixtureFor('walmart-apdp-notice.pdf')), deps);
    const deductionId = opened.case?.deductionId as string;
    await store.transitionCase(deductionId, 'merged');
    const documentsBefore = store.documents.size;
    const classifyCalls = classifier.calls;

    await expect(
      processUpload(upload(fixtureFor('walmart-po.pdf')), deps, { attachToCase: deductionId }),
    ).rejects.toBeInstanceOf(CaseMergedAwayError);

    expect(classifier.calls).toBe(classifyCalls);
    expect(store.documents.size).toBe(documentsBefore);
  });

  it('does not open a second case when the notice names a case it cannot see', async () => {
    // The worst version of the old behaviour: a *notice* attached to an
    // unresolvable case fell through to `openCaseFromNotice` and opened one, so
    // a typo in a case id silently created a case instead of failing.
    const { store, deps } = harness();

    await expect(
      processUpload(upload(fixtureFor('walmart-apdp-notice.pdf')), deps, {
        attachToCase: '99999999-9999-9999-9999-999999999999',
      }),
    ).rejects.toThrow(CaseNotFoundError);

    expect(store.cases.size).toBe(0);
  });

  it('reconciles the whole case once its evidence is in', async () => {
    const { deps } = harness();
    const opened = await processUpload(upload(fixtureFor('walmart-apdp-notice.pdf')), deps);
    const deductionId = opened.case?.deductionId as string;
    for (const filename of ['walmart-po.pdf', 'harborline-invoice.pdf', 'carrier-bol.pdf']) {
      await processUpload(upload(fixtureFor(filename)), deps, { attachToCase: deductionId });
    }

    const reconciliation = await reconcileCase(deductionId, deps);
    expect(reconciliation?.lines[0]?.verdict).toBe('matches');
    expect(reconciliation?.claimedTotalCents).toBe(312_000);
    expect(reconciliation?.findings.map((f) => f.code)).toContain('delivery_confirms_shortage');
    expect(reconciliation?.internallyConsistent).toBe(true);
    expect(WALMART_CODE_24.key).toBe('walmart-code-24-shortage');
  });

  it('has nothing to reconcile before a notice arrives', async () => {
    const { store, deps } = harness();
    const empty = await store.openCase({ orgId: 'org-1' });
    expect(await reconcileCase(empty.deductionId, deps)).toBeUndefined();
  });
});

describe('the same file twice', () => {
  it('dedupes on content hash instead of storing it again', async () => {
    const { store, deps } = harness();
    const notice = fixtureFor('walmart-apdp-notice.pdf');

    const first = await ingestDocument(upload(notice), deps);
    const second = await ingestDocument(upload(notice), deps);

    expect(second.deduplicated).toBe(true);
    expect(second.document.documentId).toBe(first.document.documentId);
    expect(store.documents.size).toBe(1);
  });
});

describe('nothing unclean reaches a model', () => {
  it('stops an infected file before classification', async () => {
    const { store, classifier, extractor, deps } = harness(new AlwaysInfectedScanner());

    const result = await processUpload(upload(fixtureFor('walmart-apdp-notice.pdf')), deps);

    expect(result.haltedBecause).toMatch(/not scanned clean: infected/);
    expect(result.classification).toBeUndefined();
    expect(result.extraction).toBeUndefined();
    // The gate is only real if the model was never called.
    expect(classifier.calls).toBe(0);
    expect(extractor.calls).toBe(0);
    expect(store.modelCalls).toHaveLength(0);
    expect(store.cases.size).toBe(0);
  });

  it('stops a file whose scan errored — an error is not a pass', async () => {
    const erroring = {
      name: 'broken',
      async scan(): Promise<ScanVerdict> {
        return { status: 'error', scanner: 'broken', detail: 'clamd unreachable' };
      },
    };
    const { classifier, deps } = harness(erroring);
    const result = await processUpload(upload(fixtureFor('kehe-ksolve-notice.pdf')), deps);
    expect(result.haltedBecause).toMatch(/not scanned clean: error/);
    // Why it errored, not only that it did: "clamd unreachable" and "no scanner
    // is configured" are the same status and want different people to fix them.
    expect(result.haltedBecause).toMatch(/clamd unreachable/);
    expect(classifier.calls).toBe(0);
  });

  it('refuses to read a stored document that was never scanned at all', async () => {
    const { store, classifier, deps } = harness();
    const notice = fixtureFor('walmart-apdp-notice.pdf');
    // Straight into the store, bypassing ingest: the gate still holds.
    const stored = await store.putDocument({
      orgId: 'org-1',
      sha256: 'deadbeef',
      filename: notice.filename,
      mimeType: 'application/pdf',
      byteSize: notice.bytes.length,
      bytes: notice.bytes,
      requiresSplit: false,
    });

    await expect(classifyDocument(stored, deps)).rejects.toThrow(UnscannedDocumentError);
    expect(classifier.calls).toBe(0);
  });
});

describe('what the front door refuses', () => {
  it('rejects a file type we do not accept, and stores nothing', async () => {
    const { store, deps } = harness();
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    await expect(
      processUpload({ ...upload(fixtureFor('walmart-po.pdf')), bytes: zip, filename: 'a.zip' }, deps),
    ).rejects.toThrow(RejectedUploadError);
    expect(store.documents.size).toBe(0);
  });
});

/**
 * A typed document filed against a case, without a fixture behind it.
 *
 * Correspondence and delivery records have no authored fixture with an expected
 * extraction, and these tests are about what `reconcileCase` does with the rows
 * rather than about reading a page. The rows themselves are real: the document
 * goes through `buildExtractionResult`, which is the same `flattenExtraction`
 * the pipeline writes with, so a field with no provenance is dropped here
 * exactly as it would be in production.
 */
async function fileDocument(
  store: InMemoryStore,
  deductionId: string,
  docType: DocType,
  document: unknown,
): Promise<string> {
  const stored = await store.putDocument({
    orgId: 'org-1',
    sha256: `sha-${docType}-${randomUUID()}`,
    filename: `${docType}.pdf`,
    mimeType: 'application/pdf',
    byteSize: 1,
    bytes: new Uint8Array([0x25]),
    requiresSplit: false,
  });
  await store.recordClassification(stored.documentId, docType, 0.99);
  const built = buildExtractionResult({
    docType,
    extractor: 'test',
    document,
    pageText: undefined,
    call: {
      purpose: 'extract',
      provider: 'anthropic',
      modelVersion: 'fixture',
      documentId: stored.documentId,
      costMicros: 0,
      latencyMs: 0,
      outcome: 'ok',
    },
  });
  await store.recordExtraction({
    documentId: stored.documentId,
    deductionId,
    docType,
    extractor: built.extractor,
    schemaVersion: built.schemaVersion,
    fields: built.fields,
    document,
  });
  await store.linkDocument(deductionId, stored.documentId, 'evidence');
  return stored.documentId;
}

const field = <T>(value: T, quote: string) => ({
  value,
  confidence: 0.95,
  source_page: 1,
  source_quote: quote,
});
const noField = () => ({ value: null, confidence: 0, source_page: 1, source_quote: '' });
/** A value the reader had and could not point at: no page, no quote, no row. */
const unquoted = <T>(value: T) => ({ value, confidence: 0.9, source_page: 0, source_quote: '' });

/**
 * One unreadable field used to cost a case every line it had.
 *
 * `flattenExtraction` writes no row for a value with no page or no quote, the
 * rebuild has nothing to put back, `DeductionNoticeSchema` then rejects the
 * document, and `reconcileCase` answered the whole case with no lines, no
 * totals and a blocking finding. On a scan — where one smudged date is
 * ordinary — that is the difference between a reviewable case and a dead page.
 */
describe('a notice with a field stored without provenance', () => {
  const noticeFixture = () => fixtureFor('walmart-apdp-notice.pdf');

  it('says so at the write, and opens the case anyway', async () => {
    const { store, deps } = harness();
    const result = await processUpload(upload(noticeFixture()), {
      ...deps,
      extractor: new PatchedExtractor({ deduction_date: unquoted('08/14/2026') }),
    });

    // The case exists, with everything else the notice said on it.
    expect(result.case?.claimId).toBe('APDP-99812');
    expect(result.case?.deductionAmountCents).toBe(312_000);

    // And the divergence is recorded where it was created, naming the field.
    const said = store.events.find((e) => e.eventType === 'document.stored_without_provenance');
    expect(said?.payload.fields).toEqual(['deduction_date']);
    expect(said?.payload.document_id).toBe(result.ingest.document.documentId);
    expect(said?.deductionId).toBe(result.case?.deductionId);
    // The event carries ids and field paths, never anything off the page.
    expect(JSON.stringify(said?.payload)).not.toContain('08/14/2026');
  });

  it('says nothing when every field kept its provenance', async () => {
    const { store, deps } = harness();
    await processUpload(upload(noticeFixture()), deps);
    expect(store.events.map((e) => e.eventType)).toEqual(['case.discovered', 'case.classified']);
  });

  it('is still reconciled, with a warning that names the field', async () => {
    const { store, deps } = harness();
    const patched = {
      ...deps,
      extractor: new PatchedExtractor({ deduction_date: unquoted('08/14/2026') }),
    };
    const opened = await processUpload(upload(noticeFixture()), patched);
    const deductionId = opened.case?.deductionId as string;
    for (const filename of ['walmart-po.pdf', 'harborline-invoice.pdf', 'carrier-bol.pdf']) {
      await processUpload(upload(fixtureFor(filename)), patched, { attachToCase: deductionId });
    }

    const reconciliation = await reconcileCase(deductionId, deps);

    // The real reconciliation, not an empty one: the lines, the totals and the
    // three-way match are all still there.
    expect(reconciliation?.lines[0]?.verdict).toBe('matches');
    expect(reconciliation?.claimedTotalCents).toBe(312_000);
    expect(reconciliation?.findings.map((f) => f.code)).toContain('delivery_confirms_shortage');

    const said = reconciliation?.findings.find((f) => f.code === 'stored_document_not_typed');
    expect(said?.severity).toBe('warning');
    expect(said?.message).toContain('deduction_date');
    // A date we could not read does not stop the claim adding up.
    expect(reconciliation?.internallyConsistent).toBe(true);
    expect(store.extractions).not.toHaveLength(0);
  });

  it('stays blocking when the field that was lost is money', async () => {
    const { store, deps } = harness();
    const notice = noticeFixture();
    const lines = (expectedExtraction(notice) as { lines: Record<string, unknown>[] }).lines;
    const patched = {
      ...deps,
      extractor: new PatchedExtractor({
        lines: lines.map((line, index) =>
          index === 0 ? { ...line, deduction_amount: unquoted('$3,120.00') } : line,
        ),
      }),
    };
    const opened = await processUpload(upload(notice), patched);
    const deductionId = opened.case?.deductionId as string;

    const reconciliation = await reconcileCase(deductionId, deps);

    const said = reconciliation?.findings.find((f) => f.code === 'stored_document_not_typed');
    expect(said?.severity).toBe('blocking');
    expect(said?.message).toContain('lines[0].deduction_amount');
    // The write named the same field the same way, so the event on the case and
    // the finding on the page are recognisably about one thing.
    expect(
      store.events.find((e) => e.eventType === 'document.stored_without_provenance')?.payload
        .fields,
    ).toEqual(['lines[0].deduction_amount']);
    // The sum of the lines has a hole in it, so the claim cannot be said to add
    // up — which is what blocking means here.
    expect(reconciliation?.internallyConsistent).toBe(false);
    expect(reconciliation?.lineSumCents).toBeNull();
    // And the notice is still reconciled rather than refused: the total the
    // page printed is on the finding list for a reviewer to work from.
    expect(reconciliation?.claimedTotalCents).toBe(312_000);
    expect(reconciliation?.lines).toHaveLength(lines.length);
  });

  it('still refuses a stored notice that is wrong in some other way', async () => {
    // The narrowing has a floor. A document whose shape we do not understand —
    // not a value that is missing, a value that is the wrong kind — is not
    // reconciled as though we did.
    const { store, deps } = harness();
    const opened = await processUpload(upload(noticeFixture()), deps);
    const deductionId = opened.case?.deductionId as string;
    const documentId = (await store.documentsForCase(deductionId))[0]?.documentId as string;
    await store.recordExtraction({
      documentId,
      deductionId,
      docType: 'deduction_notice',
      extractor: 'test',
      schemaVersion: '1.1.0',
      fields: [
        {
          fieldPath: 'lines',
          value: 'not an array of lines',
          confidence: 1,
          sourcePage: 1,
          sourceQuote: 'nowhere',
          sourceBbox: null,
          quoteVerified: null,
        },
      ],
      document: {},
    });

    const reconciliation = await reconcileCase(deductionId, deps);
    expect(reconciliation?.lines).toEqual([]);
    expect(reconciliation?.internallyConsistent).toBe(false);
    expect(reconciliation?.findings[0]?.code).toBe('stored_document_not_typed');
    expect(reconciliation?.findings[0]?.severity).toBe('blocking');
    // Not a path into a document: what is unusable is the document.
    expect(reconciliation?.findings[0]?.fieldPath).toBeUndefined();
  });
});

/**
 * The freight case's own shape: a delivery record and the message that moved
 * the appointment it was measured against.
 *
 * This is LOG-001 (`packages/fixtures/src/logistics.ts`) reduced to what
 * `reconcileCase` sees — gate check-in 13:42 against a 14:00 appointment, and a
 * customer message approving revision 2 and saying no late charge applies.
 * Every one of those findings existed and none of them could be reached,
 * because `reconcileCase` never passed a `correspondence` document to
 * `reconcileNotice`.
 */
describe('a case whose evidence is a message', () => {
  const pod = {
    document_number: field('POD-771', 'POD-771'),
    ship_date: field('August 13, 2026', 'August 13, 2026'),
    carrier_name: field('Atlas Freight Systems', 'Atlas Freight Systems'),
    po_number: field('PO-BSC-8841', 'PO-BSC-8841'),
    ship_from: noField(),
    ship_to: noField(),
    appointment_at: field(
      'August 13, 2026, 2:00 PM Eastern',
      'Appointment: August 13, 2026, 2:00 PM Eastern',
    ),
    gate_check_in_at: field(
      'August 13, 2026, 1:42 PM Eastern',
      'Gate check-in: August 13, 2026, 1:42 PM Eastern',
    ),
    appointment_reference: field('AP-BSC-771 revision 2', 'AP-BSC-771 revision 2'),
    total_cartons_shipped: noField(),
    total_cartons_received: noField(),
    signed_by: field('R. Alvarez', 'R. Alvarez'),
    signature_present: field(true, 'Signed: R. Alvarez'),
    lines: [],
  };

  const message = {
    message_reference: field('MSG-BSC-0811-338', 'MSG-BSC-0811-338'),
    sent_at: field('August 11, 2026, 4:12 PM Eastern', 'August 11, 2026, 4:12 PM Eastern'),
    sender: field('operations@brookfieldsupply.test', 'operations@brookfieldsupply.test'),
    sender_organisation: field('Brookfield Supply Co.', 'Brookfield Supply Co.'),
    recipient: noField(),
    subject: field('Appointment change', 'Subject: Appointment change'),
    references: [],
    commitments: [
      {
        commitment_text: field(
          'AP-BSC-771 revision 2 replaces revision 1; no late charge will apply.',
          'AP-BSC-771 revision 2 replaces revision 1; no late charge will apply.',
        ),
        effective_at: field('August 13, 2026, 2:00 PM Eastern', 'August 13, 2026, 2:00 PM Eastern'),
        supersedes: field('revision 1', 'replaces revision 1'),
        establishes: field('AP-BSC-771 revision 2', 'AP-BSC-771 revision 2'),
        waives_charge: field(true, 'no late charge will apply'),
        attributed_to: field('customer-requested', 'customer-requested'),
      },
    ],
  };

  it('reaches the findings the message is on the case for', async () => {
    const { store, deps } = harness();
    const opened = await processUpload(upload(fixtureFor('walmart-apdp-notice.pdf')), deps);
    const deductionId = opened.case?.deductionId as string;
    await fileDocument(store, deductionId, 'pod', pod);
    await fileDocument(store, deductionId, 'correspondence', message);

    const codes = (await reconcileCase(deductionId, deps))?.findings.map((f) => f.code);

    expect(codes).toContain('appointment_superseded');
    expect(codes).toContain('charge_waived_in_writing');
    expect(codes).toContain('arrived_before_appointment');
  });

  it('reports an unusable pod even when a bol answered first', async () => {
    // `bol ?? pod` never asked the pod when the bol parsed, so a delivery
    // record on the case that could not be read back went unmentioned.
    const { store, deps } = harness();
    const opened = await processUpload(upload(fixtureFor('walmart-apdp-notice.pdf')), deps);
    const deductionId = opened.case?.deductionId as string;
    await processUpload(upload(fixtureFor('carrier-bol.pdf')), deps, {
      attachToCase: deductionId,
    });
    // A pod whose required `document_number` was stored without provenance: no
    // row, so it comes back absent and the document is no longer a shipment.
    await fileDocument(store, deductionId, 'pod', {
      ...pod,
      document_number: unquoted('POD-771'),
    });

    const reconciliation = await reconcileCase(deductionId, deps);
    const said = reconciliation?.findings.filter((f) => f.code === 'stored_document_not_typed');

    expect(said).toHaveLength(1);
    expect(said?.[0]?.severity).toBe('warning');
    expect(said?.[0]?.message).toContain('pod');
    // The bol still did its job: the case is not held up by the pod.
    expect(reconciliation?.findings.map((f) => f.code)).toContain('delivery_confirms_shortage');
  });

  it('reports an unusable correspondence rather than dropping it', async () => {
    const { store, deps } = harness();
    const opened = await processUpload(upload(fixtureFor('walmart-apdp-notice.pdf')), deps);
    const deductionId = opened.case?.deductionId as string;
    await fileDocument(store, deductionId, 'pod', pod);
    await fileDocument(store, deductionId, 'correspondence', {
      ...message,
      message_reference: unquoted('MSG-BSC-0811-338'),
    });

    const reconciliation = await reconcileCase(deductionId, deps);
    const said = reconciliation?.findings.find((f) => f.code === 'stored_document_not_typed');

    expect(said?.severity).toBe('warning');
    expect(said?.message).toContain('correspondence');
    expect(reconciliation?.findings.map((f) => f.code)).not.toContain('appointment_superseded');
  });
});

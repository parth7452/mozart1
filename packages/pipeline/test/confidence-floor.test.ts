/**
 * A doubtful classification is held for a person (ADR 0044).
 *
 * A notice or a remittance opens its case(s) on its own only when the
 * classifier is at or above the tenant's floor and the reading fits the type it
 * was read as. Otherwise the read is recorded exactly as any other, an
 * `audit_log` row says why no case came of it, every later delivery is answered
 * from that record for free, and a person can open the case from the recorded
 * reading without anything being read again.
 *
 * The last block replays every recorded notice and remittance through the real
 * `processUpload`: the two the corpus has below the floor are held, and every
 * other one opens its case(s) as before.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildExtractionResult,
  CassetteClassifier,
  CassetteExtractor,
  type Cassette,
  type ClassificationResult,
  type Classifier,
  type DocType,
  type DocumentPayload,
  type ExtractionResult,
  type Extractor,
} from '@recouple/extraction';
import {
  everyDocument,
  expectedExtraction,
  type FixtureDocument,
} from '@recouple/fixtures';
import { WrongRoleError, type PipelineDeps } from '../src/ports';
import {
  processUpload,
  readDocument,
  recordedRead,
  type IngestInput,
} from '../src/steps';
import { DocumentNotFoundError, ingestForJob, readDocumentJob, type JobDeps } from '../src/jobs';
import {
  DOCUMENT_HELD,
  DOCUMENT_HOLD_RELEASED,
  HELD_FOR_REVIEW,
  holdFor,
  typeFits,
} from '../src/hold';
import {
  DocumentAlreadyOnCaseError,
  DocumentBusyError,
  DocumentNotHeldError,
  HeldReadingUnusableError,
  openHeldDocument,
} from '../src/open-held';
import { AlwaysCleanScanner, InMemoryStore } from '../src/testing/memory-store';
import type { StoredDocument } from '../src/ports';

const ORG = 'org-1';
const USER = 'user-7';

const cassetteDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'cassettes',
);

function cassette(key: string): Cassette {
  return JSON.parse(readFileSync(path.join(cassetteDir, `${key}.json`), 'utf8')) as Cassette;
}

function fixture(key: string): FixtureDocument {
  const found = everyDocument().find((d) => d.key === key);
  if (found === undefined) throw new Error(`no fixture ${key}`);
  return found;
}

/** The in-memory store, plus a document by id, which a job owes itself. */
class FloorStore extends InMemoryStore {
  floorCalls = 0;
  override async classificationFloor(): Promise<number> {
    this.floorCalls += 1;
    return super.classificationFloor();
  }
  async getDocument(documentId: string): Promise<StoredDocument | undefined> {
    return this.documents.get(documentId);
  }
}

/**
 * What the reader "said" about each document, by filename: the type, the
 * confidence, and the reading. Counted, so a test can say no model was asked.
 */
interface Reading {
  readonly docType: DocType;
  readonly confidence: number;
  readonly document: unknown;
  readonly validated?: boolean;
}

class ScriptedClassifier implements Classifier {
  calls = 0;
  constructor(private readonly readings: ReadonlyMap<string, Reading>) {}
  async classify(document: DocumentPayload): Promise<ClassificationResult> {
    this.calls += 1;
    const reading = this.readings.get(document.filename);
    if (reading === undefined) throw new Error(`no reading scripted for ${document.filename}`);
    return {
      docType: reading.docType,
      confidence: reading.confidence,
      call: {
        purpose: 'classify',
        provider: 'anthropic',
        modelVersion: 'scripted',
        documentId: document.documentId,
        costMicros: 1_300,
        latencyMs: 1,
        outcome: 'ok',
      },
    };
  }
}

class ScriptedExtractor implements Extractor {
  readonly name = 'scripted';
  calls = 0;
  constructor(private readonly readings: ReadonlyMap<string, Reading>) {}
  async extract(document: DocumentPayload, docType: DocType): Promise<ExtractionResult> {
    this.calls += 1;
    const reading = this.readings.get(document.filename);
    if (reading === undefined) throw new Error(`no reading scripted for ${document.filename}`);
    return buildExtractionResult({
      docType,
      extractor: this.name,
      document: reading.document,
      pageText: document.pageText,
      ...(reading.validated !== undefined ? { validated: reading.validated } : {}),
      call: {
        purpose: 'extract',
        provider: 'anthropic',
        modelVersion: 'scripted',
        documentId: document.documentId,
        costMicros: 12_700,
        latencyMs: 1,
        outcome: 'ok',
      },
    });
  }
}

function harness(readings: Readonly<Record<string, Reading>>) {
  const map = new Map(Object.entries(readings));
  const store = new FloorStore();
  store.addMember(ORG, USER, 'analyst');
  const classifier = new ScriptedClassifier(map);
  const extractor = new ScriptedExtractor(map);
  const deps: JobDeps = {
    store,
    scanner: new AlwaysCleanScanner(),
    classifier,
    extractor,
    now: () => new Date('2026-09-23T12:00:00Z'),
  };
  return { store, classifier, extractor, deps };
}

function upload(document: FixtureDocument, pageText?: readonly string[]): IngestInput {
  return {
    orgId: ORG,
    filename: document.filename,
    bytes: document.bytes,
    source: document.mimeType === 'text/plain' ? 'email_body' : 'web_upload',
    uploadedBy: USER,
    pageText: pageText ?? document.pageText,
  };
}

const NOTICE = fixture('walmart-apdp-notice');
const NOTICE_READING = expectedExtraction(NOTICE);
const BOL = fixture('carrier-bol');
const REMITTANCE = fixture('hl-case-01-remittance');
const REMITTANCE_READING = cassette('hl-case-01-remittance').document;

function notice(confidence: number, extra: Partial<Reading> = {}): Record<string, Reading> {
  return {
    [NOTICE.filename]: {
      docType: 'deduction_notice',
      confidence,
      document: NOTICE_READING,
      ...extra,
    },
  };
}

/** The notice's reading with one field read as nothing — a notice that does not fit its type. */
function noticeWithout(field: string): unknown {
  const reading = NOTICE_READING as Record<string, unknown>;
  return {
    ...reading,
    [field]: { value: null, confidence: 0, source_page: 1, source_quote: '' },
  };
}

function noticeWithoutClaim(): unknown {
  return noticeWithout('claim_id');
}

/**
 * The notice's reading with its deduction date read, but with no quote to
 * point at. It validates as read — the value is there — and `flattenExtraction`
 * writes no row for it, so the reading that comes back out of the store has
 * lost a required field: the provenance gap `document.stored_without_provenance`
 * exists to name.
 */
function noticeWithUnquotedDate(): unknown {
  const reading = NOTICE_READING as Record<string, Record<string, unknown>>;
  return {
    ...reading,
    deduction_date: { ...reading.deduction_date, source_quote: '' },
  };
}

function holds(store: InMemoryStore) {
  return store.auditLog.filter((row) => row.action === DOCUMENT_HELD);
}

describe('the gate, where a notice or a remittance would open its case(s)', () => {
  it('holds a notice read below the floor: read and recorded, on no case, and said once', async () => {
    const { store, deps } = harness(notice(0.9));

    const result = await processUpload(upload(NOTICE), deps);

    expect(result.case).toBeUndefined();
    expect(result.haltedBecause).toBe(HELD_FOR_REVIEW);
    expect(result.held).toMatchObject({
      docType: 'deduction_notice',
      confidence: 0.9,
      floor: 0.95,
      reason: 'below_floor',
    });
    expect(result.held?.fields).toBeUndefined();
    expect(store.cases.size).toBe(0);
    expect(store.links).toEqual([]);
    expect(store.identifiers).toEqual([]);

    // The read is recorded as any other, against no case: the spend, the
    // classification and the extraction.
    expect(store.classifications).toEqual([
      { documentId: result.ingest.document.documentId, docType: 'deduction_notice', confidence: 0.9 },
    ]);
    expect(store.extractions).toHaveLength(1);
    expect(store.extractions[0]?.deductionId).toBeUndefined();
    expect(store.modelCalls.map((c) => c.purpose).sort()).toEqual(['classify', 'extract']);
    expect(store.modelCalls.every((c) => c.deductionId === undefined)).toBe(true);

    // One hold, naming the document, in closed-set words and numbers only.
    expect(holds(store)).toHaveLength(1);
    expect(holds(store)[0]).toMatchObject({
      orgId: ORG,
      subjectTable: 'documents',
      subjectId: result.ingest.document.documentId,
      payload: { doc_type: 'deduction_notice', confidence: 0.9, floor: 0.95, reason: 'below_floor' },
    });
    const said = JSON.stringify(holds(store)[0]?.payload);
    expect(said).not.toContain('APDP');
    expect(said).not.toContain(NOTICE.filename);
  });

  it('opens the case at exactly the floor, and holds it once the tenant raises the floor', async () => {
    const atFloor = harness(notice(0.95));
    const opened = await processUpload(upload(NOTICE), atFloor.deps);
    expect(opened.case?.state).toBe('classified');
    expect(opened.held).toBeUndefined();
    expect(opened.haltedBecause).toBeUndefined();
    expect(holds(atFloor.store)).toEqual([]);

    const raised = harness(notice(0.95));
    raised.store.classificationFloorValue = 0.96;
    const held = await processUpload(upload(NOTICE), raised.deps);
    expect(held.case).toBeUndefined();
    expect(held.held).toMatchObject({ confidence: 0.95, floor: 0.96, reason: 'below_floor' });
  });

  it('holds a confident reading that does not fit its type, naming the field and not its value', async () => {
    const { store, deps } = harness(notice(0.99, { document: noticeWithoutClaim(), validated: false }));

    const result = await processUpload(upload(NOTICE), deps);

    expect(result.case).toBeUndefined();
    expect(result.held).toMatchObject({ reason: 'type_did_not_fit', fields: ['claim_id'] });
    expect(holds(store)[0]?.payload).toEqual({
      doc_type: 'deduction_notice',
      confidence: 0.99,
      floor: 0.95,
      reason: 'type_did_not_fit',
      fields: ['claim_id'],
    });
  });

  it('records below_floor when both apply, with the fields that did not fit', async () => {
    const { deps } = harness(notice(0.6, { document: noticeWithoutClaim(), validated: false }));
    const result = await processUpload(upload(NOTICE), deps);
    expect(result.held).toMatchObject({ reason: 'below_floor', fields: ['claim_id'] });
  });

  it('holds a remittance with no lines, however sure the classifier was', async () => {
    const empty = { ...(REMITTANCE_READING as Record<string, unknown>), lines: [] };
    const { store, deps } = harness({
      [REMITTANCE.filename]: { docType: 'remittance_advice', confidence: 0.99, document: empty },
    });

    const result = await processUpload(upload(REMITTANCE), deps);

    expect(result.remittance).toBeUndefined();
    expect(result.held).toMatchObject({ reason: 'type_did_not_fit', fields: ['lines'] });
    expect(store.cases.size).toBe(0);
  });

  it('holds a remittance below the floor before any line opens a case or is declined', async () => {
    const { store, deps } = harness({
      [REMITTANCE.filename]: {
        docType: 'remittance_advice',
        confidence: 0.92,
        document: REMITTANCE_READING,
      },
    });

    const result = await processUpload(upload(REMITTANCE), deps);

    expect(result.remittance).toBeUndefined();
    expect(result.held).toMatchObject({ docType: 'remittance_advice', reason: 'below_floor' });
    expect(store.cases.size).toBe(0);
    expect(store.events).toEqual([]);
  });

  it('never holds evidence, however unsure the classifier was', async () => {
    const { store, deps } = harness({
      [BOL.filename]: { docType: 'bol', confidence: 0.4, document: expectedExtraction(BOL) },
    });

    const result = await processUpload(upload(BOL), deps);

    expect(result.held).toBeUndefined();
    expect(result.haltedBecause).toBeUndefined();
    expect(holds(store)).toEqual([]);
  });

  it('does not hold a document that may not open a case: the unauthenticated email halt stands', async () => {
    const { store, deps } = harness(notice(0.4));

    const result = await processUpload(upload(NOTICE), deps, { allowCaseOpen: false });

    expect(result.held).toBeUndefined();
    expect(result.haltedBecause).toMatch(/unauthenticated sender/);
    expect(holds(store)).toEqual([]);
    // It never asks for a floor it has no use for.
    expect(store.floorCalls).toBe(0);
  });

  it('does not hold a notice uploaded to a case a person named', async () => {
    const { store, deps } = harness(notice(0.4));
    const named = await store.openCase({ orgId: ORG, claimId: 'NAMED-1' });

    const result = await processUpload(upload(NOTICE), deps, { attachToCase: named.deductionId });

    expect(result.held).toBeUndefined();
    expect(store.links).toContainEqual({
      deductionId: named.deductionId,
      documentId: result.ingest.document.documentId,
      role: 'evidence',
    });
    expect(holds(store)).toEqual([]);
    expect(store.floorCalls).toBe(0);
  });

  it('asks for the floor before it spends anything, and stops if there is none', async () => {
    const { store, classifier, deps } = harness(notice(0.99));
    store.classificationFloor = async () => {
      throw new Error('no org_settings row');
    };

    await expect(processUpload(upload(NOTICE), deps)).rejects.toThrow(/no org_settings row/);
    expect(classifier.calls).toBe(0);
    expect(store.modelCalls).toEqual([]);
  });
});

describe('a held document is answered from the record', () => {
  it('is not read again when the same file is uploaded again', async () => {
    const { store, classifier, extractor, deps } = harness(notice(0.9));
    await processUpload(upload(NOTICE), deps);
    const calls = store.modelCalls.length;

    const again = await processUpload(upload(NOTICE), deps);

    expect(again.haltedBecause).toBe(HELD_FOR_REVIEW);
    expect(again.held?.reason).toBe('below_floor');
    expect(again.case).toBeUndefined();
    expect(classifier.calls).toBe(1);
    expect(extractor.calls).toBe(1);
    expect(store.modelCalls).toHaveLength(calls);
    expect(holds(store)).toHaveLength(1);
  });

  it('is not read again by a redelivered job, and the job says why', async () => {
    const { store, classifier, deps } = harness(notice(0.9));
    const ingested = await ingestForJob(deps, upload(NOTICE));
    const first = await readDocumentJob(deps, {
      documentId: ingested.documentId,
      orgId: ORG,
      actor: { userId: USER },
    });
    expect(first).toMatchObject({
      alreadyRead: false,
      haltedBecause: HELD_FOR_REVIEW,
      held: 'below_floor',
      deductionId: null,
    });

    const redelivered = await readDocumentJob(deps, {
      documentId: ingested.documentId,
      orgId: ORG,
      actor: { userId: USER },
    });

    expect(redelivered).toMatchObject({
      alreadyRead: true,
      beingRead: false,
      haltedBecause: HELD_FOR_REVIEW,
      held: 'below_floor',
      docType: 'deduction_notice',
      deductionId: null,
    });
    expect(classifier.calls).toBe(1);
    expect(holds(store)).toHaveLength(1);
  });

  it('answers the case, not the hold, once a case holds the document', async () => {
    const { store, deps } = harness(notice(0.9));
    const read = await processUpload(upload(NOTICE), deps);
    const documentId = read.ingest.document.documentId;
    const opened = await openHeldDocument(store, { orgId: ORG, documentId, confirmedBy: USER });

    const recorded = await recordedRead({ documentId }, deps);

    expect(recorded).toEqual({
      docType: 'deduction_notice',
      deductionId: opened.opened[0]?.deductionId,
    });
  });
});

describe('a person opens a case from a held document', () => {
  async function heldNotice() {
    const h = harness(notice(0.9));
    const read = await processUpload(upload(NOTICE), h.deps);
    return { ...h, documentId: read.ingest.document.documentId };
  }

  it('opens the case once, from the recorded reading, with no model call', async () => {
    const { store, classifier, extractor, documentId } = await heldNotice();
    const spent = store.modelCalls.length;

    const result = await openHeldDocument(store, { orgId: ORG, documentId, confirmedBy: USER });

    expect(result.docType).toBe('deduction_notice');
    expect(result.opened).toHaveLength(1);
    const deductionId = result.opened[0]?.deductionId as string;
    expect(store.cases.get(deductionId)?.state).toBe('classified');
    expect(store.cases.get(deductionId)?.claimId).toBe('APDP-99812');
    expect(store.links).toContainEqual({ deductionId, documentId, role: 'notice' });

    // Nothing read, nothing charged.
    expect(classifier.calls).toBe(1);
    expect(extractor.calls).toBe(1);
    expect(store.modelCalls).toHaveLength(spent);

    // The case says it was opened on a doubted reading, and who decided.
    const discovered = store.events.find(
      (e) => e.deductionId === deductionId && e.eventType === 'case.discovered',
    );
    expect(discovered?.payload).toMatchObject({
      document_id: documentId,
      held: { confidence: 0.9, floor: 0.95, reason: 'below_floor' },
      confirmed_by: USER,
    });

    // And the release names the person and the case, after it.
    const released = store.auditLog.filter((row) => row.action === DOCUMENT_HOLD_RELEASED);
    expect(released).toHaveLength(1);
    expect(released[0]).toMatchObject({
      subjectId: documentId,
      actorId: USER,
      payload: { reason: 'below_floor', deduction_ids: [deductionId] },
    });
    expect(await store.documentHold(documentId)).toBeUndefined();
  });

  it('refuses a second press: the document is on a case now', async () => {
    const { store, documentId } = await heldNotice();
    await openHeldDocument(store, { orgId: ORG, documentId, confirmedBy: USER });

    await expect(
      openHeldDocument(store, { orgId: ORG, documentId, confirmedBy: USER }),
    ).rejects.toBeInstanceOf(DocumentAlreadyOnCaseError);
    expect(store.cases.size).toBe(1);
  });

  it('refuses a document that is not held', async () => {
    const { store, deps } = harness({
      [BOL.filename]: { docType: 'bol', confidence: 0.99, document: expectedExtraction(BOL) },
    });
    const read = await processUpload(upload(BOL), deps);

    await expect(
      openHeldDocument(store, {
        orgId: ORG,
        documentId: read.ingest.document.documentId,
        confirmedBy: USER,
      }),
    ).rejects.toBeInstanceOf(DocumentNotHeldError);
    expect(store.cases.size).toBe(0);
  });

  it('opens a notice whose reading does not fit its type, with the missing field empty and named', async () => {
    // Held because the reading lacks its deduction date — a real notice, one
    // field short. Before ADR 0044 it would have opened a case on its own with
    // that date null; a person's confirmation must not make that impossible.
    const { store, deps } = harness(
      notice(0.99, { document: noticeWithout('deduction_date'), validated: false }),
    );
    const read = await processUpload(upload(NOTICE), deps);
    expect(read.held).toMatchObject({ reason: 'type_did_not_fit', fields: ['deduction_date'] });
    const documentId = read.ingest.document.documentId;

    const result = await openHeldDocument(store, { orgId: ORG, documentId, confirmedBy: USER });

    expect(result.opened).toHaveLength(1);
    const deductionId = result.opened[0]?.deductionId as string;
    const opened = store.cases.get(deductionId);
    expect(opened?.state).toBe('classified');
    expect(opened?.claimId).toBe('APDP-99812');
    expect(opened?.deductionDate).toBeUndefined();
    const discovered = store.events.find(
      (e) => e.deductionId === deductionId && e.eventType === 'case.discovered',
    );
    expect(discovered?.payload).toMatchObject({
      deduction_date: null,
      held: { reason: 'type_did_not_fit', fields: ['deduction_date'] },
      fields_missing_on_open: ['deduction_date'],
      confirmed_by: USER,
    });
    // Paths only: nothing off the page rode along with the field names.
    expect(JSON.stringify((discovered?.payload as { held: unknown }).held)).not.toContain('APDP');
    expect(await store.documentHold(documentId)).toBeUndefined();
  });

  it('opens even a notice with no claim id, the gap named rather than refused', async () => {
    const { store, deps } = harness(
      notice(0.99, { document: noticeWithoutClaim(), validated: false }),
    );
    const read = await processUpload(upload(NOTICE), deps);

    const result = await openHeldDocument(store, {
      orgId: ORG,
      documentId: read.ingest.document.documentId,
      confirmedBy: USER,
    });

    const opened = store.cases.get(result.opened[0]?.deductionId as string);
    expect(opened).toBeDefined();
    expect(opened?.claimId).toBeUndefined();
    const discovered = store.events.find((e) => e.eventType === 'case.discovered');
    expect(discovered?.payload).toMatchObject({
      claim_id: null,
      held: { fields: ['claim_id'] },
      fields_missing_on_open: ['claim_id'],
    });
  });

  it('opens a below-floor notice whose stored rows lost a required field', async () => {
    // Fits as read — the date has a value — so held for its confidence alone,
    // with no `fields`. But the date had no quote, so no row was stored for it,
    // and the reading restored from the store no longer validates. That is not
    // a reason to refuse: the case opens without the date, and says so.
    const { store, deps } = harness(notice(0.9, { document: noticeWithUnquotedDate() }));
    const read = await processUpload(upload(NOTICE), deps);
    expect(read.held).toMatchObject({ reason: 'below_floor' });
    expect(read.held?.fields).toBeUndefined();
    const documentId = read.ingest.document.documentId;
    expect((await store.latestExtraction(documentId))?.validated).toBe(false);

    const result = await openHeldDocument(store, { orgId: ORG, documentId, confirmedBy: USER });

    const deductionId = result.opened[0]?.deductionId as string;
    expect(store.cases.get(deductionId)?.deductionDate).toBeUndefined();
    expect(store.cases.get(deductionId)?.claimId).toBe('APDP-99812');
    const discovered = store.events.find(
      (e) => e.deductionId === deductionId && e.eventType === 'case.discovered',
    );
    expect(discovered?.payload).toMatchObject({
      held: { reason: 'below_floor', confidence: 0.9 },
      fields_missing_on_open: ['deduction_date'],
    });
    expect((discovered?.payload as { held: Record<string, unknown> }).held).not.toHaveProperty(
      'fields',
    );
  });

  it('refuses a remittance with no lines — there is nothing to open — and the hold stands', async () => {
    const empty = { ...(REMITTANCE_READING as Record<string, unknown>), lines: [] };
    const { store, deps } = harness({
      [REMITTANCE.filename]: { docType: 'remittance_advice', confidence: 0.99, document: empty },
    });
    const read = await processUpload(upload(REMITTANCE), deps);
    expect(read.held).toMatchObject({ reason: 'type_did_not_fit', fields: ['lines'] });
    const documentId = read.ingest.document.documentId;

    const refused = openHeldDocument(store, { orgId: ORG, documentId, confirmedBy: USER });
    await expect(refused).rejects.toBeInstanceOf(HeldReadingUnusableError);
    await expect(refused).rejects.toMatchObject({ fields: ['lines'] });
    expect(store.cases.size).toBe(0);
    expect(store.auditLog.filter((row) => row.action === DOCUMENT_HOLD_RELEASED)).toEqual([]);
    expect(await store.documentHold(documentId)).toBeDefined();
  });

  it('refuses a member the database says may not write', async () => {
    const { store, documentId } = await heldNotice();
    store.memberships.splice(0, store.memberships.length);
    store.addMember(ORG, USER, 'read_only');

    await expect(
      openHeldDocument(store, { orgId: ORG, documentId, confirmedBy: USER }),
    ).rejects.toBeInstanceOf(WrongRoleError);
    expect(store.cases.size).toBe(0);
  });

  it('treats another tenant’s hold as a document it cannot see', async () => {
    // RLS answers this on Postgres; a store without it is asked in the function.
    const { store, documentId } = await heldNotice();
    store.addMember('org-2', USER, 'analyst');

    await expect(
      openHeldDocument(store, { orgId: 'org-2', documentId, confirmedBy: USER }),
    ).rejects.toBeInstanceOf(DocumentNotFoundError);
    expect(store.cases.size).toBe(0);
  });

  it('refuses while the document is being read or opened by somebody else', async () => {
    const { store, documentId } = await heldNotice();

    const inner = await store.withDocumentRead(documentId, () =>
      openHeldDocument(store, { orgId: ORG, documentId, confirmedBy: USER }).then(
        () => 'opened',
        (error: unknown) => error,
      ),
    );

    expect(inner.held).toBe(true);
    expect(inner.held && inner.result).toBeInstanceOf(DocumentBusyError);
    expect(store.cases.size).toBe(0);
  });

  it('opens a held remittance’s lines, each saying who confirmed it', async () => {
    const { store, deps } = harness({
      [REMITTANCE.filename]: {
        docType: 'remittance_advice',
        confidence: 0.92,
        document: REMITTANCE_READING,
      },
    });
    const read = await processUpload(upload(REMITTANCE), deps);
    const documentId = read.ingest.document.documentId;

    const result = await openHeldDocument(store, { orgId: ORG, documentId, confirmedBy: USER });

    expect(result.docType).toBe('remittance_advice');
    expect(result.opened).toHaveLength(1);
    const deductionId = result.opened[0]?.deductionId as string;
    expect(store.cases.get(deductionId)).toMatchObject({
      discoveredVia: 'remittance_line',
      deductionAmountCents: 60_000,
      state: 'classified',
    });
    const discovered = store.events.find(
      (e) => e.deductionId === deductionId && e.eventType === 'case.discovered',
    );
    expect(discovered?.payload).toMatchObject({
      discovered_via: 'remittance_line',
      held: { confidence: 0.92, floor: 0.95, reason: 'below_floor' },
      confirmed_by: USER,
    });
    expect(await store.documentHold(documentId)).toBeUndefined();
  });
});

describe('typeFits and holdFor', () => {
  it('fits a validated notice, and a validated remittance with lines', () => {
    expect(typeFits('deduction_notice', { document: NOTICE_READING, validated: true })).toEqual({
      fits: true,
    });
    expect(
      typeFits('remittance_advice', { document: REMITTANCE_READING, validated: true }),
    ).toEqual({ fits: true });
  });

  it('names lines for a remittance that has none, whether or not it validated', () => {
    const empty = { ...(REMITTANCE_READING as Record<string, unknown>), lines: [] };
    expect(typeFits('remittance_advice', { document: empty, validated: true })).toEqual({
      fits: false,
      fields: ['lines'],
    });
    // And alongside a schema complaint about another field, not hidden by it.
    const unvalidated = typeFits('remittance_advice', {
      document: { ...empty, payer_name: { value: null, confidence: 0, source_page: 1, source_quote: '' } },
      validated: false,
    });
    expect(unvalidated).toEqual({ fits: false, fields: ['lines', 'payer_name'] });
  });

  it('names only fields the type declares, never a path a model invented', () => {
    // A notice's reading handed in as a remittance: the schema's complaint is
    // about the remittance's own required fields, by their own names.
    const fit = typeFits('remittance_advice', { document: NOTICE_READING, validated: false });
    expect(fit.fits).toBe(false);
    if (fit.fits) return;
    expect(fit.fields).toContain('payer_name');
    expect(fit.fields).toContain('payment_reference');
    for (const field of fit.fields) {
      expect(field).toMatch(/^[a-z][a-z0-9_]*(\[\d+\])?(\.[a-z][a-z0-9_]*)?$/);
    }

    const invented = typeFits('deduction_notice', {
      document: { ...(NOTICE_READING as object), '<script>': { value: 'x' } },
      validated: false,
    });
    expect(JSON.stringify(invented)).not.toContain('script');
  });

  it('opens at or above the floor when the reading fits, and holds otherwise', () => {
    const reading = { document: NOTICE_READING, validated: true };
    expect(holdFor({ docType: 'deduction_notice', confidence: 0.95, floor: 0.95, reading })).toBeUndefined();
    expect(holdFor({ docType: 'deduction_notice', confidence: 0.949, floor: 0.95, reading })).toEqual({
      reason: 'below_floor',
    });
    expect(
      holdFor({ docType: 'deduction_notice', confidence: Number.NaN, floor: 0.95, reading }),
    ).toEqual({ reason: 'below_floor' });
  });
});

describe('the recorded corpus, replayed through processUpload', () => {
  /** Every fixture whose cassette the classifier read as a notice or a remittance. */
  const recorded = everyDocument()
    .map((document) => {
      try {
        return { document, cassette: cassette(document.key) };
      } catch {
        return undefined;
      }
    })
    .filter(
      (entry): entry is { document: FixtureDocument; cassette: Cassette } =>
        entry !== undefined &&
        (entry.cassette.classifiedAs === 'deduction_notice' ||
          entry.cassette.classifiedAs === 'remittance_advice'),
    );

  // None, today. Two were held while they were recorded: `stf-201-short-pay-
  // remittance`, one unpinned sample at 0.92 that reads 0.95 at temperature 0,
  // and `stf-203-short-payment-notice`, a notice read as a remittance at 0.75
  // until the classifier learned that a short payment notice is a notice. Both
  // now meet the floor — inclusive, like LOG-001's remittance — and open. The
  // hold itself is exercised above, on readings built to fall below it.
  const HELD = new Set<string>();

  it('covers every recorded notice and remittance, and each meets the floor', () => {
    const keys = recorded.map((entry) => entry.document.key);
    expect(keys.length).toBeGreaterThanOrEqual(25);
    expect(keys).toContain('stf-203-short-payment-notice');
    expect(keys).toContain('stf-201-short-pay-remittance');
    for (const key of HELD) expect(keys).toContain(key);
  });

  for (const { document, cassette: recording } of recorded) {
    // A notice written in an email's body arrives through the email door, and
    // no email opens a case by itself (ADR 0047 §7): held, whatever its
    // confidence.
    const byEmail = document.mimeType === 'text/plain';
    const expectHeld = HELD.has(document.key) || byEmail;
    it(`${document.key} (${recording.classifiedAs} at ${recording.classifierConfidence}) is ${
      expectHeld ? 'held' : 'opened'
    }`, async () => {
      const store = new InMemoryStore();
      const byFilename = new Map([[document.filename, recording]]);
      const key = (payload: { readonly filename: string }) => payload.filename;
      const deps: PipelineDeps = {
        store,
        scanner: new AlwaysCleanScanner(),
        classifier: new CassetteClassifier(byFilename, key),
        extractor: new CassetteExtractor(byFilename, key),
        now: () => new Date('2026-09-23T12:00:00Z'),
      };
      const pageText = recording.ocr?.pages.map((page) => page.text) ?? document.pageText;

      const result = await processUpload(upload(document, pageText), deps);

      if (expectHeld) {
        expect(result.held?.reason).toBe(byEmail ? 'by_email' : 'below_floor');
        expect(result.held?.confidence).toBe(recording.classifierConfidence);
        expect(result.case).toBeUndefined();
        expect(result.remittance).toBeUndefined();
        expect(store.cases.size).toBe(0);
        return;
      }

      expect(result.held).toBeUndefined();
      expect(store.auditLog).toEqual([]);
      if (recording.classifiedAs === 'deduction_notice') {
        expect(result.case?.state).toBe('classified');
      } else {
        const cases = [
          ...(result.remittance?.opened ?? []).map((c) => c.deductionId),
          ...(result.remittance?.mergedInto ?? []),
        ];
        expect(cases.length).toBeGreaterThan(0);
      }
    });
  }
});

// `readDocument` is exported for the job path; the gate is the same one.
describe('readDocument, called directly', () => {
  it('holds exactly as processUpload does', async () => {
    const { store, deps } = harness(notice(0.5));
    const ingested = await ingestForJob(deps, upload(NOTICE));
    const document = await store.getDocument(ingested.documentId);
    if (document === undefined) throw new Error('no document');

    const read = await readDocument(document, deps);

    expect(read.held?.reason).toBe('below_floor');
    expect(read.haltedBecause).toBe(HELD_FOR_REVIEW);
    expect(await store.documentHold(document.documentId)).toMatchObject({
      documentId: document.documentId,
      orgId: ORG,
      reason: 'below_floor',
    });
  });
});

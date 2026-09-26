import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
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
  ActorIsNotTheSessionError,
  ClassificationFloorError,
  DOCUMENT_HELD,
  DOCUMENT_HOLD_RELEASED,
  DocumentAlreadyOnCaseError,
  HELD_FOR_REVIEW,
  openHeldDocument,
  processUpload,
  type PipelineDeps,
} from '@recouple/pipeline';
import { closeAllPools, PostgresStore } from '../src/store';

/**
 * A doubtful classification is held for a person (ADR 0044), on the real
 * schema: the floor read from the tenant's own `org_settings` row through RLS,
 * the hold and its release as `audit_log` rows migration 0030's policy lets
 * only a writer write and only as themselves, and the case list's read of both.
 *
 * `pnpm db:test` prepares the database; without TEST_DATABASE_URL there is nothing
 * to test against.
 */

const connectionString = process.env.TEST_DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

const NOTICE: FixtureDocument = (() => {
  const found = allFixtureDocuments().find((d) => d.filename === 'walmart-apdp-notice.pdf');
  if (found === undefined) throw new Error('no walmart notice fixture');
  return found;
})();

/** The fixture notice, read as a notice at whatever confidence the test says. */
class UnsureClassifier implements Classifier {
  calls = 0;
  constructor(private readonly confidence: number) {}
  async classify(document: DocumentPayload): Promise<ClassificationResult> {
    this.calls += 1;
    return {
      docType: 'deduction_notice',
      confidence: this.confidence,
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

class NoticeExtractor implements Extractor {
  readonly name = 'fixture';
  calls = 0;
  async extract(document: DocumentPayload, docType: DocType): Promise<ExtractionResult> {
    this.calls += 1;
    return buildExtractionResult({
      docType,
      extractor: this.name,
      document: expectedExtraction(NOTICE),
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

describeDb('the classification floor and the hold, on Postgres', () => {
  const admin = new Pool({ connectionString });
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const bareOrgId = randomUUID();
  const analystId = randomUUID();
  const readerId = randomUUID();
  const otherAnalystId = randomUUID();
  const bareAnalystId = randomUUID();
  const suffix = orgId.slice(0, 8);
  const config = { connectionString: connectionString as string };
  let store: PostgresStore;
  let reader: PostgresStore;
  let other: PostgresStore;
  let bare: PostgresStore;

  /** A stored, scanned, classified and extracted document, through the store as `app_rw`. */
  async function readDocument(
    into: PostgresStore,
    org: string,
    confidence: number,
    docType: DocType = 'deduction_notice',
  ): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `insert into documents (org_id, sha256, byte_size, mime_type, storage_ref, filename)
       values ($1, $2, 4, 'application/pdf', $3, $4) returning id`,
      [
        org,
        Buffer.from(randomUUID().replace(/-/g, '').padEnd(64, '0'), 'hex'),
        `doc/${randomUUID()}`,
        `held-${randomUUID().slice(0, 8)}.pdf`,
      ],
    );
    const documentId = rows[0]?.id as string;
    await into.recordScan(documentId, { status: 'clean', scanner: 'test' });
    await into.recordClassification(documentId, docType, confidence);
    await into.recordExtraction({
      documentId,
      docType,
      extractor: 'test',
      schemaVersion: '1.1.0',
      fields: [
        {
          fieldPath: 'claim_id',
          value: 'C-1',
          confidence: 0.9,
          sourcePage: 1,
          sourceQuote: 'C-1',
          sourceBbox: null,
          quoteVerified: true,
        },
      ],
      document: {},
    });
    return documentId;
  }

  async function auditRows(documentId: string) {
    const { rows } = await admin.query<{
      action: string;
      actor_id: string | null;
      org_id: string;
      payload: Record<string, unknown>;
    }>(
      `select action, actor_id, org_id, payload from audit_log
        where subject_table = 'documents' and subject_id = $1 order by id`,
      [documentId],
    );
    return rows;
  }

  beforeAll(async () => {
    await admin.query(
      `insert into organizations (id, slug, name)
       values ($1,$2,'Floor'), ($3,$4,'Floor Other'), ($5,$6,'Floor Bare')`,
      [orgId, `floor-${suffix}`, otherOrgId, `floor-other-${suffix}`, bareOrgId, `floor-bare-${suffix}`],
    );
    // The bare tenant has no settings row, which every path that makes a
    // tenant writes — it stands for the one that did not.
    await admin.query('insert into org_settings (org_id) values ($1), ($2)', [orgId, otherOrgId]);
    // The other tenant has raised its floor, which needs no ADR: raising holds more.
    await admin.query(
      'update org_settings set min_classification_confidence = 0.990 where org_id = $1',
      [otherOrgId],
    );
    await admin.query('insert into users (id, email) values ($1,$2), ($3,$4), ($5,$6), ($7,$8)', [
      analystId,
      `floor-analyst-${suffix}@example.test`,
      readerId,
      `floor-reader-${suffix}@example.test`,
      otherAnalystId,
      `floor-other-${suffix}@example.test`,
      bareAnalystId,
      `floor-bare-${suffix}@example.test`,
    ]);
    await admin.query(
      `insert into memberships (org_id, user_id, role)
       values ($1,$2,'analyst'), ($1,$3,'read_only'), ($4,$5,'analyst'), ($6,$7,'analyst')`,
      [orgId, analystId, readerId, otherOrgId, otherAnalystId, bareOrgId, bareAnalystId],
    );
    store = new PostgresStore(config, { orgId, userId: analystId });
    reader = new PostgresStore(config, { orgId, userId: readerId });
    other = new PostgresStore(config, { orgId: otherOrgId, userId: otherAnalystId });
    bare = new PostgresStore(config, { orgId: bareOrgId, userId: bareAnalystId });
  });

  afterAll(async () => {
    await admin.end();
    await closeAllPools();
  });

  it('reads the tenant’s own floor, and not another tenant’s', async () => {
    expect(await store.classificationFloor()).toBe(0.95);
    expect(await other.classificationFloor()).toBe(0.99);
  });

  it('refuses a tenant with no settings row rather than defaulting', async () => {
    const refused = bare.classificationFloor();
    await expect(refused).rejects.toBeInstanceOf(ClassificationFloorError);
    await expect(refused).rejects.toMatchObject({ reason: 'missing', orgId: bareOrgId });
  });

  it('writes a hold naming the acting member, and reads it back', async () => {
    const documentId = await readDocument(store, orgId, 0.9);

    await store.recordHold({
      documentId,
      orgId,
      docType: 'deduction_notice',
      confidence: 0.9,
      floor: 0.95,
      reason: 'below_floor',
    });

    const rows = await auditRows(documentId);
    expect(rows).toEqual([
      {
        action: DOCUMENT_HELD,
        actor_id: analystId,
        org_id: orgId,
        payload: { doc_type: 'deduction_notice', confidence: 0.9, floor: 0.95, reason: 'below_floor' },
      },
    ]);
    expect(await store.documentHold(documentId)).toMatchObject({
      documentId,
      orgId,
      docType: 'deduction_notice',
      confidence: 0.9,
      floor: 0.95,
      reason: 'below_floor',
      heldBy: analystId,
    });
    // Another tenant sees no hold on a document it cannot see.
    expect(await other.documentHold(documentId)).toBeUndefined();
  });

  it('is refused for a member who may not write, by the policy', async () => {
    const documentId = await readDocument(store, orgId, 0.9);

    await expect(
      reader.recordHold({
        documentId,
        orgId,
        docType: 'deduction_notice',
        confidence: 0.9,
        floor: 0.95,
        reason: 'below_floor',
      }),
    ).rejects.toMatchObject({ code: '42501' });
    expect(await auditRows(documentId)).toEqual([]);
  });

  it('will not record a hold for another tenant, or release one as somebody else', async () => {
    const documentId = await readDocument(store, orgId, 0.9);
    await expect(
      store.recordHold({
        documentId,
        orgId: otherOrgId,
        docType: 'deduction_notice',
        confidence: 0.9,
        floor: 0.95,
        reason: 'below_floor',
      }),
    ).rejects.toThrow(/cannot be recorded by a store acting in org/);
    await expect(
      store.releaseHold({
        orgId,
        documentId,
        releasedBy: readerId,
        reason: 'below_floor',
        deductionIds: [],
      }),
    ).rejects.toBeInstanceOf(ActorIsNotTheSessionError);
    expect(await auditRows(documentId)).toEqual([]);
  });

  it('lists a held document with its confidence and hold; a released hold is no longer a hold', async () => {
    const held = await readDocument(store, orgId, 0.75, 'remittance_advice');
    const plain = await readDocument(store, orgId, 0.98, 'pod');
    await store.recordHold({
      documentId: held,
      orgId,
      docType: 'remittance_advice',
      confidence: 0.75,
      floor: 0.95,
      reason: 'below_floor',
      fields: ['lines'],
    });

    const listed = await store.unattachedDocuments(200);
    const heldRow = listed.find((row) => row.documentId === held);
    const plainRow = listed.find((row) => row.documentId === plain);
    expect(heldRow).toMatchObject({
      docType: 'remittance_advice',
      confidence: 0.75,
      hold: { reason: 'below_floor', confidence: 0.75, floor: 0.95, fields: ['lines'] },
    });
    expect(plainRow).toMatchObject({ docType: 'pod', confidence: 0.98 });
    expect(plainRow).not.toHaveProperty('hold');

    await store.releaseHold({
      orgId,
      documentId: held,
      releasedBy: analystId,
      reason: 'below_floor',
      deductionIds: [],
    });
    expect(await store.documentHold(held)).toBeUndefined();
    const after = (await store.unattachedDocuments(200)).find((row) => row.documentId === held);
    expect(after).not.toHaveProperty('hold');
    expect((await auditRows(held)).map((row) => [row.action, row.actor_id])).toEqual([
      [DOCUMENT_HELD, analystId],
      [DOCUMENT_HOLD_RELEASED, analystId],
    ]);

    // Held again after a release — a second read that doubted it too — is a hold again.
    await store.recordHold({
      documentId: held,
      orgId,
      docType: 'remittance_advice',
      confidence: 0.7,
      floor: 0.95,
      reason: 'below_floor',
    });
    expect(await store.documentHold(held)).toMatchObject({ confidence: 0.7 });
  });

  it('holds an unsure notice through the real pipeline, and a person opens its case without a read', async () => {
    const classifier = new UnsureClassifier(0.9);
    const extractor = new NoticeExtractor();
    const deps: PipelineDeps = {
      store,
      scanner: { name: 'test', async scan() { return { status: 'clean', scanner: 'test' }; } },
      classifier,
      extractor,
      now: () => new Date(),
    };

    const read = await processUpload(
      {
        orgId,
        filename: NOTICE.filename,
        bytes: NOTICE.bytes,
        source: 'web_upload',
        uploadedBy: analystId,
        pageText: NOTICE.pageText,
      },
      deps,
    );
    const documentId = read.ingest.document.documentId;
    expect(read.haltedBecause).toBe(HELD_FOR_REVIEW);
    expect(read.case).toBeUndefined();
    const { rows: before } = await admin.query<{ n: string }>(
      'select count(*)::text as n from model_calls where document_id = $1',
      [documentId],
    );
    expect(Number(before[0]?.n)).toBe(2);

    // The same bytes again: answered from the record, nothing spent.
    const again = await processUpload(
      {
        orgId,
        filename: NOTICE.filename,
        bytes: NOTICE.bytes,
        source: 'web_upload',
        uploadedBy: analystId,
        pageText: NOTICE.pageText,
      },
      deps,
    );
    expect(again.held?.reason).toBe('below_floor');
    expect(classifier.calls).toBe(1);

    const opened = await openHeldDocument(store, { orgId, documentId, confirmedBy: analystId });
    const deductionId = opened.opened[0]?.deductionId as string;
    expect(deductionId).toBeDefined();

    const { rows: after } = await admin.query<{ n: string }>(
      'select count(*)::text as n from model_calls where document_id = $1',
      [documentId],
    );
    expect(Number(after[0]?.n)).toBe(2);
    expect(extractor.calls).toBe(1);

    const { rows: discovered } = await admin.query<{ payload: Record<string, unknown> }>(
      `select payload from deduction_events
        where deduction_id = $1 and event_type = 'case.discovered'`,
      [deductionId],
    );
    expect(discovered[0]?.payload).toMatchObject({
      document_id: documentId,
      held: { confidence: 0.9, floor: 0.95, reason: 'below_floor' },
      confirmed_by: analystId,
    });
    expect((await auditRows(documentId)).map((row) => [row.action, row.actor_id])).toEqual([
      [DOCUMENT_HELD, analystId],
      [DOCUMENT_HOLD_RELEASED, analystId],
    ]);
    const released = (await auditRows(documentId))[1];
    expect(released?.payload).toEqual({ reason: 'below_floor', deduction_ids: [deductionId] });

    // Not listed any more, and a second press is refused by name.
    expect((await store.unattachedDocuments(200)).map((r) => r.documentId)).not.toContain(documentId);
    await expect(
      openHeldDocument(store, { orgId, documentId, confirmedBy: analystId }),
    ).rejects.toBeInstanceOf(DocumentAlreadyOnCaseError);
  });
});

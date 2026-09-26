import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { UnreadDocumentsQueryError } from '@recouple/pipeline';
import {
  ArrivalAlreadyRecordedError,
  closeAllPools,
  PostgresStore,
  ProvenanceUnknownError,
} from '../src/store';

const connectionString = process.env.TEST_DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

/**
 * Recording how a pre-provenance document arrived (ADR 0024 §3).
 *
 * The documents stored before ingest wrote `uploads` rows have
 * `documents.upload_id` null, and `declineCase` refuses their cases rather than
 * attributing a decline to a guessed channel. Migration 0019 freezes `uploads`,
 * which closes the last lever that could have papered over that, and adds
 * `document_arrivals` as the one way back: write-once, named, and refused for
 * any document that already says how it arrived.
 *
 * The three properties that make this a record of an assertion rather than an
 * invention of provenance are what this file is about — it never overwrites,
 * it is written once, and it always has a person's name on it — plus the one
 * thing it is for: the case becomes declinable, under the channel that was
 * recorded and not under a default.
 */
describeDb('recording an arrival after the fact', () => {
  const admin = new Pool({ connectionString });
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const analystId = randomUUID();
  const readerId = randomUUID();
  const otherAnalystId = randomUUID();
  const suffix = orgId.slice(0, 8);
  let store: PostgresStore;
  let readerStore: PostgresStore;
  let documents = 0;

  beforeAll(async () => {
    await admin.query(
      `insert into organizations (id, slug, name) values ($1,$2,'Arrival'), ($3,$4,'Arrival Other')`,
      [orgId, `arr-${suffix}`, otherOrgId, `arr-other-${suffix}`],
    );
    await admin.query(`insert into org_settings (org_id) values ($1), ($2)`, [orgId, otherOrgId]);
    await admin.query(`insert into users (id, email) values ($1,$2), ($3,$4), ($5,$6)`, [
      analystId, `arr-a-${suffix}@example.test`,
      readerId, `arr-r-${suffix}@example.test`,
      otherAnalystId, `arr-o-${suffix}@example.test`,
    ]);
    await admin.query(
      `insert into memberships (org_id, user_id, role)
       values ($1,$2,'analyst'), ($1,$3,'read_only'), ($4,$5,'analyst')`,
      [orgId, analystId, readerId, otherOrgId, otherAnalystId],
    );

    store = new PostgresStore(
      { connectionString: connectionString as string },
      { orgId, userId: analystId },
    );
    readerStore = new PostgresStore(
      { connectionString: connectionString as string },
      { orgId, userId: readerId },
    );
  });

  afterAll(async () => {
    await closeAllPools();
    await admin.end();
  });

  /**
   * A notice with no arrival on it at all: a document as it looked before
   * `ingestDocument` recorded where things came from.
   *
   * Written through the admin pool because `putDocument` would happily store
   * one with no `uploadId`, but `created_at` has to be a chosen date — the
   * `uploads` row this test suite asserts is stamped with it rather than with
   * `now()`, and a row whose two timestamps were both "a moment ago" could not
   * tell the two apart.
   */
  async function legacyNotice(
    caseId: string | undefined,
    options: { readonly createdAt?: string } = {},
  ): Promise<string> {
    documents += 1;
    const documentId = randomUUID();
    await admin.query(
      `insert into documents
         (id, org_id, sha256, byte_size, mime_type, storage_ref, filename, created_at)
       values ($1, $2, $3, 1024, 'application/pdf', $4, $5, $6)`,
      [
        documentId,
        orgId,
        Buffer.from(`${suffix}${documents}`.padEnd(64, 'e').slice(0, 64), 'hex'),
        `doc/${documentId}`,
        `legacy-${documents}.pdf`,
        options.createdAt ?? '2026-09-01T09:00:00Z',
      ],
    );
    if (caseId !== undefined) await store.linkDocument(caseId, documentId, 'notice');
    return documentId;
  }

  /** A notice that arrived the way one arrives now: the `uploads` row, then the bytes. */
  async function ingestedNotice(caseId: string): Promise<string> {
    documents += 1;
    const upload = await store.recordUpload({ orgId, source: 'web_upload', createdBy: analystId });
    const stored = await store.putDocument({
      orgId,
      sha256: `${suffix}${documents}`.padEnd(64, 'f').slice(0, 64),
      filename: `notice-${documents}.pdf`,
      mimeType: 'application/pdf',
      byteSize: 1024,
      bytes: new Uint8Array([37, 80, 68, 70]),
      uploadId: upload.uploadId,
      requiresSplit: false,
    });
    await store.linkDocument(caseId, stored.documentId, 'notice');
    return stored.documentId;
  }

  it('records the arrival, stamps it with when the bytes were stored, and says so on the case', async () => {
    const opened = await store.openCase({
      orgId,
      claimId: `ARR-${suffix}-1`,
      deductionAmountCents: 128_000,
    });
    const documentId = await legacyNotice(opened.deductionId, {
      createdAt: '2026-09-02T11:30:00Z',
    });

    const arrival = await store.recordDocumentArrival({
      documentId,
      source: 'web_upload',
      recordedBy: analystId,
      detail: 'ADR 0024: this deployment has never had an inbound-email caller',
    });
    expect(arrival.source).toBe('web_upload');
    expect(arrival.deductionIds).toEqual([opened.deductionId]);

    const { rows } = await admin.query<{
      source: string;
      created_by: string | null;
      received_at: Date;
      recorded_by: string;
      detail: string | null;
    }>(
      `select u.source, u.created_by, u.received_at, da.recorded_by, da.detail
         from document_arrivals da join uploads u on u.id = da.upload_id
        where da.document_id = $1`,
      [documentId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe('web_upload');
    // It has a name on it, in two places: the operator recorded it, and the
    // arrival row is theirs. An arrival recorded at ingest by an inbound email
    // has a null `created_by`; one asserted afterwards never does.
    expect(rows[0]?.created_by).toBe(analystId);
    expect(rows[0]?.recorded_by).toBe(analystId);
    expect(rows[0]?.detail).toMatch(/inbound-email caller/);
    // And `received_at` is when the bytes were stored, not when the script ran.
    // `now()` there would be a statement about an operator's afternoon recorded
    // in a column that means when something reached this tenant.
    expect(rows[0]?.received_at.toISOString()).toBe('2026-09-02T11:30:00.000Z');

    // The case's own timeline says the provenance was supplied rather than
    // observed, so a reviewer reading it does not have to know that
    // `document_arrivals` exists to know that somebody put the channel there.
    const { rows: events } = await admin.query<{ payload: Record<string, unknown> }>(
      `select payload from deduction_events
        where deduction_id = $1 and event_type = 'document.provenance_recorded'`,
      [opened.deductionId],
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      document_id: documentId,
      source: 'web_upload',
      recorded_by: analystId,
      asserted_after_the_fact: true,
    });
  });

  it('makes the case declinable, under the channel that was recorded', async () => {
    // The point of the whole mechanism. Before: refused by name, because
    // `discovered_from` is what coverage is grouped by and there was nothing to
    // derive it from. After: one decline, under `email_in` — which is the
    // channel an operator typed, not a default, and not `web_upload` because
    // the decline happened to come through the web app.
    const opened = await store.openCase({
      orgId,
      claimId: `ARR-${suffix}-2`,
      deductionAmountCents: 77_000,
    });
    const documentId = await legacyNotice(opened.deductionId);

    const before = store.declineCase({
      deductionId: opened.deductionId,
      reason: 'below_economic_floor',
      decidedBy: `arr-a-${suffix}@example.test`,
    });
    await expect(before).rejects.toBeInstanceOf(ProvenanceUnknownError);
    await expect(before).rejects.toThrow(/pnpm link:provenance/);

    await store.recordDocumentArrival({
      documentId,
      source: 'email_in',
      recordedBy: analystId,
    });

    const declined = await store.declineCase({
      deductionId: opened.deductionId,
      reason: 'below_economic_floor',
      decidedBy: `arr-a-${suffix}@example.test`,
    });
    expect(declined.discoveredFrom).toBe('email_in');

    const { rows } = await admin.query<{ discovered_from: string }>(
      `select discovered_from from declined_candidates where deduction_id = $1`,
      [opened.deductionId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.discovered_from).toBe('email_in');
  });

  it('never overwrites what ingest observed', async () => {
    // The rule the table exists under. A document whose arrival ingest recorded
    // has its answer, and an operator cannot put a different one beside it —
    // otherwise §2 of the ADR (a wrong source is uncorrectable in place) would
    // have a door in it, and re-labelling a channel after the declines
    // attributed to it were counted is exactly what freezing `uploads` is for.
    const opened = await store.openCase({
      orgId,
      claimId: `ARR-${suffix}-3`,
      deductionAmountCents: 51_000,
    });
    const documentId = await ingestedNotice(opened.deductionId);

    const refusal = store.recordDocumentArrival({
      documentId,
      source: 'erp_sync' as 'web_upload',
      recordedBy: analystId,
    });
    // Refused on the channel first, before the document is even read: only the
    // three doors that existed while a pre-provenance document could be stored
    // can have delivered one.
    await expect(refusal).rejects.toThrow(/not a channel an arrival can be asserted from/);

    const second = store.recordDocumentArrival({
      documentId,
      source: 'email_in',
      recordedBy: analystId,
    });
    await expect(second).rejects.toBeInstanceOf(ArrivalAlreadyRecordedError);
    await expect(second).rejects.toMatchObject({ origin: 'ingest' });

    // And the database refuses it too, if the store's check is ever raced past.
    const { rows: upload } = await admin.query<{ id: string }>(
      `insert into uploads (org_id, source, created_by) values ($1,'email_in',$2) returning id`,
      [orgId, analystId],
    );
    await expect(
      admin.query(
        `insert into document_arrivals (org_id, document_id, upload_id, recorded_by)
         values ($1,$2,$3,$4)`,
        [orgId, documentId, upload[0]?.id, analystId],
      ),
    ).rejects.toThrow(/already records arrival/);

    const { rows } = await admin.query<{ n: string }>(
      `select count(*)::text as n from document_arrivals where document_id = $1`,
      [documentId],
    );
    expect(rows[0]?.n).toBe('0');
  });

  it('is written once: the first assertion about a document is the last one', async () => {
    const documentId = await legacyNotice(undefined);
    await store.recordDocumentArrival({
      documentId,
      source: 'web_upload',
      recordedBy: analystId,
    });

    const again = store.recordDocumentArrival({
      documentId,
      source: 'email_body',
      recordedBy: analystId,
    });
    await expect(again).rejects.toBeInstanceOf(ArrivalAlreadyRecordedError);
    await expect(again).rejects.toMatchObject({ origin: 'asserted' });

    // The channel still says what the first run said — a second assertion is
    // refused, not layered on top, and there is no "latest wins" reading of
    // this table the way there is for `document_scans`.
    const { rows } = await admin.query<{ source: string; n: string }>(
      `select u.source, (select count(*)::text from document_arrivals where document_id = $1) as n
         from document_arrivals da join uploads u on u.id = da.upload_id
        where da.document_id = $1`,
      [documentId],
    );
    expect(rows[0]?.source).toBe('web_upload');
    expect(rows[0]?.n).toBe('1');
  });

  it('refuses a member who may read and not write, and a document of another tenant', async () => {
    const documentId = await legacyNotice(undefined);

    // RLS, not a check in the script: `tenant_insert` on `document_arrivals`
    // asks `app.member_may_write()` (ADR 0024, following migration 0010).
    await expect(
      readerStore.recordDocumentArrival({
        documentId,
        source: 'web_upload',
        recordedBy: readerId,
      }),
    ).rejects.toThrow(/row-level security/);

    // Another tenant's store cannot see the document at all, which is the
    // refusal to give: it does not exist as far as those claims are concerned.
    const otherStore = new PostgresStore(
      { connectionString: connectionString as string },
      { orgId: otherOrgId, userId: otherAnalystId },
    );
    try {
      await expect(
        otherStore.recordDocumentArrival({
          documentId,
          source: 'web_upload',
          recordedBy: otherAnalystId,
        }),
      ).rejects.toThrow(/not visible to this tenant/);
    } finally {
      await otherStore.close();
    }

    const { rows } = await admin.query<{ n: string }>(
      `select count(*)::text as n from document_arrivals where document_id = $1`,
      [documentId],
    );
    expect(rows[0]?.n).toBe('0');
  });

  it('lists exactly the documents that record no arrival', async () => {
    // What `pnpm link:provenance --list` shows and what `--all-unrecorded`
    // walks. A document whose arrival was asserted drops off it, so running the
    // command twice is a no-op rather than a second pass of refusals.
    const opened = await store.openCase({
      orgId,
      claimId: `ARR-${suffix}-4`,
      deductionAmountCents: 19_000,
    });
    const waiting = await legacyNotice(opened.deductionId);
    await ingestedNotice(opened.deductionId);

    const before = await store.documentsWithoutArrival();
    expect(before.map((row) => row.documentId)).toContain(waiting);
    const listed = before.find((row) => row.documentId === waiting);
    expect(listed?.deductionIds).toContain(opened.deductionId);

    await store.recordDocumentArrival({
      documentId: waiting,
      source: 'web_upload',
      recordedBy: analystId,
    });
    const after = await store.documentsWithoutArrival();
    expect(after.map((row) => row.documentId)).not.toContain(waiting);
  });

  it('caps that list, and refuses a limit it will not answer', async () => {
    // Same cap and same refusal as `unreadDocuments`, from the same function:
    // an unbounded `select` is a query whose cost is set by the tenant's history
    // rather than by the caller, and this one is read by a script that prints
    // every row before asserting anything. A caller cannot be right about one
    // list and wrong about the other.
    const opened = await store.openCase({
      orgId,
      claimId: `ARR-${suffix}-5`,
      deductionAmountCents: 8_000,
    });
    await legacyNotice(opened.deductionId);
    await legacyNotice(opened.deductionId);

    const one = await store.documentsWithoutArrival(1);
    expect(one).toHaveLength(1);
    const unlimited = await store.documentsWithoutArrival();
    expect(unlimited.length).toBeGreaterThan(1);
    // Oldest first, so the page an operator walks is the front of the history.
    expect(one[0]?.documentId).toBe(unlimited[0]?.documentId);

    await expect(store.documentsWithoutArrival(0)).rejects.toBeInstanceOf(
      UnreadDocumentsQueryError,
    );
    await expect(store.documentsWithoutArrival(201)).rejects.toBeInstanceOf(
      UnreadDocumentsQueryError,
    );
    await expect(store.documentsWithoutArrival(1.5)).rejects.toBeInstanceOf(
      UnreadDocumentsQueryError,
    );
  });
});

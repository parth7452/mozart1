import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  AlreadyDeclinedError,
  closeAllPools,
  PostgresStore,
  ProvenanceUnknownError,
} from '../src/store';

const connectionString = process.env.DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

/**
 * The name the racing stores connect under, so the poll below can see exactly
 * their two backends and nothing else. `pg_stat_activity` is server-wide and
 * this suite shares a database with every other Postgres test file, so counting
 * "backends waiting on a lock" without this would count theirs too — and open
 * the gate early, which is how a concurrency test starts passing by accident.
 */
const RACE_APP_NAME = 'recouple-decline-race';

/**
 * Waits until both racing backends are blocked on a lock, and reports how many
 * it found.
 *
 * Polled rather than slept on: a fixed delay is either flaky on a slow machine
 * or wasted on a fast one. It returns what it saw when it gave up rather than
 * throwing, so the test can assert on it — a race that never happened has to
 * fail, not pass quietly.
 */
async function waitForRacersBlocked(
  want: number,
  admin: Pool,
  deadlineMs = 10_000,
): Promise<number> {
  const until = Date.now() + deadlineMs;
  let seen = 0;
  while (Date.now() < until) {
    const { rows } = await admin.query<{ waiting: string }>(
      `select count(*)::text as waiting
         from pg_stat_activity
        where datname = current_database()
          and application_name = $1
          and wait_event_type = 'Lock'`,
      [RACE_APP_NAME],
    );
    seen = Number(rows[0]?.waiting ?? 0);
    if (seen >= want) return seen;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return seen;
}

/**
 * Declining a case writes a row, it does not remove one.
 *
 * Coverage is a ratio of dollars: what we recovered over what was there to
 * recover. Deleting the cases we chose not to fight would raise that ratio
 * every time we gave up, so a decline has to leave behind what it was worth and
 * what was missing (docs/STRATEGY.md, ADD-1).
 */
describeDb('declining a case', () => {
  const admin = new Pool({ connectionString });
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const analystId = randomUUID();
  const readerId = randomUUID();
  const otherAnalystId = randomUUID();
  const suffix = orgId.slice(0, 8);
  let store: PostgresStore;
  let deductionId: string;
  // A second case, never declined, so the tests about who may decline are not
  // answered by the case already having been declined.
  let undeclinedId: string;
  /** The notice on the first case, whose `uploads` row is what is derived from. */
  let noticeDocumentId: string;
  let documents = 0;

  beforeAll(async () => {
    await admin.query(
      `insert into organizations (id, slug, name) values ($1,$2,'Decline'), ($3,$4,'Decline Other')`,
      [orgId, `dec-${suffix}`, otherOrgId, `dec-other-${suffix}`],
    );
    await admin.query(`insert into org_settings (org_id) values ($1), ($2)`, [orgId, otherOrgId]);
    await admin.query(`insert into users (id, email) values ($1,$2), ($3,$4), ($5,$6)`, [
      analystId, `dec-a-${suffix}@example.test`,
      readerId, `dec-r-${suffix}@example.test`,
      otherAnalystId, `dec-o-${suffix}@example.test`,
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
    const opened = await store.openCase({ orgId, claimId: 'APDP-1', deductionAmountCents: 312_000 });
    deductionId = opened.deductionId;
    noticeDocumentId = await attachNotice(deductionId, 'web_upload');
    const second = await store.openCase({
      orgId,
      claimId: 'APDP-2',
      deductionAmountCents: 45_000,
    });
    undeclinedId = second.deductionId;
    await attachNotice(undeclinedId, 'web_upload');
  });

  /**
   * A notice on a case, arriving the way one arrives: the `uploads` row first,
   * then the bytes that name it.
   *
   * Every case in this file gets one, because a decline is attributed to the
   * channel its notice arrived through and a case with no notice is refused.
   * That refusal has its own tests below; the rest of the suite is about what
   * happens when the provenance is there.
   */
  async function attachNotice(
    caseId: string,
    source: 'web_upload' | 'email_in',
    options: { readonly recordArrival?: boolean } = {},
  ): Promise<string> {
    documents += 1;
    const upload =
      options.recordArrival === false
        ? undefined
        : await store.recordUpload({
            orgId,
            source,
            // Email has no member behind it; a web upload does.
            ...(source === 'web_upload' ? { createdBy: analystId } : {}),
          });
    const stored = await store.putDocument({
      orgId,
      sha256: `${suffix}${documents}`.padEnd(64, 'a').slice(0, 64),
      filename: `notice-${documents}.pdf`,
      mimeType: 'application/pdf',
      byteSize: 1024,
      bytes: new Uint8Array([37, 80, 68, 70]),
      ...(upload !== undefined ? { uploadId: upload.uploadId } : {}),
      requiresSplit: false,
    });
    await store.linkDocument(caseId, stored.documentId, 'notice');
    return stored.documentId;
  }

  /**
   * A notice with its `created_at` and its id chosen, rather than left to the
   * clock and to `gen_random_uuid()`.
   *
   * Written through the admin pool because neither of those is settable through
   * the store, and neither can be corrected afterwards: `documents` is
   * append-only (migration 0004), so the row has to be right when it is
   * inserted. The two tests below are about which of several notices the
   * derivation picks, and both need the ordering to be a fact rather than a
   * coincidence of when the inserts happened to run.
   */
  async function attachNoticeAs(
    caseId: string,
    options: {
      readonly documentId: string;
      readonly createdAt: string;
      /** `null` records no arrival at all — a document stored before provenance. */
      readonly source: 'web_upload' | 'email_in' | null;
    },
  ): Promise<string> {
    documents += 1;
    let uploadId: string | null = null;
    if (options.source !== null) {
      const upload = await store.recordUpload({
        orgId,
        source: options.source,
        ...(options.source === 'web_upload' ? { createdBy: analystId } : {}),
      });
      uploadId = upload.uploadId;
    }
    await admin.query(
      `insert into documents
         (id, org_id, sha256, byte_size, mime_type, storage_ref, filename, upload_id, created_at)
       values ($1, $2, $3, 1024, 'application/pdf', $4, $5, $6, $7)`,
      [
        options.documentId,
        orgId,
        Buffer.from(`${suffix}${documents}`.padEnd(64, 'b').slice(0, 64), 'hex'),
        `doc/${options.documentId}`,
        `notice-${documents}.pdf`,
        uploadId,
        options.createdAt,
      ],
    );
    await store.linkDocument(caseId, options.documentId, 'notice');
    return options.documentId;
  }

  afterAll(async () => {
    await closeAllPools();
    await store?.close();
    await admin.end();
  });

  it('records what the case was worth, taken from the case rather than the caller', async () => {
    const declined = await store.declineCase({
      deductionId,
      reason: 'below_economic_floor',
      decidedBy: `dec-a-${suffix}@example.test`,
      missingEvidence: ['proof_of_delivery'],
      detail: 'Recovery would not cover the work.',
    });

    // What it was worth is a fact about the case. A reviewer does not get to
    // type a number that later gets added up as coverage.
    expect(declined.estimatedRecoverableCents).toBe(312_000);
    expect(declined.reason).toBe('below_economic_floor');
    expect(declined.missingEvidence).toEqual(['proof_of_delivery']);
    expect(declined.decidedByVersion).toBe('human/v1');
  });

  it('leaves the case itself standing — a decline is not a delete', async () => {
    const stillThere = await store.getCase(deductionId);
    expect(stillThere?.deductionId).toBe(deductionId);
  });

  it('takes the channel off the notice’s own arrival rather than from the caller', async () => {
    // The deliberate inverse of the test that used to be here. That one pinned
    // the honest state of the day — `uploads` had zero rows, nothing recorded
    // where a document came from, and `discovered_from` was whatever the caller
    // assumed — and said in as many words that it should be replaced by this
    // one when ingest started recording provenance. It has.
    //
    // So the claim is now the opposite claim, and it is stronger: the row
    // exists, the notice points at it, and the channel stored against the
    // decline is the channel that row records. Nothing was passed in — the
    // parameter is gone.
    const { rows } = await admin.query<{
      discovered_from: string;
      upload_id: string | null;
      upload_source: string | null;
      created_by: string | null;
    }>(
      `select dc.discovered_from, doc.upload_id, u.source as upload_source, u.created_by
         from declined_candidates dc
         join documents doc on doc.id = $2
         left join uploads u on u.id = doc.upload_id
        where dc.deduction_id = $1`,
      [deductionId, noticeDocumentId],
    );
    expect(rows[0]?.upload_id).not.toBeNull();
    expect(rows[0]?.upload_source).toBe('web_upload');
    // The person who uploaded it, by the id the session resolved.
    expect(rows[0]?.created_by).toBe(analystId);
    // And the decline is counted under that same word, not a similar one.
    expect(rows[0]?.discovered_from).toBe(rows[0]?.upload_source);
  });

  it('refuses a case whose notice records no arrival, rather than defaulting it', async () => {
    // The old fallback's replacement. A document stored before provenance
    // existed says nothing about where it came from, and `discovered_from` is
    // what coverage is grouped by — so the choice is between a row under a
    // guessed channel and no row at all. A wrong number that looks right is
    // worse than a refusal somebody has to act on.
    const orphan = await store.openCase({
      orgId,
      claimId: `APDP-NO-UPLOAD-${suffix}`,
      deductionAmountCents: 91_000,
    });
    const documentId = await attachNotice(orphan.deductionId, 'web_upload', {
      recordArrival: false,
    });

    const refusal = store.declineCase({
      deductionId: orphan.deductionId,
      reason: 'below_economic_floor',
      decidedBy: `dec-a-${suffix}@example.test`,
    });
    await expect(refusal).rejects.toBeInstanceOf(ProvenanceUnknownError);
    // It names the document somebody would have to go and look at.
    await expect(refusal).rejects.toMatchObject({ noticeDocumentId: documentId });

    // Refused, and nothing written: no row in the log and nothing on the case's
    // timeline claiming it was given up on.
    const { rows } = await admin.query<{ declines: string; events: string }>(
      `select (select count(*)::text from declined_candidates where deduction_id = $1) as declines,
              (select count(*)::text from deduction_events
                where deduction_id = $1 and event_type = 'case.declined') as events`,
      [orphan.deductionId],
    );
    expect(rows[0]?.declines).toBe('0');
    expect(rows[0]?.events).toBe('0');
  });

  it('refuses a case with no notice at all, and says that is what is wrong', async () => {
    // A different fault from the one above, and told apart on purpose: this is
    // a case assembled wrong, not a document stored before provenance existed.
    const bare = await store.openCase({
      orgId,
      claimId: `APDP-NO-NOTICE-${suffix}`,
      deductionAmountCents: 12_000,
    });
    const refusal = store.declineCase({
      deductionId: bare.deductionId,
      reason: 'below_economic_floor',
      decidedBy: `dec-a-${suffix}@example.test`,
    });
    await expect(refusal).rejects.toBeInstanceOf(ProvenanceUnknownError);
    await expect(refusal).rejects.toThrow(/no notice document/);
    await expect(refusal).rejects.toMatchObject({ noticeDocumentId: undefined });
  });

  it('breaks a tie between two notices stored at the same instant, whichever was written first', async () => {
    // `documents.created_at` defaults to `now()`, which is the transaction's
    // start time — so two notices attached inside one transaction carry the
    // identical timestamp, and there is nothing exotic about that: a future
    // ingest that stores an email's two attachments together would do it.
    //
    // `order by created_at` alone leaves `limit 1` to pick whichever row the
    // plan reached first. Today that is stable by luck: the unique index on
    // `deduction_documents (deduction_id, document_id, role)` hands the rows
    // over in document-id order, so the lower id wins without anybody asking
    // for it. Under a sequential scan — a smaller table, a different planner, a
    // dropped index — it is insertion order instead, and the channel a case is
    // counted under changes with the plan. `doc.id asc` makes it a fact rather
    // than a coincidence.
    //
    // Both orders are exercised for exactly that reason. A single case would
    // agree with whichever rule happened to apply; a pair cannot, because no
    // insertion-order rule gives the same answer to both.
    const sameInstant = '2026-09-19T12:00:00Z';
    // Built from this run's suffix rather than hard-coded: `documents.id` is a
    // primary key across the whole database, and a literal would collide the
    // second time this suite ran against the same one. Within each pair the ids
    // differ by one hex digit, so which is lower is not in question.
    const pairs = [
      { tag: 'higher-first', first: 'f', second: 'a' },
      { tag: 'lower-first', first: 'a', second: 'f' },
    ] as const;

    for (const [index, pair] of pairs.entries()) {
      const tied = await store.openCase({
        orgId,
        claimId: `APDP-TIE-${index}-${suffix}`,
        deductionAmountCents: 77_000,
      });
      const idFor = (digit: string): string =>
        `${suffix}-0000-4000-8000-00000000${index}00${digit}`;
      // Different channels, so which notice is picked shows up in the stored
      // row rather than being a distinction without a difference. The *lower*
      // id is the email in both pairs, so a pass cannot come from the
      // derivation quietly preferring `web_upload`.
      const channelFor = (digit: string): 'web_upload' | 'email_in' =>
        digit === 'a' ? 'email_in' : 'web_upload';
      await attachNoticeAs(tied.deductionId, {
        documentId: idFor(pair.first),
        createdAt: sameInstant,
        source: channelFor(pair.first),
      });
      await attachNoticeAs(tied.deductionId, {
        documentId: idFor(pair.second),
        createdAt: sameInstant,
        source: channelFor(pair.second),
      });

      const declined = await store.declineCase({
        deductionId: tied.deductionId,
        reason: 'below_economic_floor',
        decidedBy: `dec-a-${suffix}@example.test`,
      });
      // The lower id wins, whichever of the two was written first.
      expect(`${pair.tag}: ${declined.discoveredFrom}`).toBe(`${pair.tag}: email_in`);

      // And the stored row says what the return value did — one row, under the
      // channel the lower id arrived through.
      const { rows } = await admin.query<{ discovered_from: string }>(
        `select discovered_from from declined_candidates where deduction_id = $1`,
        [tied.deductionId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.discovered_from).toBe('email_in');
    }
  });

  it('refuses when the earliest notice predates provenance, even though a later one records a channel', async () => {
    // The policy, pinned. The derivation takes the *earliest* notice, not the
    // earliest one that happens to know: the first arrival is how the deduction
    // reached us, and a later notice is a copy of something we already had.
    // Crediting the copy's channel would attribute the case to whoever re-sent
    // it, which is the same misattribution `ingestDocument` refuses when it
    // declines to write a second `uploads` row for bytes it already has.
    //
    // So this refuses, and it is meant to. Relaxing it to "the earliest notice
    // that has an arrival" would make every pre-provenance case declinable the
    // moment somebody re-uploaded its notice — quietly, under a channel that
    // describes the re-upload rather than the discovery. That is a coverage
    // number moving because of an administrative act, and this test is what
    // stops it being made to look like a fix.
    const legacy = await store.openCase({
      orgId,
      claimId: `APDP-LEGACY-${suffix}`,
      deductionAmountCents: 64_000,
    });
    const first = await attachNoticeAs(legacy.deductionId, {
      documentId: `${suffix}-0000-4000-8000-0000000000c1`,
      createdAt: '2026-09-01T09:00:00Z',
      source: null,
    });
    await attachNoticeAs(legacy.deductionId, {
      documentId: `${suffix}-0000-4000-8000-0000000000c2`,
      createdAt: '2026-09-02T09:00:00Z',
      source: 'web_upload',
    });

    const refusal = store.declineCase({
      deductionId: legacy.deductionId,
      reason: 'below_economic_floor',
      decidedBy: `dec-a-${suffix}@example.test`,
    });
    await expect(refusal).rejects.toBeInstanceOf(ProvenanceUnknownError);
    // It names the earliest notice, which is the one with nothing behind it —
    // not the later one, whose channel it declined to borrow.
    await expect(refusal).rejects.toMatchObject({ noticeDocumentId: first });
    // And it says the one true thing about it. That sentence changed with ADR
    // 0024 and it changed in one direction: nobody can set `upload_id` on an
    // append-only `documents` row, but an operator can now record the arrival
    // beside it, so the refusal names the command instead of naming a migration
    // that had not been written.
    await expect(refusal).rejects.toThrow(/predates provenance recording/);
    await expect(refusal).rejects.toThrow(/pnpm link:provenance/);

    // Nothing written, on either count.
    const { rows } = await admin.query<{ declines: string; events: string }>(
      `select (select count(*)::text from declined_candidates where deduction_id = $1) as declines,
              (select count(*)::text from deduction_events
                where deduction_id = $1 and event_type = 'case.declined') as events`,
      [legacy.deductionId],
    );
    expect(rows[0]?.declines).toBe('0');
    expect(rows[0]?.events).toBe('0');
  });

  it('writes exactly one row and one event, and touches nothing else', async () => {
    // Append-only, and appended once. A second decline would be a second row —
    // the pair being the history — but one decline must not write two.
    const { rows } = await admin.query<{ declines: string; events: string }>(
      `select (select count(*)::text from declined_candidates where deduction_id = $1) as declines,
              (select count(*)::text from deduction_events
                where deduction_id = $1 and event_type = 'case.declined') as events`,
      [deductionId],
    );
    expect(rows[0]?.declines).toBe('1');
    expect(rows[0]?.events).toBe('1');

    // The event says what the row says, so the case's own timeline is enough to
    // know what was given up and what it was worth.
    const { rows: events } = await admin.query<{ payload: Record<string, unknown> }>(
      `select payload from deduction_events
        where deduction_id = $1 and event_type = 'case.declined'`,
      [deductionId],
    );
    expect(events[0]?.payload).toMatchObject({
      reason: 'below_economic_floor',
      discovered_from: 'web_upload',
      decided_by_version: 'human/v1',
    });

    // The amount is checked against the row rather than against a literal,
    // because the two being equal is the actual claim — the event and the row
    // are one write and a reviewer reading the timeline is reading the same
    // dollars coverage adds up. A literal here would have gone on passing
    // while the payload was going through `Number()`: 312000 survives that,
    // and the cents on a case big enough to matter would not.
    const { rows: amounts } = await admin.query<{ cents: string }>(
      `select estimated_recoverable_cents::text as cents
         from declined_candidates where deduction_id = $1`,
      [deductionId],
    );
    const stored = amounts[0]?.cents;
    expect(stored).toBe('312000');
    // Digit for digit, whatever the payload's JSON type turns out to be.
    expect(String(events[0]?.payload.estimated_recoverable_cents)).toBe(stored);
  });

  it('refuses a second decline, because coverage would count the dollars twice', async () => {
    // `coverage_by_period` sums every declined row. A double-clicked form would
    // otherwise move the one number this feature exists to produce.
    await expect(
      store.declineCase({
        deductionId,
        reason: 'deadline_passed',
        decidedBy: `dec-a-${suffix}@example.test`,
      }),
    ).rejects.toThrow(AlreadyDeclinedError);

    const { rows } = await admin.query<{ declines: string }>(
      `select count(*)::text as declines from declined_candidates where deduction_id = $1`,
      [deductionId],
    );
    expect(rows[0]?.declines).toBe('1');
  });

  it('lets exactly one of two simultaneous declines through', async () => {
    // The check and the insert are one transaction, but READ COMMITTED alone
    // does not make them one decision: two requests can both read no declined
    // row and both insert one, and `coverage_by_period` would then count this
    // case's dollars twice. The fix is the row lock the read takes on the case
    // (`for update of d`), and this is the test that notices it being dropped.
    //
    // Two stores, because two requests are two stores: a web request builds its
    // own `PostgresStore`, and they share a pool rather than a connection.
    const raced = await store.openCase({
      orgId,
      claimId: `APDP-RACE-${suffix}`,
      deductionAmountCents: 128_000,
    });
    // With its notice, so both racers get as far as the insert. A case with no
    // provenance is refused before the lock matters, which would make this
    // test pass for the wrong reason.
    await attachNotice(raced.deductionId, 'web_upload');
    // Tagged so the poll below can find exactly these two backends. A
    // different connection string is also a different pool, which is fine:
    // `closeAllPools()` in `afterAll` ends every one of them.
    const raceUrl = `${connectionString as string}${
      (connectionString as string).includes('?') ? '&' : '?'
    }application_name=${RACE_APP_NAME}`;
    const one = new PostgresStore({ connectionString: raceUrl }, { orgId, userId: analystId });
    const two = new PostgresStore({ connectionString: raceUrl }, { orgId, userId: analystId });
    // A third connection holds the case row so both declines are still in
    // flight when it lets go. Racing them with `Promise.allSettled` alone does
    // not race them: the first store finds an idle pooled connection and is
    // committed before the second has finished its TCP handshake, so the test
    // passed with the lock removed. A starting gun makes the overlap a fact
    // rather than a hope.
    const gate = await admin.connect();

    try {
      const decline = (from: PostgresStore, reason: 'other' | 'deadline_passed') =>
        from.declineCase({
          deductionId: raced.deductionId,
          reason,
          decidedBy: `dec-a-${suffix}@example.test`,
        });

      await gate.query('begin');
      await gate.query('select id from deductions where id = $1 for update', [raced.deductionId]);

      const settled = Promise.allSettled([decline(one, 'other'), decline(two, 'deadline_passed')]);

      // Both are waiting on the case row before the gate opens — on the lock
      // this fix takes, or, if it were removed, on the key-share lock their
      // `declined_candidates` insert needs for the foreign key. Either way
      // they are both past their read of `declined_candidates`, which is the
      // overlap the double-count needs.
      const waiting = await waitForRacersBlocked(2, admin);
      expect(waiting).toBe(2);

      await gate.query('commit');
      const results = await settled;

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(AlreadyDeclinedError);

      // The number this whole feature exists to produce: one row, not two.
      const { rows } = await admin.query<{ declines: string }>(
        `select count(*)::text as declines
           from declined_candidates where deduction_id = $1`,
        [raced.deductionId],
      );
      expect(rows[0]?.declines).toBe('1');

      // And the case's timeline says it once, for the same reason.
      const { rows: events } = await admin.query<{ events: string }>(
        `select count(*)::text as events from deduction_events
          where deduction_id = $1 and event_type = 'case.declined'`,
        [raced.deductionId],
      );
      expect(events[0]?.events).toBe('1');
    } finally {
      await gate.query('rollback').catch(() => undefined);
      gate.release();
      await one.close();
      await two.close();
    }
  });

  it('refuses an evidence type nothing could ever add up', async () => {
    await expect(
      store.declineCase({
        deductionId: undeclinedId,
        reason: 'evidence_unavailable',
        decidedBy: `dec-a-${suffix}@example.test`,
        // Not a canonical type. The column is a plain text[], so nothing below
        // this would refuse it and nothing above would ever count it.
        missingEvidence: ['no POD' as never],
      }),
    ).rejects.toThrow(/add up/);

    const { rows } = await admin.query<{ declines: string }>(
      `select count(*)::text as declines from declined_candidates where deduction_id = $1`,
      [undeclinedId],
    );
    expect(rows[0]?.declines).toBe('0');
  });

  it('refuses a reader, because the write policy does not care what the UI showed', async () => {
    const reader = new PostgresStore(
      { connectionString: connectionString as string },
      { orgId, userId: readerId },
    );
    try {
      // A case nobody has declined, so this is the policy refusing the insert
      // rather than the one-decline-per-case check getting there first.
      await expect(
        reader.declineCase({
          deductionId: undeclinedId,
          reason: 'other',
          decidedBy: `dec-r-${suffix}@example.test`,
        }),
      ).rejects.toThrow(/row-level security|permission denied/i);
    } finally {
      await reader.close();
    }
  });

  it('cannot decline another tenant’s case, and does not leak that it exists', async () => {
    const other = new PostgresStore(
      { connectionString: connectionString as string },
      { orgId: otherOrgId, userId: otherAnalystId },
    );
    try {
      await expect(
        other.declineCase({
          deductionId,
          reason: 'other',
          decidedBy: `dec-o-${suffix}@example.test`,
        }),
      ).rejects.toThrow(/not visible to this tenant/);
    } finally {
      await other.close();
    }
  });
});

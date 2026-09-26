import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  CaseNotVisibleError,
  DuplicateCaseError,
  DuplicateVerdictAlreadyRecordedError,
  NoSuchDuplicatePairError,
  WrongRoleError,
} from '@recouple/pipeline';
import { closeAllPools, PostgresStore } from '../src/store';

const connectionString = process.env.TEST_DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

/**
 * The pairs identity resolution hands to a person, and what a person can say
 * about one (ADR 0032).
 *
 * `resolveIdentity` merges on an exact identifier match and nothing else. A
 * probable match opens the case anyway and records `case.possible_duplicate`
 * naming the other deduction, because a second case is visible and a wrong
 * merge is not (ADR 0025 §6). Until this existed nothing read that event, so
 * the pair stopped nowhere at all.
 *
 * Every pair here is produced by the real `openCase` rather than by an event
 * written in the test, so what is under test is the shape the pipeline actually
 * creates. Everything runs through `PostgresStore` as `app_rw` under the real
 * policies, because "this tenant cannot see the other half" is a claim about
 * the database and not about our code.
 */
describeDb('possible duplicates: the pairs a person answers', () => {
  const admin = new Pool({ connectionString });
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const userId = randomUUID();
  const readerId = randomUUID();
  const suffix = orgId.slice(0, 8);
  let store: PostgresStore;
  /** The same tenant, seen by a member whose role may not write. */
  let readOnlyStore: PostgresStore;
  /** Another tenant entirely, for the halves this one may not see. */
  let otherStore: PostgresStore;
  let debtorId: string;
  let otherDebtorId: string;

  beforeAll(async () => {
    for (const [id, slug] of [
      [orgId, `dupes-${suffix}`],
      [otherOrgId, `dupes-other-${suffix}`],
    ] as const) {
      await admin.query(`insert into organizations (id, slug, name) values ($1,$2,'Duplicates')`, [
        id,
        slug,
      ]);
      await admin.query(`insert into org_settings (org_id) values ($1)`, [id]);
    }
    await admin.query(`insert into users (id, email) values ($1,$2), ($3,$4)`, [
      userId,
      `dupes-${suffix}@example.test`,
      readerId,
      `dupes-reader-${suffix}@example.test`,
    ]);
    await admin.query(
      `insert into memberships (org_id, user_id, role)
       values ($1,$2,'analyst'), ($1,$3,'read_only'), ($4,$2,'analyst')`,
      [orgId, userId, readerId, otherOrgId],
    );
    const { rows } = await admin.query<{ id: string }>(
      `insert into debtors (org_id, retailer_key, display_name)
       values ($1, 'walmart_apdp', 'Walmart (APDP)') returning id`,
      [orgId],
    );
    debtorId = rows[0]?.id as string;
    const { rows: otherRows } = await admin.query<{ id: string }>(
      `insert into debtors (org_id, retailer_key, display_name)
       values ($1, 'walmart_apdp', 'Walmart (APDP)') returning id`,
      [otherOrgId],
    );
    otherDebtorId = otherRows[0]?.id as string;

    store = new PostgresStore({ connectionString: connectionString as string }, { orgId, userId });
    readOnlyStore = new PostgresStore(
      { connectionString: connectionString as string },
      { orgId, userId: readerId },
    );
    otherStore = new PostgresStore(
      { connectionString: connectionString as string },
      { orgId: otherOrgId, userId },
    );
  });

  afterAll(async () => {
    await closeAllPools();
    await store?.close();
    await readOnlyStore?.close();
    await otherStore?.close();
    await admin.end();
  });

  /**
   * A probable pair, opened the way the pipeline opens one: a case we already
   * hold whose invoice is recorded as an identifier, and a notice that agrees
   * with it on invoice, amount and date but prints a claim id of its own.
   *
   * The second call goes through the real `openCase`, so `resolveIdentity`
   * decides this is probable and the `case.possible_duplicate` event is the
   * pipeline's own rather than one seeded here.
   */
  async function probablePair(
    label: string,
    options?: { readonly orgId?: string; readonly debtorId?: string; readonly store?: PostgresStore },
  ): Promise<{ older: string; newer: string; invoiceNumber: string; claimId: string }> {
    const tenant = options?.orgId ?? orgId;
    const owner = options?.debtorId ?? debtorId;
    const writer = options?.store ?? store;
    const seeded = randomUUID();
    const invoiceNumber = `INV-${suffix}-${label}`;
    await admin.query(
      `insert into deductions (id, org_id, debtor_id, claim_id, deduction_amount_cents, deduction_date)
       values ($1,$2,$3,$4,42150,'2026-07-02')`,
      [seeded, tenant, owner, `APDP-${suffix}-${label}-held`],
    );
    await admin.query(
      `insert into deduction_identifiers (org_id, deduction_id, source, identifier_kind, identifier)
       values ($1,$2,'erp_sync','invoice_number',$3)`,
      [tenant, seeded, invoiceNumber],
    );

    const claimId = `APDP-${suffix}-${label}-new`;
    const opened = await writer.openCase({
      orgId: tenant,
      claimId,
      invoiceNumber,
      source: 'web_upload',
      retailerName: 'Walmart (APDP)',
      deductionAmountCents: 42_150,
      deductionDate: '2026-07-05',
    });
    return { older: seeded, newer: opened.deductionId, invoiceNumber, claimId };
  }

  async function verdictEvents(deductionId: string) {
    const { rows } = await admin.query<{
      event_type: string;
      payload: Record<string, unknown>;
      created_by: string | null;
    }>(
      `select event_type, payload, created_by::text as created_by
         from deduction_events
        where deduction_id = $1
          and event_type in ('case.duplicate_confirmed', 'case.duplicate_dismissed')
        order by id asc`,
      [deductionId],
    );
    return rows;
  }

  it('lists a probable pair, older first, with the basis and both summaries', async () => {
    const pair = await probablePair('listed');

    const pairs = await store.possibleDuplicates();
    const found = pairs.find((candidate) => candidate.older.deductionId === pair.older);

    expect(found).toBeDefined();
    // Which facts agreed — never what they said (invariant 4).
    expect(found?.basis).toEqual([
      'invoice_number',
      'amount_cents',
      'deduction_date',
      'debtor_id',
    ]);
    // The basis names facts; the summary beside it is where a value belongs.
    expect(JSON.stringify(found?.basis)).not.toContain(pair.invoiceNumber);
    expect(JSON.stringify(found?.basis)).not.toContain('42150');
    expect(found?.newer.deductionId).toBe(pair.newer);
    // Enough of each side to tell them apart, in integer cents.
    expect(found?.older.deductionAmountCents).toBe(42_150);
    expect(found?.newer.claimId).toBe(pair.claimId);
    expect(found?.newer.retailer).toBe('Walmart (APDP)');
    expect(found?.newer.retailerMatched).toBe(true);
    expect(found?.older.invoiceNumber).toBe(pair.invoiceNumber);
    expect(found?.older.state).toBe('discovered');
    // The older one is the case we already held, whichever side the event was
    // written on.
    expect(new Date(found?.older.openedAt as string).getTime()).toBeLessThanOrEqual(
      new Date(found?.newer.openedAt as string).getTime(),
    );
  });

  it('answers one case’s pairs without the rest of the tenant’s', async () => {
    const mine = await probablePair('mine');
    const theirs = await probablePair('theirs');

    const pairs = await store.possibleDuplicates({ deductionId: mine.newer });

    expect(pairs.map((pair) => pair.newer.deductionId)).toEqual([mine.newer]);
    expect(pairs.map((pair) => pair.newer.deductionId)).not.toContain(theirs.newer);
  });

  it('drops a pair a person dismissed, and records it on both cases', async () => {
    const pair = await probablePair('dismissed');

    const recorded = await store.recordDuplicateVerdict({
      deductionId: pair.newer,
      otherDeductionId: pair.older,
      verdict: 'different',
      recordedBy: userId,
    });

    expect(recorded.verdict).toBe('different');
    // Which one a confirmation would have kept, said on a dismissal too, so a
    // reader does not have to work out which way round the pair was.
    expect(recorded.survivingDeductionId).toBe(pair.older);

    // One event per case, each naming the other, each by the person who said so.
    const onNewer = await verdictEvents(pair.newer);
    const onOlder = await verdictEvents(pair.older);
    expect(onNewer).toHaveLength(1);
    expect(onOlder).toHaveLength(1);
    expect(onNewer[0]?.event_type).toBe('case.duplicate_dismissed');
    expect(onNewer[0]?.payload.of).toBe(pair.older);
    expect(onOlder[0]?.payload.of).toBe(pair.newer);
    expect(onNewer[0]?.created_by).toBe(userId);
    expect(onNewer[0]?.payload.recorded_by).toBe(userId);
    // A dismissal says nothing survives anything: they are two deductions.
    expect(onNewer[0]?.payload.surviving_deduction_id).toBeUndefined();

    const pairs = await store.possibleDuplicates();
    expect(pairs.map((candidate) => candidate.newer.deductionId)).not.toContain(pair.newer);
  });

  it('drops a pair a person confirmed, and leaves the exact match exactly as it was', async () => {
    const pair = await probablePair('confirmed');

    const recorded = await store.recordDuplicateVerdict({
      deductionId: pair.newer,
      otherDeductionId: pair.older,
      verdict: 'same',
      recordedBy: userId,
    });

    expect(recorded.verdict).toBe('same');
    expect(recorded.survivingDeductionId).toBe(pair.older);
    const onOlder = await verdictEvents(pair.older);
    expect(onOlder[0]?.event_type).toBe('case.duplicate_confirmed');
    expect(onOlder[0]?.payload.surviving_deduction_id).toBe(pair.older);

    expect(
      (await store.possibleDuplicates()).map((candidate) => candidate.newer.deductionId),
    ).not.toContain(pair.newer);

    // The identifiers are untouched and still resolve, through the real path:
    // the same claim id arriving again is an *exact* match on the case that
    // holds it, refused by name rather than opened as a third case. A
    // confirmation records what a person concluded; it does not re-point an
    // identifier, which append-only plus the per-source unique constraint make
    // impossible anyway (ADR 0032 §5).
    const again = store.openCase({
      orgId,
      claimId: pair.claimId,
      source: 'web_upload',
      retailerName: 'Walmart (APDP)',
      deductionAmountCents: 42_150,
      deductionDate: '2026-07-05',
    });
    await expect(again).rejects.toThrow(DuplicateCaseError);
    await expect(again).rejects.toThrow(new RegExp(pair.newer));

    // And nothing moved: a verdict is not a state change (ADR 0032 §5).
    const { rows } = await admin.query<{ state: string }>(
      `select state from deductions where id in ($1,$2) order by created_at asc`,
      [pair.older, pair.newer],
    );
    expect(rows.map((row) => row.state)).toEqual(['discovered', 'discovered']);
  });

  it('refuses a second verdict on a pair that already has one', async () => {
    const pair = await probablePair('twice');
    await store.recordDuplicateVerdict({
      deductionId: pair.newer,
      otherDeductionId: pair.older,
      verdict: 'same',
      recordedBy: userId,
    });

    // The other way round, which is the same pair: a second answer would make
    // the list depend on which event it read first, and the events are
    // append-only so the first could never be corrected.
    const again = store.recordDuplicateVerdict({
      deductionId: pair.older,
      otherDeductionId: pair.newer,
      verdict: 'different',
      recordedBy: userId,
    });
    await expect(again).rejects.toThrow(DuplicateVerdictAlreadyRecordedError);
    await expect(again).rejects.toThrow(/already answered as one deduction/);

    // Still one verdict per case, not two.
    expect(await verdictEvents(pair.newer)).toHaveLength(1);
    expect(await verdictEvents(pair.older)).toHaveLength(1);
  });

  it('records one verdict when two answers land at the same moment', async () => {
    // The genuine race, not a double click. READ COMMITTED lets two
    // transactions both read no verdict and both write one, and there is no
    // unique index over "a pair" to catch the second — so the row locks on both
    // cases are what makes the check and the writes one decision. Taken in id
    // order, which is also why the two cannot deadlock waiting on each other.
    const pair = await probablePair('raced');

    const answers = await Promise.allSettled([
      store.recordDuplicateVerdict({
        deductionId: pair.newer,
        otherDeductionId: pair.older,
        verdict: 'same',
        recordedBy: userId,
      }),
      store.recordDuplicateVerdict({
        deductionId: pair.older,
        otherDeductionId: pair.newer,
        verdict: 'different',
        recordedBy: userId,
      }),
    ]);

    expect(answers.filter((answer) => answer.status === 'fulfilled')).toHaveLength(1);
    const refused = answers.find((answer) => answer.status === 'rejected');
    expect((refused as PromiseRejectedResult).reason).toBeInstanceOf(
      DuplicateVerdictAlreadyRecordedError,
    );
    // One answer, on each case, and the two agree about which it was.
    const onNewer = await verdictEvents(pair.newer);
    const onOlder = await verdictEvents(pair.older);
    expect(onNewer).toHaveLength(1);
    expect(onOlder).toHaveLength(1);
    expect(onNewer[0]?.event_type).toBe(onOlder[0]?.event_type);
  });

  it('refuses a verdict on two cases nothing named as a pair', async () => {
    const left = await probablePair('unrelated-left');
    const right = await probablePair('unrelated-right');

    await expect(
      store.recordDuplicateVerdict({
        deductionId: left.newer,
        otherDeductionId: right.newer,
        verdict: 'same',
        recordedBy: userId,
      }),
    ).rejects.toThrow(NoSuchDuplicatePairError);

    // A case is not a duplicate of itself either, and no event says it is.
    await expect(
      store.recordDuplicateVerdict({
        deductionId: left.newer,
        otherDeductionId: left.newer,
        verdict: 'same',
        recordedBy: userId,
      }),
    ).rejects.toThrow(NoSuchDuplicatePairError);

    expect(await verdictEvents(left.newer)).toEqual([]);
  });

  it('refuses a member whose role may read the cases but not write', async () => {
    const pair = await probablePair('read-only');

    await expect(
      readOnlyStore.recordDuplicateVerdict({
        deductionId: pair.newer,
        otherDeductionId: pair.older,
        verdict: 'same',
        recordedBy: readerId,
      }),
    ).rejects.toThrow(WrongRoleError);
    expect(await verdictEvents(pair.newer)).toEqual([]);
  });

  it('refuses a verdict naming somebody other than the session', async () => {
    const pair = await probablePair('not-me');

    await expect(
      store.recordDuplicateVerdict({
        deductionId: pair.newer,
        otherDeductionId: pair.older,
        verdict: 'same',
        recordedBy: readerId,
      }),
    ).rejects.toThrow(/cannot act as/);
    expect(await verdictEvents(pair.newer)).toEqual([]);
  });

  it('shows neither half of another tenant’s pair, and refuses a verdict on it', async () => {
    const theirs = await probablePair('other-tenant', {
      orgId: otherOrgId,
      debtorId: otherDebtorId,
      store: otherStore,
    });

    const pairs = await store.possibleDuplicates();
    const ids = pairs.flatMap((pair) => [pair.older.deductionId, pair.newer.deductionId]);
    expect(ids).not.toContain(theirs.older);
    expect(ids).not.toContain(theirs.newer);

    await expect(
      store.recordDuplicateVerdict({
        deductionId: theirs.newer,
        otherDeductionId: theirs.older,
        verdict: 'same',
        recordedBy: userId,
      }),
    ).rejects.toThrow(CaseNotVisibleError);

    // And the tenant that owns it still sees it, so the refusal above is RLS
    // rather than the read being broken.
    expect(
      (await otherStore.possibleDuplicates()).map((pair) => pair.newer.deductionId),
    ).toContain(theirs.newer);
  });

  it('will not list a pair whose other half belongs to another tenant', async () => {
    // A `case.possible_duplicate` naming a deduction this tenant cannot see.
    // The matcher cannot produce one — it reads identifiers through RLS — so it
    // is written here directly, which is the only way to ask whether the read
    // would show half a pair if one ever existed.
    const mine = randomUUID();
    const theirs = randomUUID();
    await admin.query(
      `insert into deductions (id, org_id, deduction_amount_cents) values ($1,$2,100)`,
      [mine, orgId],
    );
    await admin.query(
      `insert into deductions (id, org_id, deduction_amount_cents) values ($1,$2,100)`,
      [theirs, otherOrgId],
    );
    await admin.query(
      `insert into deduction_events (org_id, deduction_id, event_type, payload, event_time)
       values ($1,$2,'case.possible_duplicate',$3::jsonb, now())`,
      [orgId, mine, JSON.stringify({ of: theirs, basis: ['invoice_number'] })],
    );

    const pairs = await store.possibleDuplicates();
    expect(pairs.flatMap((pair) => [pair.older.deductionId, pair.newer.deductionId])).not.toContain(
      mine,
    );

    // And a verdict on it is refused on the half this tenant cannot see.
    await expect(
      store.recordDuplicateVerdict({
        deductionId: mine,
        otherDeductionId: theirs,
        verdict: 'same',
        recordedBy: userId,
      }),
    ).rejects.toThrow(CaseNotVisibleError);
  });

  it('refuses a limit that is not a number of pairs', async () => {
    // A `NaN` reaches the driver as a bind parameter that answers nothing at
    // all, and "nothing to answer" is the one reply this list must never give
    // wrongly.
    await expect(store.possibleDuplicates({ limit: Number.NaN })).rejects.toThrow(
      /positive integer/,
    );
    await expect(store.possibleDuplicates({ limit: 0 })).rejects.toThrow(/positive integer/);
  });
});

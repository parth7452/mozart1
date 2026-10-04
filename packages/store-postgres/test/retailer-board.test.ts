import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { rankForReview, type PayerGroup, type QueueCase } from '@recouple/core-domain';
import { closeAllPools, PostgresStore, type CaseSummary } from '../src/store';

const connectionString = process.env.TEST_DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

/**
 * The case list's board, on Postgres as `app_rw` under RLS.
 *
 * Every figure is worked out by hand from the cases below and compared to the
 * cent. What only the database can answer: that a debtor's cases are one group
 * whatever each notice printed, that two spellings of an unmatched name fold
 * into one, that a merged-away case is counted nowhere and its survivor once,
 * that a decline is neither open nor in dispute, that recovered is what each
 * outcome recorded, that the cases under a payer come in the review queue's
 * order, and that another tenant's cases are not there.
 */
describeDb('the retailer board, on Postgres', () => {
  const admin = new Pool({ connectionString });
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const emptyOrgId = randomUUID();
  const analystId = randomUUID();
  const readerId = randomUUID();
  const suffix = orgId.slice(0, 8);
  const today = new Date('2026-09-23T15:00:00Z');
  let store: PostgresStore;
  let readOnlyStore: PostgresStore;
  let otherStore: PostgresStore;
  let emptyStore: PostgresStore;
  let walmart: string;
  let kehe: string;
  const ids: Record<string, string> = {};

  function day(offset: number): string {
    return new Date(Date.UTC(2026, 8, 23) + offset * 86_400_000).toISOString().slice(0, 10);
  }

  /** Noon UTC on the day `offset` days from today, so its day is the same in any zone a test runs in. */
  function noon(offset: number): string {
    return `${day(offset)}T12:00:00Z`;
  }

  async function aCase(
    label: string,
    fields: {
      state: string;
      amount: number;
      debtor?: string;
      printed?: string;
      deadline?: number;
      deductionDate?: number;
      /** Days from today the case was opened; today when absent. */
      opened?: number;
      org?: string;
    },
  ): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `insert into deductions (org_id, debtor_id, retailer_name_as_printed, claim_id,
                               deduction_amount_cents, state, dispute_deadline, deduction_date,
                               created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)
       returning id`,
      [
        fields.org ?? orgId,
        fields.debtor ?? null,
        fields.printed ?? null,
        `RB-${suffix}-${label}`,
        fields.amount,
        fields.state,
        fields.deadline === undefined ? null : day(fields.deadline),
        fields.deductionDate === undefined ? null : day(fields.deductionDate),
        noon(fields.opened ?? 0),
      ],
    );
    const id = rows[0]?.id as string;
    ids[label] = id;
    return id;
  }

  /** What `recordOutcome` writes: the amount as text on an `outcome.recorded` event. */
  async function outcome(deductionId: string, outcome: string, recoveredCents: number) {
    await admin.query(
      `insert into deduction_events (org_id, deduction_id, event_type, payload, event_time)
       values ($1, $2, 'outcome.recorded', $3::jsonb, now())`,
      [orgId, deductionId, JSON.stringify({ outcome, recovered_cents: String(recoveredCents) })],
    );
  }

  async function decline(deductionId: string, amount: number): Promise<void> {
    await admin.query(
      `insert into declined_candidates (org_id, deduction_id, discovered_from, reason,
                                        estimated_recoverable_cents, decided_by, decided_by_version)
       values ($1, $2, 'web_upload', 'deduction_valid', $3, 'rb', 'human/v1')`,
      [orgId, deductionId, amount],
    );
  }

  beforeAll(async () => {
    for (const [id, slug] of [
      [orgId, `rb-${suffix}`],
      [otherOrgId, `rb-other-${suffix}`],
      [emptyOrgId, `rb-empty-${suffix}`],
    ] as const) {
      await admin.query(`insert into organizations (id, slug, name) values ($1,$2,'Board')`, [id, slug]);
      await admin.query(`insert into org_settings (org_id) values ($1)`, [id]);
    }
    await admin.query(`insert into users (id, email) values ($1,$2), ($3,$4)`, [
      analystId,
      `rb-a-${suffix}@example.test`,
      readerId,
      `rb-r-${suffix}@example.test`,
    ]);
    await admin.query(
      `insert into memberships (org_id, user_id, role)
       values ($1,$2,'analyst'), ($1,$3,'read_only'), ($4,$2,'analyst'), ($5,$2,'analyst')`,
      [orgId, analystId, readerId, otherOrgId, emptyOrgId],
    );
    const debtor = async (key: string, name: string, org = orgId) => {
      const { rows } = await admin.query<{ id: string }>(
        `insert into debtors (org_id, retailer_key, display_name) values ($1,$2,$3) returning id`,
        [org, key, name],
      );
      return rows[0]?.id as string;
    };
    walmart = await debtor('walmart', 'Walmart');
    kehe = await debtor('kehe', 'KeHE Distributors');

    // --- Walmart: one debtor, three printed spellings, every kind of case. ---
    await aCase('w-soon', { state: 'classified', amount: 10_000, debtor: walmart, printed: 'WALMART INC', deadline: 3 });
    await aCase('w-later', { state: 'awaiting_approval', amount: 20_000, debtor: walmart, printed: 'Wal-Mart Stores', deadline: 30 });
    await aCase('w-filed', { state: 'submitted', amount: 5_000, debtor: walmart, deadline: 1 });
    await outcome(await aCase('w-won', { state: 'won', amount: 7_000, debtor: walmart, deadline: -90 }), 'won', 7_000);
    await outcome(await aCase('w-partial', { state: 'partial', amount: 9_000, debtor: walmart }), 'partial', 4_000);
    await outcome(await aCase('w-lost', { state: 'lost', amount: 3_000, debtor: walmart }), 'lost', 0);
    await decline(
      await aCase('w-declined', { state: 'classified', amount: 2_500, debtor: walmart, deadline: 0 }),
      2_500,
    );
    // A confirmed duplicate, merged: the older case survives and is counted
    // once; the merged-away one is counted nowhere.
    await aCase('w-survivor', { state: 'classified', amount: 1_111, debtor: walmart, opened: -100 });
    await aCase('w-merged', { state: 'classified', amount: 1_111, debtor: walmart, opened: -1 });
    // Its claim id as an identifier, as `openCase` writes one: `db:test` on a
    // database these tests have used re-runs migration 0020's backfill, which
    // would otherwise try to write it on a merged-away case and be refused.
    await admin.query(
      `insert into deduction_identifiers (org_id, deduction_id, source, identifier_kind, identifier)
       values ($1,$2,'web_upload','claim_id',$3)`,
      [orgId, ids['w-merged'], `RB-${suffix}-w-merged`],
    );
    await admin.query(
      `insert into deduction_events (org_id, deduction_id, event_type, payload, event_time)
       values ($1,$2,'case.possible_duplicate',$3::jsonb,now())`,
      [orgId, ids['w-merged'], JSON.stringify({ of: ids['w-survivor'], basis: ['amount_cents'] })],
    );

    // --- KeHE: past its deadline, and a win nobody recorded an amount for. ---
    await aCase('k-past', { state: 'analyst_review', amount: 50_000, debtor: kehe, deadline: -2, opened: -40 });
    await aCase('k-won', { state: 'won', amount: 4_000, debtor: kehe });

    // --- Unmatched: two spellings of one name, and a name with only a closed case. ---
    await aCase('s-llc', { state: 'classified', amount: 6_000, printed: 'Sysco Eastern Maryland, LLC', opened: -7 });
    await aCase('s-caps', { state: 'evidence_pending', amount: 4_000, printed: 'SYSCO EASTERN MARYLAND', deadline: 40 });
    await aCase('s-caps-2', { state: 'classified', amount: 500, printed: 'SYSCO EASTERN MARYLAND', deadline: 5 });
    await aCase('t-off', { state: 'written_off', amount: 800, printed: 'Target Corp' });

    // --- Nothing read for a name at all. ---
    await aCase('unknown', { state: 'discovered', amount: 300, opened: -3 });

    // --- Another tenant's, under the same names. ---
    const theirWalmart = await debtor('walmart', 'Walmart', otherOrgId);
    await aCase('theirs', { state: 'classified', amount: 99_999, debtor: theirWalmart, deadline: 1, org: otherOrgId });
    await aCase('theirs-printed', { state: 'classified', amount: 88_888, printed: 'Target Corp', org: otherOrgId });

    const config = { connectionString: connectionString as string };
    store = new PostgresStore(config, { orgId, userId: analystId });
    readOnlyStore = new PostgresStore(config, { orgId, userId: readerId });
    otherStore = new PostgresStore(config, { orgId: otherOrgId, userId: analystId });
    emptyStore = new PostgresStore(config, { orgId: emptyOrgId, userId: analystId });

    const verdict = await store.recordDuplicateVerdict({
      deductionId: ids['w-merged'] as string,
      otherDeductionId: ids['w-survivor'] as string,
      verdict: 'same',
      recordedBy: analystId,
      merge: true,
    });
    if (verdict.merge?.kind !== 'merged') throw new Error('the pair did not merge');
    expect(verdict.survivingDeductionId).toBe(ids['w-survivor']);
  });

  afterAll(async () => {
    await closeAllPools();
    await store?.close();
    await readOnlyStore?.close();
    await otherStore?.close();
    await emptyStore?.close();
    await admin.end();
  });

  function group(
    groups: readonly PayerGroup<CaseSummary>[],
    name: string,
  ): PayerGroup<CaseSummary> {
    const found = groups.filter((g) => g.name === name);
    if (found.length !== 1) throw new Error(`${found.length} groups called ${name}`);
    return found[0] as PayerGroup<CaseSummary>;
  }

  const listed = (g: PayerGroup<CaseSummary>) => g.cases.map((c) => c.deductionId);

  it('groups by debtor, then by folded printed name, then nothing read, in that order', async () => {
    const board = await store.retailerBoard({ today });
    expect(board.groups.map((g) => [g.kind, g.name])).toEqual([
      // Matched, by dollars in dispute.
      ['matched', 'KeHE Distributors'],
      ['matched', 'Walmart'],
      // Unmatched, the same way: Sysco has open dollars, Target none.
      ['unmatched', 'SYSCO EASTERN MARYLAND'],
      ['unmatched', 'Target Corp'],
      ['unknown', undefined],
    ]);
    expect(group(board.groups, 'Walmart').debtorId).toBe(walmart);
    // Two spellings, one group; the one more cases carry names it.
    expect(group(board.groups, 'SYSCO EASTERN MARYLAND').printedNames).toEqual([
      'SYSCO EASTERN MARYLAND',
      'Sysco Eastern Maryland, LLC',
    ]);
    expect(group(board.groups, 'Walmart').printedNames).toEqual([]);
  });

  it('counts and sums each payer to the cent', async () => {
    const board = await store.retailerBoard({ today });

    // Walmart. Open: w-soon, w-later, w-filed, w-survivor.
    expect(group(board.groups, 'Walmart').totals).toEqual({
      openCases: 4,
      closedCases: 3,
      declinedCases: 1,
      awaitingApprovalCases: 1,
      inDisputeCents: 10_000 + 20_000 + 5_000 + 1_111,
      recoveredCents: 7_000 + 4_000 + 0,
      recoveredUnrecordedCases: 0,
      declinedCents: 2_500,
      // Only w-soon: the filed case is not a person's to act on, the declined
      // one is decided, and w-won's old deadline is on a closed case.
      atRiskCases: 1,
      atRiskCents: 10_000,
      oldestOpenDays: 100,
      // The four open ones and the declined one.
      listableCases: 5,
    });

    expect(group(board.groups, 'KeHE Distributors').totals).toEqual({
      openCases: 1,
      closedCases: 1,
      declinedCases: 0,
      awaitingApprovalCases: 0,
      inDisputeCents: 50_000,
      // A win with no outcome event: nothing is assumed for it, and it is counted.
      recoveredCents: 0,
      recoveredUnrecordedCases: 1,
      declinedCents: 0,
      atRiskCases: 1,
      atRiskCents: 50_000,
      oldestOpenDays: 40,
      listableCases: 1,
    });

    expect(group(board.groups, 'SYSCO EASTERN MARYLAND').totals).toEqual({
      openCases: 3,
      closedCases: 0,
      declinedCases: 0,
      awaitingApprovalCases: 0,
      inDisputeCents: 6_000 + 4_000 + 500,
      recoveredCents: 0,
      recoveredUnrecordedCases: 0,
      declinedCents: 0,
      atRiskCases: 1,
      atRiskCents: 500,
      oldestOpenDays: 7,
      listableCases: 3,
    });

    // Closed cases only: no age, nothing to list.
    const target = group(board.groups, 'Target Corp');
    expect(target.totals).toEqual({
      openCases: 0,
      closedCases: 1,
      declinedCases: 0,
      awaitingApprovalCases: 0,
      inDisputeCents: 0,
      recoveredCents: 0,
      recoveredUnrecordedCases: 0,
      declinedCents: 0,
      atRiskCases: 0,
      atRiskCents: 0,
      listableCases: 0,
    });
    expect(target.cases).toEqual([]);
    expect(target.moreCases).toBe(0);

    const unknown = board.groups[board.groups.length - 1] as PayerGroup<CaseSummary>;
    expect(unknown.kind).toBe('unknown');
    expect(unknown.totals).toMatchObject({ openCases: 1, inDisputeCents: 300, oldestOpenDays: 3 });

    // The board's totals are the groups' added up, and the merged-away case's
    // $11.11 is in them once.
    expect(board.totals).toMatchObject({
      openCases: 9,
      closedCases: 5,
      declinedCases: 1,
      awaitingApprovalCases: 1,
      inDisputeCents: 36_111 + 50_000 + 10_500 + 300,
      recoveredCents: 11_000,
      recoveredUnrecordedCases: 1,
      declinedCents: 2_500,
      atRiskCases: 3,
      atRiskCents: 60_500,
      oldestOpenDays: 100,
    });
  });

  it('agrees with the case list’s own figures about what is open', async () => {
    const board = await store.retailerBoard({ today });
    const tally = await store.caseTally({ today });
    const closed = ['won', 'lost', 'partial', 'written_off', 'merged'];
    const open = tally.filter((row) => !row.declined && !closed.includes(row.state));
    expect(board.totals.openCases).toBe(open.reduce((n, row) => n + row.cases, 0));
    expect(board.totals.inDisputeCents).toBe(open.reduce((n, row) => n + row.deductedCents, 0));
    expect(board.totals.atRiskCases).toBe(
      open.filter((row) => row.state !== 'submitted').reduce((n, row) => n + row.dueSoonOrPast, 0),
    );
  });

  it('lists a payer’s cases in the review queue’s order, then the filed and declined ones', async () => {
    const board = await store.retailerBoard({ today });
    const w = group(board.groups, 'Walmart');
    expect(listed(w)).toEqual([
      // Queued: due soon, no deadline, due later.
      ids['w-soon'],
      ids['w-survivor'],
      ids['w-later'],
      // Not queued, in the same order: due today (declined), due tomorrow (filed).
      ids['w-declined'],
      ids['w-filed'],
    ]);
    expect(w.moreCases).toBe(0);
    // No closed case and no merged-away one is listed.
    for (const label of ['w-won', 'w-partial', 'w-lost', 'w-merged']) {
      expect(listed(w)).not.toContain(ids[label]);
    }
    expect(w.cases.find((c) => c.deductionId === ids['w-declined'])?.declined).toBe(true);

    // Two spellings' cases are one list, still in the queue's order.
    expect(listed(group(board.groups, 'SYSCO EASTERN MARYLAND'))).toEqual([
      ids['s-caps-2'],
      ids['s-llc'],
      ids['s-caps'],
    ]);
  });

  it('orders every group’s queued cases exactly as rankForReview does', async () => {
    const board = await store.retailerBoard({ today });
    const queue = await store.reviewQueue({ today });
    const queued = new Set(queue.rows.map((row) => row.deductionId));
    let compared = 0;
    for (const g of board.groups) {
      const mine = g.cases.filter((c) => queued.has(c.deductionId));
      // The same cases through the pure function. An approval moves no case in
      // the order, so `hasApproval` is not something the board has to carry.
      const asQueueCases: QueueCase[] = mine.map((c) => ({
        deductionId: c.deductionId,
        state: c.state,
        deductionAmountCents: c.deductionAmountCents,
        ...(c.disputeDeadline !== undefined ? { disputeDeadline: c.disputeDeadline } : {}),
        ...(c.deductionDate !== undefined ? { deductionDate: c.deductionDate } : {}),
        createdAt: c.createdAt,
        hasApproval: false,
      }));
      const ranked = rankForReview([...asQueueCases].reverse(), today);
      expect(ranked.map((r) => r.case.deductionId)).toEqual(mine.map((c) => c.deductionId));
      // And the queued ones come before every case that is not queued.
      const firstOther = g.cases.findIndex((c) => !queued.has(c.deductionId));
      if (firstOther !== -1) {
        expect(g.cases.slice(firstOther).some((c) => queued.has(c.deductionId))).toBe(false);
      }
      compared += mine.length;
    }
    // Every queued case of the tenant is under exactly one payer.
    expect(compared).toBe(queue.total);
  });

  it('cuts each payer’s list at the limit, keeps the most urgent, and says how many it left out', async () => {
    const full = await store.retailerBoard({ today });
    const cut = await store.retailerBoard({ today, casesPerGroup: 2 });
    expect(cut.casesPerGroup).toBe(2);
    for (const g of cut.groups) {
      const whole = full.groups.find((other) => other.key === g.key) as PayerGroup<CaseSummary>;
      expect(listed(g)).toEqual(listed(whole).slice(0, 2));
      expect(g.moreCases).toBe(whole.totals.listableCases - g.cases.length);
      // A limit changes what is listed, never what is counted.
      expect(g.totals).toEqual(whole.totals);
    }
    expect(group(cut.groups, 'Walmart').moreCases).toBe(3);
    // The two Sysco spellings each had a case in their own top two; the fold
    // still keeps the two most urgent of the group.
    expect(listed(group(cut.groups, 'SYSCO EASTERN MARYLAND'))).toEqual([ids['s-caps-2'], ids['s-llc']]);

    const none = await store.retailerBoard({ today, casesPerGroup: 0 });
    expect(none.groups.every((g) => g.cases.length === 0)).toBe(true);
    expect(none.totals).toEqual(full.totals);
  });

  it('is this tenant’s, readable by a read-only member, and refuses a nonsense request', async () => {
    const mine = await store.retailerBoard({ today });
    expect(await readOnlyStore.retailerBoard({ today })).toEqual(mine);

    const theirs = await otherStore.retailerBoard({ today });
    expect(theirs.groups.map((g) => [g.kind, g.name, g.totals.inDisputeCents])).toEqual([
      ['matched', 'Walmart', 99_999],
      ['unmatched', 'Target Corp', 88_888],
    ]);
    const everyListed = mine.groups.flatMap(listed);
    expect(everyListed).not.toContain(ids.theirs);
    expect(everyListed).not.toContain(ids['theirs-printed']);

    const empty = await emptyStore.retailerBoard({ today });
    expect(empty.groups).toEqual([]);
    expect(empty.totals).toMatchObject({ openCases: 0, inDisputeCents: 0, recoveredCents: 0 });
    expect(empty.totals.oldestOpenDays).toBeUndefined();

    await expect(store.retailerBoard({ today: new Date('nope') })).rejects.toThrow(RangeError);
    await expect(store.retailerBoard({ today, casesPerGroup: 1.5 })).rejects.toThrow(RangeError);
    await expect(store.retailerBoard({ today, casesPerGroup: -1 })).rejects.toThrow(RangeError);
    await expect(store.retailerBoard({ today, casesPerGroup: 51 })).rejects.toThrow(RangeError);
  });

  it('reads through RLS as app_rw, with no org filter of its own', async () => {
    // The owner sees both tenants' Walmart cases; the store sees one tenant's.
    const { rows } = await admin.query<{ n: string }>(
      `select count(*)::text as n from deductions where org_id = any ($1::uuid[])`,
      [[orgId, otherOrgId]],
    );
    const mine = await store.retailerBoard({ today });
    const theirs = await otherStore.retailerBoard({ today });
    const counted = (board: typeof mine) =>
      board.groups.reduce(
        (n, g) => n + g.totals.openCases + g.totals.closedCases + g.totals.declinedCases,
        0,
      );
    // Every case but the merged-away one, each in exactly one figure here
    // (no case in these fixtures is both closed and declined).
    expect(counted(mine) + counted(theirs)).toBe(Number(rows[0]?.n) - 1);
  });
});

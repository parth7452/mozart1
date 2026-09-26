import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { DUE_SOON_DAYS, isQueued } from '@recouple/core-domain';
import { closeAllPools, PostgresStore, type CaseStateTally } from '../src/store';

const connectionString = process.env.TEST_DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

/**
 * The case list's figures, on Postgres as `app_rw` under RLS.
 *
 * The list is the newest hundred cases, and its figures used to be summed from
 * it. `caseTally` counts every case by state instead, and what only the
 * database can answer is here: that it reaches the case the list drops, that a
 * deadline is "due soon or past" on exactly the days the list's label says so
 * — today and `DUE_SOON_DAYS` ahead in, a day past that out — and that another
 * tenant's cases are not in it.
 *
 * A decline moves no state, so a declined case comes back as its own row,
 * split by the queue's own predicate: the figures and the queue under them must
 * agree about which cases are open.
 */
describeDb('the case tally, on Postgres', () => {
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
  let oldId: string;

  function day(offset: number): string {
    return new Date(Date.UTC(2026, 8, 23) + offset * 86_400_000).toISOString().slice(0, 10);
  }

  async function aCase(
    label: string,
    fields: { state: string; amount: number; deadline?: number; createdAt?: string; org?: string },
  ): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `insert into deductions (org_id, claim_id, deduction_amount_cents, state,
                               dispute_deadline, created_at)
       values ($1, $2, $3, $4, $5, coalesce($6::timestamptz, now()))
       returning id`,
      [
        fields.org ?? orgId,
        `CT-${suffix}-${label}`,
        fields.amount,
        fields.state,
        fields.deadline === undefined ? null : day(fields.deadline),
        fields.createdAt ?? null,
      ],
    );
    return rows[0]?.id as string;
  }

  /**
   * A decline naming the case, written as the owner. Straight into the table
   * rather than through `declineCase`, which refuses a filed case: the
   * `submitted` one below stands for a case declined before that guard existed.
   */
  async function decline(deductionId: string, amount: number, org = orgId): Promise<void> {
    await admin.query(
      `insert into declined_candidates (org_id, deduction_id, discovered_from, reason,
                                        estimated_recoverable_cents, decided_by, decided_by_version)
       values ($1, $2, 'web_upload', 'deduction_valid', $3, 'ct', 'human/v1')`,
      [org, deductionId, amount],
    );
  }

  /** In state order, declined last, so a comparison does not depend on the collation's. */
  function byState(tally: readonly CaseStateTally[]): CaseStateTally[] {
    return [...tally].sort((a, b) =>
      a.state < b.state ? -1 : a.state > b.state ? 1 : Number(a.declined) - Number(b.declined),
    );
  }

  beforeAll(async () => {
    for (const [id, slug] of [
      [orgId, `ct-${suffix}`],
      [otherOrgId, `ct-other-${suffix}`],
      [emptyOrgId, `ct-empty-${suffix}`],
    ] as const) {
      await admin.query(`insert into organizations (id, slug, name) values ($1,$2,'Tally')`, [id, slug]);
      await admin.query(`insert into org_settings (org_id) values ($1)`, [id]);
    }
    await admin.query(`insert into users (id, email) values ($1,$2), ($3,$4)`, [
      analystId,
      `ct-a-${suffix}@example.test`,
      readerId,
      `ct-r-${suffix}@example.test`,
    ]);
    await admin.query(
      `insert into memberships (org_id, user_id, role)
       values ($1,$2,'analyst'), ($1,$3,'read_only'), ($4,$2,'analyst'), ($5,$2,'analyst')`,
      [orgId, analystId, readerId, otherOrgId, emptyOrgId],
    );

    // The deadline edges, all in one open state.
    await aCase('past', { state: 'classified', amount: 5_000, deadline: -2 });
    await aCase('today', { state: 'classified', amount: 1_000, deadline: 0 });
    await aCase('last-soon', { state: 'classified', amount: 2_000, deadline: DUE_SOON_DAYS });
    await aCase('first-later', { state: 'classified', amount: 3_000, deadline: DUE_SOON_DAYS + 1 });
    await aCase('none', { state: 'classified', amount: 4_000 });
    // States the page tells apart, each with a deadline the SQL counts.
    await aCase('approval', { state: 'awaiting_approval', amount: 9_900, deadline: 5 });
    await aCase('filed', { state: 'submitted', amount: 11, deadline: 1 });
    await aCase('won', { state: 'won', amount: 22, deadline: -1 });
    // Declined: a classified case due today, and a filed one declined before
    // `declineCase` refused that. Each is its own row, apart from the rest.
    await decline(
      await aCase('declined-today', { state: 'classified', amount: 60_000, deadline: 0 }),
      60_000,
    );
    await decline(
      await aCase('declined-filed', { state: 'submitted', amount: 70_000, deadline: 1 }),
      70_000,
    );
    // A year old and due in three days: the one a newest-first hundred drops.
    oldId = await aCase('old', {
      state: 'analyst_review',
      amount: 777,
      deadline: 3,
      createdAt: '2025-09-01T09:00:00Z',
    });
    // A hundred and five newer cases, closed, with no deadline.
    await admin.query(
      `insert into deductions (org_id, claim_id, deduction_amount_cents, state)
       select $1, 'CT-' || $2 || '-newer-' || g, 100, 'lost' from generate_series(1, 105) g`,
      [orgId, suffix],
    );
    await aCase('theirs', { state: 'classified', amount: 123, deadline: 0, org: otherOrgId });
    await decline(
      await aCase('theirs-declined', {
        state: 'classified',
        amount: 456,
        deadline: 0,
        org: otherOrgId,
      }),
      456,
      otherOrgId,
    );

    const config = { connectionString: connectionString as string };
    store = new PostgresStore(config, { orgId, userId: analystId });
    readOnlyStore = new PostgresStore(config, { orgId, userId: readerId });
    otherStore = new PostgresStore(config, { orgId: otherOrgId, userId: analystId });
    emptyStore = new PostgresStore(config, { orgId: emptyOrgId, userId: analystId });
  });

  afterAll(async () => {
    await closeAllPools();
    await store?.close();
    await readOnlyStore?.close();
    await otherStore?.close();
    await emptyStore?.close();
    await admin.end();
  });

  const expected: readonly CaseStateTally[] = [
    { state: 'analyst_review', declined: false, cases: 1, deductedCents: 777, dueSoonOrPast: 1 },
    {
      state: 'awaiting_approval',
      declined: false,
      cases: 1,
      deductedCents: 9_900,
      dueSoonOrPast: 1,
    },
    // past, today and the last day of the window; not the day after, not none.
    { state: 'classified', declined: false, cases: 5, deductedCents: 15_000, dueSoonOrPast: 3 },
    { state: 'classified', declined: true, cases: 1, deductedCents: 60_000, dueSoonOrPast: 1 },
    { state: 'lost', declined: false, cases: 105, deductedCents: 10_500, dueSoonOrPast: 0 },
    // Counted here; the page leaves a filed or closed case out of its deadlines.
    { state: 'submitted', declined: false, cases: 1, deductedCents: 11, dueSoonOrPast: 1 },
    { state: 'submitted', declined: true, cases: 1, deductedCents: 70_000, dueSoonOrPast: 1 },
    { state: 'won', declined: false, cases: 1, deductedCents: 22, dueSoonOrPast: 1 },
  ];

  it('counts every case, including the one the newest hundred drops', async () => {
    const newest = await store.listCases();
    expect(newest).toHaveLength(100);
    expect(newest.some((c) => c.deductionId === oldId)).toBe(false);

    const tally = await store.caseTally({ today });
    expect(byState(tally)).toEqual(expected);
    expect(tally.reduce((n, row) => n + row.cases, 0)).toBe(116);
  });

  it('is this tenant’s, read the same by a read-only member, and empty for a tenant with none', async () => {
    expect(byState(await readOnlyStore.caseTally({ today }))).toEqual(expected);
    expect(byState(await otherStore.caseTally({ today }))).toEqual([
      { state: 'classified', declined: false, cases: 1, deductedCents: 123, dueSoonOrPast: 1 },
      { state: 'classified', declined: true, cases: 1, deductedCents: 456, dueSoonOrPast: 1 },
    ]);
    expect(await emptyStore.caseTally({ today })).toEqual([]);
  });

  it('leaves out of the open figures exactly the cases the queue leaves out', async () => {
    // One rule, `DECLINED_SQL`, read twice: the undeclined rows whose state the
    // queue holds add up to the queue's own total.
    const tally = await store.caseTally({ today });
    const open = tally
      .filter((row) => !row.declined && isQueued(row.state))
      .reduce((n, row) => n + row.cases, 0);
    expect(open).toBe(7);
    expect((await store.reviewQueue({ today })).total).toBe(open);
  });

  it('refuses a today that is not a date', async () => {
    await expect(store.caseTally({ today: new Date('nope') })).rejects.toBeInstanceOf(RangeError);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { closeAllPools, PostgresStore } from '../src/store';

const connectionString = process.env.TEST_DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

/**
 * The cases the case list offers to attach a read document to, on Postgres as
 * `app_rw` under RLS.
 *
 * The control used to be handed the newest hundred cases, so an older open
 * case could never be chosen. What only the database can answer: that the old
 * open case is offered behind a hundred and ten newer ones, that a closed case
 * is not, that the order is the review queue's and then the filed and declined
 * cases', that a cut at a limit keeps the most urgent and counts the rest, and
 * that another tenant's cases are not there.
 */
describeDb('the cases to attach a document to, on Postgres', () => {
  const admin = new Pool({ connectionString });
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const analystId = randomUUID();
  const readerId = randomUUID();
  const suffix = orgId.slice(0, 8);
  const today = new Date('2026-09-23T15:00:00Z');
  const aYearAgo = '2025-09-01T09:00:00Z';
  let store: PostgresStore;
  let readOnlyStore: PostgresStore;
  let otherStore: PostgresStore;
  const ids: Record<string, string> = {};

  function day(offset: number): string {
    return new Date(Date.UTC(2026, 8, 23) + offset * 86_400_000).toISOString().slice(0, 10);
  }

  async function aCase(
    label: string,
    fields: {
      state: string;
      amount: number;
      deadline?: number;
      deductionDate?: number;
      createdAt?: string;
      org?: string;
    },
  ): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `insert into deductions (org_id, claim_id, deduction_amount_cents, state,
                               dispute_deadline, deduction_date, created_at)
       values ($1, $2, $3, $4, $5, $6, coalesce($7::timestamptz, now()))
       returning id`,
      [
        fields.org ?? orgId,
        `AT-${suffix}-${label}`,
        fields.amount,
        fields.state,
        fields.deadline === undefined ? null : day(fields.deadline),
        fields.deductionDate === undefined ? null : day(fields.deductionDate),
        fields.createdAt ?? null,
      ],
    );
    const id = rows[0]?.id as string;
    ids[label] = id;
    return id;
  }

  beforeAll(async () => {
    for (const [id, slug] of [
      [orgId, `at-${suffix}`],
      [otherOrgId, `at-other-${suffix}`],
    ] as const) {
      await admin.query(`insert into organizations (id, slug, name) values ($1,$2,'Attach')`, [id, slug]);
      await admin.query(`insert into org_settings (org_id) values ($1)`, [id]);
    }
    await admin.query(`insert into users (id, email) values ($1,$2), ($3,$4)`, [
      analystId,
      `at-a-${suffix}@example.test`,
      readerId,
      `at-r-${suffix}@example.test`,
    ]);
    await admin.query(
      `insert into memberships (org_id, user_id, role)
       values ($1,$2,'analyst'), ($1,$3,'read_only'), ($4,$2,'analyst')`,
      [orgId, analystId, readerId, otherOrgId],
    );

    // Opened a year ago and due tomorrow: the case the bug hid.
    await aCase('old-urgent', { state: 'classified', amount: 12_345, deadline: 1, createdAt: aYearAgo });
    // The review queue's four buckets.
    await aCase('due-soon', { state: 'evidence_pending', amount: 1_000, deadline: 3 });
    await aCase('past', { state: 'classified', amount: 5_000, deadline: -2 });
    await aCase('ledger', { state: 'analyst_review', amount: 45_000, deductionDate: -60 });
    await aCase('later', { state: 'decided', amount: 700, deadline: 30 });
    // Open, not queued: filed, and declined without a state moving (ADR 0038).
    // Evidence can still go on either, so both are offered — after the queue.
    await aCase('filed', { state: 'submitted', amount: 1, deadline: 1, createdAt: aYearAgo });
    const declined = await aCase('declined', { state: 'classified', amount: 99_999, deadline: 0 });
    await admin.query(
      `insert into declined_candidates (org_id, deduction_id, discovered_from, reason,
                                        estimated_recoverable_cents, decided_by, decided_by_version)
       values ($1, $2, 'web_upload', 'deduction_valid', 99999, 'at', 'human')`,
      [orgId, declined],
    );
    // Closed, each as old and as urgent as the one that must be offered.
    for (const state of ['won', 'lost', 'partial', 'written_off']) {
      await aCase(state, { state, amount: 1, deadline: 1, createdAt: aYearAgo });
    }
    await aCase('theirs', { state: 'classified', amount: 1, deadline: 1, org: otherOrgId });

    // A hundred and ten newer cases, all closed: enough to push every case
    // above off a newest-first list of a hundred.
    await admin.query(
      `insert into deductions (org_id, claim_id, deduction_amount_cents, state)
       select $1, 'AT-' || $2 || '-newer-' || g, 100, 'lost' from generate_series(1, 110) g`,
      [orgId, suffix],
    );

    const config = { connectionString: connectionString as string };
    store = new PostgresStore(config, { orgId, userId: analystId });
    readOnlyStore = new PostgresStore(config, { orgId, userId: readerId });
    otherStore = new PostgresStore(config, { orgId: otherOrgId, userId: analystId });
  });

  afterAll(async () => {
    await closeAllPools();
    await store?.close();
    await readOnlyStore?.close();
    await otherStore?.close();
    await admin.end();
  });

  /** The queue's order, then the filed and declined cases' in the same order. */
  const expectedOrder = () => [
    ids['old-urgent'],
    ids['due-soon'],
    ids.past,
    ids.ledger,
    ids.later,
    // Due today, then due tomorrow.
    ids.declined,
    ids.filed,
  ];

  it('offers the old open case a newest-first hundred drops, and no closed case', async () => {
    const newest = await store.listCases();
    expect(newest).toHaveLength(100);
    expect(newest.some((c) => c.deductionId === ids['old-urgent'])).toBe(false);

    const targets = await store.attachTargets({ today });
    expect(targets.rows.map((c) => c.deductionId)).toEqual(expectedOrder());
    expect(targets.total).toBe(7);
    expect(targets.limit).toBe(250);
    // The row the list and the case page show, mapped the same way.
    expect(targets.rows[0]).toEqual(await store.caseSummary(ids['old-urgent'] as string));
  });

  it('puts the review queue’s cases first, in the queue’s own order', async () => {
    const queue = await store.reviewQueue({ today });
    const targets = await store.attachTargets({ today });
    expect(targets.rows.slice(0, queue.total).map((c) => c.deductionId)).toEqual(
      queue.rows.map((r) => r.deductionId),
    );
  });

  it('cuts at a limit where the order says, and still counts every open case', async () => {
    const all = expectedOrder();
    for (let limit = 1; limit <= all.length; limit += 1) {
      const cut = await store.attachTargets({ today, limit });
      expect(cut.rows.map((c) => c.deductionId)).toEqual(all.slice(0, limit));
      expect(cut.total).toBe(all.length);
      expect(cut.limit).toBe(limit);
    }
  });

  it('is this tenant’s, read the same by a read-only member, and refuses nonsense', async () => {
    const theirs = await otherStore.attachTargets({ today });
    expect(theirs.rows.map((c) => c.deductionId)).toEqual([ids.theirs]);
    expect(theirs.total).toBe(1);

    expect(await readOnlyStore.attachTargets({ today })).toEqual(await store.attachTargets({ today }));

    for (const limit of [0, 1.5, 2_001, Number.NaN]) {
      await expect(store.attachTargets({ today, limit })).rejects.toBeInstanceOf(RangeError);
    }
    await expect(store.attachTargets({ today: new Date('nope') })).rejects.toBeInstanceOf(RangeError);
  });
});

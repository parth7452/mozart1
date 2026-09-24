import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { DUE_SOON_DAYS, isQueued, rankForReview } from '@recouple/core-domain';
import { closeAllPools, PostgresStore, type CaseSummary } from '../src/store';

const connectionString = process.env.DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

/**
 * The attach control's cases, on Postgres as `app_rw` under RLS.
 *
 * "Read, not on a case" offered the open cases among `listCases`' newest
 * hundred, so evidence for an older case had nowhere to go from the list.
 * `attachTargets` reads every open case in the review queue's order, and what
 * only the database can answer is here: that a year-old case due in three days
 * comes first although a hundred and five newer ones exist, that a closed case
 * is never offered and a filed one still is, that the order is the one
 * `rankForReview` gives the same rows, that a limit cuts it exactly there and
 * `total` still counts every open case, and that another tenant's cases are
 * not in it.
 */
describeDb('the attach targets, on Postgres', () => {
  const admin = new Pool({ connectionString });
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const analystId = randomUUID();
  const readerId = randomUUID();
  const suffix = orgId.slice(0, 8);
  const today = new Date('2026-09-23T15:00:00Z');
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

  const ofIds = (rows: readonly CaseSummary[]) => rows.map((row) => row.deductionId);

  beforeAll(async () => {
    for (const [id, slug] of [
      [orgId, `at-${suffix}`],
      [otherOrgId, `at-other-${suffix}`],
    ] as const) {
      await admin.query(`insert into organizations (id, slug, name) values ($1,$2,'Attach')`, [
        id,
        slug,
      ]);
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

    // A year old and due in three days: the case the newest hundred drops.
    await aCase('old-urgent', {
      state: 'analyst_review',
      amount: 777,
      deadline: 3,
      createdAt: '2025-09-01T09:00:00Z',
    });
    // One of each bucket, and a tie on the deadline broken by the amount.
    await aCase('past', { state: 'classified', amount: 5_000, deadline: -2 });
    await aCase('soon-small', { state: 'classified', amount: 1_000, deadline: DUE_SOON_DAYS });
    await aCase('soon-large', { state: 'decided', amount: 9_000, deadline: DUE_SOON_DAYS });
    await aCase('later', { state: 'classified', amount: 3_000, deadline: DUE_SOON_DAYS + 30 });
    await aCase('no-deadline-old', { state: 'discovered', amount: 400, deductionDate: -90 });
    // Filed: not the queue's, but evidence can still arrive for it.
    await aCase('filed', { state: 'submitted', amount: 11, deadline: 1 });
    // Closed: never offered.
    await aCase('won', { state: 'won', amount: 22, deadline: 0 });
    await aCase('written-off', { state: 'written_off', amount: 33, deadline: 0 });
    // A hundred and five newer open cases with no deadline.
    await admin.query(
      `insert into deductions (org_id, claim_id, deduction_amount_cents, state)
       select $1, 'AT-' || $2 || '-newer-' || g, 100, 'classified' from generate_series(1, 105) g`,
      [orgId, suffix],
    );
    await aCase('theirs', { state: 'classified', amount: 123, deadline: 0, org: otherOrgId });

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

  it('offers every open case, the old urgent one first, and no closed one', async () => {
    const newest = await store.listCases();
    expect(ofIds(newest)).not.toContain(ids['old-urgent']);

    const targets = await store.attachTargets({ today });
    // Seven labelled open cases and the hundred and five newer ones.
    expect(targets.total).toBe(112);
    expect(targets.rows).toHaveLength(112);
    expect(targets.limit).toBe(500);
    expect(ofIds(targets.rows).slice(0, 4)).toEqual([
      ids['filed'], // due tomorrow, filed or not
      ids['old-urgent'], // due in three days
      ids['soon-large'], // due on the last day of the window, the larger first
      ids['soon-small'],
    ]);
    expect(ofIds(targets.rows)).toContain(ids['past']);
    expect(ofIds(targets.rows)).not.toContain(ids['won']);
    expect(ofIds(targets.rows)).not.toContain(ids['written-off']);
    expect(targets.rows.every((row) => row.state !== 'won' && row.state !== 'written_off')).toBe(
      true,
    );
  });

  it('is in the order rankForReview gives the same cases', async () => {
    const { rows } = await store.attachTargets({ today });
    // `rankForReview` ranks only the queue's cases, so the filed one is left
    // out of both sides; every other case must come back in its order.
    const queued = rows.filter((row) => isQueued(row.state));
    const ranked = rankForReview(
      queued.map((row) => ({ ...row, hasApproval: false })),
      today,
    ).map((r) => r.case.deductionId);
    expect(ofIds(queued)).toEqual(ranked);
  });

  it('cuts at a limit where the full order does, and still counts every open case', async () => {
    const all = ofIds((await store.attachTargets({ today })).rows);
    for (const limit of [1, 2, 5, 8, 100]) {
      const cut = await store.attachTargets({ today, limit });
      expect(ofIds(cut.rows)).toEqual(all.slice(0, limit));
      expect(cut.total).toBe(112);
      expect(cut.limit).toBe(limit);
    }
  });

  it('is this tenant’s, the same for a read-only member, and refuses what it was not written for', async () => {
    expect(await readOnlyStore.attachTargets({ today })).toEqual(
      await store.attachTargets({ today }),
    );
    const theirs = await otherStore.attachTargets({ today });
    expect(ofIds(theirs.rows)).toEqual([ids['theirs']]);
    expect(theirs.total).toBe(1);
    expect(ofIds((await store.attachTargets({ today })).rows)).not.toContain(ids['theirs']);

    await expect(store.attachTargets({ today, limit: 0 })).rejects.toBeInstanceOf(RangeError);
    await expect(store.attachTargets({ today, limit: 2_001 })).rejects.toBeInstanceOf(RangeError);
    await expect(store.attachTargets({ today: new Date('nope') })).rejects.toBeInstanceOf(
      RangeError,
    );
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { rankForReview } from '@recouple/core-domain';
import { closeAllPools, PostgresStore } from '../src/store';
import { ReviewQueueReadError } from '../src/review-queue';

const connectionString = process.env.TEST_DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

/**
 * The review queue's read (ADR 0043), on Postgres as `app_rw` under RLS.
 *
 * What only the database can answer: which cases are queued (not closed, not
 * filed, not declined), that another tenant's are invisible, that an old urgent
 * case is still there behind a hundred newer ones — the gap the newest-first
 * list had — and that the SQL's order is `rankForReview`'s, so cutting at a
 * limit keeps exactly the rows the queue would put first.
 */
describeDb('the review queue, on Postgres', () => {
  const admin = new Pool({ connectionString });
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const analystId = randomUUID();
  const approverId = randomUUID();
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
        `RQ-${suffix}-${label}`,
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
      [orgId, `rq-${suffix}`],
      [otherOrgId, `rq-other-${suffix}`],
    ] as const) {
      await admin.query(`insert into organizations (id, slug, name) values ($1,$2,'Queue')`, [id, slug]);
      await admin.query(`insert into org_settings (org_id) values ($1)`, [id]);
    }
    await admin.query(`insert into users (id, email) values ($1,$2), ($3,$4), ($5,$6)`, [
      analystId,
      `rq-a-${suffix}@example.test`,
      approverId,
      `rq-b-${suffix}@example.test`,
      readerId,
      `rq-r-${suffix}@example.test`,
    ]);
    await admin.query(
      `insert into memberships (org_id, user_id, role)
       values ($1,$2,'analyst'), ($1,$3,'approver'), ($1,$4,'read_only'), ($5,$2,'analyst')`,
      [orgId, analystId, approverId, readerId, otherOrgId],
    );

    // Queued, one per bucket, plus an approved case waiting to be filed.
    await aCase('due-soon', { state: 'classified', amount: 1_000, deadline: 3 });
    await aCase('past', { state: 'classified', amount: 5_000, deadline: -2 });
    await aCase('ledger', { state: 'classified', amount: 45_000, deductionDate: -60 });
    await aCase('later', { state: 'analyst_review', amount: 700, deadline: 30 });
    // An old, urgent case: opened a year ago, due tomorrow.
    await aCase('old-urgent', {
      state: 'classified',
      amount: 12_345,
      deadline: 1,
      createdAt: '2025-09-01T09:00:00Z',
    });
    const approved = await aCase('approved', {
      state: 'awaiting_approval',
      amount: 9_900,
      deadline: 5,
    });
    const { rows: decision } = await admin.query<{ id: string }>(
      `insert into decisions (org_id, deduction_id, schema_id, schema_version, provider,
                              model_version, input_state_hash, questions, result,
                              raw_probabilities, confidence, latency_ms, prepared_by)
       values ($1,$2,'B','1.0.0','jev','jev-latest',digest($4,'sha256'),
               '{}'::jsonb,'{}'::jsonb,'{}'::jsonb,0.9,1,$3)
       returning id`,
      [orgId, approved, analystId, `rq-${approved}`],
    );
    // Written as the approver, in their session: an approval names its caller.
    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query('select set_config($1, $2, true)', [
        'request.jwt.claims',
        JSON.stringify({ org_id: orgId, sub: approverId }),
      ]);
      await client.query(
        `insert into approvals (org_id, decision_id, approver_id, action_type)
         values ($1, $2, $3, 'submit')`,
        [orgId, decision[0]?.id, approverId],
      );
      await client.query('commit');
    } finally {
      client.release();
    }

    // Not queued: filed, closed, declined, and another tenant's.
    await aCase('filed', { state: 'submitted', amount: 1, deadline: 1 });
    await aCase('won', { state: 'won', amount: 1, deadline: 1 });
    const declined = await aCase('declined', { state: 'classified', amount: 99_999, deadline: 0 });
    await admin.query(
      `insert into declined_candidates (org_id, deduction_id, discovered_from, reason,
                                        estimated_recoverable_cents, decided_by, decided_by_version)
       values ($1, $2, 'web_upload', 'deduction_valid', 99999, 'rq', 'human')`,
      [orgId, declined],
    );
    await aCase('theirs', { state: 'classified', amount: 1, deadline: 1, org: otherOrgId });

    // A hundred and ten newer cases, all closed: enough to push the old urgent
    // case off a newest-first list of a hundred.
    await admin.query(
      `insert into deductions (org_id, claim_id, deduction_amount_cents, state)
       select $1, 'RQ-' || $2 || '-newer-' || g, 100, 'lost' from generate_series(1, 110) g`,
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

  it('holds the cases a person can act on now, and counts the filed ones apart', async () => {
    const queue = await store.reviewQueue({ today });
    expect(new Set(queue.rows.map((r) => r.deductionId))).toEqual(
      new Set([ids['due-soon'], ids.past, ids.ledger, ids.later, ids['old-urgent'], ids.approved]),
    );
    expect(queue.total).toBe(6);
    expect(queue.waitingOnRetailer).toBe(1);

    const approved = queue.rows.find((r) => r.deductionId === ids.approved);
    expect(approved).toMatchObject({ hasApproval: true, preparedBy: analystId });
    const ledger = queue.rows.find((r) => r.deductionId === ids.ledger);
    expect(ledger).toMatchObject({ deductionDate: day(-60), hasApproval: false });
    expect(ledger?.disputeDeadline).toBeUndefined();
  });

  it('keeps an old, urgent case that a newest-first list of a hundred drops', async () => {
    const newest = await store.listCases(100);
    expect(newest.some((c) => c.deductionId === ids['old-urgent'])).toBe(false);

    const queue = await store.reviewQueue({ today });
    const ranked = rankForReview(queue.rows, today);
    expect(ranked.map((r) => r.case.deductionId)).toEqual([
      ids['old-urgent'],
      ids['due-soon'],
      ids.approved,
      ids.past,
      ids.ledger,
      ids.later,
    ]);
    expect(ranked.map((r) => r.nextStep)).toEqual([
      'decide',
      'decide',
      'file',
      'decide',
      'decide',
      'assemble',
    ]);
  });

  it('opens that case on its own page, by id, and no other tenant’s', async () => {
    // The queue links every row to `/cases/<id>`, and the page reads its case
    // with `caseSummary`. Before, it looked in `listCases()`, which is the
    // newest hundred — so the case the queue put first was a 404.
    const oldUrgent = ids['old-urgent'] as string;
    const theirs = ids.theirs as string;
    const every = await store.listCases(1_000);
    expect(every.length).toBeGreaterThan(100);
    const oldest = every.at(-1);
    expect(oldest?.deductionId).toBe(oldUrgent);

    // The same row the list shows, mapped the same way.
    expect(await store.caseSummary(oldUrgent)).toEqual(oldest);
    // A uuid is not a string: the page accepts either case, and so does this.
    expect(await store.caseSummary(oldUrgent.toUpperCase())).toEqual(oldest);
    expect(await readOnlyStore.caseSummary(oldUrgent)).toEqual(oldest);

    // Another tenant's case is not there, either way round, which is the page's 404.
    expect(await store.caseSummary(theirs)).toBeUndefined();
    expect(await otherStore.caseSummary(oldUrgent)).toBeUndefined();
    expect(await otherStore.caseSummary(theirs)).toMatchObject({ deductionId: theirs });
    expect(await store.caseSummary(randomUUID())).toBeUndefined();
  });

  it('cuts at a limit exactly where rankForReview would', async () => {
    const all = rankForReview((await store.reviewQueue({ today })).rows, today).map(
      (r) => r.case.deductionId,
    );
    for (let limit = 1; limit <= all.length; limit += 1) {
      const cut = await store.reviewQueue({ today, limit });
      expect(cut.rows.map((r) => r.deductionId)).toEqual(all.slice(0, limit));
      expect(cut.total).toBe(all.length);
    }
  });

  it('is this tenant’s, readable by a read-only member, and refuses a nonsense limit', async () => {
    const theirs = await otherStore.reviewQueue({ today });
    expect(theirs.rows.map((r) => r.deductionId)).toEqual([ids.theirs]);
    expect(theirs.waitingOnRetailer).toBe(0);

    const reader = await readOnlyStore.reviewQueue({ today });
    expect(reader.total).toBe(6);

    for (const limit of [0, 1.5, 2_001, Number.NaN]) {
      await expect(store.reviewQueue({ today, limit })).rejects.toBeInstanceOf(ReviewQueueReadError);
    }
    await expect(store.reviewQueue({ today: new Date('nope') })).rejects.toBeInstanceOf(
      ReviewQueueReadError,
    );
  });
});

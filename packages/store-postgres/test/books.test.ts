import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { closeAllPools } from '../src/store';
import { BOOKS_CASES_MAX, BooksReadError, PostgresBooksStore } from '../src/books';

const connectionString = process.env.TEST_DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

/**
 * The Books page's read of our own cases (ADR 0066 §3), on Postgres as
 * `app_rw` under RLS: which cases a window holds, that another tenant's are
 * invisible, that a `read_only` member reads the same rows, and that nothing
 * is written.
 */
describeDb('cases in a books window, on Postgres', () => {
  const admin = new Pool({ connectionString });
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const analystId = randomUUID();
  const readerId = randomUUID();
  const suffix = orgId.slice(0, 8);
  const window = { from: '2026-09-01', to: '2026-09-30' };
  const ids: Record<string, string> = {};
  let store: PostgresBooksStore;
  let readOnlyStore: PostgresBooksStore;
  let otherStore: PostgresBooksStore;

  async function aCase(
    label: string,
    fields: {
      amount: number;
      state?: string;
      deductionDate?: string;
      createdAt?: string;
      org?: string;
      debtorId?: string;
      printed?: string;
    },
  ): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `insert into deductions (org_id, claim_id, deduction_amount_cents, state, deduction_date,
                               created_at, debtor_id, retailer_name_as_printed)
       values ($1, $2, $3, $4, $5, coalesce($6::timestamptz, now()), $7, $8)
       returning id`,
      [
        fields.org ?? orgId,
        `BK-${suffix}-${label}`,
        fields.amount,
        fields.state ?? 'classified',
        fields.deductionDate ?? null,
        fields.createdAt ?? null,
        fields.debtorId ?? null,
        fields.printed ?? null,
      ],
    );
    const id = rows[0]?.id as string;
    ids[label] = id;
    return id;
  }

  beforeAll(async () => {
    for (const [id, slug] of [
      [orgId, `bk-${suffix}`],
      [otherOrgId, `bk-other-${suffix}`],
    ] as const) {
      await admin.query(`insert into organizations (id, slug, name) values ($1,$2,'Books')`, [id, slug]);
      await admin.query(`insert into org_settings (org_id) values ($1)`, [id]);
    }
    await admin.query(`insert into users (id, email) values ($1,$2), ($3,$4)`, [
      analystId,
      `bk-a-${suffix}@example.test`,
      readerId,
      `bk-r-${suffix}@example.test`,
    ]);
    await admin.query(
      `insert into memberships (org_id, user_id, role)
       values ($1,$2,'analyst'), ($1,$3,'read_only'), ($4,$2,'analyst')`,
      [orgId, analystId, readerId, otherOrgId],
    );
    const { rows: debtor } = await admin.query<{ id: string }>(
      `insert into debtors (org_id, retailer_key, display_name)
       values ($1, $2, 'Sysco Baltimore, LLC') returning id`,
      [orgId, `sysco-${suffix}`],
    );

    await aCase('first-day', { amount: 127_000, deductionDate: '2026-09-01', debtorId: debtor[0]?.id as string });
    await aCase('last-day', { amount: 50_000, deductionDate: '2026-09-30', printed: 'US FOODS INC' });
    await aCase('won', { amount: 32_000, deductionDate: '2026-09-22', state: 'won' });
    // No printed date: in the window by the day it was opened, in UTC.
    await aCase('undated', { amount: 9_900, createdAt: '2026-09-15T23:30:00Z' });
    // Outside: the day before, the day after, and an undated case opened later.
    await aCase('before', { amount: 1, deductionDate: '2026-08-31' });
    await aCase('after', { amount: 1, deductionDate: '2026-10-01' });
    await aCase('undated-later', { amount: 1, createdAt: '2026-10-01T00:00:00Z' });
    // Dated inside the window but opened long after: the printed date decides.
    await aCase('opened-late', { amount: 777, deductionDate: '2026-09-10', createdAt: '2026-12-01T09:00:00Z' });
    await aCase('theirs', { amount: 127_000, deductionDate: '2026-09-01', org: otherOrgId });

    const config = { connectionString: connectionString as string };
    store = new PostgresBooksStore(config, { orgId, userId: analystId });
    readOnlyStore = new PostgresBooksStore(config, { orgId, userId: readerId });
    otherStore = new PostgresBooksStore(config, { orgId: otherOrgId, userId: analystId });
  });

  afterAll(async () => {
    await closeAllPools();
    await admin.end();
  });

  it('lists the cases dated inside the window, both ends counted, oldest first', async () => {
    const read = await store.casesInWindow(window);
    expect(read.rows.map((row) => row.deductionId)).toEqual([
      ids['first-day'],
      ids['opened-late'],
      ids.undated,
      ids.won,
      ids['last-day'],
    ]);
    expect(read.total).toBe(5);
    expect(read.rows[0]).toEqual({
      deductionId: ids['first-day'],
      state: 'classified',
      claimId: `BK-${suffix}-first-day`,
      amountCents: 127_000,
      deductionDate: '2026-09-01',
      payerName: 'Sysco Baltimore, LLC',
      payerMatched: true,
    });
  });

  it('says when a payer is only a printed name, and when a case has no date', async () => {
    const read = await store.casesInWindow(window);
    const lastDay = read.rows.find((row) => row.deductionId === ids['last-day']);
    expect(lastDay).toMatchObject({ payerName: 'US FOODS INC', payerMatched: false });
    const undated = read.rows.find((row) => row.deductionId === ids.undated);
    expect(undated).toBeDefined();
    expect('deductionDate' in (undated as object)).toBe(false);
    expect('payerName' in (undated as object)).toBe(false);
  });

  it('leaves out a merged-away case', async () => {
    const before = await store.casesInWindow(window);
    const merged = await aCase('merged-away', { amount: 127_000, deductionDate: '2026-09-01' });
    // The state alone is what the read filters on; the merge ledger is ADR
    // 0042's and is exercised in its own suite. The trigger refuses this move
    // without a merge row, so it is made with triggers off, as the owner.
    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query(`set local session_replication_role = replica`);
      await client.query(`update deductions set state = 'merged' where id = $1`, [merged]);
      await client.query('commit');
    } finally {
      client.release();
    }
    const after = await store.casesInWindow(window);
    expect(after.rows.map((row) => row.deductionId)).toEqual(before.rows.map((row) => row.deductionId));
    expect(after.total).toBe(before.total);
  });

  it('cuts at the limit and still counts the whole window', async () => {
    const read = await store.casesInWindow(window, { limit: 2 });
    expect(read.rows.map((row) => row.deductionId)).toEqual([ids['first-day'], ids['opened-late']]);
    expect(read.total).toBe(5);
    expect(read.limit).toBe(2);
  });

  it('shows a read-only member the same rows and another tenant none of them', async () => {
    const mine = await store.casesInWindow(window);
    expect(await readOnlyStore.casesInWindow(window)).toEqual(mine);
    const theirs = await otherStore.casesInWindow(window);
    expect(theirs.rows.map((row) => row.deductionId)).toEqual([ids.theirs]);
    expect(theirs.total).toBe(1);
  });

  it('answers an empty window with nothing, not an error', async () => {
    expect(await store.casesInWindow({ from: '2020-01-01', to: '2020-01-31' })).toEqual({
      rows: [],
      total: 0,
      limit: 500,
    });
  });

  it('refuses a window or a limit it was not written for', async () => {
    await expect(store.casesInWindow({ from: '2026-09-30', to: '2026-09-01' })).rejects.toBeInstanceOf(
      BooksReadError,
    );
    await expect(store.casesInWindow({ from: "2026-09-01'; --", to: '2026-09-30' })).rejects.toBeInstanceOf(
      BooksReadError,
    );
    await expect(store.casesInWindow(window, { limit: 0 })).rejects.toBeInstanceOf(BooksReadError);
    await expect(store.casesInWindow(window, { limit: BOOKS_CASES_MAX + 1 })).rejects.toBeInstanceOf(
      BooksReadError,
    );
  });

  it('writes nothing', async () => {
    const count = async (): Promise<string> => {
      const { rows } = await admin.query<{ n: string }>(
        `select (select count(*) from deductions where org_id = $1)::text
             || ':' || (select count(*) from deduction_events where org_id = $1)::text
             || ':' || (select count(*) from audit_log where org_id = $1)::text as n`,
        [orgId],
      );
      return rows[0]?.n as string;
    };
    const before = await count();
    await store.casesInWindow(window);
    await readOnlyStore.casesInWindow(window);
    expect(await count()).toBe(before);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { closeAllPools, DuplicateCaseError, PostgresStore } from '../src/store';

const connectionString = process.env.DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

/**
 * What `openCase` does with a retailer name and two dates (ADR 0019).
 *
 * The rule under test is a safety property, not a feature: untrusted document
 * text may *select* a debtor a human already created, and may never create one
 * or pick between two. Everything here runs as `app_rw` through the real
 * policies, because "it can only see this tenant's debtors" is a claim about
 * the database, not about our code.
 */
describeDb('openCase: the retailer as printed, and the debtor only when sure', () => {
  const admin = new Pool({ connectionString });
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const suffix = orgId.slice(0, 8);
  let store: PostgresStore;
  let walmartId: string;

  beforeAll(async () => {
    await admin.query(
      `insert into organizations (id, slug, name) values ($1,$2,'Retailers'), ($3,$4,'Retailers Other')`,
      [orgId, `retailers-${suffix}`, otherOrgId, `retailers-other-${suffix}`],
    );
    await admin.query(`insert into org_settings (org_id) values ($1), ($2)`, [orgId, otherOrgId]);
    await admin.query(`insert into users (id, email) values ($1,$2), ($3,$4)`, [
      userId,
      `retailers-${suffix}@example.test`,
      otherUserId,
      `retailers-other-${suffix}@example.test`,
    ]);
    await admin.query(
      `insert into memberships (org_id, user_id, role) values ($1,$2,'analyst'), ($3,$4,'analyst')`,
      [orgId, userId, otherOrgId, otherUserId],
    );

    const { rows } = await admin.query<{ id: string }>(
      `insert into debtors (org_id, retailer_key, display_name)
       values ($1, 'walmart_apdp', 'Walmart (APDP)'), ($1, 'kehe', 'KeHE')
       returning id`,
      [orgId],
    );
    walmartId = rows[0]?.id as string;
    await admin.query(
      `insert into debtor_aliases (org_id, debtor_id, alias) values ($1, $2, $3)`,
      [orgId, walmartId, 'WALMART STORES, INC.'],
    );
    // The other tenant has a debtor with the same name. It must never be
    // reachable from here — that is invariant 6 doing the work, not a filter we
    // remembered to write.
    await admin.query(
      `insert into debtors (org_id, retailer_key, display_name)
       values ($1, 'walmart_apdp', 'Walmart (APDP)')`,
      [otherOrgId],
    );

    store = new PostgresStore({ connectionString: connectionString as string }, { orgId, userId });
  });

  afterAll(async () => {
    await closeAllPools();
    await store?.close();
    await admin.end();
  });

  async function readBack(deductionId: string) {
    const { rows } = await admin.query<{
      debtor_id: string | null;
      retailer_name_as_printed: string | null;
      deduction_date: Date | null;
      dispute_deadline: Date | null;
    }>(
      `select debtor_id, retailer_name_as_printed, deduction_date, dispute_deadline
         from deductions where id = $1`,
      [deductionId],
    );
    const row = rows[0];
    if (row === undefined) throw new Error(`no case ${deductionId}`);
    return row;
  }

  function iso(value: Date | null): string | undefined {
    return value === null ? undefined : value.toISOString().slice(0, 10);
  }

  it('keeps the retailer and both dates, which is the bug this fixes', async () => {
    const opened = await store.openCase({
      orgId,
      claimId: `APDP-${suffix}-1`,
      retailerName: 'Walmart (APDP)',
      deductionAmountCents: 312_000,
      deductionDate: '2026-08-14',
      disputeDeadline: '2026-11-12',
    });
    expect(opened.retailerName).toBe('Walmart (APDP)');
    expect(opened.deductionDate).toBe('2026-08-14');
    expect(opened.disputeDeadline).toBe('2026-11-12');

    const row = await readBack(opened.deductionId);
    expect(row.retailer_name_as_printed).toBe('Walmart (APDP)');
    expect(iso(row.deduction_date)).toBe('2026-08-14');
    expect(iso(row.dispute_deadline)).toBe('2026-11-12');
    expect(row.debtor_id).toBe(walmartId);
  });

  it('resolves through an alias a human added', async () => {
    const opened = await store.openCase({
      orgId,
      claimId: `APDP-${suffix}-2`,
      retailerName: 'WALMART STORES, INC.',
      deductionAmountCents: 100,
    });
    expect(opened.debtorId).toBe(walmartId);
    // And the name still reads as the page printed it, not as the debtor.
    expect((await readBack(opened.deductionId)).retailer_name_as_printed).toBe(
      'WALMART STORES, INC.',
    );
  });

  it('leaves a name nobody has claimed unresolved, and creates no debtor for it', async () => {
    const before = await admin.query<{ n: string }>(
      `select count(*) as n from debtors where org_id = $1`,
      [orgId],
    );
    const opened = await store.openCase({
      orgId,
      claimId: `APDP-${suffix}-3`,
      retailerName: 'Costco Wholesale Corporation',
      deductionAmountCents: 100,
    });
    expect(opened.debtorId).toBeUndefined();
    expect((await readBack(opened.deductionId)).debtor_id).toBeNull();

    const after = await admin.query<{ n: string }>(
      `select count(*) as n from debtors where org_id = $1`,
      [orgId],
    );
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });

  it('refuses to choose when two debtors answer to the same name', async () => {
    const twin = randomUUID();
    await admin.query(
      `insert into debtors (id, org_id, retailer_key, display_name)
       values ($1, $2, 'bigmart_a', 'Bigmart')`,
      [twin, orgId],
    );
    const second = randomUUID();
    await admin.query(
      `insert into debtors (id, org_id, retailer_key, display_name)
       values ($1, $2, 'bigmart_b', 'Bigmart Inc.')`,
      [second, orgId],
    );
    try {
      const opened = await store.openCase({
        orgId,
        claimId: `APDP-${suffix}-4`,
        retailerName: 'Bigmart',
        deductionAmountCents: 100,
      });
      expect(opened.debtorId).toBeUndefined();
      expect((await readBack(opened.deductionId)).retailer_name_as_printed).toBe('Bigmart');
    } finally {
      await admin.query(`delete from debtors where id = any($1::uuid[])`, [[twin, second]]);
    }
  });

  it('cannot reach another tenant’s debtor, even with the same name', async () => {
    const otherStore = new PostgresStore(
      { connectionString: connectionString as string },
      { orgId: otherOrgId, userId: otherUserId },
    );
    try {
      const opened = await otherStore.openCase({
        orgId: otherOrgId,
        claimId: `APDP-${suffix}-5`,
        retailerName: 'Walmart (APDP)',
        deductionAmountCents: 100,
      });
      expect(opened.debtorId).not.toBe(walmartId);
      const row = await readBack(opened.deductionId);
      expect(row.debtor_id).not.toBe(walmartId);
    } finally {
      await otherStore.close();
    }
  });

  it('opens the case with no dates when the notice printed none', async () => {
    const opened = await store.openCase({
      orgId,
      claimId: `APDP-${suffix}-6`,
      retailerName: 'KeHE',
      deductionAmountCents: 8_845,
    });
    const row = await readBack(opened.deductionId);
    expect(row.deduction_date).toBeNull();
    expect(row.dispute_deadline).toBeNull();
    // Better a case with no deadline than no case.
    expect(opened.deductionId).toBeTruthy();
  });

  it('names the existing case when the same claim arrives twice for one debtor', async () => {
    const claimId = `APDP-${suffix}-dupe`;
    const first = await store.openCase({
      orgId,
      claimId,
      retailerName: 'Walmart (APDP)',
      deductionAmountCents: 312_000,
    });
    expect(first.debtorId).toBe(walmartId);

    // The same claim, read off a scan of the same notice. The constraint only
    // starts to bite once a debtor resolves, which is exactly why this used to
    // open two cases silently.
    const again = store.openCase({
      orgId,
      claimId,
      retailerName: 'WALMART STORES, INC.',
      deductionAmountCents: 312_000,
    });
    await expect(again).rejects.toThrow(DuplicateCaseError);
    await expect(again).rejects.toThrow(new RegExp(first.deductionId));
  });

  it('still opens a second case for a claim whose retailer never resolved', async () => {
    // Two unresolved cases are not a duplicate the database can see: null
    // debtor_ids do not compare. Recording that rather than pretending
    // otherwise is the honest state until identity resolution lands.
    const claimId = `APDP-${suffix}-unresolved`;
    const first = await store.openCase({
      orgId,
      claimId,
      retailerName: 'Costco Wholesale Corporation',
      deductionAmountCents: 100,
    });
    const second = await store.openCase({
      orgId,
      claimId,
      retailerName: 'Costco Wholesale Corporation',
      deductionAmountCents: 100,
    });
    expect(second.deductionId).not.toBe(first.deductionId);
  });

  it('adds an alias, and only then does the name resolve', async () => {
    // Before: a spelling nobody has claimed opens an unmatched case.
    const before = await store.openCase({
      orgId,
      claimId: `APDP-${suffix}-alias-1`,
      retailerName: 'Wal-Mart Stores',
      deductionAmountCents: 100,
    });
    expect(before.debtorId).toBeUndefined();

    await store.addDebtorAlias(walmartId, 'Wal-Mart Stores');

    // After: every later case with that spelling resolves by itself.
    const after = await store.openCase({
      orgId,
      claimId: `APDP-${suffix}-alias-2`,
      retailerName: 'WAL-MART STORES, INC.',
      deductionAmountCents: 100,
    });
    expect(after.debtorId).toBe(walmartId);

    // And the case opened before the alias existed is untouched until someone
    // asks for it: adding an alias does not silently rewrite history.
    expect((await readBack(before.deductionId)).debtor_id).toBeNull();
  });

  it('adding the same alias twice is not an error', async () => {
    await store.addDebtorAlias(walmartId, 'Wal-Mart Stores');
    await store.addDebtorAlias(walmartId, 'wal-mart stores');
    const { rows } = await admin.query<{ n: string }>(
      `select count(*) as n from debtor_aliases where debtor_id = $1 and alias ilike 'wal-mart%'`,
      [walmartId],
    );
    expect(rows[0]?.n).toBe('1');
  });

  it('refuses to hang an alias off another tenant’s debtor', async () => {
    const { rows } = await admin.query<{ id: string }>(
      `select id from debtors where org_id = $1 limit 1`,
      [otherOrgId],
    );
    await expect(store.addDebtorAlias(rows[0]?.id as string, 'Anything')).rejects.toThrow(
      /no debtor/,
    );
  });

  it('backfills the cases an alias reaches back to, and records why', async () => {
    const claimId = `APDP-${suffix}-backfill`;
    const opened = await store.openCase({
      orgId,
      claimId,
      retailerName: 'Shipmart Supply',
      deductionAmountCents: 100,
    });
    expect(opened.debtorId).toBeUndefined();

    const debtorId = randomUUID();
    await admin.query(
      `insert into debtors (id, org_id, retailer_key, display_name)
       values ($1, $2, 'shipmart', 'Shipmart')`,
      [debtorId, orgId],
    );
    try {
      await store.addDebtorAlias(debtorId, 'Shipmart Supply');
      const result = await store.resolveUnmatchedCases();

      expect(result.resolved.map((r) => r.deductionId)).toContain(opened.deductionId);
      expect((await readBack(opened.deductionId)).debtor_id).toBe(debtorId);

      // The projection changed, so the stream says so.
      const events = await admin.query<{ payload: { debtor_id: string } }>(
        `select payload from deduction_events
          where deduction_id = $1 and event_type = 'case.debtor_resolved'`,
        [opened.deductionId],
      );
      expect(events.rows[0]?.payload.debtor_id).toBe(debtorId);

      // The names nobody claimed are still nobody's, and were not guessed at.
      expect(result.stillUnmatched).toBeGreaterThan(0);
      // Running it again changes nothing.
      const again = await store.resolveUnmatchedCases();
      expect(again.resolved).toHaveLength(0);
    } finally {
      await admin.query(`update deductions set debtor_id = null where debtor_id = $1`, [debtorId]);
      await admin.query(`delete from debtor_aliases where debtor_id = $1`, [debtorId]);
      await admin.query(`delete from debtors where id = $1`, [debtorId]);
    }
  });

  it('reports a backfill that would make two cases of one claim, rather than doing it', async () => {
    // Two cases opened while the retailer was unmatched, same claim. Once a
    // debtor resolves they cannot both point at it — that is the constraint
    // doing its job, and a backfill must not pretend otherwise.
    const claimId = `APDP-${suffix}-collide`;
    const first = await store.openCase({
      orgId,
      claimId,
      retailerName: 'Northvale Grocers',
      deductionAmountCents: 100,
    });
    const second = await store.openCase({
      orgId,
      claimId,
      retailerName: 'Northvale Grocers',
      deductionAmountCents: 100,
    });

    const debtorId = randomUUID();
    await admin.query(
      `insert into debtors (id, org_id, retailer_key, display_name)
       values ($1, $2, 'northvale', 'Northvale Grocers')`,
      [debtorId, orgId],
    );
    try {
      const result = await store.resolveUnmatchedCases();
      const resolvedIds = result.resolved.map((r) => r.deductionId);
      const blockedIds = result.blocked.map((r) => r.deductionId);

      // Exactly one of the pair went through; the other is reported by id.
      expect(resolvedIds).toContain(first.deductionId);
      expect(blockedIds).toContain(second.deductionId);
      expect(result.blocked[0]?.reason).toMatch(new RegExp(first.deductionId));
      expect((await readBack(second.deductionId)).debtor_id).toBeNull();
    } finally {
      await admin.query(`update deductions set debtor_id = null where debtor_id = $1`, [debtorId]);
      await admin.query(`delete from debtors where id = $1`, [debtorId]);
    }
  });

  it('reads the printed name back onto the case list', async () => {
    const cases = await store.listCases(200);
    const unmatched = cases.find((c) => c.claimId === `APDP-${suffix}-3`);
    expect(unmatched?.retailerNameAsPrinted).toBe('Costco Wholesale Corporation');
    expect(unmatched?.debtorName).toBeUndefined();

    const matched = cases.find((c) => c.claimId === `APDP-${suffix}-1`);
    expect(matched?.debtorName).toBe('Walmart (APDP)');
    expect(matched?.deductionDate).toBe('2026-08-14');
    expect(matched?.disputeDeadline).toBe('2026-11-12');
  });
});

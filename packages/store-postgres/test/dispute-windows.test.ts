import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { manualEntryFromForm, resolveDisputeWindow } from '@recouple/core-domain';
import { closeAllPools, PostgresStore } from '../src/store';
import { DisputeWindowRefusedError, PostgresDisputeWindowStore } from '../src/dispute-windows';

/**
 * Payer dispute windows (ADR 0071, migration 0043) through
 * `PostgresDisputeWindowStore` and `PostgresStore.openCaseOn`, as `app_rw`,
 * with two tenants: who may write, which row applies on a date (SQL and
 * `resolveDisputeWindow` held to one answer), and the deadline it fills in
 * when — and only when — a case opens without one.
 */

const connectionString = process.env.TEST_DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

describeDb('payer dispute windows, on Postgres', () => {
  const admin = new Pool({ connectionString });
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const approverId = randomUUID();
  const analystId = randomUUID();
  const otherApproverId = randomUUID();
  const debtorId = randomUUID();
  const laterDebtorId = randomUUID();
  const bareDebtorId = randomUUID();
  const otherDebtorId = randomUUID();
  const suffix = orgId.slice(0, 8);
  const config = { connectionString: connectionString as string };
  let approver: PostgresDisputeWindowStore;
  let analyst: PostgresDisputeWindowStore;
  let other: PostgresDisputeWindowStore;
  let cases: PostgresStore;
  let otherCases: PostgresStore;

  beforeAll(async () => {
    await admin.query(
      `insert into organizations (id, slug, name) values ($1,$2,'Windows'), ($3,$4,'Windows Other')`,
      [orgId, `windows-${suffix}`, otherOrgId, `windows-other-${suffix}`],
    );
    await admin.query('insert into org_settings (org_id) values ($1), ($2)', [orgId, otherOrgId]);
    await admin.query('insert into users (id, email) values ($1,$2), ($3,$4), ($5,$6)', [
      approverId,
      `windows-approver-${suffix}@example.test`,
      analystId,
      `windows-analyst-${suffix}@example.test`,
      otherApproverId,
      `windows-other-${suffix}@example.test`,
    ]);
    await admin.query(
      `insert into memberships (org_id, user_id, role)
       values ($1,$2,'approver'), ($1,$3,'analyst'), ($4,$5,'owner')`,
      [orgId, approverId, analystId, otherOrgId, otherApproverId],
    );
    await admin.query(
      `insert into debtors (id, org_id, retailer_key, display_name)
       values ($1,$2,'sysco','Sysco'), ($3,$2,'pfg','PFG'), ($4,$2,'gordon','Gordon'),
              ($5,$6,'sysco','Sysco')`,
      [debtorId, orgId, laterDebtorId, bareDebtorId, otherDebtorId, otherOrgId],
    );
    approver = new PostgresDisputeWindowStore(config, { orgId, userId: approverId });
    analyst = new PostgresDisputeWindowStore(config, { orgId, userId: analystId });
    other = new PostgresDisputeWindowStore(config, { orgId: otherOrgId, userId: otherApproverId });
    cases = new PostgresStore(config, { orgId, userId: analystId });
    otherCases = new PostgresStore(config, { orgId: otherOrgId, userId: otherApproverId });
  });

  afterAll(async () => {
    await cases?.close();
    await otherCases?.close();
    await closeAllPools();
    await admin.end();
  });

  async function derivedEvents(deductionId: string) {
    const { rows } = await admin.query<{ payload: Record<string, unknown> }>(
      `select payload from deduction_events where deduction_id = $1 and event_type = 'case.deadline_derived'`,
      [deductionId],
    );
    return rows.map((r) => r.payload);
  }

  async function deadlineOf(deductionId: string): Promise<string | null> {
    const { rows } = await admin.query<{ d: string | null }>(
      `select dispute_deadline::text as d from deductions where id = $1`,
      [deductionId],
    );
    return rows[0]?.d ?? null;
  }

  let windowId: string;

  it('records a window as the member who wrote it', async () => {
    const row = await approver.recordDisputeWindow({
      debtorId,
      windowDays: 30,
      effectiveFrom: '2026-01-01',
      source: 'payer_guide_url',
      sourceNote: ' supplier guide §4 ',
      confidence: 'high',
    });
    windowId = row.id;
    expect(row).toMatchObject({
      debtorId,
      windowDays: 30,
      measuredFrom: 'deduction_date',
      effectiveFrom: '2026-01-01',
      source: 'payer_guide_url',
      sourceNote: 'supplier guide §4',
      confidence: 'high',
      recordedBy: approverId,
    });
    expect(row.effectiveTo).toBeUndefined();
  });

  it('refuses an analyst, another tenant\'s debtor and fields the table would not take', async () => {
    const base = { debtorId, effectiveFrom: '2026-01-01', source: 'operator', confidence: 'low' } as const;
    const refusal = analyst.recordDisputeWindow({ ...base, windowDays: 10 });
    await expect(refusal).rejects.toBeInstanceOf(DisputeWindowRefusedError);
    await expect(refusal).rejects.toMatchObject({ refusal: 'not_permitted' });
    await expect(
      approver.recordDisputeWindow({ ...base, debtorId: otherDebtorId, windowDays: 10 }),
    ).rejects.toMatchObject({ refusal: 'unknown_debtor' });
    await expect(approver.recordDisputeWindow({ ...base, windowDays: 0 })).rejects.toMatchObject({
      refusal: 'invalid',
      field: 'windowDays',
    });
    await expect(approver.recordDisputeWindow({ ...base, windowDays: 731 })).rejects.toMatchObject({
      refusal: 'invalid',
      field: 'windowDays',
    });
    await expect(
      approver.recordDisputeWindow({ ...base, windowDays: 10, effectiveTo: '2025-12-31' }),
    ).rejects.toMatchObject({ refusal: 'invalid', field: 'effectiveTo' });
    await expect(
      approver.recordDisputeWindow({ ...base, windowDays: 10, effectiveFrom: '2026-02-30' }),
    ).rejects.toMatchObject({ refusal: 'invalid', field: 'effectiveFrom' });
    const { rows } = await admin.query(`select 1 from payer_dispute_windows where org_id = $1`, [orgId]);
    expect(rows).toHaveLength(1);
  });

  it('a manual case for a payer with a 30-day window opens with its deadline derived', async () => {
    const opened = await cases.openManualCase({
      entry: manualEntryFromForm(
        {
          debtorId,
          deductionReference: `CB-${suffix}`,
          amount: '$1,250.00',
          deductionDate: '2026-09-15',
          invoiceNumbers: `INV-${suffix}`,
          reasonCode: 'PREMIUM-NOAUTH',
        },
        new Date('2026-10-07T10:00:00Z'),
      ),
      now: new Date('2026-10-07T10:00:00Z'),
    });
    expect(await deadlineOf(opened.deductionId)).toBe('2026-10-15');
    expect(await derivedEvents(opened.deductionId)).toEqual([
      {
        window_id: windowId,
        window_days: 30,
        measured_from: 'deduction_date',
        effective_from: '2026-01-01',
        source: 'payer_guide_url',
        confidence: 'high',
        deadline: '2026-10-15',
      },
    ]);
    const { rows } = await admin.query<{ payload: { deadline: string } }>(
      `select payload from deduction_events where deduction_id = $1 and event_type = 'case.discovered'`,
      [opened.deductionId],
    );
    expect(rows[0]?.payload.deadline).toBe('payer_window');
    expect(await approver.disputeWindowForCase(opened.deductionId)).toMatchObject({
      kind: 'window',
      deadline: '2026-10-15',
      window: { id: windowId, windowDays: 30 },
    });
  });

  it('a printed deadline wins and no derived event is written', async () => {
    const opened = await cases.openCase({
      orgId,
      claimId: `PRINTED-${suffix}`,
      debtorId,
      deductionAmountCents: 5000,
      deductionDate: '2026-09-15',
      disputeDeadline: '2026-12-01',
    });
    expect(opened.disputeDeadline).toBe('2026-12-01');
    expect(await deadlineOf(opened.deductionId)).toBe('2026-12-01');
    expect(await derivedEvents(opened.deductionId)).toEqual([]);
  });

  it('no window, no date or no debtor: no deadline and no event', async () => {
    const bare = await cases.openCase({
      orgId,
      claimId: `BARE-${suffix}`,
      debtorId: bareDebtorId,
      deductionAmountCents: 5000,
      deductionDate: '2026-09-15',
    });
    expect(bare.disputeDeadline).toBeUndefined();
    expect(await deadlineOf(bare.deductionId)).toBeNull();
    expect(await derivedEvents(bare.deductionId)).toEqual([]);
    expect(await approver.disputeWindowForCase(bare.deductionId)).toEqual({ kind: 'none' });

    const undated = await cases.openCase({
      orgId,
      claimId: `UNDATED-${suffix}`,
      debtorId,
      deductionAmountCents: 5000,
    });
    expect(await deadlineOf(undated.deductionId)).toBeNull();
    expect(await derivedEvents(undated.deductionId)).toEqual([]);
    expect(await approver.disputeWindowForCase(undated.deductionId)).toEqual({ kind: 'no_date' });

    const unmatched = await cases.openCase({
      orgId,
      claimId: `UNMATCHED-${suffix}`,
      retailerName: 'Nobody We Know',
      deductionAmountCents: 5000,
      deductionDate: '2026-09-15',
    });
    expect(await deadlineOf(unmatched.deductionId)).toBeNull();
    expect(await approver.disputeWindowForCase(unmatched.deductionId)).toEqual({ kind: 'no_debtor' });
    expect(await approver.disputeWindowForCase(randomUUID())).toEqual({ kind: 'none' });
  });

  it('a window recorded after a case opened changes nothing on it', async () => {
    const opened = await cases.openCase({
      orgId,
      claimId: `EARLY-${suffix}`,
      debtorId: laterDebtorId,
      deductionAmountCents: 5000,
      deductionDate: '2026-09-15',
    });
    await approver.recordDisputeWindow({
      debtorId: laterDebtorId,
      windowDays: 45,
      effectiveFrom: '2026-01-01',
      source: 'customer_confirmed',
      confidence: 'medium',
    });
    expect(await deadlineOf(opened.deductionId)).toBeNull();
    expect(await derivedEvents(opened.deductionId)).toEqual([]);
    // The page may still say what the window would give.
    expect(await approver.disputeWindowForCase(opened.deductionId)).toMatchObject({
      kind: 'window',
      deadline: '2026-10-30',
    });
  });

  it('another tenant\'s window is never used or seen', async () => {
    const opened = await otherCases.openCase({
      orgId: otherOrgId,
      claimId: `OTHER-${suffix}`,
      debtorId: otherDebtorId,
      deductionAmountCents: 5000,
      deductionDate: '2026-09-15',
    });
    expect(await deadlineOf(opened.deductionId)).toBeNull();
    expect(await other.currentDisputeWindows('2026-10-07')).toEqual([]);
    expect(await other.disputeWindowForCase(opened.deductionId)).toEqual({ kind: 'none' });
  });

  it('lists windows in force and payers with open cases and none', async () => {
    const listed = await analyst.currentDisputeWindows('2026-10-07');
    expect(listed.map((w) => [w.debtorName, w.windowDays])).toEqual([
      ['PFG', 45],
      ['Sysco', 30],
    ]);
    expect(await approver.payersWithoutWindow('2026-10-07')).toEqual([
      { debtorId: bareDebtorId, displayName: 'Gordon', openCases: 1, openCasesWithoutDeadline: 1 },
    ]);
  });

  it('the SQL function and resolveDisputeWindow give one answer on every date', async () => {
    await approver.recordDisputeWindow({
      debtorId,
      windowDays: 60,
      effectiveFrom: '2026-03-01',
      effectiveTo: '2026-03-31',
      source: 'operator',
      confidence: 'low',
    });
    await approver.recordDisputeWindow({
      debtorId,
      windowDays: 90,
      effectiveFrom: '2026-03-01',
      source: 'operator',
      confidence: 'low',
    });
    const all = await approver.allDisputeWindows();
    for (let day = 0; day < 200; day += 7) {
      const asOf = new Date(Date.UTC(2025, 11, 1) + day * 86_400_000).toISOString().slice(0, 10);
      const sql = (await approver.currentDisputeWindows(asOf)).find((w) => w.debtorId === debtorId);
      expect(sql?.id, asOf).toBe(resolveDisputeWindow(all, debtorId, asOf)?.id);
    }
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  buildLedgerSnapshot,
  cents,
  snapshotSha256,
  type GeneralLedger,
  type TrialBalance,
} from '@recouple/core-domain';
import { PostgresLedgerSyncStore } from '../src/connections';
import { LedgerSnapshotRefusedError, PostgresLedgerSnapshotStore } from '../src/snapshots';
import { closeAllPools, PostgresStore } from '../src/store';

const connectionString = process.env.TEST_DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

/**
 * Kept snapshots of the books against a real database (ADR 0074, migration
 * 0045). `supabase/tests/41` asks the schema its questions in SQL; this asks
 * the ones only the driver can: does the content `buildLedgerSnapshot` makes
 * cross the door intact, does it come back out of the rows byte for byte so
 * the stored hash recomputes, and does the chain refuse a fork.
 */
describeDb('ledger snapshots on Postgres', () => {
  const admin = new Pool({ connectionString });
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const analystId = randomUUID();
  const otherAnalystId = randomUUID();
  const connectionId = randomUUID();
  const suffix = orgId.slice(0, 8);
  const config = { connectionString: connectionString as string };
  const window = { from: '2026-09-03', to: '2026-10-07' };

  let runs: PostgresLedgerSyncStore;
  let snapshots: PostgresLedgerSnapshotStore;
  let otherSnapshots: PostgresLedgerSnapshotStore;

  async function completedRun(): Promise<string> {
    return runs.recordLedgerSyncRun({
      orgId,
      connectionId,
      requestedBy: analystId,
      windowFrom: window.from,
      windowTo: window.to,
      startedAt: new Date(Date.now() - 5_000),
      finishedAt: new Date(),
      outcome: 'completed',
      invoicesExamined: 3,
      openedCount: 0,
      skippedCount: 0,
      declinedCount: 0,
      anomalyCount: 0,
      anomalies: [],
    });
  }

  const trialBalance: TrialBalance = {
    sourceKind: 'qbo',
    asOf: window.to,
    basis: 'Accrual',
    currency: 'USD',
    lines: [
      { accountExternalId: '84', accountName: 'Accounts Receivable', debitCents: cents(1_250_000), creditCents: cents(0) },
      { accountExternalId: '79', accountName: 'Sales — "Food" & Bev', debitCents: cents(0), creditCents: cents(1_000_000) },
      { accountName: 'Promotional Allowances', debitCents: cents(0), creditCents: cents(250_000) },
    ],
    totalDebitCents: cents(1_250_000),
    totalCreditCents: cents(1_250_000),
  };
  const generalLedger: GeneralLedger = {
    sourceKind: 'qbo',
    window,
    accounts: [
      {
        accountExternalId: '84',
        accountName: 'Accounts Receivable',
        lines: [
          {
            accountExternalId: '84',
            accountName: 'Accounts Receivable',
            date: '2026-09-10',
            transactionType: 'Payment',
            transactionExternalId: '128',
            memo: 'never kept',
            debitCents: cents(0),
            creditCents: cents(920_000),
          },
          {
            accountExternalId: '84',
            accountName: 'Accounts Receivable',
            date: '2026-09-01',
            transactionType: 'Invoice',
            transactionExternalId: '96',
            documentNumber: 'INV-1001',
            debitCents: cents(1_000_000),
            creditCents: cents(0),
          },
        ],
      },
    ],
  };

  beforeAll(async () => {
    await admin.query(
      `insert into organizations (id, slug, name) values ($1,$2,'Kept'), ($3,$4,'Kept Other')`,
      [orgId, `kept-${suffix}`, otherOrgId, `kept-other-${suffix}`],
    );
    await admin.query(`insert into org_settings (org_id) values ($1), ($2)`, [orgId, otherOrgId]);
    await admin.query(`insert into users (id, email) values ($1,$2), ($3,$4)`, [
      analystId, `kept-a-${suffix}@example.test`,
      otherAnalystId, `kept-o-${suffix}@example.test`,
    ]);
    await admin.query(
      `insert into memberships (org_id, user_id, role) values ($1,$2,'analyst'), ($3,$4,'analyst')`,
      [orgId, analystId, otherOrgId, otherAnalystId],
    );
    await admin.query(
      `insert into accounting_connections (id, org_id, provider, provider_account_id, created_by)
       values ($1,$2,'qbo',$3,$4)`,
      [connectionId, orgId, `realm-kept-${suffix}`, analystId],
    );
    const tenant = { orgId, userId: analystId };
    runs = new PostgresLedgerSyncStore(config, tenant, new PostgresStore(config, tenant));
    snapshots = new PostgresLedgerSnapshotStore(config, tenant);
    otherSnapshots = new PostgresLedgerSnapshotStore(config, {
      orgId: otherOrgId,
      userId: otherAnalystId,
    });
  });

  afterAll(async () => {
    await closeAllPools();
    await admin.end();
  });

  it('keeps a chain: a complete first snapshot, a refused second, and a fork refused', async () => {
    expect(await snapshots.latestSnapshotSha(connectionId)).toBeUndefined();

    const firstRun = await completedRun();
    const first = buildLedgerSnapshot({
      orgId, connectionId, runId: firstRun, window, status: 'complete', trialBalance, generalLedger,
    });
    const firstSha = snapshotSha256(first, null);
    const firstId = await snapshots.recordLedgerSnapshot({ content: first, sha256: firstSha, prevSha256: null });
    expect(await snapshots.latestSnapshotSha(connectionId)).toBe(firstSha);

    // Read back out of the rows, the content is what was built, and the hash recomputes.
    const stored = await snapshots.snapshotContent(firstId);
    expect(stored?.content).toEqual(first);
    expect(stored?.prevSha256).toBeNull();
    expect(snapshotSha256(stored!.content, stored!.prevSha256)).toBe(firstSha);

    // A second run whose snapshot names no predecessor would fork the chain.
    const secondRun = await completedRun();
    const second = buildLedgerSnapshot({
      orgId, connectionId, runId: secondRun, window, status: 'refused', refusalClass: 'QboReportTooLarge',
    });
    await expect(
      snapshots.recordLedgerSnapshot({ content: second, sha256: snapshotSha256(second, null), prevSha256: null }),
    ).rejects.toBeInstanceOf(LedgerSnapshotRefusedError);

    const secondSha = snapshotSha256(second, firstSha);
    const secondId = await snapshots.recordLedgerSnapshot({ content: second, sha256: secondSha, prevSha256: firstSha });
    const storedSecond = await snapshots.snapshotContent(secondId);
    expect(snapshotSha256(storedSecond!.content, storedSecond!.prevSha256)).toBe(secondSha);

    const listed = await snapshots.recentSnapshots(connectionId, 12);
    expect(listed.map((row) => row.snapshotId)).toEqual([secondId, firstId]);
    expect(listed[0]).toMatchObject({ status: 'refused', refusalClass: 'QboReportTooLarge', prevSha256: firstSha });
    expect(listed[0]?.totalDebitCents).toBeUndefined();
    expect(listed[1]).toMatchObject({
      status: 'complete',
      asOf: window.to,
      totalDebitCents: 1_250_000,
      totalCreditCents: 1_250_000,
      trialBalanceLineCount: 3,
      ledgerLineCount: 2,
    });
  });

  it('keeps no memo', async () => {
    const { rows } = await admin.query<{ n: string }>(
      `select count(*)::text as n from ledger_snapshot_lines
        where org_id = $1 and (account_name ilike '%never kept%' or doc_number ilike '%never kept%')`,
      [orgId],
    );
    expect(rows[0]?.n).toBe('0');
  });

  it('is invisible to another tenant, and refuses their write onto this chain', async () => {
    expect(await otherSnapshots.latestSnapshotSha(connectionId)).toBeUndefined();
    expect(await otherSnapshots.recentSnapshots(connectionId, 12)).toEqual([]);
    const run = await completedRun();
    const content = buildLedgerSnapshot({
      orgId, connectionId, runId: run, window, status: 'refused', refusalClass: 'QboMalformedResponse',
    });
    await expect(
      otherSnapshots.recordLedgerSnapshot({ content, sha256: snapshotSha256(content, null), prevSha256: null }),
    ).rejects.toBeInstanceOf(LedgerSnapshotRefusedError);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  buildLedgerExtract,
  cents,
  detectShortPays,
  type LedgerInvoice,
  type LedgerPayment,
} from '@recouple/core-domain';
import { closeAllPools, PostgresStore } from '../src/store';
import { DiscoveryStoreError, PostgresDiscoveryStore } from '../src/discovery';

/**
 * Coverage with a denominator (migration 0023, ADR 0030, STRATEGY §2, ADD-2).
 *
 * `coverage_of_seen` answers "of what reached us, how much did we fight for",
 * which improves when we look at less. This is the test that the number the
 * business is measured by now has *discovered* dollars under it — every case we
 * opened plus every candidate we declined — and that it says which channel each
 * dollar came from, because a blended rate moves whenever the source mix does.
 *
 * What only the database can answer, and therefore what is tested here: that a
 * case's channel is derived from its own notice rather than passed in, that a
 * case with no recorded arrival lands in `unknown` rather than in somebody's
 * denominator, and that the ratio comes back from the view rather than from
 * dividing two bigints in TypeScript.
 */

const connectionString = process.env.DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

function invoice(overrides: Partial<LedgerInvoice> = {}): LedgerInvoice {
  return {
    sourceKind: 'qbo',
    externalId: 'cov-inv-1',
    invoiceNumber: 'COV-1001',
    customerExternalId: 'cov-cust-1',
    customerName: 'US Foods Seattle',
    issuedOn: '2026-07-01',
    totalCents: cents(1_000_000),
    balanceCents: cents(80_000),
    currency: 'USD',
    ...overrides,
  };
}

function payment(overrides: Partial<LedgerPayment> = {}): LedgerPayment {
  return {
    sourceKind: 'qbo',
    externalId: 'cov-pay-1',
    customerExternalId: 'cov-cust-1',
    receivedOn: '2026-07-20',
    totalCents: cents(920_000),
    reference: 'ACH-90210',
    memo: 'shortage',
    appliedTo: [{ invoiceExternalId: 'cov-inv-1', amountCents: cents(920_000) }],
    ...overrides,
  };
}

describeDb('coverage has a denominator', () => {
  const admin = new Pool({ connectionString });
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const analystId = randomUUID();
  const approverId = randomUUID();
  const suffix = orgId.slice(0, 8);
  let store: PostgresStore;
  let discovery: PostgresDiscoveryStore;

  /** The ERP-discovered case: the one that gets filed. */
  let erpDeductionId: string;

  beforeAll(async () => {
    await admin.query(
      `insert into organizations (id, slug, name)
       values ($1, $2, 'Coverage Denominator'), ($3, $4, 'Coverage Other')`,
      [orgId, `covd-${suffix}`, otherOrgId, `covd-other-${suffix}`],
    );
    await admin.query(`insert into org_settings (org_id) values ($1), ($2)`, [orgId, otherOrgId]);
    await admin.query(`insert into users (id, email) values ($1,$2), ($3,$4)`, [
      analystId,
      `covd-a-${suffix}@example.test`,
      approverId,
      `covd-p-${suffix}@example.test`,
    ]);
    await admin.query(
      `insert into memberships (org_id, user_id, role)
       values ($1,$2,'analyst'), ($1,$3,'approver')`,
      [orgId, analystId, approverId],
    );

    const config = { connectionString: connectionString as string };
    store = new PostgresStore(config, { orgId, userId: analystId });
    discovery = new PostgresDiscoveryStore(config, { orgId, userId: analystId }, store);

    // 1. A short-pay the customer never surfaced, entering as a document
    //    through the ERP door (ADR 0029). Nothing tells the view it is
    //    `erp_sync`; the view reads it back off this case's own notice.
    const report = detectShortPays([invoice()], [payment()], []);
    const candidate = report.candidates[0];
    if (candidate === undefined) throw new Error('no candidate');
    const recorded = await discovery.recordLedgerCase({
      orgId,
      extract: buildLedgerExtract(candidate, invoice(), [payment()], []),
      identifiers: { ledgerInvoiceId: 'cov-inv-1', invoiceNumber: 'COV-1001' },
      gapCents: 80_000,
      customerName: 'US Foods Seattle',
      gapStatus: 'open',
      deductionDate: '2026-07-20',
    });
    erpDeductionId = recorded.deductionId;

    // 2. One a person uploaded: found, and not yet fought.
    const uploaded = await store.openCase({
      orgId,
      claimId: `COVD-${suffix}-WEB`,
      deductionAmountCents: 60_000,
    });
    const upload = await store.recordUpload({
      orgId,
      source: 'web_upload',
      createdBy: analystId,
    });
    const stored = await store.putDocument({
      orgId,
      sha256: `${suffix}web`.padEnd(64, 'a').slice(0, 64),
      filename: 'notice.pdf',
      mimeType: 'application/pdf',
      byteSize: 1024,
      bytes: new Uint8Array([37, 80, 68, 70]),
      uploadId: upload.uploadId,
      requiresSplit: false,
    });
    await store.linkDocument(uploaded.deductionId, stored.documentId, 'notice');

    // 3. A case with no notice document at all. It has to be reported
    //    somewhere, and the one place it must not be reported is inside a
    //    channel's denominator.
    await store.openCase({
      orgId,
      claimId: `COVD-${suffix}-UNKNOWN`,
      deductionAmountCents: 25_000,
    });

    // 4. A ledger candidate declined below the floor: never a case, and the
    //    half of the denominator migration 0014 already had (ADD-1).
    await discovery.declineCandidate({
      orgId,
      reason: 'below_economic_floor',
      estimatedRecoverableCents: 4_200,
      identifiers: { ledgerInvoiceId: 'cov-inv-tiny', invoiceNumber: 'COV-TINY' },
      customerExternalId: 'cov-cust-1',
      customerName: 'US Foods Seattle',
    });

    // 5. File the ERP case, through the gate rather than around it: a decision
    //    prepared by the analyst, an approval by somebody else, and only then a
    //    submission, complete when written (ADR 0023).
    const { rows: decisionRows } = await admin.query<{ id: string }>(
      `insert into decisions (org_id, deduction_id, schema_id, schema_version, provider,
                              model_version, input_state_hash, questions, result,
                              raw_probabilities, confidence, latency_ms, prepared_by)
       values ($1, $2, 'B', '1.0.0', 'jev', 'jev-latest', digest('cov state', 'sha256'),
               '{"validity":"choice"}'::jsonb, '{"validity":"invalid_deduction"}'::jsonb,
               '{"validity":{"invalid_deduction":0.96,"valid":0.04}}'::jsonb, 0.96, 180, $3)
       returning id`,
      [orgId, erpDeductionId, analystId],
    );
    const decisionId = decisionRows[0]?.id;
    if (decisionId === undefined) throw new Error('no decision');
    await admin.query(
      `insert into approvals (org_id, decision_id, approver_id, action_type)
       values ($1, $2, $3, 'submit')`,
      [orgId, decisionId, approverId],
    );
    await admin.query(
      `insert into submissions (org_id, deduction_id, decision_id, channel, packet_hash,
                                confirmation_number, submitted_at)
       values ($1, $2, $3, 'manual_portal', digest('filed packet', 'sha256'), 'COVD-1', now())`,
      [orgId, erpDeductionId, decisionId],
    );
  });

  afterAll(async () => {
    await closeAllPools();
    await admin.end();
  });

  it('reports one row per channel that found money, and never blends them', async () => {
    const rows = await discovery.coverageByPeriod(orgId);
    expect(rows.map((row) => row.discoveredFrom).sort()).toEqual([
      'erp_sync',
      'unknown',
      'web_upload',
    ]);
    expect(rows.every((row) => row.orgId === orgId)).toBe(true);
    // The month, as its first day — a period a caller can group on without
    // parsing a timestamp.
    expect(rows.every((row) => /^\d{4}-\d{2}-01$/.test(row.period))).toBe(true);
  });

  it('puts the ledger case and the ledger decline under erp_sync, in integer cents', async () => {
    const rows = await discovery.coverageByPeriod(orgId);
    const erp = rows.find((row) => row.discoveredFrom === 'erp_sync');

    expect(erp?.openedCount).toBe(1);
    expect(erp?.openedCents).toBe(80_000);
    expect(erp?.declinedCount).toBe(1);
    expect(erp?.declinedCents).toBe(4_200);
    // The denominator, and the definition of it: what we judged worth fighting
    // for plus what we judged was not.
    expect(erp?.discoveredCents).toBe(84_200);
    expect(erp?.filedCount).toBe(1);
    expect(erp?.filedCents).toBe(80_000);
    // Every one of those is an exact integer, not a float that happens to look
    // like one (invariant 3).
    expect(Number.isSafeInteger(erp?.discoveredCents)).toBe(true);
  });

  it('gets the ratio from the view, rounded there', async () => {
    const rows = await discovery.coverageByPeriod(orgId);
    const erp = rows.find((row) => row.discoveredFrom === 'erp_sync');
    // 80000 / 84200 = 0.950118…, rounded to four places in SQL. Asserted
    // against the rounded literal rather than against a TypeScript division,
    // because a TypeScript division here is the thing being avoided.
    expect(erp?.coverageOfDiscovered).toBe(0.9501);

    const web = rows.find((row) => row.discoveredFrom === 'web_upload');
    expect(web?.openedCents).toBe(60_000);
    expect(web?.filedCents).toBe(0);
    // Zero, not null and not absent. A channel that found dollars and filed
    // none is the case coverage exists to make visible.
    expect(web?.coverageOfDiscovered).toBe(0);
  });

  it('reports a case whose arrival nothing recorded as unknown, never as a channel', async () => {
    const rows = await discovery.coverageByPeriod(orgId);
    const unknown = rows.find((row) => row.discoveredFrom === 'unknown');
    expect(unknown?.openedCents).toBe(25_000);
    expect(unknown?.filedCents).toBe(0);
    // And it is a bucket of its own rather than dollars folded into a channel
    // that did not find them: the two real channels still report exactly what
    // they found.
    const attributed = rows
      .filter((row) => row.discoveredFrom !== 'unknown')
      .reduce((sum, row) => sum + row.openedCents, 0);
    expect(attributed).toBe(140_000);
  });

  /**
   * `coverage_by_period` itself is not touched: `scripts/db-test.sh` re-applies
   * migration 0014 after 0023, and its `create or replace view` cannot drop
   * columns, so extending that view would break the second pass and 0014 is
   * merged (ADR 0030 §2). The totals view is where the denominator lives.
   */
  it('agrees with the summed view, column for column', async () => {
    const rows = await discovery.coverageByPeriod(orgId);
    const { rows: summed } = await admin.query<{
      filed_cents: string;
      declined_cents: string;
      discovered_cents: string;
      coverage_of_discovered: string;
      coverage_of_seen: string;
    }>(
      `select filed_cents::text, declined_cents::text, discovered_cents::text,
              coverage_of_discovered::text, coverage_of_seen::text
         from coverage_by_period_totals where org_id = $1`,
      [orgId],
    );
    const total = summed[0];
    expect(total?.discovered_cents).toBe(
      String(rows.reduce((sum, row) => sum + row.discoveredCents, 0)),
    );
    expect(total?.discovered_cents).toBe('169200');
    expect(total?.filed_cents).toBe('80000');
    // 80000 / 169200 blended, against 80000 / 84200 for the channel that found
    // it — which is why the two are reported separately and the blended one is
    // not a rate anybody should quote.
    expect(Number(total?.coverage_of_discovered)).toBe(0.4728);
    // Migration 0014's number, unchanged: filed over filed plus declined.
    expect(Number(total?.coverage_of_seen)).toBe(0.9501);
  });

  it('answers for this tenant only, and refuses to be asked about another', async () => {
    const { rows } = await admin.query<{ n: string }>(
      `select count(*)::text as n from coverage_by_period_by_source where org_id = $1`,
      [otherOrgId],
    );
    expect(rows[0]?.n).toBe('0');
    await expect(discovery.coverageByPeriod(otherOrgId)).rejects.toThrow(DiscoveryStoreError);
  });
});

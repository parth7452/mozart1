import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { closeAllPools, PostgresStore } from '../src/store';
import { PostgresDiscoveryStore } from '../src/discovery';

/**
 * A declined case is found once (migration 0029, ADR 0038).
 *
 * `declineCase` writes a `declined_candidates` row that names the case and
 * carries its full amount, and the case stays in `deductions`. Migration 0023
 * added the two — `discovered = opened + declined` — so the first case a
 * reviewer declined would have been counted twice in its channel's
 * denominator. The existing coverage tests never met one: they decline only
 * candidates that never became a case, through `declineCandidate`.
 *
 * This declines a real case, through the real store method, and asks the
 * view the product reads. The case's dollars must be in `discovered_cents`
 * exactly once; the decline must still be reported in `declined_*`.
 */

const connectionString = process.env.TEST_DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

describeDb('a declined case is found once', () => {
  const admin = new Pool({ connectionString });
  const orgId = randomUUID();
  const analystId = randomUUID();
  const suffix = orgId.slice(0, 8);
  let store: PostgresStore;
  let discovery: PostgresDiscoveryStore;
  let documents = 0;

  /** As the tenant would read it: `app_rw`, claims set transaction-locally. */
  async function asTenant<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query('set local role app_rw');
      await client.query('select set_config($1, $2, true)', [
        'request.jwt.claims',
        JSON.stringify({ org_id: orgId, sub: analystId }),
      ]);
      const result = await work(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** A case whose notice a person uploaded. */
  async function openUploadedCase(amountCents: number): Promise<string> {
    documents += 1;
    const opened = await store.openCase({
      orgId,
      claimId: `ONCE-${suffix}-${documents}`,
      deductionAmountCents: amountCents,
    });
    const upload = await store.recordUpload({ orgId, source: 'web_upload', createdBy: analystId });
    const stored = await store.putDocument({
      orgId,
      sha256: `${suffix}${documents}`.padEnd(64, 'e').slice(0, 64),
      filename: `notice-${documents}.pdf`,
      mimeType: 'application/pdf',
      byteSize: 1024,
      bytes: new Uint8Array([37, 80, 68, 70]),
      uploadId: upload.uploadId,
      requiresSplit: false,
    });
    await store.linkDocument(opened.deductionId, stored.documentId, 'notice');
    return opened.deductionId;
  }

  beforeAll(async () => {
    await admin.query(`insert into organizations (id, slug, name) values ($1,$2,'Found Once')`, [
      orgId,
      `once-${suffix}`,
    ]);
    await admin.query(`insert into org_settings (org_id) values ($1)`, [orgId]);
    await admin.query(`insert into users (id, email) values ($1,$2)`, [
      analystId,
      `once-${suffix}@example.test`,
    ]);
    await admin.query(`insert into memberships (org_id, user_id, role) values ($1,$2,'analyst')`, [
      orgId,
      analystId,
    ]);
    const config = { connectionString: connectionString as string };
    store = new PostgresStore(config, { orgId, userId: analystId });
    discovery = new PostgresDiscoveryStore(config, { orgId, userId: analystId }, store);

    // Two uploaded cases, one of which a reviewer declines — through
    // `declineCase`, which derives the channel and the amount from the case.
    const declined = await openUploadedCase(312_000);
    await openUploadedCase(45_000);
    const decline = await store.declineCase({
      deductionId: declined,
      reason: 'deduction_valid',
      decidedBy: `once-${suffix}@example.test`,
    });
    expect(decline.estimatedRecoverableCents).toBe(312_000);
    expect(decline.discoveredFrom).toBe('web_upload');

    // And one ledger candidate declined at triage, which never became a case:
    // the half of the denominator that must keep counting.
    await discovery.declineCandidate({
      orgId,
      reason: 'below_economic_floor',
      estimatedRecoverableCents: 4_200,
      identifiers: { ledgerInvoiceId: `once-inv-${suffix}`, invoiceNumber: 'ONCE-TINY' },
      customerExternalId: 'once-cust-1',
      customerName: 'US Foods Seattle',
    });
  });

  afterAll(async () => {
    await closeAllPools();
    await admin.end();
  });

  it("counts the declined case's dollars in discovered exactly once", async () => {
    const rows = await discovery.coverageByPeriod(orgId);
    const web = rows.find((row) => row.discoveredFrom === 'web_upload');

    // Both cases were opened; declining one of them afterwards does not
    // un-open it (ADR 0038 §1).
    expect(web?.openedCount).toBe(2);
    expect(web?.openedCents).toBe(357_000);
    // The decline is still reported, in full: the counterfactual log does not
    // lose a reviewer's decision (ADR 0038 §2).
    expect(web?.declinedCount).toBe(1);
    expect(web?.declinedCents).toBe(312_000);
    // And the denominator holds each case once: 312,000 + 45,000. Migration
    // 0023 answered 669,000 here — the declined case twice.
    expect(web?.discoveredCents).toBe(357_000);
    expect(web?.coverageOfDiscovered).toBe(0);
  });

  it('still counts a candidate that never became a case', async () => {
    const rows = await discovery.coverageByPeriod(orgId);
    const erp = rows.find((row) => row.discoveredFrom === 'erp_sync');
    expect(erp?.openedCents).toBe(0);
    expect(erp?.declinedCents).toBe(4_200);
    expect(erp?.discoveredCents).toBe(4_200);
  });

  it('carries the correction into the tenant total, and leaves coverage_of_seen alone', async () => {
    const { rows } = await asTenant(async (client) =>
      client.query<{
        discovered_cents: string;
        declined_cents: string;
        seen_here: string | null;
        seen_0014: string | null;
      }>(
        `select t.discovered_cents::text as discovered_cents,
                t.declined_cents::text   as declined_cents,
                t.coverage_of_seen::text as seen_here,
                (select p.coverage_of_seen::text from coverage_by_period p
                  where p.org_id = t.org_id and p.period = t.period) as seen_0014
           from coverage_by_period_totals t
          where t.org_id = $1`,
        [orgId],
      ),
    );
    expect(rows).toHaveLength(1);
    const total = rows[0];
    // 357,000 opened + 4,200 declined without a case. Each dollar once.
    expect(total?.discovered_cents).toBe('361200');
    // Every decline, case or no case.
    expect(total?.declined_cents).toBe('316200');
    // Migration 0014's number, to the digit, with a declined case present —
    // the property narrowing `declined_cents` would have broken.
    expect(total?.seen_here).toBe(total?.seen_0014);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { closeAllPools, PostgresStore } from '../src/store';
import { PostgresDiscoveryStore } from '../src/discovery';
import { PostgresLedgerSyncStore } from '../src/connections';
import { CoverageReadError } from '../src/coverage';
import { LedgerHealthReadError } from '../src/ledger-health';

/**
 * The coverage page's two reads, on Postgres as `app_rw` with the tenant's
 * claims: what `coverageReport` answers must be what the views answer, per
 * channel and never blended, and `ledgerSyncHealth` must scope a ledger's
 * findings to its own connection and its own latest completed run.
 */

const connectionString = process.env.TEST_DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

describeDb('the coverage page reads', () => {
  const admin = new Pool({ connectionString });
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const analystId = randomUUID();
  const readerId = randomUUID();
  const approverId = randomUUID();
  const suffix = orgId.slice(0, 8);
  let store: PostgresStore;
  let readOnlyStore: PostgresStore;
  let otherStore: PostgresStore;
  let discovery: PostgresDiscoveryStore;
  let runs: PostgresLedgerSyncStore;
  let debtorId: string;
  let documents = 0;

  /** As the tenant would read it: `app_rw`, claims set transaction-locally. */
  async function asTenant<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query('set local role app_rw');
      await client.query(`set local timezone = 'UTC'`);
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

  /** A case whose notice arrived through `source`, or through nothing recorded. */
  async function openCase(
    amountCents: number,
    source: 'web_upload' | 'email_in' | 'unrecorded',
  ): Promise<string> {
    documents += 1;
    const opened = await store.openCase({
      orgId,
      claimId: `COV-${suffix}-${documents}`,
      deductionAmountCents: amountCents,
    });
    const upload =
      source === 'unrecorded'
        ? undefined
        : await store.recordUpload({
            orgId,
            source,
            // An email's sender is not one of our users (ADR 0024).
            ...(source === 'web_upload' ? { createdBy: analystId } : {}),
          });
    const stored = await store.putDocument({
      orgId,
      sha256: `${suffix}${documents}`.padEnd(64, 'c').slice(0, 64),
      filename: `notice-${documents}.pdf`,
      mimeType: 'application/pdf',
      byteSize: 1024,
      bytes: new Uint8Array([37, 80, 68, 70]),
      ...(upload === undefined ? {} : { uploadId: upload.uploadId }),
      requiresSplit: false,
    });
    await store.linkDocument(opened.deductionId, stored.documentId, 'notice');
    return opened.deductionId;
  }

  /** A filed case: the approval gate is exercised, not routed around. */
  async function file(deductionId: string): Promise<void> {
    // A decision prepared by the analyst, an approval by somebody else, and
    // only then a submission, complete when written (ADR 0023).
    const { rows: decision } = await admin.query<{ id: string }>(
      `insert into decisions (org_id, deduction_id, schema_id, schema_version, provider,
                              model_version, input_state_hash, questions, result,
                              raw_probabilities, confidence, latency_ms, prepared_by)
       values ($1, $2, 'B', '1.0.0', 'jev', 'jev-latest', digest('cov report state', 'sha256'),
               '{"validity":"choice"}'::jsonb, '{"validity":"invalid_deduction"}'::jsonb,
               '{"validity":{"invalid_deduction":0.96,"valid":0.04}}'::jsonb, 0.96, 180, $3)
       returning id`,
      [orgId, deductionId, analystId],
    );
    const decisionId = decision[0]?.id;
    if (decisionId === undefined) throw new Error('no decision');
    // The approval is the approver's own act, written in their session as
    // `app_rw`: one in anybody else's name, or in nobody's, is refused by
    // `app.approval_names_its_approver()` (migration 0031, ADR 0041).
    const approving = await admin.connect();
    try {
      await approving.query('begin');
      await approving.query('set local role app_rw');
      await approving.query('select set_config($1, $2, true)', [
        'request.jwt.claims',
        JSON.stringify({ org_id: orgId, sub: approverId }),
      ]);
      await approving.query(
        `insert into approvals (org_id, decision_id, approver_id, action_type)
         values ($1, $2, $3, 'submit')`,
        [orgId, decisionId, approverId],
      );
      await approving.query('commit');
    } catch (error) {
      await approving.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      approving.release();
    }
    await admin.query(
      `insert into submissions (org_id, deduction_id, decision_id, channel, packet_hash,
                                confirmation_number, submitted_at)
       values ($1, $2, $3, 'manual_portal', digest('cov filed packet', 'sha256'), 'COVR-1', now())`,
      [orgId, deductionId, decisionId],
    );
  }

  beforeAll(async () => {
    for (const [id, slug] of [
      [orgId, `cov-${suffix}`],
      [otherOrgId, `cov-other-${suffix}`],
    ] as const) {
      await admin.query(`insert into organizations (id, slug, name) values ($1,$2,'Coverage')`, [id, slug]);
      await admin.query(`insert into org_settings (org_id) values ($1)`, [id]);
    }
    await admin.query(`insert into users (id, email) values ($1,$2), ($3,$4), ($5,$6)`, [
      analystId,
      `cov-${suffix}@example.test`,
      readerId,
      `cov-reader-${suffix}@example.test`,
      approverId,
      `cov-approver-${suffix}@example.test`,
    ]);
    await admin.query(
      `insert into memberships (org_id, user_id, role)
       values ($1,$2,'analyst'), ($1,$3,'read_only'), ($4,$2,'analyst'), ($1,$5,'approver')`,
      [orgId, analystId, readerId, otherOrgId, approverId],
    );
    const { rows } = await admin.query<{ id: string }>(
      `insert into debtors (org_id, retailer_key, display_name)
       values ($1,'cov_walmart','Walmart (APDP)') returning id`,
      [orgId],
    );
    debtorId = rows[0]?.id as string;

    const config = { connectionString: connectionString as string };
    store = new PostgresStore(config, { orgId, userId: analystId });
    readOnlyStore = new PostgresStore(config, { orgId, userId: readerId });
    otherStore = new PostgresStore(config, { orgId: otherOrgId, userId: analystId });
    discovery = new PostgresDiscoveryStore(config, { orgId, userId: analystId }, store);
    runs = new PostgresLedgerSyncStore(config, { orgId, userId: analystId }, store);

    // Uploaded: one filed, one open. Emailed: one open. Unrecorded: one open.
    const filed = await openCase(312_000, 'web_upload');
    await openCase(45_000, 'web_upload');
    await openCase(80_000, 'email_in');
    await openCase(12_345, 'unrecorded');
    await file(filed);
    // A ledger candidate declined at triage, which never became a case.
    await discovery.declineCandidate({
      orgId,
      reason: 'below_economic_floor',
      estimatedRecoverableCents: 400,
      identifiers: { ledgerInvoiceId: `cov-inv-${suffix}`, invoiceNumber: 'COV-TINY' },
      customerExternalId: 'cov-cust-1',
      customerName: 'Amy’s Bird Sanctuary',
    });
  });

  afterAll(async () => {
    await closeAllPools();
    await admin.end();
  });

  describe('coverageReport', () => {
    it('answers exactly what the per-channel view answers, unknown included', async () => {
      const report = await store.coverageReport();
      const direct = await asTenant(async (client) => {
        const { rows } = await client.query<{
          discovered_from: string;
          discovered_cents: string;
          filed_cents: string;
          coverage_of_discovered: string | null;
        }>(
          `select discovered_from, discovered_cents::text, filed_cents::text, coverage_of_discovered::text
             from coverage_by_period_by_source
            where period = date_trunc('month', now())
            order by discovered_from`,
        );
        return rows;
      });

      const thisMonth = report.bySource.filter((row) => row.period === report.currentMonth);
      expect(thisMonth.map((row) => row.discoveredFrom)).toEqual(direct.map((row) => row.discovered_from));
      for (const row of direct) {
        const mine = thisMonth.find((candidate) => candidate.discoveredFrom === row.discovered_from);
        expect(mine?.discoveredCents, row.discovered_from).toBe(Number(row.discovered_cents));
        expect(mine?.filedCents, row.discovered_from).toBe(Number(row.filed_cents));
        expect(mine?.coverageOfDiscovered, row.discovered_from).toBe(
          row.coverage_of_discovered === null ? undefined : Number(row.coverage_of_discovered),
        );
      }
      // The channel nothing recorded is shown, not guessed at.
      expect(thisMonth.map((row) => row.discoveredFrom)).toEqual(
        expect.arrayContaining(['email_in', 'erp_sync', 'unknown', 'web_upload']),
      );
    });

    it('divides the trailing rate in the database, per channel', async () => {
      const report = await store.coverageReport();
      const web = report.trailing.find((row) => row.discoveredFrom === 'web_upload');
      expect(web).toMatchObject({ openedCount: 2, filedCount: 1, filedCents: 312_000, discoveredCents: 357_000 });
      // round(312000 / 357000, 4) = 0.8739
      expect(web?.coverageOfDiscovered).toBe(0.8739);
      const erp = report.trailing.find((row) => row.discoveredFrom === 'erp_sync');
      expect(erp).toMatchObject({ openedCount: 0, filedCents: 0, discoveredCents: 400 });
      expect(erp?.coverageOfDiscovered).toBe(0);
    });

    it('carries dollars and no rate for all channels together', async () => {
      const report = await store.coverageReport();
      const month = report.totals.find((row) => row.period === report.currentMonth);
      expect(month).toEqual({
        period: report.currentMonth,
        openedCents: 312_000 + 45_000 + 80_000 + 12_345,
        filedCents: 312_000,
        declinedCents: 400,
        discoveredCents: 312_000 + 45_000 + 80_000 + 12_345 + 400,
      });
      expect(Object.keys(month ?? {})).not.toContain('coverageOfDiscovered');
      expect(Object.keys(month ?? {})).not.toContain('coverageOfSeen');
    });

    it('counts a confirmed duplicate’s newer half once, by channel, in SQL', async () => {
      // A case held from the ledger and an uploaded notice that agrees with it:
      // the real openCase records the probable pair, and a person confirms it.
      const older = randomUUID();
      await admin.query(
        `insert into deductions (id, org_id, debtor_id, claim_id, deduction_amount_cents, deduction_date)
         values ($1,$2,$3,$4,42150,'2026-07-02')`,
        [older, orgId, debtorId, `COV-${suffix}-held`],
      );
      await admin.query(
        `insert into deduction_identifiers (org_id, deduction_id, source, identifier_kind, identifier)
         values ($1,$2,'erp_sync','invoice_number',$3)`,
        [orgId, older, `COV-INV-${suffix}`],
      );
      const newer = await store.openCase({
        orgId,
        claimId: `COV-${suffix}-new`,
        invoiceNumber: `COV-INV-${suffix}`,
        source: 'web_upload',
        retailerName: 'Walmart (APDP)',
        deductionAmountCents: 42_150,
        deductionDate: '2026-07-05',
      });
      await store.recordDuplicateVerdict({
        deductionId: newer.deductionId,
        otherDeductionId: older,
        verdict: 'same',
        recordedBy: analystId,
      });

      const report = await store.coverageReport();
      expect(report.countedTwice.cases).toBe(1);
      expect(report.countedTwice.cents).toBe(42_150);
      expect(report.countedTwice.listed).toEqual([
        { deductionId: newer.deductionId, claimId: `COV-${suffix}-new`, amountCents: 42_150 },
      ]);
      // The newer case has no notice document here, so its channel is the one
      // nothing recorded — derived the way the view derives it.
      expect(report.countedTwice.byChannel).toEqual([{ discoveredFrom: 'unknown', cases: 1, cents: 42_150 }]);

      // The same newer half confirmed against a second older case is still one case.
      const olderAgain = randomUUID();
      await admin.query(
        `insert into deductions (id, org_id, debtor_id, claim_id, deduction_amount_cents, deduction_date)
         values ($1,$2,$3,$4,42150,'2026-07-02')`,
        [olderAgain, orgId, debtorId, `COV-${suffix}-held-2`],
      );
      await admin.query(
        `insert into deduction_events (org_id, deduction_id, event_type, event_time, payload, created_by)
         values ($1,$2,'case.duplicate_confirmed',now(),$3::jsonb,$4)`,
        [
          orgId,
          newer.deductionId,
          JSON.stringify({ of: olderAgain, older_deduction_id: olderAgain, newer_deduction_id: newer.deductionId }),
          analystId,
        ],
      );
      const again = await store.coverageReport();
      expect(again.countedTwice.cases).toBe(1);
      expect(again.countedTwice.cents).toBe(42_150);

      // Merged, the view counts the pair once itself (ADR 0042 §8), and the
      // newer half is merged away, so nothing is left counted twice.
      const merge = await store.mergeConfirmedDuplicate({
        deductionId: newer.deductionId,
        otherDeductionId: older,
        mergedBy: analystId,
      });
      expect(merge.mergedDeductionId).toBe(newer.deductionId);
      const merged = await store.coverageReport();
      expect(merged.countedTwice).toEqual({ cases: 0, cents: 0, byChannel: [], listed: [] });
    });

    it('is this tenant’s, readable by a read-only member, and refuses a nonsense window', async () => {
      const theirs = await otherStore.coverageReport();
      expect(theirs.bySource).toEqual([]);
      expect(theirs.trailing).toEqual([]);
      expect(theirs.totals).toEqual([]);
      expect(theirs.countedTwice).toEqual({ cases: 0, cents: 0, byChannel: [], listed: [] });

      const reader = await readOnlyStore.coverageReport();
      expect(reader.trailing.length).toBeGreaterThan(0);

      for (const months of [0, 1.5, 37, Number.NaN]) {
        await expect(store.coverageReport({ months })).rejects.toBeInstanceOf(CoverageReadError);
      }
      const one = await store.coverageReport({ months: 1 });
      expect(one.fromMonth).toBe(one.currentMonth);
    });
  });

  describe('ledgerSyncHealth', () => {
    async function connection(realmId: string): Promise<string> {
      const { rows } = await admin.query<{ id: string }>(
        `insert into accounting_connections (org_id, provider, provider_account_id, created_by)
         values ($1,'qbo',$2,$3) returning id`,
        [orgId, realmId, analystId],
      );
      return rows[0]?.id as string;
    }

    function run(connectionId: string, day: string, overrides: Record<string, unknown> = {}) {
      return runs.recordLedgerSyncRun({
        orgId,
        connectionId,
        requestedBy: analystId,
        windowFrom: '2026-08-19',
        windowTo: day,
        startedAt: new Date(`${day}T07:00:00.000Z`),
        finishedAt: new Date(`${day}T07:00:09.000Z`),
        outcome: 'completed',
        invoicesExamined: 9,
        openedCount: 0,
        skippedCount: 2,
        declinedCount: 1,
        anomalyCount: 0,
        anomalies: [],
        ...overrides,
      } as Parameters<PostgresLedgerSyncStore['recordLedgerSyncRun']>[0]);
    }

    it('finds each connection’s latest completed run and only its anomalies', async () => {
      const first = await connection(`41${suffix.replace(/\D/g, '1').slice(0, 6)}`);
      const second = await connection(`42${suffix.replace(/\D/g, '2').slice(0, 6)}`);

      // First connection: an older run with an anomaly that later left the
      // window, then a newer completed run without it, then a failure.
      await run(first, '2026-09-20', {
        anomalyCount: 1,
        anomalies: [{ kind: 'overapplied', invoiceExternalId: '71' }],
      });
      await run(first, '2026-09-21', {
        anomalyCount: 2,
        anomalies: [
          { kind: 'negative_amount', invoiceExternalId: '13', transactionExternalId: '72' },
          { kind: 'application_to_unknown_invoice', invoiceExternalId: '96', transactionExternalId: '128' },
        ],
      });
      await run(first, '2026-09-22', {
        outcome: 'failed',
        errorClass: 'QboRequestFailed',
        invoicesExamined: 0,
        skippedCount: 0,
        declinedCount: 0,
      });
      // Second connection: one completed run with one anomaly.
      await run(second, '2026-09-19', {
        anomalyCount: 1,
        anomalies: [{ kind: 'currency_mismatch', invoiceExternalId: '5' }],
      });

      const health = await store.ledgerSyncHealth();
      expect(health.runs.map((row) => [row.connectionId, row.windowTo, row.outcome])).toEqual([
        [first, '2026-09-22', 'failed'],
        [first, '2026-09-21', 'completed'],
        [first, '2026-09-20', 'completed'],
        [second, '2026-09-19', 'completed'],
      ]);
      expect(health.runs[0]).toMatchObject({ errorClass: 'QboRequestFailed', itemised: true });

      expect(health.findings.map((finding) => [finding.connectionId, finding.run.windowTo])).toEqual([
        [first, '2026-09-21'],
        [second, '2026-09-19'],
      ]);
      expect(health.findings[0]?.anomalies).toEqual([
        { kind: 'application_to_unknown_invoice', invoiceExternalId: '96', transactionExternalId: '128' },
        { kind: 'negative_amount', invoiceExternalId: '13', transactionExternalId: '72' },
      ]);
      expect(health.findings[1]?.anomalies).toEqual([{ kind: 'currency_mismatch', invoiceExternalId: '5' }]);
      // The window the anomalies came from, so the page can say an older one
      // may only have aged out.
      expect(health.findings[0]?.run).toMatchObject({ windowFrom: '2026-08-19', windowTo: '2026-09-21' });

      expect((await store.ledgerSyncHealth({ runLimit: 2 })).runs).toHaveLength(2);
      expect((await readOnlyStore.ledgerSyncHealth()).runs).toHaveLength(4);
      expect(await otherStore.ledgerSyncHealth()).toEqual({ runs: [], findings: [] });
      for (const runLimit of [0, 101, 2.5]) {
        await expect(store.ledgerSyncHealth({ runLimit })).rejects.toBeInstanceOf(LedgerHealthReadError);
      }
    });

    it('says a run counted before anomalies were kept is not itemised', async () => {
      // Migration 0027 came after the first production run, which counted 8
      // anomalies and kept no ids. Written as the table owner, the way that
      // row came to exist.
      const legacy = await connection(`43${suffix.replace(/\D/g, '3').slice(0, 6)}`);
      await admin.query(
        `insert into ledger_sync_runs
           (org_id, connection_id, window_from, window_to, started_at, finished_at, outcome,
            invoices_examined, anomaly_count, requested_by)
         values ($1,$2,'2026-08-18','2026-09-21','2026-09-21T16:40:00Z','2026-09-21T16:40:02Z','completed',12,8,$3)`,
        [orgId, legacy, analystId],
      );
      const health = await store.ledgerSyncHealth();
      const finding = health.findings.find((candidate) => candidate.connectionId === legacy);
      expect(finding?.run).toMatchObject({ anomalyCount: 8, itemised: false });
      expect(finding?.anomalies).toEqual([]);
    });
  });
});

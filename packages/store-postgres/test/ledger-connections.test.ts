import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  PostgresLedgerSyncStore,
  UnknownAccountingProviderError,
  listConnectionsToSync,
} from '../src/connections';
import { closeAllPools, PostgresStore } from '../src/store';

const connectionString = process.env.DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

/**
 * The connection registry and the run log, against a real database
 * (ADR 0031, migration 0024).
 *
 * `supabase/tests/20` asks the schema its questions in SQL. This asks the
 * questions only the driver can answer, and they are the ones that would ship
 * broken without being asked: does the parameter list of
 * `app.record_ledger_sync_run()` line up with the fourteen arguments this code
 * passes it, does a `date` come back as `YYYY-MM-DD` and a count as a number,
 * and does the tenant-scoped read actually see one tenant's connection and not
 * the other's. A unit test with a fake store cannot fail on any of those.
 */
describeDb('the accounting-connection registry on Postgres', () => {
  const admin = new Pool({ connectionString });
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const analystId = randomUUID();
  const readerId = randomUUID();
  const otherAnalystId = randomUUID();
  const suffix = orgId.slice(0, 8);

  let store: PostgresStore;
  let runs: PostgresLedgerSyncStore;
  let readerRuns: PostgresLedgerSyncStore;
  let otherRuns: PostgresLedgerSyncStore;
  const connectionId = randomUUID();
  const otherConnectionId = randomUUID();
  const disabledConnectionId = randomUUID();

  const config = { connectionString: connectionString as string };

  beforeAll(async () => {
    await admin.query(
      `insert into organizations (id, slug, name) values ($1,$2,'Ledger'), ($3,$4,'Ledger Other')`,
      [orgId, `led-${suffix}`, otherOrgId, `led-other-${suffix}`],
    );
    await admin.query(`insert into org_settings (org_id) values ($1), ($2)`, [orgId, otherOrgId]);
    await admin.query(`insert into users (id, email) values ($1,$2), ($3,$4), ($5,$6)`, [
      analystId, `led-a-${suffix}@example.test`,
      readerId, `led-r-${suffix}@example.test`,
      otherAnalystId, `led-o-${suffix}@example.test`,
    ]);
    await admin.query(
      `insert into memberships (org_id, user_id, role)
       values ($1,$2,'analyst'), ($1,$3,'read_only'), ($4,$5,'analyst')`,
      [orgId, analystId, readerId, otherOrgId, otherAnalystId],
    );

    // The ids are chosen here rather than read back out of `returning`, which
    // does not promise the order of the VALUES list.
    await admin.query(
      `insert into accounting_connections
         (id, org_id, provider, provider_account_id, created_by, enabled)
       values ($1,$2,'qbo',$3,$4,true), ($5,$6,'qbo',$7,$8,true), ($9,$2,'qbo',$10,$4,false)`,
      [
        connectionId, orgId, `realm-${suffix}`, analystId,
        otherConnectionId, otherOrgId, `realm-other-${suffix}`, otherAnalystId,
        disabledConnectionId, `realm-off-${suffix}`,
      ],
    );

    store = new PostgresStore(config, { orgId, userId: analystId });
    runs = new PostgresLedgerSyncStore(config, { orgId, userId: analystId }, store);
    readerRuns = new PostgresLedgerSyncStore(
      config,
      { orgId, userId: readerId },
      new PostgresStore(config, { orgId, userId: readerId }),
    );
    otherRuns = new PostgresLedgerSyncStore(
      config,
      { orgId: otherOrgId, userId: otherAnalystId },
      new PostgresStore(config, { orgId: otherOrgId, userId: otherAnalystId }),
    );
  });

  afterAll(async () => {
    await closeAllPools();
    await admin.end();
  });

  it('lists every enabled connection with no tenant claims, and only ids', async () => {
    const listed = await listConnectionsToSync(config);
    const ours = listed.filter((row) => row.orgId === orgId || row.orgId === otherOrgId);

    // Both tenants, because the fan-out is the query that decides which tenants
    // to adopt and cannot have adopted one yet (ADR 0031 §5).
    expect(ours.map((row) => row.connectionId).sort()).toEqual(
      [connectionId, otherConnectionId].sort(),
    );
    // And the member each sync will act as travels with it.
    expect(ours.find((row) => row.connectionId === connectionId)?.createdBy).toBe(analystId);
    // Ids and a provider name. Nothing here is a provider account id.
    for (const row of ours) {
      expect(Object.keys(row).sort()).toEqual(['connectionId', 'createdBy', 'orgId', 'provider']);
      expect(row.provider).toBe('qbo');
    }
    // A disabled connection is not a connection to sync.
    expect(listed.some((row) => row.connectionId === disabledConnectionId)).toBe(false);
  });

  it('is refused to a caller that is acting for a tenant', async () => {
    // The guard that keeps the one cross-tenant query to the one caller it is
    // for: `authenticated` inherits every grant `app_rw` holds, and a request
    // always carries claims. `listConnectionsToSync` sets a role and no claims,
    // which is why it works and this does not.
    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query('set local role app_rw');
      await client.query('select set_config($1, $2, true)', [
        'request.jwt.claims',
        JSON.stringify({ org_id: orgId, sub: analystId }),
      ]);
      await expect(
        client.query('select * from app.ledger_connections_to_sync()'),
      ).rejects.toThrow(/untenanted/);
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
  });

  it('refuses a provider row this build has no source for, rather than skipping it', async () => {
    // A registry row from a future migration. Skipping it silently would be a
    // tenant whose ledger nobody walks and nothing anywhere saying so.
    //
    // The only way to make such a row is to lift the check constraint for the
    // length of this test, which is DDL on the scratch database `pnpm db:test`
    // builds — so it is put back in a `finally`, and the last assertion here
    // reads it back rather than trusting that it was. A migration re-run would
    // not restore it (`create table if not exists` does not revisit
    // constraints), which is why it is checked rather than assumed.
    await admin.query(
      `alter table accounting_connections drop constraint accounting_connections_provider_check`,
    );
    try {
      await admin.query(
        `insert into accounting_connections (org_id, provider, provider_account_id, created_by)
         values ($1,'netsuite',$2,$3)`,
        [orgId, `realm-future-${suffix}`, analystId],
      );
      await expect(listConnectionsToSync(config)).rejects.toThrow(UnknownAccountingProviderError);
    } finally {
      await admin.query(`delete from accounting_connections where provider = 'netsuite'`);
      await admin.query(
        `alter table accounting_connections
           add constraint accounting_connections_provider_check check (provider in ('qbo'))`,
      );
    }

    const { rows } = await admin.query<{ n: string }>(
      `select count(*)::text as n from pg_constraint
        where conname = 'accounting_connections_provider_check'`,
    );
    expect(rows[0]?.n).toBe('1');
  });

  it('reads a connection under the tenant’s own claims, and nobody else’s', async () => {
    const mine = await runs.connection(connectionId);
    expect(mine?.orgId).toBe(orgId);
    expect(mine?.providerAccountId).toBe(`realm-${suffix}`);
    expect(mine?.enabled).toBe(true);
    expect(mine?.createdBy).toBe(analystId);

    // Not forbidden — not found. RLS doing the work rather than a filter this
    // code remembered to apply (invariant 6), which is also what makes the
    // fan-out's id list safe to act on.
    expect(await runs.connection(otherConnectionId)).toBeUndefined();
    expect(await otherRuns.connection(connectionId)).toBeUndefined();
    expect(await runs.connection(randomUUID())).toBeUndefined();
  });

  it('records a completed run through the one door the database opens', async () => {
    const startedAt = new Date('2026-09-22T07:00:00.000Z');
    const finishedAt = new Date('2026-09-22T07:00:21.000Z');

    const runId = await runs.recordLedgerSyncRun({
      orgId,
      connectionId,
      requestedBy: analystId,
      windowFrom: '2026-08-19',
      windowTo: '2026-09-22',
      startedAt,
      finishedAt,
      outcome: 'completed',
      invoicesExamined: 120,
      openedCount: 3,
      skippedCount: 7,
      declinedCount: 11,
      anomalyCount: 1,
      anomalies: [
        {
          kind: 'application_to_unknown_invoice',
          invoiceExternalId: '96',
          transactionExternalId: '128',
        },
      ],
    });

    const { rows } = await admin.query<{
      org_id: string;
      window_from: string;
      window_to: string;
      invoices_examined: number;
      opened_count: number;
      declined_count: number;
      outcome: string;
      error_class: string | null;
      requested_by: string;
      started_at: Date;
    }>(
      `select org_id, to_char(window_from,'YYYY-MM-DD') as window_from,
              to_char(window_to,'YYYY-MM-DD') as window_to, invoices_examined,
              opened_count, declined_count, outcome, error_class, requested_by, started_at
         from ledger_sync_runs where id = $1`,
      [runId],
    );
    const row = rows[0];
    expect(row?.org_id).toBe(orgId);
    expect(row?.window_from).toBe('2026-08-19');
    expect(row?.window_to).toBe('2026-09-22');
    expect(row?.invoices_examined).toBe(120);
    expect(row?.opened_count).toBe(3);
    expect(row?.declined_count).toBe(11);
    expect(row?.outcome).toBe('completed');
    expect(row?.error_class).toBeNull();
    expect(row?.requested_by).toBe(analystId);
    expect(row?.started_at.toISOString()).toBe(startedAt.toISOString());

    // And which invoice it could not reason about, as ids — in the same
    // transaction as the run row (ADR 0035 §5).
    const anomalies = await admin.query<{
      org_id: string;
      kind: string;
      invoice_external_id: string;
      transaction_external_id: string | null;
    }>(
      `select org_id, kind, invoice_external_id, transaction_external_id
         from ledger_sync_anomalies where run_id = $1`,
      [runId],
    );
    expect(anomalies.rows).toEqual([
      {
        org_id: orgId,
        kind: 'application_to_unknown_invoice',
        invoice_external_id: '96',
        transaction_external_id: '128',
      },
    ]);
  });

  it('refuses a run whose anomaly list is not its anomaly count, before anything is written', async () => {
    const before = await admin.query<{ n: string }>(
      `select count(*) as n from ledger_sync_runs where connection_id = $1`,
      [connectionId],
    );
    await expect(
      runs.recordLedgerSyncRun({
        orgId,
        connectionId,
        requestedBy: analystId,
        windowFrom: '2026-08-19',
        windowTo: '2026-09-22',
        startedAt: new Date('2026-09-22T07:00:00.000Z'),
        finishedAt: new Date('2026-09-22T07:00:01.000Z'),
        outcome: 'completed',
        invoicesExamined: 12,
        openedCount: 0,
        skippedCount: 0,
        declinedCount: 0,
        anomalyCount: 8,
        anomalies: [],
      }),
    ).rejects.toThrow(/partial list is not the list/);
    const after = await admin.query<{ n: string }>(
      `select count(*) as n from ledger_sync_runs where connection_id = $1`,
      [connectionId],
    );
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });

  it('records a refusal on behalf of a member who may no longer write', async () => {
    // The whole reason app.record_ledger_sync_run() is definer. This member's
    // writes are refused everywhere else in the schema, and the row that says
    // their sync was refused still has to be written (ADR 0031 §4).
    expect(await readerRuns.memberMayWrite({ orgId, userId: readerId })).toBe(false);

    const runId = await readerRuns.recordLedgerSyncRun({
      orgId,
      connectionId,
      requestedBy: readerId,
      windowFrom: '2026-08-19',
      windowTo: '2026-09-22',
      startedAt: new Date('2026-09-22T07:00:00.000Z'),
      finishedAt: new Date('2026-09-22T07:00:00.000Z'),
      outcome: 'refused',
      invoicesExamined: 0,
      openedCount: 0,
      skippedCount: 0,
      declinedCount: 0,
      anomalyCount: 0,
      anomalies: [],
      errorClass: 'LedgerSyncRefusedError',
    });

    const { rows } = await admin.query<{ outcome: string; error_class: string }>(
      `select outcome, error_class from ledger_sync_runs where id = $1`,
      [runId],
    );
    expect(rows[0]?.outcome).toBe('refused');
    expect(rows[0]?.error_class).toBe('LedgerSyncRefusedError');
  });

  it('cannot be used to write another tenant’s run, or to name another member', async () => {
    const base = {
      windowFrom: '2026-08-19',
      windowTo: '2026-09-22',
      startedAt: new Date('2026-09-22T07:00:00.000Z'),
      finishedAt: new Date('2026-09-22T07:00:01.000Z'),
      outcome: 'completed' as const,
      invoicesExamined: 0,
      openedCount: 0,
      skippedCount: 0,
      declinedCount: 0,
      anomalyCount: 0,
      anomalies: [],
    };

    // Definer, and bounded to the caller's own claims: an org that is not this
    // store's, a `requested_by` that is not this store's subject, and a
    // connection belonging to somebody else are each refused in the database.
    await expect(
      runs.recordLedgerSyncRun({
        ...base,
        orgId: otherOrgId,
        connectionId: otherConnectionId,
        requestedBy: analystId,
      }),
    ).rejects.toThrow(/not the tenant/);

    await expect(
      runs.recordLedgerSyncRun({ ...base, orgId, connectionId, requestedBy: otherAnalystId }),
    ).rejects.toThrow(/acted as/);

    await expect(
      runs.recordLedgerSyncRun({
        ...base,
        orgId,
        connectionId: otherConnectionId,
        requestedBy: analystId,
      }),
    ).rejects.toThrow(/another org/);
  });

  it('refuses a count that is not a count before it reaches the database', async () => {
    await expect(
      runs.recordLedgerSyncRun({
        orgId,
        connectionId,
        requestedBy: analystId,
        windowFrom: '2026-08-19',
        windowTo: '2026-09-22',
        startedAt: new Date('2026-09-22T07:00:00.000Z'),
        finishedAt: new Date('2026-09-22T07:00:01.000Z'),
        outcome: 'completed',
        invoicesExamined: Number.NaN,
        openedCount: 0,
        skippedCount: 0,
        declinedCount: 0,
        anomalyCount: 0,
        anomalies: [],
      }),
    ).rejects.toThrow(/non-negative/);
  });
});

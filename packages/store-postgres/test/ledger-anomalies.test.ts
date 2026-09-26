import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { LEDGER_ANOMALY_KINDS } from '@recouple/core-domain';
import { LEDGER_SYNC_ANOMALY_KINDS } from '../src/connections';

/**
 * Three lists of anomaly kinds, kept identical (ADR 0035 §5).
 *
 * `LEDGER_ANOMALY_KINDS` is what the detector can produce, `LEDGER_SYNC_ANOMALY_KINDS`
 * is what this store will send, and `ledger_sync_anomalies_kind_check` is what
 * the database will keep. A fifth kind added to the detector and not to the
 * migration would fail a completed run's write — and with it the run row, which
 * is written in the same transaction. This is where that is caught instead, on
 * the day it is written, the way `doc-types.test.ts` catches a thirteenth
 * document type.
 */

describe('ledger anomaly kinds', () => {
  it('the store sends exactly the kinds the detector produces', () => {
    expect([...LEDGER_SYNC_ANOMALY_KINDS].sort()).toEqual([...LEDGER_ANOMALY_KINDS].sort());
  });
});

const connectionString = process.env.TEST_DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

describeDb('ledger anomaly kinds on Postgres', () => {
  const admin = new Pool({ connectionString });
  afterAll(async () => {
    await admin.end();
  });

  it('the check constraint admits exactly the detector’s kinds, in both directions', async () => {
    const { rows } = await admin.query<{ def: string }>(
      `select pg_get_constraintdef(c.oid) as def
         from pg_constraint c
        where c.conrelid = 'ledger_sync_anomalies'::regclass
          and c.contype = 'c'
          and pg_get_constraintdef(c.oid) like '%kind%'`,
    );
    // A missing constraint is a schema this test cannot speak about, not "no
    // restriction" — say so rather than passing vacuously.
    expect(rows, 'ledger_sync_anomalies has exactly one check on kind').toHaveLength(1);
    const admitted = [...(rows[0]?.def ?? '').matchAll(/'([a-z0-9_]+)'::text/g)].map((m) => m[1]);

    expect(
      [...admitted].sort(),
      'the constraint admits every kind the detector produces: a new kind needs a migration',
    ).toEqual([...LEDGER_ANOMALY_KINDS].sort());
    expect(
      admitted.filter((k) => !(LEDGER_ANOMALY_KINDS as readonly string[]).includes(k as string)),
      'and nothing the detector cannot produce',
    ).toEqual([]);
  });

  it('keeps no ledger text: the columns are a kind and ids', async () => {
    const { rows } = await admin.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'ledger_sync_anomalies'
        order by column_name`,
    );
    expect(rows.map((r) => r.column_name)).toEqual([
      'id',
      'invoice_external_id',
      'kind',
      'org_id',
      'recorded_at',
      'run_id',
      'transaction_external_id',
    ]);
  });
});

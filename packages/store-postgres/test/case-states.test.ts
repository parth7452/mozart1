import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { CASE_STATES, MERGEABLE_STATES } from '@recouple/core-domain';

/**
 * The lists of case states, kept identical.
 *
 * `CASE_STATES` is the state machine; `deductions_state_check` is what the
 * database will store. `MERGEABLE_STATES` is where a case may be merged away
 * from; `deduction_merges.state_before`'s check is what a merge row may record
 * and an undo may restore (ADR 0042). A state in one list and not the other is
 * a case the code can move somewhere the database refuses — or the reverse, a
 * state the database holds that no screen has words for — so both are read off
 * `pg_constraint` and compared as sets, in both directions.
 */

const connectionString = process.env.TEST_DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

describeDb('the case states the database admits', () => {
  const admin = new Pool({ connectionString });

  afterAll(async () => {
    await admin.end();
  });

  async function admitted(table: string, constraint: string): Promise<string[]> {
    const { rows } = await admin.query<{ def: string }>(
      `select pg_get_constraintdef(c.oid) as def
         from pg_constraint c
        where c.conrelid = $1::regclass and c.conname = $2`,
      [table, constraint],
    );
    const def = rows[0]?.def;
    expect(def, `${table}.${constraint} exists`).toBeDefined();
    return [...(def as string).matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1] as string);
  }

  it('stores exactly the states the state machine has', async () => {
    const states = await admitted('deductions', 'deductions_state_check');
    expect(new Set(states)).toEqual(new Set(CASE_STATES));
    expect(states).toHaveLength(CASE_STATES.length);
  });

  it('lets a merge record, and an undo restore, exactly the mergeable states', async () => {
    const { rows } = await admin.query<{ conname: string }>(
      `select c.conname from pg_constraint c
        where c.conrelid = 'deduction_merges'::regclass and c.contype = 'c'
          and pg_get_constraintdef(c.oid) like '%state_before%'
          and pg_get_constraintdef(c.oid) like '%''discovered''%'`,
    );
    expect(rows).toHaveLength(1);
    const states = await admitted('deduction_merges', rows[0]?.conname as string);
    expect(new Set(states)).toEqual(new Set(MERGEABLE_STATES));
  });
});

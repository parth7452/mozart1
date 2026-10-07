import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { CaseRemovalRefusedError, MAX_CASES_REMOVED_AT_ONCE } from '@recouple/pipeline';
import { closeAllPools, PostgresStore } from '../src/store';

const connectionString = process.env.TEST_DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

/**
 * Removing a case opened in error (ADR 0072), on Postgres as `app_rw`: an
 * approver removes, all or none; an analyst is refused by the database; a
 * removed case leaves the lists and figures and its event stays.
 */
describeDb('removing cases opened in error, on Postgres', () => {
  const admin = new Pool({ connectionString });
  const orgId = randomUUID();
  const analystId = randomUUID();
  const approverId = randomUUID();
  const suffix = orgId.slice(0, 8);
  let approver: PostgresStore;
  let analyst: PostgresStore;

  async function aCase(label: string, state: string, amount = 1_000): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `insert into deductions (org_id, claim_id, deduction_amount_cents, state)
       values ($1, $2, $3, $4) returning id`,
      [orgId, `RM-${suffix}-${label}`, amount, state],
    );
    return rows[0]?.id as string;
  }

  async function stateOf(id: string): Promise<string> {
    const { rows } = await admin.query<{ state: string }>(
      `select state from deductions where id = $1`,
      [id],
    );
    return rows[0]?.state as string;
  }

  beforeAll(async () => {
    await admin.query(`insert into organizations (id, slug, name) values ($1,$2,'Remove')`, [
      orgId,
      `rm-${suffix}`,
    ]);
    await admin.query(`insert into org_settings (org_id) values ($1)`, [orgId]);
    await admin.query(`insert into users (id, email) values ($1,$2), ($3,$4)`, [
      analystId,
      `rm-a-${suffix}@example.test`,
      approverId,
      `rm-p-${suffix}@example.test`,
    ]);
    await admin.query(
      `insert into memberships (org_id, user_id, role) values ($1,$2,'analyst'), ($1,$3,'approver')`,
      [orgId, analystId, approverId],
    );
    const config = { connectionString: connectionString as string };
    approver = new PostgresStore(config, { orgId, userId: approverId });
    analyst = new PostgresStore(config, { orgId, userId: analystId });
  });

  afterAll(async () => {
    await closeAllPools();
    await approver?.close();
    await analyst?.close();
    await admin.end();
  });

  it('removes several cases in one go, event first, and drops them from the lists', async () => {
    const a = await aCase('a', 'classified', 1_100);
    const b = await aCase('b', 'awaiting_approval', 2_200);
    const removed = await approver.removeCases([b, a, a], 'opened twice by mistake');
    expect(removed.map((r) => r.deductionId).sort()).toEqual([a, b].sort());
    expect(await stateOf(a)).toBe('removed');
    expect(await stateOf(b)).toBe('removed');

    const { rows: events } = await admin.query<{ payload: Record<string, unknown>; created_by: string }>(
      `select payload, created_by from deduction_events
        where deduction_id = $1 and event_type = 'case.removed'`,
      [a],
    );
    expect(events).toEqual([
      {
        payload: { state_before: 'classified', reason: 'opened twice by mistake' },
        created_by: approverId,
      },
    ]);

    const listed = (await approver.listCases()).map((c) => c.deductionId);
    expect(listed).not.toContain(a);
    const searched = (await approver.searchCases({ query: `RM-${suffix}` })).rows.map(
      (c) => c.deductionId,
    );
    expect(searched).not.toContain(a);
    expect(
      (await approver.searchCases({ state: 'removed' })).rows.map((c) => c.deductionId),
    ).toContain(a);
    const tally = await approver.caseTally();
    expect(tally.some((row) => row.state === 'removed')).toBe(false);
    // The case page still reads it.
    expect((await approver.caseSummary(a))?.state).toBe('removed');
  });

  it('is all or nothing: one filed case refuses the whole request', async () => {
    const open = await aCase('open', 'classified');
    const filed = await aCase('filed', 'submitted');
    await expect(approver.removeCases([open, filed])).rejects.toMatchObject({
      name: 'CaseRemovalRefusedError',
      reason: 'not_removable_state',
      deductionId: filed,
    });
    expect(await stateOf(open)).toBe('classified');
  });

  it('refuses an analyst by the database', async () => {
    const c = await aCase('analyst', 'classified');
    const refused = await analyst.removeCases([c]).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(CaseRemovalRefusedError);
    expect(refused).toMatchObject({ reason: 'not_owner_or_approver' });
    expect(await stateOf(c)).toBe('classified');
    const { rows } = await admin.query(
      `select 1 from deduction_events where deduction_id = $1 and event_type = 'case.removed'`,
      [c],
    );
    expect(rows).toHaveLength(0);
  });

  it('refuses a removed case again, too many, and none', async () => {
    const c = await aCase('twice', 'classified');
    await approver.removeCases([c]);
    await expect(approver.removeCases([c])).rejects.toMatchObject({ reason: 'irreversible' });
    const many = Array.from({ length: MAX_CASES_REMOVED_AT_ONCE + 1 }, () => randomUUID());
    await expect(approver.removeCases(many)).rejects.toMatchObject({ reason: 'too_many' });
    await expect(approver.removeCases([])).rejects.toMatchObject({ reason: 'none_given' });
  });
});

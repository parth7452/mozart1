import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  ActorIsNotTheSessionError,
  CaseNotVisibleError,
  DeadlineAlreadySetError,
  DeadlineBasisRequiredError,
  DeadlineOutOfRangeError,
  WrongCaseStateError,
  WrongRoleError,
} from '@recouple/pipeline';
import { closeAllPools, PostgresStore } from '../src/store';

/**
 * A dispute deadline a person enters (pilot E6), against the real schema.
 *
 * What only the database can say: that `app_rw` under the tenant's claims may
 * set `deductions.dispute_deadline` at all (no migration was needed), that the
 * column and the `case.deadline_set` event land together or not at all, that a
 * printed deadline survives, and that RLS keeps another tenant's case out of
 * reach. The shared rules are unit-tested in
 * `packages/pipeline/test/deadline.test.ts`.
 */

const connectionString = process.env.TEST_DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

const BASIS = 'Sysco vendor agreement: 60 days from deduction date';

/** `YYYY-MM-DD`, `days` from today in UTC. */
function daysFromToday(days: number): string {
  const now = new Date();
  const at = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + days * 86_400_000;
  return new Date(at).toISOString().slice(0, 10);
}

describeDb('setDisputeDeadline on postgres', () => {
  let admin: Pool;
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const analyst = randomUUID();
  const reader = randomUUID();
  const outsider = randomUUID();
  const stores: PostgresStore[] = [];
  let claim = 0;

  const storeFor = (org: string, userId: string): PostgresStore => {
    const store = new PostgresStore({ connectionString: connectionString as string }, { orgId: org, userId });
    stores.push(store);
    return store;
  };

  async function newCase(disputeDeadline?: string): Promise<string> {
    claim += 1;
    const store = storeFor(orgId, analyst);
    const opened = await store.openCase({
      orgId,
      claimId: `E6-${orgId.slice(0, 8)}-${claim}`,
      deductionAmountCents: 50_000,
      ...(disputeDeadline === undefined ? {} : { disputeDeadline }),
    });
    await store.transitionCase(opened.deductionId, 'classified');
    return opened.deductionId;
  }

  async function row(deductionId: string): Promise<string | null> {
    const { rows } = await admin.query<{ d: string | null }>(
      `select dispute_deadline::text as d from deductions where id = $1`,
      [deductionId],
    );
    return rows[0]?.d ?? null;
  }

  async function events(deductionId: string): Promise<
    { payload: Record<string, unknown>; created_by: string }[]
  > {
    const { rows } = await admin.query<{ payload: Record<string, unknown>; created_by: string }>(
      `select payload, created_by::text as created_by from deduction_events
        where deduction_id = $1 and event_type = 'case.deadline_set' order by id`,
      [deductionId],
    );
    return rows;
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString });
    for (const [id, label] of [
      [orgId, 'e6'],
      [otherOrgId, 'e6-other'],
    ] as const) {
      await admin.query(`insert into organizations (id, slug, name) values ($1, $2, $3)`, [
        id,
        `${label}-${id.slice(0, 8)}`,
        `Deadline ${label}`,
      ]);
      await admin.query(`insert into org_settings (org_id) values ($1)`, [id]);
    }
    await admin.query(`insert into users (id, email) values ($1,$2), ($3,$4), ($5,$6)`, [
      analyst, `e6-analyst-${analyst.slice(0, 8)}@example.test`,
      reader, `e6-reader-${reader.slice(0, 8)}@example.test`,
      outsider, `e6-outsider-${outsider.slice(0, 8)}@example.test`,
    ]);
    await admin.query(
      `insert into memberships (org_id, user_id, role)
       values ($1,$2,'analyst'), ($1,$3,'read_only'), ($4,$5,'analyst')`,
      [orgId, analyst, reader, otherOrgId, outsider],
    );
  });

  afterAll(async () => {
    await Promise.all(stores.map((store) => store.close()));
    await admin?.end();
    await closeAllPools();
  });

  it('sets the column and appends the event, naming who, the date and the basis', async () => {
    const deductionId = await newCase();
    const deadline = daysFromToday(60);

    const { eventId } = await storeFor(orgId, analyst).setDisputeDeadline({
      deductionId,
      deadline,
      basis: `  ${BASIS}  `,
      setBy: analyst,
    });

    expect(await row(deductionId)).toBe(deadline);
    expect(await events(deductionId)).toEqual([
      {
        payload: { dispute_deadline: deadline, basis: BASIS, set_by: analyst },
        created_by: analyst,
      },
    ]);
    const workflow = await storeFor(orgId, analyst).getWorkflow(deductionId);
    expect(workflow?.deadlineSet).toMatchObject({ eventId, deadline, basis: BASIS, setBy: analyst });
    // And the case the queue and the page read carries it like a printed one.
    expect((await storeFor(orgId, analyst).caseSummary(deductionId))?.disputeDeadline).toBe(deadline);
  });

  it('never overwrites a printed deadline, and refuses a second entered one', async () => {
    const printed = daysFromToday(30);
    const onPrinted = await newCase(printed);
    await expect(
      storeFor(orgId, analyst).setDisputeDeadline({
        deductionId: onPrinted,
        deadline: daysFromToday(90),
        basis: BASIS,
        setBy: analyst,
      }),
    ).rejects.toMatchObject({ name: 'DeadlineAlreadySetError', existing: printed });
    expect(await row(onPrinted)).toBe(printed);
    expect(await events(onPrinted)).toEqual([]);

    const entered = await newCase();
    const first = daysFromToday(20);
    await storeFor(orgId, analyst).setDisputeDeadline({
      deductionId: entered,
      deadline: first,
      basis: BASIS,
      setBy: analyst,
    });
    await expect(
      storeFor(orgId, analyst).setDisputeDeadline({
        deductionId: entered,
        deadline: daysFromToday(40),
        basis: 'a second opinion',
        setBy: analyst,
      }),
    ).rejects.toThrow(DeadlineAlreadySetError);
    expect(await row(entered)).toBe(first);
    expect(await events(entered)).toHaveLength(1);
  });

  it('writes nothing for a refused date or basis', async () => {
    const deductionId = await newCase();
    const store = storeFor(orgId, analyst);
    await expect(
      store.setDisputeDeadline({ deductionId, deadline: '2020-01-01', basis: BASIS, setBy: analyst }),
    ).rejects.toThrow(DeadlineOutOfRangeError);
    await expect(
      store.setDisputeDeadline({ deductionId, deadline: daysFromToday(5000), basis: BASIS, setBy: analyst }),
    ).rejects.toThrow(DeadlineOutOfRangeError);
    await expect(
      store.setDisputeDeadline({ deductionId, deadline: daysFromToday(10), basis: ' ', setBy: analyst }),
    ).rejects.toThrow(DeadlineBasisRequiredError);
    expect(await row(deductionId)).toBeNull();
    expect(await events(deductionId)).toEqual([]);
  });

  it('refuses a reader, a forged actor, a closed case and another tenant', async () => {
    const deductionId = await newCase();
    const deadline = daysFromToday(10);
    await expect(
      storeFor(orgId, reader).setDisputeDeadline({ deductionId, deadline, basis: BASIS, setBy: reader }),
    ).rejects.toThrow(WrongRoleError);
    await expect(
      storeFor(orgId, analyst).setDisputeDeadline({ deductionId, deadline, basis: BASIS, setBy: reader }),
    ).rejects.toThrow(ActorIsNotTheSessionError);
    await expect(
      storeFor(otherOrgId, outsider).setDisputeDeadline({
        deductionId,
        deadline,
        basis: BASIS,
        setBy: outsider,
      }),
    ).rejects.toThrow(CaseNotVisibleError);

    await admin.query(`update deductions set state = 'written_off' where id = $1`, [deductionId]);
    await expect(
      storeFor(orgId, analyst).setDisputeDeadline({ deductionId, deadline, basis: BASIS, setBy: analyst }),
    ).rejects.toThrow(WrongCaseStateError);

    expect(await row(deductionId)).toBeNull();
    expect(await events(deductionId)).toEqual([]);
  });
});

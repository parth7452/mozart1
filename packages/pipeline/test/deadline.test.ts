import { describe, expect, it } from 'vitest';
import {
  checkEnteredDeadline,
  DEADLINE_BASIS_MAX_LENGTH,
  MAX_ENTERED_DEADLINE_DAYS,
} from '../src/deadline';
import {
  CaseWorkflowError,
  DeadlineAlreadySetError,
  DeadlineBasisRequiredError,
  DeadlineBasisTooLongError,
  DeadlineOutOfRangeError,
  WrongCaseStateError,
  WrongRoleError,
} from '../src/ports';
import { InMemoryStore } from '../src/testing/memory-store';

/**
 * A dispute deadline a person enters (pilot E6): the shared rules, and the
 * in-memory store that runs them. The Postgres half is
 * `packages/store-postgres/test/dispute-deadline.test.ts`.
 */

const NOW = new Date('2026-09-26T15:00:00Z');
const BASIS = 'Sysco vendor agreement: 60 days from deduction date';

/** `YYYY-MM-DD`, `days` from today in UTC. */
function daysFromToday(days: number, now: Date = new Date()): string {
  const at = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + days * 86_400_000;
  return new Date(at).toISOString().slice(0, 10);
}

function refusalOf(deadline: string): string | undefined {
  try {
    checkEnteredDeadline('ded-1', { deadline, basis: BASIS }, NOW);
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(DeadlineOutOfRangeError);
    expect(error).toBeInstanceOf(CaseWorkflowError);
    return (error as DeadlineOutOfRangeError).refusal;
  }
}

describe('checkEnteredDeadline', () => {
  it('takes today, the far edge and anything between, with the basis trimmed', () => {
    for (const deadline of ['2026-09-26', '2026-11-25', daysFromToday(MAX_ENTERED_DEADLINE_DAYS, NOW)]) {
      expect(checkEnteredDeadline('ded-1', { deadline, basis: `  ${BASIS}\n` }, NOW)).toEqual({
        deadline,
        basis: BASIS,
      });
    }
  });

  it('takes yesterday in UTC, which is still today somewhere west of it', () => {
    expect(refusalOf('2026-09-25')).toBeUndefined();
  });

  it('refuses the past, years out, and what is not a calendar date, each by name', () => {
    expect(refusalOf('2026-09-24')).toBe('in_the_past');
    expect(refusalOf('2020-01-01')).toBe('in_the_past');
    expect(refusalOf(daysFromToday(MAX_ENTERED_DEADLINE_DAYS + 1, NOW))).toBe('too_far_out');
    expect(refusalOf('2206-09-26')).toBe('too_far_out');
    for (const bad of ['', '2026-02-30', '2026-13-01', '26-10-01', '10/01/2026', '2026-10-01T00:00']) {
      expect(refusalOf(bad), bad).toBe('not_a_date');
    }
  });

  it('refuses a missing basis, and a long one rather than cutting it', () => {
    expect(() =>
      checkEnteredDeadline('ded-1', { deadline: '2026-10-30', basis: '  \n ' }, NOW),
    ).toThrow(DeadlineBasisRequiredError);
    const long = 'x'.repeat(DEADLINE_BASIS_MAX_LENGTH + 1);
    const error = (() => {
      try {
        checkEnteredDeadline('ded-1', { deadline: '2026-10-30', basis: long }, NOW);
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(DeadlineBasisTooLongError);
    expect((error as DeadlineBasisTooLongError).length).toBe(DEADLINE_BASIS_MAX_LENGTH + 1);
  });
});

describe('setDisputeDeadline on the in-memory store', () => {
  const ORG = 'org-1';
  const ANALYST = 'user-analyst';
  const READER = 'user-reader';

  async function storeWithCase(
    disputeDeadline?: string,
  ): Promise<{ store: InMemoryStore; deductionId: string }> {
    const store = new InMemoryStore();
    store.addMember(ORG, ANALYST, 'analyst');
    store.addMember(ORG, READER, 'read_only');
    const { deductionId } = await store.openCase({
      orgId: ORG,
      claimId: 'PAY-1:INV-1',
      deductionAmountCents: 50_000,
      ...(disputeDeadline === undefined ? {} : { disputeDeadline }),
    });
    await store.transitionCase(deductionId, 'classified');
    return { store, deductionId };
  }

  it('sets the deadline where none was recorded, and says who and why', async () => {
    const { store, deductionId } = await storeWithCase();
    const deadline = daysFromToday(45);

    const { eventId } = await store.setDisputeDeadline({
      deductionId,
      deadline,
      basis: ` ${BASIS} `,
      setBy: ANALYST,
    });

    expect((await store.getCase(deductionId))?.disputeDeadline).toBe(deadline);
    expect(store.events.filter((e) => e.eventType === 'case.deadline_set')).toEqual([
      {
        orgId: ORG,
        deductionId,
        eventType: 'case.deadline_set',
        payload: { dispute_deadline: deadline, basis: BASIS, set_by: ANALYST },
      },
    ]);
    const workflow = await store.getWorkflow(deductionId);
    expect(workflow?.deadlineSet).toMatchObject({ eventId, deadline, basis: BASIS, setBy: ANALYST });
  });

  it('never overwrites a printed deadline, nor one a person entered', async () => {
    const printed = daysFromToday(30);
    const { store, deductionId } = await storeWithCase(printed);
    await expect(
      store.setDisputeDeadline({ deductionId, deadline: daysFromToday(60), basis: BASIS, setBy: ANALYST }),
    ).rejects.toThrow(DeadlineAlreadySetError);
    expect((await store.getCase(deductionId))?.disputeDeadline).toBe(printed);

    const other = await storeWithCase();
    const first = daysFromToday(20);
    await other.store.setDisputeDeadline({
      deductionId: other.deductionId,
      deadline: first,
      basis: BASIS,
      setBy: ANALYST,
    });
    await expect(
      other.store.setDisputeDeadline({
        deductionId: other.deductionId,
        deadline: daysFromToday(90),
        basis: BASIS,
        setBy: ANALYST,
      }),
    ).rejects.toMatchObject({ name: 'DeadlineAlreadySetError', existing: first });
    expect(other.store.events.filter((e) => e.eventType === 'case.deadline_set')).toHaveLength(1);
  });

  it('writes nothing for a refused date, a reader, or a closed case', async () => {
    const { store, deductionId } = await storeWithCase();
    await expect(
      store.setDisputeDeadline({ deductionId, deadline: '2020-01-01', basis: BASIS, setBy: ANALYST }),
    ).rejects.toThrow(DeadlineOutOfRangeError);
    await expect(
      store.setDisputeDeadline({ deductionId, deadline: daysFromToday(10), basis: BASIS, setBy: READER }),
    ).rejects.toThrow(WrongRoleError);
    await store.transitionCase(deductionId, 'written_off');
    await expect(
      store.setDisputeDeadline({ deductionId, deadline: daysFromToday(10), basis: BASIS, setBy: ANALYST }),
    ).rejects.toThrow(WrongCaseStateError);

    expect((await store.getCase(deductionId))?.disputeDeadline).toBeUndefined();
    expect(store.events.filter((e) => e.eventType === 'case.deadline_set')).toEqual([]);
  });
});

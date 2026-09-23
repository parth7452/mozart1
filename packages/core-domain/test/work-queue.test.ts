import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  CASE_STATES,
  DUE_SOON_DAYS,
  QUEUE_BUCKETS,
  isClosed,
  isQueued,
  nextStepFor,
  queueBucket,
  rankForReview,
  type QueueCase,
  type RankedCase,
} from '../src';

/**
 * The review queue's order (ADR 0043). Property-tested because the claim is
 * about every input, not about the handful a person thought of: the order is
 * total and deterministic, nothing that is not a person's to act on appears,
 * the buckets come in the founder's order whatever the amounts, and each bucket
 * keeps the one ordering it states.
 */

const TODAY = new Date('2026-09-23T15:00:00Z');

function iso(offsetDays: number): string {
  return new Date(Date.UTC(2026, 8, 23) + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

const anyCase: fc.Arbitrary<QueueCase> = fc.record(
  {
    deductionId: fc.uuid(),
    state: fc.constantFrom(...CASE_STATES),
    deductionAmountCents: fc.integer({ min: 1, max: 1_000_000_000 }),
    disputeDeadline: fc.oneof(
      fc.integer({ min: -400, max: 400 }).map(iso),
      fc.constantFrom('not a date', '2026-13-45', ''),
    ),
    deductionDate: fc.oneof(fc.integer({ min: -900, max: 30 }).map(iso), fc.constant('??')),
    createdAt: fc.integer({ min: -900, max: 0 }).map((d) => `${iso(d)}T09:00:00.000Z`),
    hasApproval: fc.boolean(),
  },
  { requiredKeys: ['deductionId', 'state', 'deductionAmountCents', 'createdAt', 'hasApproval'] },
);

const anyCases = fc.uniqueArray(anyCase, { selector: (c) => c.deductionId, maxLength: 40 });

function ids(ranked: readonly RankedCase<QueueCase>[]): string[] {
  return ranked.map((r) => r.case.deductionId);
}

/** The ordering a bucket states, as a comparison of two neighbours. */
function inOrder(a: RankedCase<QueueCase>, b: RankedCase<QueueCase>): boolean {
  const ai = QUEUE_BUCKETS.indexOf(a.bucket);
  const bi = QUEUE_BUCKETS.indexOf(b.bucket);
  if (ai !== bi) return ai < bi;
  const key = (r: RankedCase<QueueCase>): number => {
    switch (r.bucket) {
      case 'past_deadline':
        return -(r.daysToDeadline as number);
      case 'no_deadline':
        return r.daysSinceShortPay === undefined ? Number.POSITIVE_INFINITY : -r.daysSinceShortPay;
      default:
        return r.daysToDeadline as number;
    }
  };
  if (key(a) !== key(b)) return key(a) < key(b);
  if (a.case.deductionAmountCents !== b.case.deductionAmountCents) {
    return a.case.deductionAmountCents > b.case.deductionAmountCents;
  }
  return a.case.deductionId < b.case.deductionId;
}

describe('the review queue', () => {
  it('is a total order: the same cases rank the same way whatever order they arrive in', () => {
    const casesAndAShuffle = anyCases.chain((cases) =>
      fc.tuple(
        fc.constant(cases),
        fc.shuffledSubarray(cases, { minLength: cases.length, maxLength: cases.length }),
      ),
    );
    fc.assert(
      fc.property(casesAndAShuffle, ([cases, shuffled]) => {
        expect(ids(rankForReview(shuffled, TODAY))).toEqual(ids(rankForReview(cases, TODAY)));
      }),
    );
  });

  it('holds exactly the cases a person can act on now: nothing closed, nothing filed', () => {
    fc.assert(
      fc.property(anyCases, (cases) => {
        const ranked = rankForReview(cases, TODAY);
        for (const r of ranked) {
          expect(isClosed(r.case.state)).toBe(false);
          expect(r.case.state).not.toBe('submitted');
        }
        expect(ranked).toHaveLength(cases.filter((c) => isQueued(c.state)).length);
      }),
    );
  });

  it('keeps the buckets in order and each bucket in its own stated order, whatever the amounts', () => {
    fc.assert(
      fc.property(anyCases, (cases) => {
        const ranked = rankForReview(cases, TODAY);
        for (let i = 1; i < ranked.length; i += 1) {
          const before = ranked[i - 1] as RankedCase<QueueCase>;
          expect(inOrder(before, ranked[i] as RankedCase<QueueCase>)).toBe(true);
        }
      }),
    );
  });

  it('puts every case in the bucket its deadline says', () => {
    fc.assert(
      fc.property(anyCases, (cases) => {
        for (const r of rankForReview(cases, TODAY)) {
          expect(r.bucket).toBe(queueBucket(r.daysToDeadline));
          expect(r.nextStep).toBe(nextStepFor(r.case.state, r.case.hasApproval));
        }
      }),
    );
  });

  it('never throws on a date it cannot read, and never invents one', () => {
    const ranked = rankForReview(
      [
        {
          deductionId: 'a',
          state: 'classified',
          deductionAmountCents: 100,
          disputeDeadline: 'soon',
          deductionDate: 'yesterday',
          createdAt: 'whenever',
          hasApproval: false,
        },
      ],
      TODAY,
    );
    expect(ranked).toEqual([
      {
        case: expect.objectContaining({ deductionId: 'a' }),
        bucket: 'no_deadline',
        nextStep: 'decide',
      },
    ]);
  });

  it('refuses a today that is not a date, rather than ordering against NaN', () => {
    expect(() => rankForReview([], new Date('nope'))).toThrow(RangeError);
  });
});

describe('the founder’s order (2026-09-23)', () => {
  const base = { state: 'classified' as const, hasApproval: false, createdAt: '2026-01-01' };
  const cases: QueueCase[] = [
    { ...base, deductionId: 'later', deductionAmountCents: 9_000_000, disputeDeadline: iso(DUE_SOON_DAYS + 1) },
    { ...base, deductionId: 'ledger-new', deductionAmountCents: 45_000, deductionDate: iso(-3) },
    { ...base, deductionId: 'ledger-old', deductionAmountCents: 23_900, deductionDate: iso(-60) },
    { ...base, deductionId: 'overdue-long', deductionAmountCents: 5_000_000, disputeDeadline: iso(-30) },
    { ...base, deductionId: 'overdue-just', deductionAmountCents: 100, disputeDeadline: iso(-1) },
    { ...base, deductionId: 'due-today', deductionAmountCents: 100, disputeDeadline: iso(0) },
    { ...base, deductionId: 'due-14-big', deductionAmountCents: 8_000_000, disputeDeadline: iso(DUE_SOON_DAYS) },
    { ...base, deductionId: 'due-14-small', deductionAmountCents: 50, disputeDeadline: iso(DUE_SOON_DAYS) },
    { ...base, deductionId: 'filed', state: 'submitted', deductionAmountCents: 1, disputeDeadline: iso(1) },
    { ...base, deductionId: 'merged', state: 'merged', deductionAmountCents: 1, disputeDeadline: iso(1) },
  ];

  it('files on time first, then the late ones, then no deadline oldest first, then later', () => {
    expect(ids(rankForReview(cases, TODAY))).toEqual([
      'due-today',
      'due-14-big',
      'due-14-small',
      'overdue-just',
      'overdue-long',
      'ledger-old',
      'ledger-new',
      'later',
    ]);
  });

  it('says what each case is waiting for', () => {
    const step = (state: QueueCase['state'], hasApproval = false) => nextStepFor(state, hasApproval);
    expect(step('classified')).toBe('decide');
    expect(step('analyst_review')).toBe('assemble');
    expect(step('awaiting_approval')).toBe('approve');
    expect(step('awaiting_approval', true)).toBe('file');
    expect(step('discovered')).toBe('review');
  });

  it('counts the deadline day as due, and the day after as due later', () => {
    expect(queueBucket(0)).toBe('due_soon');
    expect(queueBucket(DUE_SOON_DAYS)).toBe('due_soon');
    expect(queueBucket(DUE_SOON_DAYS + 1)).toBe('due_later');
    expect(queueBucket(-1)).toBe('past_deadline');
    expect(queueBucket(undefined)).toBe('no_deadline');
  });
});

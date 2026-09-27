import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { cents, type Cents } from '../src/money';
import {
  DEFAULT_ACCOUNT_MAP,
  JournalInputError,
  draftEntries,
  isBalanced,
  projectedEntries,
  writeoffAccountFor,
  type DraftEntry,
} from '../src/journal';

const amountAndRecovered = fc
  .integer({ min: 1, max: 1_000_000_000_000 })
  .chain((a) => fc.tuple(fc.constant(a), fc.integer({ min: 0, max: a })));

function netDeductionsReceivable(entries: readonly DraftEntry[]): number {
  let net = 0;
  for (const e of entries)
    for (const l of e.lines) if (l.role === 'deductions_receivable') net += l.debit - l.credit;
  return net;
}

describe('draftEntries', () => {
  it('every entry balances and every line is one-sided integer cents', () => {
    fc.assert(
      fc.property(amountAndRecovered, ([a, r]) => {
        const entries = draftEntries({
          amountCents: cents(a),
          recoveredCents: cents(r),
          outcome: r === a ? 'won' : r === 0 ? 'lost' : 'partial',
        });
        for (const e of entries) {
          expect(isBalanced(e)).toBe(true);
          for (const l of e.lines) {
            expect(Number.isInteger(l.debit) && Number.isInteger(l.credit)).toBe(true);
            expect((l.debit > 0) !== (l.credit > 0)).toBe(true);
          }
        }
        expect(netDeductionsReceivable(entries)).toBe(0);
      }),
    );
  });

  it('a partial splits the credits to Deductions Receivable into R and A - R', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 1_000_000_000_000 }).chain((a) =>
          fc.tuple(fc.constant(a), fc.integer({ min: 1, max: a - 1 })),
        ),
        ([a, r]) => {
          const entries = draftEntries({
            amountCents: cents(a),
            recoveredCents: cents(r),
            outcome: 'partial',
          });
          expect(entries.map((e) => e.stage)).toEqual(['found', 'recovered', 'written_off']);
          const credits = entries
            .filter((e) => e.stage !== 'found')
            .flatMap((e) => e.lines)
            .filter((l) => l.role === 'deductions_receivable')
            .map((l) => l.credit);
          expect(credits).toEqual([r, a - r]);
        },
      ),
    );
  });

  it('won has no write-off; lost and declined have no recovery', () => {
    const a = cents(50_000);
    expect(draftEntries({ amountCents: a, recoveredCents: a, outcome: 'won' }).map((e) => e.stage)).toEqual([
      'found',
      'recovered',
    ]);
    for (const outcome of ['lost', 'declined'] as const) {
      const entries = draftEntries({ amountCents: a, outcome });
      expect(entries.map((e) => e.stage)).toEqual(['found', 'written_off']);
      expect(entries[1]!.lines[0]!.debit).toBe(a);
    }
    expect(draftEntries({ amountCents: a }).map((e) => e.stage)).toEqual(['found']);
  });

  it('refuses what cannot be drafted', () => {
    const a = cents(1_000);
    const bad: (() => unknown)[] = [
      () => draftEntries({ amountCents: a, recoveredCents: cents(1_001), outcome: 'partial' }),
      () => draftEntries({ amountCents: a, recoveredCents: -1 as Cents, outcome: 'partial' }),
      () => draftEntries({ amountCents: a, recoveredCents: 1.5 as Cents, outcome: 'partial' }),
      () => draftEntries({ amountCents: a, recoveredCents: cents(999), outcome: 'won' }),
      () => draftEntries({ amountCents: a, recoveredCents: cents(1), outcome: 'lost' }),
      () => draftEntries({ amountCents: a, recoveredCents: cents(1), outcome: 'declined' }),
      () => draftEntries({ amountCents: cents(0) }),
    ];
    for (const f of bad) expect(f).toThrow(JournalInputError);
  });

  it('names the write-off account by family', () => {
    expect(writeoffAccountFor('freight')).toBe('Freight Deductions Expense');
    expect(writeoffAccountFor(undefined)).toBe(DEFAULT_ACCOUNT_MAP.unclassifiedWriteoff);
    const [, off] = draftEntries({ amountCents: cents(10), outcome: 'lost', family: 'promotion' });
    expect(off!.lines[0]!.account).toBe('Trade Promotion Expense');
    expect(off!.tag).toBe('promotion');
  });

  it('the found memo uses the printed code when no family is chosen', () => {
    const [found] = draftEntries({ amountCents: cents(10), printedReasonCode: 'CB-203' });
    expect(found!.lines[0]!.memo).toBe('Payer reason as printed: CB-203');
    const [bare] = draftEntries({ amountCents: cents(10) });
    expect(bare!.lines[0]!.memo).toBe('Reason not chosen yet');
  });

  it('projects both ends of an open case', () => {
    const p = projectedEntries(cents(700), 'pricing');
    expect(p.won.map((e) => e.stage)).toEqual(['found', 'recovered']);
    expect(p.lost.map((e) => e.stage)).toEqual(['found', 'written_off']);
  });
});

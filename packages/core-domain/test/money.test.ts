import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  ZERO,
  addCents,
  allocateCents,
  applyBps,
  bps,
  cents,
  feeCents,
  formatCents,
  MoneyError,
  shortageCents,
  parseMoneyToCents,
  sumCents,
} from '../src/money';

/** Amounts up to ~$90bn in cents: comfortably past any real claim. */
const anyCents = fc.integer({ min: 0, max: 9_000_000_000_000 }).map((n) => cents(n));
const anyBps = fc.integer({ min: 0, max: 10_000 }).map((n) => bps(n));

describe('cents', () => {
  it('rejects anything that is not an integer number of cents', () => {
    expect(() => cents(10.5)).toThrow(MoneyError);
    expect(() => cents(Number.NaN)).toThrow(MoneyError);
    expect(() => cents(Number.MAX_VALUE)).toThrow(MoneyError);
  });

  it('formats without floating point drift', () => {
    expect(formatCents(cents(312000))).toBe('$3,120.00');
    expect(formatCents(cents(1))).toBe('$0.01');
    expect(formatCents(cents(-2599))).toBe('-$25.99');
  });
});

describe('fee maths', () => {
  it('matches the plan’s worked example: 25% of $3,120 is $780', () => {
    expect(feeCents(cents(312_000), bps(2500))).toBe(78_000);
  });

  it('never exceeds the recovery and is never negative', () => {
    fc.assert(
      fc.property(anyCents, anyBps, (amount, rate) => {
        const fee = feeCents(amount, rate);
        expect(fee).toBeGreaterThanOrEqual(0);
        expect(fee).toBeLessThanOrEqual(amount);
      }),
    );
  });

  it('always returns whole cents', () => {
    fc.assert(
      fc.property(anyCents, anyBps, (amount, rate) => {
        expect(Number.isInteger(feeCents(amount, rate))).toBe(true);
      }),
    );
  });

  it('is monotonic in both the amount and the rate', () => {
    fc.assert(
      fc.property(anyCents, anyCents, anyBps, (a, b, rate) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        expect(feeCents(lo, rate)).toBeLessThanOrEqual(feeCents(hi, rate));
      }),
    );
    fc.assert(
      fc.property(anyCents, anyBps, anyBps, (amount, r1, r2) => {
        const [lo, hi] = r1 <= r2 ? [r1, r2] : [r2, r1];
        expect(feeCents(amount, lo)).toBeLessThanOrEqual(feeCents(amount, hi));
      }),
    );
  });

  it('pins the endpoints: 0 bps bills nothing, 10000 bps bills everything', () => {
    fc.assert(
      fc.property(anyCents, (amount) => {
        expect(feeCents(amount, bps(0))).toBe(0);
        expect(feeCents(amount, bps(10_000))).toBe(amount);
      }),
    );
  });

  it('billing two recoveries separately differs from billing the sum by at most a cent', () => {
    fc.assert(
      fc.property(anyCents, anyCents, anyBps, (a, b, rate) => {
        const separately = feeCents(a, rate) + feeCents(b, rate);
        const together = feeCents(addCents(a, b), rate);
        expect(Math.abs(separately - together)).toBeLessThanOrEqual(1);
      }),
    );
  });

  it('rounds half-up, exactly, with no float error', () => {
    // 1 cent at 50% is half a cent: it rounds up, not to 0 and not to 0.5.
    expect(applyBps(cents(1), bps(5000))).toBe(1);
    expect(applyBps(cents(3), bps(5000))).toBe(2);
    // 0.1 + 0.2 territory: 2999 cents at 33.33% is 999.5667 → 1000.
    expect(applyBps(cents(2999), bps(3333))).toBe(1000);
  });

  it('rejects a negative recovery rather than inventing a negative fee', () => {
    expect(() => feeCents(cents(-100), bps(2500))).toThrow(MoneyError);
  });
});

describe('sumCents', () => {
  it('is exact over long ledgers', () => {
    fc.assert(
      fc.property(fc.array(anyCents, { maxLength: 200 }), (values) => {
        const total = sumCents(values);
        expect(total).toBe(values.reduce<number>((a, b) => a + b, 0));
        expect(Number.isSafeInteger(total)).toBe(true);
      }),
    );
  });

  it('sums an empty ledger to zero', () => {
    expect(sumCents([])).toBe(ZERO);
  });
});

describe('shortageCents', () => {
  it('computes the plan’s Walmart code 24 example', () => {
    // 30 cartons shipped, 25 signed for, $624 per carton.
    expect(shortageCents(30, 25, cents(62_400))).toBe(312_000);
  });

  it('refuses an overage disguised as a shortage', () => {
    expect(() => shortageCents(25, 30, cents(62_400))).toThrow(/overage/);
  });

  it('is exact for any plausible line', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 0, max: 10_000_000 }),
        (invoiced, received, unitCost) => {
          fc.pre(received <= invoiced);
          const result = shortageCents(invoiced, received, cents(unitCost));
          expect(result).toBe((invoiced - received) * unitCost);
        },
      ),
    );
  });
});

describe('allocateCents', () => {
  it('splits a recovery across lines without losing or inventing a cent', () => {
    fc.assert(
      fc.property(
        anyCents,
        fc.array(fc.integer({ min: 1, max: 1000 }), { minLength: 1, maxLength: 20 }),
        (amount, weights) => {
          const parts = allocateCents(amount, weights);
          expect(parts).toHaveLength(weights.length);
          expect(sumCents(parts)).toBe(amount);
          parts.forEach((p) => expect(p).toBeGreaterThanOrEqual(0));
        },
      ),
    );
  });

  it('rejects weights that cannot describe a split', () => {
    expect(() => allocateCents(cents(100), [])).toThrow(MoneyError);
    expect(() => allocateCents(cents(100), [0, 0])).toThrow(MoneyError);
    expect(() => allocateCents(cents(100), [-1, 2])).toThrow(MoneyError);
  });
});

describe('parseMoneyToCents', () => {
  it('reads money the way it appears on a deduction notice', () => {
    expect(parseMoneyToCents('$3,120.00')).toBe(312_000);
    expect(parseMoneyToCents('3120')).toBe(312_000_00 / 100);
    expect(parseMoneyToCents('  $624.00 ')).toBe(62_400);
    expect(parseMoneyToCents('1,234.56 USD')).toBe(123_456);
    expect(parseMoneyToCents('0.01')).toBe(1);
    expect(parseMoneyToCents('.99')).toBe(99);
  });

  it('reads the two ways a document says "negative"', () => {
    expect(parseMoneyToCents('(1,234.56)')).toBe(-123_456);
    expect(parseMoneyToCents('-1,234.56')).toBe(-123_456);
    expect(parseMoneyToCents('1,234.56 CR')).toBe(-123_456);
    expect(parseMoneyToCents('1,234.56 DR')).toBe(123_456);
    // Both markers cancel, which is what a credit in parentheses means.
    expect(parseMoneyToCents('(1,234.56 CR)')).toBe(123_456);
  });

  it('refuses to guess', () => {
    expect(() => parseMoneyToCents('')).toThrow(MoneyError);
    expect(() => parseMoneyToCents('three thousand')).toThrow(MoneyError);
    expect(() => parseMoneyToCents('1,23.45')).toThrow(/ambiguous/);
    expect(() => parseMoneyToCents('12,3456')).toThrow(/ambiguous/);
    // Three decimals could be 1.234 or 1,234 — either reading is a real number
    // of dollars, so this is exactly where guessing would cost money.
    expect(() => parseMoneyToCents('1.234')).toThrow(/two decimal places/);
    expect(() => parseMoneyToCents('$')).toThrow(MoneyError);
    expect(() => parseMoneyToCents('.')).toThrow(MoneyError);
  });

  it('round-trips anything we format', () => {
    fc.assert(
      fc.property(fc.integer({ min: -9_000_000_000, max: 9_000_000_000 }), (n) => {
        const amount = cents(n);
        expect(parseMoneyToCents(formatCents(amount))).toBe(amount);
      }),
    );
  });
});

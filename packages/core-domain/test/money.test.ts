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
  shortageCentsAt,
  parseMoneyToCents,
  parseUnitPrice,
  extendedCents,
  unitsAtPrice,
  compareUnitPrices,
  formatUnitPrice,
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

  it('reads a unit price printed past the cents in zeros', () => {
    // Oklahoma County's purchase order (public suite, eb-oklahoma-county-po).
    expect(parseMoneyToCents('$6,721.8000')).toBe(672_180);
    expect(parseMoneyToCents('6721.8000')).toBe(672_180);
    expect(parseMoneyToCents('(6,721.8000)')).toBe(-672_180);
    expect(parseMoneyToCents('6,721.8000 CR')).toBe(-672_180);
    expect(parseMoneyToCents('$1.0000')).toBe(100);
    expect(parseMoneyToCents('0.5000')).toBe(50);
    expect(parseMoneyToCents('.1000')).toBe(10);
    expect(parseMoneyToCents('12.34000000')).toBe(1_234);
    expect(parseMoneyToCents('1,234.5000')).toBe(123_450);
  });

  it('refuses a fraction of a cent rather than rounding it', () => {
    for (const text of ['$0.0125', '6,721.8050', '1,234.501', '12.3450', '0.00001']) {
      expect(() => parseMoneyToCents(text), text).toThrow(/fraction of a cent/);
    }
  });

  it('refuses three places, even after a comma', () => {
    // `1.000` is a dollar, or a thousand with a point for the separator. After
    // a comma, `$1,500.000` is likelier `$1,500,000` with its last comma
    // misread as a point than $1,500.00: a thousandth of the amount.
    for (const text of ['1.000', '$12.500', '0.500', '1234.500', '1,234.500', '$1,500.000', '$1,000.000']) {
      expect(() => parseMoneyToCents(text), text).toThrow(/thousands group/);
    }
  });

  it('refuses one decimal place, which a quote cut short of two would look like', () => {
    for (const text of ['6,721.8', '1800.5', '$0.5', '.5']) {
      expect(() => parseMoneyToCents(text), text).toThrow(/two decimal places/);
    }
  });

  it('reads zeros past the cents as the same cents, with or without separators', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -9_000_000_000, max: 9_000_000_000 }),
        fc.integer({ min: 2, max: 8 }),
        (n, zeros) => {
          const amount = cents(n);
          const plain = `${n < 0 ? '-' : ''}${Math.floor(Math.abs(n) / 100)}.${String(
            Math.abs(n) % 100,
          ).padStart(2, '0')}`;
          expect(parseMoneyToCents(formatCents(amount) + '0'.repeat(zeros))).toBe(amount);
          expect(parseMoneyToCents(plain + '0'.repeat(zeros))).toBe(amount);
        },
      ),
    );
  });

  it('never reads exactly one zero past the cents, grouped by commas or not', () => {
    fc.assert(
      fc.property(fc.integer({ min: -9_000_000_000, max: 9_000_000_000 }), (n) => {
        const text = `${formatCents(cents(n))}0`;
        expect(() => parseMoneyToCents(text)).toThrow(/thousands group/);
      }),
    );
  });

  it('refuses any digit past the cents that is not zero', () => {
    const digits = fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 1, maxLength: 6 });
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 9_000_000_000 }),
        digits,
        fc.integer({ min: 1, max: 9 }),
        digits,
        (n, before, nonZero, after) => {
          const tail = [...before, nonZero, ...after].join('');
          const text = formatCents(cents(n)) + tail;
          expect(() => parseMoneyToCents(text), text).toThrow(/fraction of a cent/);
        },
      ),
    );
  });

  it('reads a quote cut anywhere after the cents as the same cents, or not at all', () => {
    // The quote check matches a quote anywhere on the page, so a quote cut
    // short still verifies. Past the cents, a cut can cost the read but never
    // change the amount.
    fc.assert(
      fc.property(
        fc.integer({ min: -9_000_000_000, max: 9_000_000_000 }),
        fc.integer({ min: 0, max: 8 }),
        (n, zeros) => {
          const amount = cents(n);
          const formatted = formatCents(amount);
          const printed = formatted + '0'.repeat(zeros);
          for (let end = formatted.length; end <= printed.length; end += 1) {
            const quoted = printed.slice(0, end);
            let read: number | undefined;
            try {
              read = parseMoneyToCents(quoted);
            } catch (error) {
              expect(error).toBeInstanceOf(MoneyError);
            }
            if (read !== undefined) expect(read, quoted).toBe(amount);
          }
        },
      ),
    );
  });

  it('refuses one decimal place for any amount', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 90_000_000 }),
        fc.integer({ min: 0, max: 9 }),
        (whole, digit) => {
          const withCommas = whole.toLocaleString('en-US');
          expect(() => parseMoneyToCents(`$${withCommas}.${digit}`)).toThrow(
            /two decimal places/,
          );
          expect(() => parseMoneyToCents(`${whole}.${digit}`)).toThrow(/two decimal places/);
        },
      ),
    );
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

/**
 * A unit price (ADR 0049). The founder's rule: store it rounded half-up to the
 * cent, and do a line's arithmetic on the printed price, rounded once.
 */
describe('parseUnitPrice', () => {
  /** A price as a page prints it: whole dollars, two cent digits, then more. */
  const printedPrice = fc
    .record({
      whole: fc.integer({ min: 0, max: 9_000_000 }),
      centDigits: fc.integer({ min: 0, max: 99 }),
      tail: fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 2, maxLength: 7 }),
      commas: fc.boolean(),
    })
    .map(({ whole, centDigits, tail, commas }) => ({
      whole,
      centDigits,
      tail,
      text: `$${commas ? whole.toLocaleString('en-US') : String(whole)}.${String(centDigits).padStart(2, '0')}${tail.join('')}`,
    }));

  it('stores the founder\'s example, $0.0125, as $0.01', () => {
    const price = parseUnitPrice('$0.0125');
    expect(price.cents).toBe(1);
    expect(price.rounded).toBe(true);
  });

  it('rounds half-up to the cent', () => {
    expect(parseUnitPrice('$0.0150').cents).toBe(2);
    expect(parseUnitPrice('$0.0149').cents).toBe(1);
    expect(parseUnitPrice('$0.0199').cents).toBe(2);
    expect(parseUnitPrice('$0.0050').cents).toBe(1);
    expect(parseUnitPrice('$0.0049').cents).toBe(0);
    expect(parseUnitPrice('$3.4590').cents).toBe(346);
    expect(parseUnitPrice('$1,234.5651').cents).toBe(123_457);
    expect(parseUnitPrice('(0.0150)').cents).toBe(-2);
  });

  it('reads a price in whole cents exactly as parseMoneyToCents does', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -9_000_000_000, max: 9_000_000_000 }),
        fc.integer({ min: 0, max: 6 }),
        (n, zeros) => {
          const text = formatCents(cents(n)) + (zeros === 1 ? '00' : '0'.repeat(zeros));
          const price = parseUnitPrice(text);
          expect(price.cents).toBe(parseMoneyToCents(text));
          expect(price.rounded).toBe(false);
        },
      ),
    );
  });

  it('rounds any price half-up on its first digit past the cents', () => {
    fc.assert(
      fc.property(printedPrice, ({ whole, centDigits, tail, text }) => {
        fc.pre(!text.includes(',') || whole >= 1000);
        const expected = whole * 100 + centDigits + ((tail[0] ?? 0) >= 5 ? 1 : 0);
        const price = parseUnitPrice(text);
        expect(price.cents, text).toBe(expected);
        expect(price.rounded, text).toBe(tail.some((d) => d !== 0));
      }),
    );
  });

  it('refuses what parseMoneyToCents refuses, except a fraction of a cent', () => {
    for (const text of ['', '$', '.', 'three thousand', '1,23.45', '12,3456', '6,721.8', '1800.5']) {
      expect(() => parseUnitPrice(text), text).toThrow(MoneyError);
    }
    // Three places are a thousands group as often as they are a price.
    for (const text of ['$1.250', '$3.459', '0.125', '1.000']) {
      expect(() => parseUnitPrice(text), text).toThrow(/thousands group/);
    }
    // Even after a thousands comma: `$1,500.000` is likelier `$1,500,000` misread.
    expect(() => parseUnitPrice('$1,234.567')).toThrow(/thousands group/);
    expect(parseUnitPrice('$1,234.5670').cents).toBe(123_457);
  });
});

describe('arithmetic at a printed unit price', () => {
  const anyPrice = fc
    .record({
      units: fc.bigInt({ min: 0n, max: 10_000_000_000n }),
      places: fc.integer({ min: 2, max: 7 }),
    })
    .map(({ units, places }) => {
      const scale = 10n ** BigInt(places);
      const text = `${(units / scale).toString()}.${(units % scale).toString().padStart(places, '0')}`;
      return { text, price: parseUnitPrice(places === 3 ? `${text}0` : text) };
    });

  it('prices the founder\'s line at the printed price: 10,000 lb at $0.0125 is $125.00', () => {
    const price = parseUnitPrice('$0.0125');
    expect(extendedCents(10_000, price)).toBe(12_500);
    expect(shortageCentsAt(10_000, 0, price)).toBe(12_500);
    // Never the stored cent times the quantity, which would be $100.00.
    expect(shortageCentsAt(10_000, 0, price)).not.toBe(shortageCents(10_000, 0, price.cents));
  });

  it('rounds the line total once, half-up', () => {
    const price = parseUnitPrice('$0.0125');
    expect(extendedCents(3, price)).toBe(4); // $0.0375
    expect(extendedCents(333, price)).toBe(416); // $4.1625
    expect(extendedCents(2, price)).toBe(3); // $0.025
  });

  it('is within half a cent of the exact product, and exact when the price is whole cents', () => {
    fc.assert(
      // A price up to $100m and a quantity up to 100,000 keep every product in
      // range; past it, `extendedCents` refuses (below) rather than wrapping.
      fc.property(anyPrice, fc.integer({ min: 0, max: 100_000 }), ({ price }, quantity) => {
        const total = extendedCents(quantity, price);
        const scale = 10n ** BigInt(price.places);
        const exact = BigInt(quantity) * price.units * 100n;
        const error = BigInt(total) * scale - exact;
        expect(2n * (error < 0n ? -error : error) <= scale).toBe(true);
        if (!price.rounded) expect(total).toBe(quantity * price.cents);
      }),
    );
  });

  it('refuses a line total it cannot hold exactly', () => {
    expect(() => extendedCents(999_999, parseUnitPrice('90072082.62'))).toThrow(
      /999999 at \$90,072,082\.62 is out of the safe integer range/,
    );
    expect(() => extendedCents(1.5, parseUnitPrice('$0.0125'))).toThrow(/integer/);
  });

  it('agrees with shortageCents whenever the price is whole cents', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 0, max: 10_000_000 }),
        (invoiced, received, unitCost) => {
          fc.pre(received <= invoiced);
          const price = parseUnitPrice(formatCents(cents(unitCost)));
          expect(shortageCentsAt(invoiced, received, price)).toBe(
            shortageCents(invoiced, received, cents(unitCost)),
          );
        },
      ),
    );
  });

  it('refuses what shortageCents refuses', () => {
    const price = parseUnitPrice('$0.0125');
    expect(() => shortageCentsAt(25, 30, price)).toThrow(/overage/);
    expect(() => shortageCentsAt(1.5, 0, price)).toThrow(MoneyError);
    expect(() => shortageCentsAt(-1, 0, price)).toThrow(MoneyError);
    expect(() => shortageCentsAt(1, 0, parseUnitPrice('(0.0125)'))).toThrow(/negative/);
  });

  it('counts whole units at a printed price, exactly', () => {
    const price = parseUnitPrice('$0.0125');
    expect(unitsAtPrice(cents(12_500), price)).toBe(10_000);
    expect(unitsAtPrice(cents(416), price)).toBeUndefined();
    expect(unitsAtPrice(cents(100), parseUnitPrice('0.00'))).toBeUndefined();
    fc.assert(
      fc.property(anyPrice, fc.integer({ min: 1, max: 100_000 }), ({ price }, quantity) => {
        fc.pre(price.units > 0n && (BigInt(quantity) * price.units * 100n) % 10n ** BigInt(price.places) === 0n);
        expect(unitsAtPrice(extendedCents(quantity, price), price)).toBe(quantity);
      }),
    );
  });

  it('compares printed prices exactly, not their stored cents', () => {
    const agreed = parseUnitPrice('$0.0149');
    const used = parseUnitPrice('$0.0125');
    expect(agreed.cents).toBe(used.cents);
    expect(compareUnitPrices(used, agreed)).toBeLessThan(0);
    expect(compareUnitPrices(parseUnitPrice('$6,721.80'), parseUnitPrice('$6,721.8000'))).toBe(0);
    fc.assert(
      fc.property(anyPrice, anyPrice, ({ price: a }, { price: b }) => {
        const left = a.units * 10n ** BigInt(b.places);
        const right = b.units * 10n ** BigInt(a.places);
        expect(Math.sign(compareUnitPrices(a, b))).toBe(left === right ? 0 : left < right ? -1 : 1);
        expect(compareUnitPrices(a, b)).toBe(-compareUnitPrices(b, a) || 0);
      }),
    );
  });

  it('writes a price the way the page did, and reads it back unchanged', () => {
    expect(formatUnitPrice(parseUnitPrice('$0.0125'))).toBe('$0.0125');
    expect(formatUnitPrice(parseUnitPrice('$6,721.8000'))).toBe('$6,721.80');
    expect(formatUnitPrice(parseUnitPrice('1.2350'))).toBe('$1.2350');
    expect(formatUnitPrice(parseUnitPrice('1234.5670'))).toBe('$1,234.5670');
    expect(formatUnitPrice(parseUnitPrice('(0.0125)'))).toBe('-$0.0125');
    fc.assert(
      fc.property(anyPrice, ({ price }) => {
        const again = parseUnitPrice(formatUnitPrice(price));
        expect(compareUnitPrices(again, price)).toBe(0);
        expect(again.cents).toBe(price.cents);
      }),
    );
  });
});

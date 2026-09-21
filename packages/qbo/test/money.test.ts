import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { cents, formatCents } from '@recouple/core-domain';
import { QboMalformedResponse } from '../src/errors';
import { qboAmountToCents } from '../src/money';

/**
 * Invariant 3, at the seam where QuickBooks hands us a float.
 *
 * The test that matters here is not "1234.50 is 123450" — it is that a value
 * which cannot be two decimal places throws instead of rounding. A rounded
 * guess on this path becomes a dollar figure on a reviewer's screen and then a
 * contingency fee.
 */
describe('qboAmountToCents', () => {
  it('reads a plain two-decimal amount', () => {
    expect(qboAmountToCents(3120.0, 'Invoice[0].TotalAmt')).toBe(312_000);
    expect(qboAmountToCents(890.25, 'Invoice[1].TotalAmt')).toBe(89_025);
    expect(qboAmountToCents(0, 'Invoice[2].Balance')).toBe(0);
  });

  it('reads an amount JSON serialised with one decimal place', () => {
    // QBO sends `1234.5`, not `1234.50` — JSON has no trailing zeros.
    expect(qboAmountToCents(1234.5, 'Invoice[3].TotalAmt')).toBe(123_450);
    expect(qboAmountToCents(62.4, 'CreditMemo[1].TotalAmt')).toBe(6_240);
  });

  it('reads a negative amount', () => {
    expect(qboAmountToCents(-49.99, 'Payment[0].Line[0].Amount')).toBe(-4_999);
  });

  it('refuses a third decimal place rather than rounding it', () => {
    expect(() => qboAmountToCents(1234.567, 'Invoice[0].TotalAmt')).toThrow(QboMalformedResponse);

    try {
      qboAmountToCents(1234.567, 'Invoice[0].TotalAmt');
      expect.unreachable('a three-decimal amount must not convert');
    } catch (error) {
      expect(error).toBeInstanceOf(QboMalformedResponse);
      // The error has to say which number it refused, or a sync failure is a
      // scavenger hunt.
      expect((error as QboMalformedResponse).fieldPath).toBe('Invoice[0].TotalAmt');
      expect((error as QboMalformedResponse).message).toContain('1234.567');
    }
  });

  it('never silently loses the half cent that float maths would', () => {
    // 1234.565 * 100 is 123456.49999999999 in IEEE-754, which rounds to 123456
    // — a cent short of both plausible answers. We refuse it instead.
    expect(() => qboAmountToCents(1234.565, 'Invoice[0].TotalAmt')).toThrow(QboMalformedResponse);
  });

  it('refuses anything that is not a finite number', () => {
    for (const value of ['3120.00', null, undefined, {}, [], Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => qboAmountToCents(value, 'Invoice[0].TotalAmt')).toThrow(QboMalformedResponse);
    }
  });

  it('refuses a magnitude it cannot hold exactly instead of truncating it', () => {
    // Past the safe-integer range in cents, and past the point where `toFixed`
    // gives up and returns exponential notation.
    expect(() => qboAmountToCents(1e21, 'Invoice[0].TotalAmt')).toThrow(QboMalformedResponse);
    expect(() => qboAmountToCents(1e15, 'Invoice[0].TotalAmt')).toThrow(QboMalformedResponse);
  });

  /**
   * Amounts up to ~$90bn, the same range core-domain property-tests its money
   * maths over. The generator produces cents and then the JSON number QBO would
   * have serialised for them, so this asserts the whole round trip rather than
   * a re-implementation of it.
   */
  const anyCents = fc.integer({ min: -9_000_000_000_000, max: 9_000_000_000_000 });

  it('round-trips any well-formed two-decimal amount back to the cents it came from', () => {
    fc.assert(
      fc.property(anyCents, (amountCents) => {
        const asQboWouldSendIt = Number((amountCents / 100).toFixed(2));
        expect(qboAmountToCents(asQboWouldSendIt, 'Invoice[0].TotalAmt')).toBe(amountCents);
      }),
    );
  });

  it('agrees with core-domain about what the amount is called', () => {
    fc.assert(
      fc.property(anyCents, (amountCents) => {
        const asQboWouldSendIt = Number((amountCents / 100).toFixed(2));
        expect(formatCents(qboAmountToCents(asQboWouldSendIt, 'x'))).toBe(
          formatCents(cents(amountCents)),
        );
      }),
    );
  });
});

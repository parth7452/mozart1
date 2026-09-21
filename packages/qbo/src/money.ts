/**
 * QBO amounts into integer cents (invariant 3, ADR 0026).
 *
 * QuickBooks returns money as a JSON *number* — `"TotalAmt": 1234.5` — so by
 * the time our code sees it, it has already been through an IEEE-754 double.
 * The obvious conversion is `Math.round(amount * 100)` and it is the one that
 * eventually bills someone the wrong amount: `1234.565 * 100` is
 * `123456.49999999999`.
 *
 * So we do here what we do with a number printed on a page: copy the value into
 * a string and let deterministic code do the arithmetic. The only arithmetic is
 * base-10 digit shuffling, inside `parseMoneyToCents` — the same function that
 * turns `"$3,120.00"` off a scan into cents, so there is one money parser in
 * this system and not two.
 */

import { MoneyError, parseMoneyToCents, type Cents } from '@recouple/core-domain';
import { QboMalformedResponse } from './errors';
import { describe } from './reader';

/**
 * Converts one QBO amount to cents, or refuses.
 *
 * The gate is a round trip: `Number(value.toFixed(2)) === value`. `1234.5`
 * formats as `"1234.50"` and reads back identical, so it is exactly $1,234.50
 * and becomes `123450`. `1234.567` formats as `"1234.57"`, which is a different
 * number, so we never learn what was meant — and a third decimal place on a
 * money field is a fact about the response, not a rounding opportunity. It
 * throws, naming the field.
 *
 * `fieldPath` is the path in the response (`Invoice[2].TotalAmt`), so the error
 * says which number it refused.
 */
export function qboAmountToCents(value: unknown, fieldPath: string): Cents {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new QboMalformedResponse(
      `expected a finite JSON number at ${fieldPath}, got ${describe(value)}`,
      fieldPath,
    );
  }

  const asText = value.toFixed(2);
  if (Number(asText) !== value) {
    throw new QboMalformedResponse(
      `amount at ${fieldPath} does not round-trip at two decimal places: ` +
        `${value} formats as ${JSON.stringify(asText)}, which is a different number`,
      fieldPath,
    );
  }

  try {
    return parseMoneyToCents(asText);
  } catch (error) {
    // A magnitude past the safe-integer range, or a `toFixed` that fell back to
    // exponential notation (values ≥ 1e21). Either way it is not money we can
    // hold exactly, and rounding it would be the guess this function exists to
    // refuse.
    if (error instanceof MoneyError) {
      throw new QboMalformedResponse(
        `amount at ${fieldPath} is not an amount we can hold exactly: ${error.message}`,
        fieldPath,
      );
    }
    throw error;
  }
}

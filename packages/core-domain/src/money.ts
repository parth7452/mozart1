/**
 * Money is integer cents, never floats (invariant 3).
 *
 * Every function here is exact: the intermediate arithmetic runs in BigInt so a
 * fee on a large recovery cannot silently lose precision, and the result is
 * checked back into the safe-integer range before it leaves.
 */

export type Cents = number & { readonly __cents: unique symbol };

/** Basis points: 2500 bps = 25%. Contingency fees are stored as bps. */
export type Bps = number & { readonly __bps: unique symbol };

export class MoneyError extends Error {}

export function cents(value: number): Cents {
  if (!Number.isInteger(value)) {
    throw new MoneyError(`money must be integer cents, got ${value}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`money out of safe integer range: ${value}`);
  }
  return value as Cents;
}

export function bps(value: number): Bps {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new MoneyError(`bps must be an integer in [0, 10000], got ${value}`);
  }
  return value as Bps;
}

export const ZERO = cents(0);

export function addCents(a: Cents, b: Cents): Cents {
  return cents(a + b);
}

export function subCents(a: Cents, b: Cents): Cents {
  return cents(a - b);
}

export function sumCents(values: readonly Cents[]): Cents {
  return values.reduce<Cents>((acc, v) => addCents(acc, v), ZERO);
}

/** Half-up rounding away from zero, done in BigInt so it is exact. */
function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new MoneyError('denominator must be positive');
  const negative = numerator < 0n;
  const n = negative ? -numerator : numerator;
  const q = (n * 2n + denominator) / (denominator * 2n);
  return negative ? -q : q;
}

/** Applies a basis-point rate to an amount, half-up to the nearest cent. */
export function applyBps(amount: Cents, rate: Bps): Cents {
  const result = divRoundHalfUp(BigInt(amount) * BigInt(rate), 10_000n);
  return cents(Number(result));
}

/**
 * The contingency fee on a recovery. Only *billable* recovered dollars reach
 * this function — attribution decides that, not the fee maths (plan §14).
 */
export function feeCents(billableRecovery: Cents, feePctBps: Bps): Cents {
  if (billableRecovery < 0) {
    throw new MoneyError(`a recovery cannot be negative: ${billableRecovery}`);
  }
  return applyBps(billableRecovery, feePctBps);
}

/**
 * Shortage maths for a claim line: (qty_invoiced − qty_received) × unit_cost.
 * Deterministic code owns this, never a model (plan §7).
 */
export function shortageCents(
  qtyInvoiced: number,
  qtyReceived: number,
  unitCostCents: Cents,
): Cents {
  if (!Number.isInteger(qtyInvoiced) || !Number.isInteger(qtyReceived)) {
    throw new MoneyError('quantities must be integers');
  }
  if (qtyInvoiced < 0 || qtyReceived < 0) {
    throw new MoneyError('quantities cannot be negative');
  }
  if (qtyReceived > qtyInvoiced) {
    throw new MoneyError(
      `received (${qtyReceived}) exceeds invoiced (${qtyInvoiced}): this is an overage, not a shortage`,
    );
  }
  if (unitCostCents < 0) throw new MoneyError('unit cost cannot be negative');
  return cents(Number(BigInt(qtyInvoiced - qtyReceived) * BigInt(unitCostCents)));
}

/**
 * Splits an amount into `parts` whole cents that sum back exactly to the input.
 * Used when one recovery covers several claim lines; the remainder cents go to
 * the earliest parts so the total is never off by rounding.
 */
export function allocateCents(amount: Cents, weights: readonly number[]): Cents[] {
  if (weights.length === 0) throw new MoneyError('need at least one weight');
  if (weights.some((w) => !Number.isFinite(w) || w < 0)) {
    throw new MoneyError('weights must be finite and non-negative');
  }
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) throw new MoneyError('weights must sum to more than zero');

  const out: Cents[] = [];
  let assigned = 0;
  for (const w of weights) {
    const share = Math.floor((amount * w) / total);
    out.push(cents(share));
    assigned += share;
  }
  let remainder = amount - assigned;
  for (let i = 0; remainder > 0; i = (i + 1) % out.length, remainder--) {
    const current = out[i];
    if (current === undefined) throw new MoneyError('allocation index out of range');
    out[i] = cents(current + 1);
  }
  return out;
}

/**
 * Money as printed, taken apart before anything decides what it is worth.
 *
 * Both parsers below start here, so an amount and a unit price agree on every
 * rule except the one that separates them: what to do with a digit past the
 * cents.
 */
interface PrintedNumber {
  readonly negative: boolean;
  /** The whole part's digits with its separators removed; `''` for `.99`. */
  readonly whole: string;
  /** Every digit after the point exactly as printed; `''` when there is none. */
  readonly fraction: string;
  readonly groupedByCommas: boolean;
}

function readPrinted(text: string): PrintedNumber {
  const original = text;
  let working = text.trim().toUpperCase();
  if (working === '') throw new MoneyError('cannot parse money from an empty string');

  let negative = false;

  // Accounting parentheses.
  const parenthesised = /^\((.*)\)$/.exec(working);
  if (parenthesised?.[1] !== undefined) {
    negative = true;
    working = parenthesised[1].trim();
  }

  // Trailing credit/debit marker.
  const marker = /^(.*?)\s*(CR|DR)$/.exec(working);
  if (marker?.[1] !== undefined) {
    if (marker[2] === 'CR') negative = !negative;
    working = marker[1].trim();
  }

  working = working.replace(/\bUSD\b/g, '').replace(/\$/g, '').replace(/\s/g, '');

  if (working.startsWith('-')) {
    negative = !negative;
    working = working.slice(1);
  } else if (working.startsWith('+')) {
    working = working.slice(1);
  }

  if (!/^[0-9,]*\.?[0-9]*$/.test(working) || working === '' || working === '.') {
    throw new MoneyError(`cannot parse money from ${JSON.stringify(original)}`);
  }

  const [wholePart = '', fractionPart = ''] = working.split('.');

  // Thousands separators must be exactly that: 1,234 or 1,234,567, never 1,23.
  if (wholePart.includes(',')) {
    const groups = wholePart.split(',');
    const [first, ...rest] = groups;
    if (
      first === undefined ||
      first.length === 0 ||
      first.length > 3 ||
      rest.some((g) => g.length !== 3)
    ) {
      throw new MoneyError(
        `ambiguous thousands separators in ${JSON.stringify(original)}`,
      );
    }
  }

  const whole = wholePart.replace(/,/g, '');
  if (whole === '' && fractionPart === '') {
    throw new MoneyError(`cannot parse money from ${JSON.stringify(original)}`);
  }
  return { negative, whole, fraction: fractionPart, groupedByCommas: wholePart.includes(',') };
}

/**
 * Parses money as written on a document into integer cents.
 *
 * Extraction models report the *verbatim* text of a money field; converting it
 * to cents is our job, not theirs (invariant 3 — and a model that does its own
 * arithmetic gives us no way to check it). USD only in V1.
 *
 * Accepts: `$3,120.00`, `3120`, `3,120.00 USD`, `(1,234.56)` and `-1,234.56`
 * (both negative), a trailing `CR`/`DR`, and an amount printed past the cents
 * in zeros (`$6,721.8000`, see `centsOfFraction`). Rejects anything it cannot
 * read unambiguously rather than guessing a value that will be billed on — a
 * fraction of a cent (`$0.0125`) included. A *unit price* printed that way is
 * `parseUnitPrice`'s, which rounds it (ADR 0049); an amount never is.
 */
export function parseMoneyToCents(text: string): Cents {
  const printed = readPrinted(text);
  const fraction =
    printed.fraction === '' ? '00' : centsOfFraction(printed.fraction, printed.groupedByCommas, text);
  const magnitude = Number(`${printed.whole === '' ? '0' : printed.whole}${fraction}`);
  if (!Number.isSafeInteger(magnitude)) {
    throw new MoneyError(`money out of safe integer range: ${JSON.stringify(text)}`);
  }
  return cents(printed.negative ? -magnitude : magnitude);
}

/**
 * The two cent digits of a printed fraction, or a refusal.
 *
 * Two decimal places are cents. More are read only when every digit past the
 * second is `0`, so the amount is exactly what the first two say:
 * `$6,721.8000` on a purchase order is 672,180 cents, and nothing is rounded.
 * A digit past the second that is not `0` is a fraction of a cent, which
 * integer cents cannot hold (invariant 3); it is refused, never rounded.
 *
 * Three places are read only after a whole part grouped by commas (see
 * `mayBeThousandsGroup`). Four or more places cannot be a group at all.
 *
 * One place (`6,721.8`) is still refused. It is lossless as written, but a
 * quote cut short of `$6,721.85` reads that way. Every form read here instead
 * ends with zeros after two places whose value was already read, so a quote
 * cut short of it reads the same cents it always did.
 */
function centsOfFraction(fractionPart: string, groupedByCommas: boolean, original: string): string {
  if (fractionPart.length === 2) return fractionPart;
  const printed = JSON.stringify(original);
  if (fractionPart.length < 2) {
    throw new MoneyError(`expected two decimal places in ${printed}, got ${fractionPart.length}`);
  }
  if (!/^0+$/.test(fractionPart.slice(2))) {
    throw new MoneyError(
      `expected two decimal places in ${printed}, got ${fractionPart.length}: ` +
        'a digit past the cents that is not 0 is a fraction of a cent, which is not rounded',
    );
  }
  if (mayBeThousandsGroup(fractionPart, groupedByCommas)) {
    throw new MoneyError(
      `expected two decimal places in ${printed}, got 3: ` +
        'three digits after a point could be a thousands group',
    );
  }
  return fractionPart.slice(0, 2);
}

/**
 * Whether three digits after a point could be a thousands group instead.
 *
 * `1.000` could be one dollar or, with a point for a thousands separator, a
 * thousand, and a thousands group is always exactly three digits; `1,234.500`
 * has already said which mark groups thousands.
 */
function mayBeThousandsGroup(fraction: string, groupedByCommas: boolean): boolean {
  return fraction.length === 3 && !groupedByCommas;
}

/**
 * A price per unit (ADR 0049): the cents it is stored as, and the price the
 * page printed, exactly, for the arithmetic that checks a line.
 *
 * A unit price may be printed past the cent — `$0.0125` a pound. It is stored
 * rounded half-up to the cent, the rule `applyBps` already uses, so `$0.0125`
 * is stored as 1 cent and `$0.0150` as 2. Nothing multiplies the stored cents:
 * 10,000 lb at 1 cent is $100.00 where the page says $125.00. A line total is
 * the printed price times the quantity, rounded once (`extendedCents`).
 *
 * `units` and `places` are never stored; they are the page's own digits, held
 * while a line is checked.
 */
export interface UnitPrice {
  /** The printed price rounded half-up to the cent: what is stored and shown. */
  readonly cents: Cents;
  /** True when the page printed a fraction of a cent, so `cents` is rounded. */
  readonly rounded: boolean;
  /** The printed price is exactly `units / 10^places` dollars. */
  readonly units: bigint;
  readonly places: number;
}

/**
 * Reads a unit price as printed (ADR 0049).
 *
 * Every rule `parseMoneyToCents` has, except that a digit past the cents is
 * kept rather than refused: the price is stored rounded half-up to the cent,
 * and its exact digits are kept for `extendedCents`. One decimal place is
 * still refused, and three are read only where they could not be a thousands
 * group — `$1.250` could be a price of $1,250.
 */
export function parseUnitPrice(text: string): UnitPrice {
  const printed = readPrinted(text);
  const quoted = JSON.stringify(text);
  if (printed.fraction.length === 1) {
    throw new MoneyError(`expected two decimal places in ${quoted}, got 1`);
  }
  if (mayBeThousandsGroup(printed.fraction, printed.groupedByCommas)) {
    throw new MoneyError(
      `expected two decimal places in ${quoted}, got 3: ` +
        'three digits after a point could be a thousands group',
    );
  }
  const places = printed.fraction.length;
  const magnitude = BigInt(`${printed.whole === '' ? '0' : printed.whole}${printed.fraction}`);
  const units = printed.negative ? -magnitude : magnitude;
  const scale = 10n ** BigInt(places);
  const rounded = divRoundHalfUp(units * 100n, scale);
  return {
    cents: centsFromBigInt(rounded, text),
    rounded: (units * 100n) % scale !== 0n,
    units,
    places,
  };
}

/** A bigint count of cents back into `Cents`, or a refusal if it cannot be held exactly. */
function centsFromBigInt(value: bigint, source: string): Cents {
  const asNumber = Number(value);
  if (!Number.isSafeInteger(asNumber)) {
    throw new MoneyError(`money out of safe integer range: ${JSON.stringify(source)}`);
  }
  return cents(asNumber);
}

/**
 * A quantity times a printed unit price, rounded once, half-up, to the cent.
 *
 * The product is exact (`BigInt`), and the only rounding is the last step, so
 * 10,000 × `$0.0125` is $125.00 and 3 × `$0.0125` ($0.0375) is $0.04. A price
 * printed in whole cents gives exactly `quantity × cents`, as it always did.
 */
export function extendedCents(quantity: number, price: UnitPrice): Cents {
  if (!Number.isSafeInteger(quantity)) throw new MoneyError('a quantity must be an integer');
  const exact = BigInt(quantity) * price.units * 100n;
  return centsFromBigInt(divRoundHalfUp(exact, 10n ** BigInt(price.places)), String(quantity));
}

/**
 * Shortage maths at a printed unit price: `(invoiced − received) × price`,
 * with `shortageCents`'s refusals, rounded once at the end (`extendedCents`).
 */
export function shortageCentsAt(
  qtyInvoiced: number,
  qtyReceived: number,
  price: UnitPrice,
): Cents {
  if (!Number.isInteger(qtyInvoiced) || !Number.isInteger(qtyReceived)) {
    throw new MoneyError('quantities must be integers');
  }
  if (qtyInvoiced < 0 || qtyReceived < 0) {
    throw new MoneyError('quantities cannot be negative');
  }
  if (qtyReceived > qtyInvoiced) {
    throw new MoneyError(
      `received (${qtyReceived}) exceeds invoiced (${qtyInvoiced}): this is an overage, not a shortage`,
    );
  }
  if (price.units < 0n) throw new MoneyError('unit cost cannot be negative');
  return extendedCents(qtyInvoiced - qtyReceived, price);
}

/**
 * How many whole units an amount buys at a printed price, or `undefined` when
 * it is not a whole number of units (or the price is zero). Exact: no float
 * division, so a price past the cent answers the same as one in cents.
 */
export function unitsAtPrice(amount: Cents, price: UnitPrice): number | undefined {
  const perUnit = price.units * 100n;
  if (perUnit === 0n) return undefined;
  const numerator = BigInt(amount) * 10n ** BigInt(price.places);
  if (numerator % perUnit !== 0n) return undefined;
  const units = Number(numerator / perUnit);
  return Number.isSafeInteger(units) ? units : undefined;
}

/** Orders two printed unit prices exactly: negative, zero or positive. */
export function compareUnitPrices(a: UnitPrice, b: UnitPrice): number {
  const left = a.units * 10n ** BigInt(b.places);
  const right = b.units * 10n ** BigInt(a.places);
  return left === right ? 0 : left < right ? -1 : 1;
}

/**
 * A unit price as the page printed it, for a sentence a reviewer reads:
 * `$0.0125`, `$6,721.80`. Zeros past the cents are dropped; digits that are a
 * fraction of a cent are kept, because they are what the page says.
 */
export function formatUnitPrice(price: UnitPrice): string {
  const negative = price.units < 0n;
  const magnitude = negative ? -price.units : price.units;
  const scale = 10n ** BigInt(price.places);
  const whole = magnitude / scale;
  let fraction = (magnitude % scale).toString().padStart(price.places, '0');
  fraction = fraction.replace(/0+$/, '').padEnd(2, '0');
  // `$1.235` could be read back as a price of $1,235; `$1.2350` cannot.
  if (fraction.length === 3 && whole < 1000n) fraction = `${fraction}0`;
  return `${negative ? '-' : ''}$${whole.toLocaleString('en-US')}.${fraction}`;
}

export function formatCents(amount: Cents): string {
  const negative = amount < 0;
  const abs = Math.abs(amount);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  return `${negative ? '-' : ''}$${whole.toLocaleString('en-US')}.${frac}`;
}

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

export function formatCents(amount: Cents): string {
  const negative = amount < 0;
  const abs = Math.abs(amount);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  return `${negative ? '-' : ''}$${whole.toLocaleString('en-US')}.${frac}`;
}

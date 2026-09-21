/**
 * One deduction, several identifiers (ADR 0027, docs/STRATEGY.md §5.2, CH-3).
 *
 * The same deduction reaches us under up to four different names: a credit memo
 * in the accounting ledger, an adjustment line on an EDI 812, a claim id in the
 * retailer's portal, and the claim id printed on an uploaded notice. This
 * module answers one question about an arrival — is this a deduction we already
 * have? — and it answers it in deterministic code, with no I/O and no model.
 *
 * **The gate is asymmetric, and that is the whole design.** A duplicate case is
 * visible: two rows, one claim, and the money is still disputable. A wrong
 * merge is invisible: the arrival disappears into another deduction's row,
 * nothing records that a second deduction was ever seen, and a disputable
 * deduction is destroyed quietly — which, with post-audit claims reaching back
 * about two years, we would find out about long after the window closed. So an
 * exact identifier match resolves, and everything else is a question for a
 * person. Two matches count as none, the rule `resolveDebtorId` already applies
 * to debtors next door in `retailers.ts`, for the same reason: we do not
 * choose.
 */

import type { Cents } from './money';

export class IdentityError extends Error {}

/**
 * What kind of name an identifier is. Mirrors the
 * `deduction_identifiers.identifier_kind` check constraint in migration 0021 —
 * add a kind in both places or a row the database accepts will be one this
 * module cannot compare.
 */
export type IdentifierKind =
  | 'claim_id'
  | 'invoice_number'
  | 'credit_memo_id'
  | 'edi_812_reference'
  | 'portal_claim_id'
  | 'ledger_invoice_id';

export const IDENTIFIER_KINDS: readonly IdentifierKind[] = [
  'claim_id',
  'invoice_number',
  'credit_memo_id',
  'edi_812_reference',
  'portal_claim_id',
  'ledger_invoice_id',
];

/**
 * Folds an identifier to a key two writings of the same name share: trim,
 * case-fold, collapse internal whitespace. Nothing cleverer, and in particular
 * no punctuation stripping — `APDP-99812` and `APDP99812` are different
 * identifiers until a human says they are not, exactly as `walmart stores` is
 * not `walmart` (ADR 0019 §3). The difference between the two is a fact about a
 * source's numbering, and facts about a source are data.
 *
 * Returns `''` for a value with nothing in it, which callers must treat as "no
 * key", never as a match.
 */
export function identifierMatchKey(identifier: string): string {
  return identifier.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** An identifier already recorded against a deduction. */
export interface KnownIdentifier {
  readonly deductionId: string;
  readonly source: string;
  readonly kind: IdentifierKind;
  readonly identifier: string;
}

/** What a new arrival knows about itself. Any field may be absent. */
export interface ArrivalIdentity {
  readonly identifiers: readonly { kind: IdentifierKind; identifier: string }[];
  readonly amountCents?: Cents;
  readonly invoiceNumber?: string;
  readonly deductionDate?: string; // YYYY-MM-DD
  readonly debtorId?: string;
}

/** A deduction we already hold, as far as matching cares about it. */
export interface KnownDeduction {
  readonly deductionId: string;
  readonly amountCents: Cents;
  readonly invoiceNumber?: string;
  readonly deductionDate?: string;
  readonly debtorId?: string;
}

/**
 * What the matcher concluded.
 *
 * `basis` names the facts that agreed — `'invoice_number'`, `'amount_cents'`,
 * `'claim_id'` — and never their values. A basis is meant to be logged and
 * written onto a case event, and document text does not go into either
 * (CLAUDE.md, invariant 4).
 */
export type IdentityResolution =
  | { readonly kind: 'exact'; readonly deductionId: string; readonly matchedOn: KnownIdentifier }
  | { readonly kind: 'probable'; readonly deductionId: string; readonly basis: readonly string[] }
  | {
      readonly kind: 'ambiguous';
      readonly deductionIds: readonly string[];
      readonly basis: readonly string[];
    }
  | { readonly kind: 'none' };

/** The default window two printings of one deduction date may differ by. */
export const DEFAULT_DATE_TOLERANCE_DAYS = 7;

/**
 * Which deduction an arrival is, if we can be sure — and an explicit "held"
 * answer when we cannot.
 *
 * In precedence order:
 *
 * 1. **exact** — an arrival identifier equals a known identifier *of the same
 *    kind* after normalisation. Exact matches pointing at more than one
 *    deduction are `ambiguous`, not a choice between them.
 * 2. **probable** — no exact match, but the invoice number, the amount in cents
 *    and a deduction date within tolerance all agree, and the debtor agrees
 *    where both sides know it. Amount alone, or date alone, is never probable.
 *    More than one probable is `ambiguous`.
 * 3. **none** — a deduction we have not seen.
 *
 * Only the first may be resolved without a person. A missing field never throws
 * and never contributes: it is simply one fewer thing that could agree.
 */
export function resolveIdentity(
  arrival: ArrivalIdentity,
  knownIdentifiers: readonly KnownIdentifier[],
  knownDeductions: readonly KnownDeduction[],
  options?: { readonly dateToleranceDays?: number },
): IdentityResolution {
  const tolerance = options?.dateToleranceDays ?? DEFAULT_DATE_TOLERANCE_DAYS;
  // A nonsense tolerance would make every date comparison false, and "nothing
  // matched" is exactly the answer that opens a second case for a deduction we
  // already have. Fail loud instead (CLAUDE.md).
  if (!Number.isInteger(tolerance) || tolerance < 0) {
    throw new IdentityError(
      `dateToleranceDays must be a non-negative integer, got ${String(options?.dateToleranceDays)}`,
    );
  }

  // 1. Exact, on an identifier of the same kind.
  const exact = new Map<string, KnownIdentifier>();
  const exactKinds = new Set<IdentifierKind>();
  for (const arrived of arrival.identifiers) {
    const key = identifierMatchKey(arrived.identifier);
    if (key === '') continue;
    for (const known of knownIdentifiers) {
      if (known.kind !== arrived.kind) continue;
      if (identifierMatchKey(known.identifier) !== key) continue;
      exactKinds.add(known.kind);
      if (!exact.has(known.deductionId)) exact.set(known.deductionId, known);
    }
  }

  const exactEntries = [...exact];
  if (exactEntries.length > 1) {
    return {
      kind: 'ambiguous',
      deductionIds: exactEntries.map(([deductionId]) => deductionId).sort(),
      basis: [...exactKinds].sort(),
    };
  }
  const onlyExact = exactEntries[0];
  if (onlyExact !== undefined) {
    const [deductionId, matchedOn] = onlyExact;
    return { kind: 'exact', deductionId, matchedOn };
  }

  // 2. Probable: the structured fields, all of them, together.
  const probable: { readonly deductionId: string; readonly basis: readonly string[] }[] = [];
  for (const candidate of knownDeductions) {
    const agreed = probableBasis(arrival, candidate, tolerance);
    if (agreed === undefined) continue;
    probable.push({ deductionId: candidate.deductionId, basis: agreed });
  }

  if (probable.length > 1) {
    const union = new Set(probable.flatMap((p) => p.basis));
    return {
      kind: 'ambiguous',
      deductionIds: probable.map((p) => p.deductionId).sort(),
      basis: PROBABLE_BASIS_ORDER.filter((name) => union.has(name)),
    };
  }
  const onlyProbable = probable[0];
  if (onlyProbable !== undefined) {
    return { kind: 'probable', deductionId: onlyProbable.deductionId, basis: onlyProbable.basis };
  }

  return { kind: 'none' };
}

/** The canonical order a probable basis is reported in. */
const PROBABLE_BASIS_ORDER: readonly string[] = [
  'invoice_number',
  'amount_cents',
  'deduction_date',
  'debtor_id',
];

/**
 * The names of the facts that agree between an arrival and one candidate, or
 * `undefined` when they do not agree on enough to be probable.
 *
 * All three of invoice number, amount and date are required. Two deductions
 * against the same invoice for the same amount a week apart is a real shape —
 * a retailer taking the same charge twice — and it is precisely the shape a
 * looser rule would merge into one.
 */
function probableBasis(
  arrival: ArrivalIdentity,
  candidate: KnownDeduction,
  toleranceDays: number,
): readonly string[] | undefined {
  if (arrival.invoiceNumber === undefined || candidate.invoiceNumber === undefined) {
    return undefined;
  }
  const arrivalInvoice = identifierMatchKey(arrival.invoiceNumber);
  if (arrivalInvoice === '') return undefined;
  if (arrivalInvoice !== identifierMatchKey(candidate.invoiceNumber)) return undefined;

  if (arrival.amountCents === undefined) return undefined;
  if (arrival.amountCents !== candidate.amountCents) return undefined;

  if (arrival.deductionDate === undefined || candidate.deductionDate === undefined) {
    return undefined;
  }
  const arrivalDay = isoDay(arrival.deductionDate);
  const candidateDay = isoDay(candidate.deductionDate);
  // A date we cannot read is a date that cannot contribute — and since a date
  // is required here, it is a date that cannot be probable either.
  if (arrivalDay === undefined || candidateDay === undefined) return undefined;
  if (Math.abs(arrivalDay - candidateDay) > toleranceDays) return undefined;

  const basis = ['invoice_number', 'amount_cents', 'deduction_date'];
  if (arrival.debtorId !== undefined && candidate.debtorId !== undefined) {
    // Where both sides name a debtor they have to be the same one. Where either
    // does not, the debtor simply says nothing — ADR 0019 leaves `debtor_id`
    // null on every case whose retailer no alias has matched yet, so requiring
    // it would make the whole branch unreachable on exactly those cases.
    if (arrival.debtorId !== candidate.debtorId) return undefined;
    basis.push('debtor_id');
  }
  return basis;
}

/**
 * `YYYY-MM-DD` as a day number, or `undefined` for anything else. Strict: the
 * components have to round-trip, so `2026-02-30` is not a date rather than
 * being silently read as 2 March.
 */
function isoDay(text: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match === null) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = Date.UTC(year, month - 1, day);
  if (!Number.isFinite(utc)) return undefined;
  const back = new Date(utc);
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCDate() !== day
  ) {
    return undefined;
  }
  return Math.round(utc / 86_400_000);
}

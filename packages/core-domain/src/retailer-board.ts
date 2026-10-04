/**
 * The case list's board: one group per payer — a retailer or a distributor —
 * with its figures and its cases.
 *
 * The database counts and sums per debtor and, for a case no debtor matched,
 * per name exactly as printed (`PostgresStore.retailerBoard`). What it does not
 * do is decide that two printed spellings are one name: that is
 * `retailerMatchKey`, which is written once, here in `core-domain`, and never a
 * second time in SQL (`retailers.ts`). So this file folds the database's rows
 * into the groups a person reads, and puts them in order. It is pure, and every
 * figure it returns is a sum of integer cents or of counts the database
 * produced; nothing is divided, and no rate is computed (ADR 0030: dollars,
 * never a blended rate).
 *
 * Three kinds of group, as the views have named a case's payer since ADR 0019:
 *
 *  - `matched`: a debtor a person created, when exactly one answered to the
 *    printed name. One group per debtor, whatever each notice printed.
 *  - `unmatched`: a name was printed and no debtor answers to it. Spellings
 *    that fold to one `retailerMatchKey` are one group; a name with nothing
 *    left after folding keeps a group of its own under its exact text, because
 *    an empty key is "no key", never a match (ADR 0019 §3).
 *  - `unknown`: nothing was read for a name at all.
 */

import { cents, sumCents } from './money';
import { retailerMatchKey } from './retailers';

/** How many of a group's cases the board lists before it says "N more". */
export const RETAILER_BOARD_CASES_PER_GROUP = 8;

export const PAYER_GROUP_KINDS = ['matched', 'unmatched', 'unknown'] as const;
export type PayerGroupKind = (typeof PAYER_GROUP_KINDS)[number];

/**
 * A payer's figures. Counts are of cases; money is integer cents (invariant 3).
 * A case merged into another is in none of them: it is not a deduction of its
 * own (ADR 0042).
 */
export interface PayerTotals {
  /** Not closed, and no decline names it. */
  readonly openCases: number;
  /** Finished: won, lost, partial or written off. */
  readonly closedCases: number;
  /** A decline names it. A decline moves no state (ADR 0043). */
  readonly declinedCases: number;
  /** Open and in `awaiting_approval`. */
  readonly awaitingApprovalCases: number;
  /** Deducted across the open cases. */
  readonly inDisputeCents: number;
  /** What came back on the closed cases, as each outcome was recorded. */
  readonly recoveredCents: number;
  /**
   * Won or partial cases whose outcome records no readable amount. They add
   * nothing to `recoveredCents`, and the board says how many there are rather
   * than letting the sum pass for complete.
   */
  readonly recoveredUnrecordedCases: number;
  /** What the declines on this payer's cases were recorded as worth. */
  readonly declinedCents: number;
  /** Open, not yet filed, and due within `DUE_SOON_DAYS` or past the deadline. */
  readonly atRiskCases: number;
  /** Deducted across those. */
  readonly atRiskCents: number;
  /** Days since the oldest open case was opened. Absent with no open case. */
  readonly oldestOpenDays?: number;
  /** Every case that is not closed: the ones the board can list. */
  readonly listableCases: number;
}

/** One of a group's cases, and where the database's order put it. */
export interface PlacedCase<C> {
  /**
   * The case's place in the database's one order over every listable case of
   * the tenant: the review queue's cases first and in its order, then the
   * filed and declined ones in the same order. Unique per case. Merging two
   * spellings' lists is a sort on this number, so there is no second ordering
   * rule to keep in step with `rankForReview`.
   */
  readonly position: number;
  readonly case: C;
}

/** What the database returns: one row per debtor, or per exact printed name. */
export interface RawPayerGroup<C> {
  readonly debtor?: { readonly id: string; readonly name: string };
  /** The name as printed, when the cases have no debtor and printed one. */
  readonly printedName?: string;
  /** Every case in the row, merged-away ones excepted. */
  readonly caseCount: number;
  readonly totals: PayerTotals;
  /** The first of the row's listable cases, in `position` order. */
  readonly cases: readonly PlacedCase<C>[];
}

export interface PayerGroup<C> {
  readonly kind: PayerGroupKind;
  /** Unique among the groups of one board; safe as an element id suffix. */
  readonly key: string;
  /** The debtor's name, or the printed spelling most cases carry. Absent when unknown. */
  readonly name?: string;
  readonly debtorId?: string;
  /**
   * Every spelling an unmatched group folds together, the one in `name` first.
   * Empty for a matched or unknown group.
   */
  readonly printedNames: readonly string[];
  readonly totals: PayerTotals;
  /** At most the limit, in the database's order. */
  readonly cases: readonly C[];
  /** How many listable cases `cases` leaves out. */
  readonly moreCases: number;
}

export class RetailerBoardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetailerBoardError';
  }
}

function count(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RetailerBoardError(`a count is a non-negative integer, not ${String(value)}`);
    }
    total += value;
  }
  if (!Number.isSafeInteger(total)) throw new RetailerBoardError('a count overflowed');
  return total;
}

function money(values: readonly number[]): number {
  return sumCents(values.map((value) => cents(value)));
}

function addTotals(rows: readonly PayerTotals[]): PayerTotals {
  const ages = rows
    .map((row) => row.oldestOpenDays)
    .filter((days): days is number => days !== undefined);
  for (const days of ages) {
    if (!Number.isSafeInteger(days)) {
      throw new RetailerBoardError(`an age is whole days, not ${String(days)}`);
    }
  }
  return {
    openCases: count(rows.map((row) => row.openCases)),
    closedCases: count(rows.map((row) => row.closedCases)),
    declinedCases: count(rows.map((row) => row.declinedCases)),
    awaitingApprovalCases: count(rows.map((row) => row.awaitingApprovalCases)),
    inDisputeCents: money(rows.map((row) => row.inDisputeCents)),
    recoveredCents: money(rows.map((row) => row.recoveredCents)),
    recoveredUnrecordedCases: count(rows.map((row) => row.recoveredUnrecordedCases)),
    declinedCents: money(rows.map((row) => row.declinedCents)),
    atRiskCases: count(rows.map((row) => row.atRiskCases)),
    atRiskCents: money(rows.map((row) => row.atRiskCents)),
    // The oldest of several is the largest age, not a sum.
    ...(ages.length > 0 ? { oldestOpenDays: Math.max(...ages) } : {}),
    listableCases: count(rows.map((row) => row.listableCases)),
  };
}

/** Plain code-unit order: the same answer on every machine, unlike a locale's. */
function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function groupKey(raw: RawPayerGroup<unknown>): { kind: PayerGroupKind; key: string } {
  if (raw.debtor !== undefined) return { kind: 'matched', key: `debtor:${raw.debtor.id}` };
  if (raw.printedName === undefined) return { kind: 'unknown', key: 'unknown' };
  const folded = retailerMatchKey(raw.printedName);
  return {
    kind: 'unmatched',
    key: folded === '' ? `printed-exact:${raw.printedName}` : `printed:${folded}`,
  };
}

const KIND_ORDER: Readonly<Record<PayerGroupKind, number>> = { matched: 0, unmatched: 1, unknown: 2 };

/**
 * The board's groups, in the order it shows them: matched payers by dollars in
 * dispute, largest first; then the unmatched names the same way; then the
 * cases with no name read. Ties go to the name, then the key, so the order
 * never depends on the order the rows arrived in.
 */
export function foldRetailerBoard<C>(
  rows: readonly RawPayerGroup<C>[],
  casesPerGroup: number = RETAILER_BOARD_CASES_PER_GROUP,
): readonly PayerGroup<C>[] {
  if (!Number.isInteger(casesPerGroup) || casesPerGroup < 0) {
    throw new RetailerBoardError(
      `a board lists a whole number of cases per payer, not ${String(casesPerGroup)}`,
    );
  }
  const gathered = new Map<string, { kind: PayerGroupKind; rows: RawPayerGroup<C>[] }>();
  for (const row of rows) {
    const { kind, key } = groupKey(row);
    const group = gathered.get(key);
    if (group === undefined) gathered.set(key, { kind, rows: [row] });
    else if (kind === 'unmatched') group.rows.push(row);
    // The database returns one row per debtor and one for no name at all; a
    // second would be the same cases counted again.
    else throw new RetailerBoardError(`two rows for one payer group (${kind})`);
  }

  const groups: PayerGroup<C>[] = [];
  for (const [key, { kind, rows: members }] of gathered) {
    // The spelling most cases carry names an unmatched group; ties to the text.
    const spellings = [...members].sort(
      (a, b) => b.caseCount - a.caseCount || byText(a.printedName ?? '', b.printedName ?? ''),
    );
    const first = spellings[0] as RawPayerGroup<C>;
    const name = first.debtor?.name ?? first.printedName;
    const totals = addTotals(members.map((member) => member.totals));
    const placed = members
      .flatMap((member) => member.cases)
      .sort((a, b) => a.position - b.position);
    const cases = placed.slice(0, casesPerGroup).map((entry) => entry.case);
    groups.push({
      kind,
      key,
      ...(name !== undefined ? { name } : {}),
      ...(first.debtor !== undefined ? { debtorId: first.debtor.id } : {}),
      printedNames:
        kind === 'unmatched' ? spellings.map((member) => member.printedName as string) : [],
      totals,
      cases,
      moreCases: Math.max(0, totals.listableCases - cases.length),
    });
  }

  return groups.sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      b.totals.inDisputeCents - a.totals.inDisputeCents ||
      byText(a.name ?? '', b.name ?? '') ||
      byText(a.key, b.key),
  );
}

/**
 * The board's figures over every group: what the page says above the groups.
 * Dollars and counts only.
 */
export function retailerBoardTotals(groups: readonly PayerGroup<unknown>[]): PayerTotals {
  return addTotals(groups.map((group) => group.totals));
}

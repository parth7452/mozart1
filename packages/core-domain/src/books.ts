/**
 * A customer's books as an accountant reads them (ADR 0066): the chart of
 * accounts, a trial balance and the general ledger, as rows — and the two pure
 * questions the Books page asks of them.
 *
 * Domain value objects, like `ledger.ts`'s: no vendor's wire format, money in
 * integer cents (invariant 3), dates as ISO `YYYY-MM-DD`. The port that fetches
 * them is `AccountingSource`, one layer out, which re-exports every name here.
 *
 * **Read through, never stored.** Nothing here is persisted and nothing here
 * writes: a snapshot table is ADR 0066's proposal, not this file's. So every
 * figure a page shows from these rows is what the ledger answered in that
 * request, and says so.
 *
 * The two questions:
 *
 * - `booksAccountRoles` — which accounts are the receivable, the accounts our
 *   own account map posts to, and the ones that *look* like deductions or
 *   allowance accounts. The last is a heuristic and is written out as data
 *   below (`DEDUCTION_ACCOUNT_SUBTYPES`, `DEDUCTION_ACCOUNT_NAME_WORDS`) so a
 *   person can read exactly what it guesses by.
 * - `reconcileDeductions` — the ledger's lines on those accounts beside our
 *   cases. **Only an exact match is asserted**: the same cents on the same
 *   day, one line to one case. Anything less is a candidate a person looks at,
 *   never a match (ADR 0025's asymmetry: a wrong pairing hides a deduction, a
 *   missed one is still on the page).
 */

import { addCents, cents, subCents, type Cents } from './money';
import type { AccountingSourceKind, LedgerWindow } from './ledger';

/** One account of the chart, as the ledger has it. */
export interface LedgerAccount {
  readonly sourceKind: AccountingSourceKind;
  /** The ledger's own id for the account. */
  readonly externalId: string;
  /** The account code an accountant assigned (QBO `AcctNum`). Many charts have none. */
  readonly code?: string;
  /** The account's own name: for a sub-account, its last segment only. */
  readonly name: string;
  /** `Parent:Child` for a sub-account; the name itself for a top-level one. */
  readonly fullyQualifiedName: string;
  /** The ledger's account type, verbatim (QBO `AccountType`). */
  readonly accountType: string;
  /** The detail type, verbatim (QBO `AccountSubType`). */
  readonly accountSubType?: string;
  /** Asset, Liability, Equity, Revenue or Expense, verbatim (QBO `Classification`). */
  readonly classification?: string;
  readonly active: boolean;
  /** The ledger's own running balance for the account, when it reports one. */
  readonly currentBalanceCents?: Cents;
}

/** One account's row of a trial balance. A blank side is zero. */
export interface TrialBalanceLine {
  /** Absent when the ledger printed a row with no account id. */
  readonly accountExternalId?: string;
  readonly accountName: string;
  readonly debitCents: Cents;
  readonly creditCents: Cents;
}

/**
 * A trial balance as of one day.
 *
 * `totalDebitCents` and `totalCreditCents` are the ledger's own totals row, and
 * an adapter returns a trial balance only when the lines it read add up to
 * them: a row dropped in parsing is a refused read, not a smaller report.
 * Whether debits equal credits is **not** checked there — a ledger that does
 * not balance is a fact a page shows (`trialBalanceDifferenceCents`), never a
 * reason to show nothing.
 */
export interface TrialBalance {
  readonly sourceKind: AccountingSourceKind;
  readonly asOf: string;
  /** The first day of the period the ledger reported, when it said. */
  readonly periodStart?: string;
  /** `Accrual` or `Cash`, as the ledger reported it. */
  readonly basis?: string;
  readonly currency?: string;
  readonly lines: readonly TrialBalanceLine[];
  readonly totalDebitCents: Cents;
  readonly totalCreditCents: Cents;
}

/** Debits less credits. Zero is a ledger that balances. */
export function trialBalanceDifferenceCents(trialBalance: TrialBalance): Cents {
  return subCents(trialBalance.totalDebitCents, trialBalance.totalCreditCents);
}

/** One posting to one account. A blank side is zero. */
export interface GeneralLedgerLine {
  /** Absent when neither the section nor the row named an account id. */
  readonly accountExternalId?: string;
  readonly accountName: string;
  readonly date: string;
  /** `Invoice`, `Payment`, `Journal Entry`… verbatim. */
  readonly transactionType?: string;
  /** The ledger's id for the transaction the line belongs to. */
  readonly transactionExternalId?: string;
  readonly documentNumber?: string;
  /** The customer, vendor or other name on the line, verbatim. */
  readonly name?: string;
  readonly memo?: string;
  readonly debitCents: Cents;
  readonly creditCents: Cents;
  /** The account's running balance after the line, when the ledger printed one. */
  readonly balanceCents?: Cents;
}

/** One account's part of a general ledger: its lines, in the ledger's order. */
export interface GeneralLedgerAccount {
  readonly accountExternalId?: string;
  readonly accountName: string;
  /** The balance brought forward into the window, when the ledger printed one. */
  readonly beginningBalanceCents?: Cents;
  readonly lines: readonly GeneralLedgerLine[];
}

export interface GeneralLedger {
  readonly sourceKind: AccountingSourceKind;
  readonly window: LedgerWindow;
  readonly basis?: string;
  readonly currency?: string;
  /** One entry per account the ledger printed a section for, in its order. */
  readonly accounts: readonly GeneralLedgerAccount[];
}

export interface GeneralLedgerOptions {
  /** Only these accounts. Absent means every account; empty reads nothing. */
  readonly accountIds?: readonly string[];
}

/**
 * The longest window a general ledger is read over, in days, both ends
 * counted. Intuit's guidance for its Reports API is about six months a request
 * and a report past its cell limit comes back cut short; an adapter refuses a
 * longer window before it asks, and a page says so.
 */
export const GENERAL_LEDGER_MAX_WINDOW_DAYS = 186;

/**
 * The most lines one general-ledger read returns. A report with more is
 * refused whole (an adapter's "too large" error), never returned in part: a
 * ledger read in part would show an account as quieter than it is.
 */
export const GENERAL_LEDGER_MAX_LINES = 20_000;

/** How many days `window` covers, both ends counted. */
export function windowDays(window: LedgerWindow): number {
  return dayNumber(window.to) - dayNumber(window.from) + 1;
}

// --- which accounts ------------------------------------------------------------

/**
 * What an account is to the Books page.
 *
 * - `receivable` — the ledger's accounts receivable.
 * - `posting` — an account this workspace's account map posts deductions to.
 * - `deductions` — an account that looks like a deductions or allowance
 *   account, by the heuristic below. A guess, and labelled as one.
 */
export type BooksAccountRole = 'receivable' | 'posting' | 'deductions';

/** The account type that makes an account `receivable`, as QuickBooks names it. */
export const RECEIVABLE_ACCOUNT_TYPE = 'Accounts Receivable';

/**
 * Detail types that mark a deductions or allowance account (QuickBooks'
 * `AccountSubType`): discounts and refunds given to customers, and the
 * allowance for bad debts.
 */
export const DEDUCTION_ACCOUNT_SUBTYPES: readonly string[] = Object.freeze([
  'DiscountsRefundsGiven',
  'AllowanceForBadDebts',
]);

/**
 * Words that mark a deductions or allowance account when its full name
 * contains one, in any case. Each is matched from the start of a word, so
 * `promo` finds "Promotional Allowances" and not "Compromise".
 */
export const DEDUCTION_ACCOUNT_NAME_WORDS: readonly string[] = Object.freeze([
  'deduction',
  'chargeback',
  'charge back',
  'charge-back',
  'allowance',
  'short pay',
  'short-pay',
  'shortpay',
  'billback',
  'bill back',
  'bill-back',
  'trade spend',
  'promo',
]);

/** Whether an account looks like a deductions or allowance account. */
export function looksLikeDeductionsAccount(account: LedgerAccount): boolean {
  if (
    account.accountSubType !== undefined &&
    DEDUCTION_ACCOUNT_SUBTYPES.includes(account.accountSubType)
  ) {
    return true;
  }
  const name = account.fullyQualifiedName.toLowerCase();
  return DEDUCTION_ACCOUNT_NAME_WORDS.some((word) => startsAWord(name, word));
}

function startsAWord(text: string, word: string): boolean {
  for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + 1)) {
    const before = at === 0 ? '' : (text[at - 1] as string);
    if (!/[a-z0-9]/.test(before)) return true;
  }
  return false;
}

/**
 * Each account's roles, by id; an account with none is absent.
 *
 * `postingAccountIds` are the accounts the workspace's account map names for
 * deductions held and written off — data a person saved, not a guess. An
 * account receivable is never also `deductions`: every invoice and payment
 * passes through it, so its name matching a word says nothing.
 */
export function booksAccountRoles(
  chart: readonly LedgerAccount[],
  postingAccountIds: readonly string[],
): ReadonlyMap<string, readonly BooksAccountRole[]> {
  const posting = new Set(postingAccountIds);
  const roles = new Map<string, readonly BooksAccountRole[]>();
  for (const account of chart) {
    const receivable = account.accountType === RECEIVABLE_ACCOUNT_TYPE;
    const found: BooksAccountRole[] = [];
    if (receivable) found.push('receivable');
    if (posting.has(account.externalId)) found.push('posting');
    if (!receivable && looksLikeDeductionsAccount(account)) found.push('deductions');
    if (found.length > 0) roles.set(account.externalId, found);
  }
  return roles;
}

// --- the reconciliation ----------------------------------------------------------

/** One of our cases, as the reconciliation reads it. */
export interface BooksCase {
  readonly caseId: string;
  readonly claimId?: string;
  readonly amountCents: Cents;
  /** The payer as a person would recognise it. Shown, never matched on. */
  readonly payerName?: string;
  /** The deduction's date. Absent when no document printed one. */
  readonly date?: string;
}

/**
 * How far apart, in days, a line and a case of the same amount may be dated
 * and still be listed as candidates for one another. A candidate is something
 * to look at; it asserts nothing.
 */
export const RECONCILIATION_CANDIDATE_DAYS = 7;

export type ReconciliationRow =
  | {
      readonly kind: 'matched';
      readonly line: GeneralLedgerLine;
      readonly amountCents: Cents;
      readonly case: BooksCase;
    }
  | {
      readonly kind: 'books_only';
      readonly line: GeneralLedgerLine;
      readonly amountCents: Cents;
      /** Cases of the same amount, dated close by or not at all. Never asserted. */
      readonly candidates: readonly BooksCase[];
    }
  | {
      readonly kind: 'case_only';
      readonly case: BooksCase;
      /** Lines of the same amount, dated close by. Never asserted. */
      readonly candidates: readonly GeneralLedgerLine[];
    };

/** What a ledger line moved, whichever side it is on: `|debit − credit|`. */
export function lineAmountCents(line: GeneralLedgerLine): Cents {
  const net = subCents(line.debitCents, line.creditCents);
  return net < 0 ? cents(-net) : net;
}

/**
 * The ledger's lines on the deductions accounts beside our cases.
 *
 * A line and a case are `matched` only when their amounts are equal to the
 * cent, their dates are the same day, and neither has another partner on that
 * amount and day — one to one. Two lines of $500.00 on one day against one
 * case is not a match for either: which line is the case's is not something
 * arithmetic says. Everything else is `books_only` or `case_only`, each with
 * its candidates: the same cents within `RECONCILIATION_CANDIDATE_DAYS`, or a
 * case with no date at all.
 *
 * The payer's name is carried for a person to read and never compared: a
 * ledger's customer name and a notice's printed payer are spelled by different
 * people. A line that moved nothing (debit equals credit) matches nothing.
 *
 * Pure, and its answer does not depend on the order of either list: matched
 * rows first, then the ledger's lines with no case, then the cases not in the
 * ledger, each by date, amount and id.
 */
export function reconcileDeductions(
  lines: readonly GeneralLedgerLine[],
  cases: readonly BooksCase[],
): readonly ReconciliationRow[] {
  const keyOf = (amount: Cents, date: string): string => `${amount}|${date}`;

  const linesByKey = new Map<string, GeneralLedgerLine[]>();
  for (const line of lines) {
    const amount = lineAmountCents(line);
    if (amount === 0) continue;
    const key = keyOf(amount, line.date);
    linesByKey.set(key, [...(linesByKey.get(key) ?? []), line]);
  }
  const casesByKey = new Map<string, BooksCase[]>();
  for (const one of cases) {
    if (one.date === undefined) continue;
    const key = keyOf(one.amountCents, one.date);
    casesByKey.set(key, [...(casesByKey.get(key) ?? []), one]);
  }

  const matchedLines = new Set<GeneralLedgerLine>();
  const matchedCases = new Set<BooksCase>();
  const matched: ReconciliationRow[] = [];
  for (const [key, keyLines] of linesByKey) {
    const keyCases = casesByKey.get(key) ?? [];
    const [line] = keyLines;
    const [one] = keyCases;
    if (keyLines.length !== 1 || keyCases.length !== 1 || line === undefined || one === undefined) {
      continue;
    }
    matchedLines.add(line);
    matchedCases.add(one);
    matched.push({ kind: 'matched', line, amountCents: lineAmountCents(line), case: one });
  }

  const near = (lineDate: string, caseDate: string | undefined): boolean =>
    caseDate === undefined ||
    Math.abs(dayNumber(lineDate) - dayNumber(caseDate)) <= RECONCILIATION_CANDIDATE_DAYS;

  const openCases = cases.filter((one) => !matchedCases.has(one));
  const openLines = lines.filter((line) => !matchedLines.has(line));

  const booksOnly: ReconciliationRow[] = openLines.map((line) => {
    const amountCents = lineAmountCents(line);
    return {
      kind: 'books_only',
      line,
      amountCents,
      candidates:
        amountCents === 0
          ? []
          : openCases
              .filter((one) => one.amountCents === amountCents && near(line.date, one.date))
              .sort(byCase),
    };
  });
  const caseOnly: ReconciliationRow[] = openCases.map((one) => ({
    kind: 'case_only',
    case: one,
    candidates: openLines
      .filter((line) => lineAmountCents(line) === one.amountCents && near(line.date, one.date))
      .sort(byLine),
  }));

  return [
    ...matched.sort((a, b) =>
      a.kind === 'matched' && b.kind === 'matched' ? byLine(a.line, b.line) : 0,
    ),
    ...booksOnly.sort((a, b) =>
      a.kind === 'books_only' && b.kind === 'books_only' ? byLine(a.line, b.line) : 0,
    ),
    ...caseOnly.sort((a, b) =>
      a.kind === 'case_only' && b.kind === 'case_only' ? byCase(a.case, b.case) : 0,
    ),
  ];
}

/** The sum of the lines' amounts, for a view's footer. */
export function totalLineAmountCents(lines: readonly GeneralLedgerLine[]): Cents {
  return lines.reduce<Cents>((total, line) => addCents(total, lineAmountCents(line)), cents(0));
}

function byLine(a: GeneralLedgerLine, b: GeneralLedgerLine): number {
  return (
    compareText(a.date, b.date) ||
    lineAmountCents(a) - lineAmountCents(b) ||
    compareText(a.accountExternalId ?? '', b.accountExternalId ?? '') ||
    compareText(a.transactionExternalId ?? '', b.transactionExternalId ?? '') ||
    compareText(a.documentNumber ?? '', b.documentNumber ?? '')
  );
}

function byCase(a: BooksCase, b: BooksCase): number {
  return (
    compareText(a.date ?? '', b.date ?? '') ||
    a.amountCents - b.amountCents ||
    compareText(a.caseId, b.caseId)
  );
}

/** Code-unit order: the same answer on every machine, whatever its locale. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A `YYYY-MM-DD` day as a count of days, for differences. Refuses anything else. */
function dayNumber(iso: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (match === null) throw new RangeError('a books date is YYYY-MM-DD');
  const [, year, month, day] = match;
  return Math.round(Date.UTC(Number(year), Number(month) - 1, Number(day)) / 86_400_000);
}

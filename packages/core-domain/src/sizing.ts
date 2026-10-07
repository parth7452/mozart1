/**
 * How big a company's deductions are beside its sales (ADR 0073): the one
 * pure question the Books page's sizing card asks of a profit and loss and a
 * chart of accounts, at onboarding, before a single case exists.
 *
 * **Read through, never stored**, like everything else in `books.ts`: the
 * profit and loss is what the ledger answered in the request, and the figures
 * here are arithmetic over it in integer cents (invariant 3). The rate is
 * basis points computed in BigInt and rounded half up once, at the end — no
 * float is ever formed, so two machines print the same percentage.
 *
 * Which accounts are "deductions" is `looksLikeDeductionsAccount`'s guess, the
 * same one the chart and the ledger on the page are marked by, and an account
 * receivable is never one (`booksAccountRoles`' rule). Which side of the
 * income statement an account is on is the chart's own `classification`,
 * never its name: the chart is what the ledger says the account *is*. The
 * section heading decides one thing only: a Revenue line counts as a sale
 * only when it is printed under `Income`. Other income — interest, a gain on
 * selling an asset — is not a sale, and counting it would inflate the
 * denominator and understate the rate.
 */

import { addCents, cents, type Cents } from './money';
import type { AccountingSourceKind, LedgerWindow } from './ledger';
import {
  RECEIVABLE_ACCOUNT_TYPE,
  looksLikeDeductionsAccount,
  type LedgerAccount,
} from './books';

/** One account's amount on a profit and loss, as the ledger printed it. */
export interface ProfitAndLossLine {
  /** Absent when the ledger printed a row with no account id. */
  readonly accountExternalId?: string;
  readonly accountName: string;
  /**
   * The top-level section the row was printed under, verbatim (QBO's group:
   * `Income`, `COGS`, `Expenses`, `OtherIncome`, `OtherExpenses`). Never used
   * to decide which side an account is on — the chart decides that — but a
   * Revenue line is a sale only under `Income` (`SALES_SECTION`).
   */
  readonly section: string;
  /** In the section's natural sign: income positive, a contra-income account negative. */
  readonly amountCents: Cents;
}

/**
 * A profit and loss over an inclusive window, one total column.
 *
 * An adapter returns one only when every line it read adds up to every total
 * the report printed: a row dropped in parsing is a refused read, never a
 * smaller company.
 */
export interface ProfitAndLoss {
  readonly sourceKind: AccountingSourceKind;
  readonly window: LedgerWindow;
  /** `Accrual` or `Cash`, as the ledger reported it. */
  readonly basis?: string;
  readonly currency?: string;
  readonly lines: readonly ProfitAndLossLine[];
}

/**
 * The sizing window, in days, both ends counted: a trailing year. Also the
 * longest window a profit and loss is read over — an adapter refuses a longer
 * one before it asks.
 */
export const SIZING_WINDOW_DAYS = 365;

/** The chart's classifications this card reads, verbatim (QBO `Classification`). */
export const REVENUE_CLASSIFICATION = 'Revenue';
export const EXPENSE_CLASSIFICATION = 'Expense';
const BALANCE_SHEET_CLASSIFICATIONS: readonly string[] = Object.freeze(['Asset', 'Liability']);

/** The profit and loss section whose Revenue lines are sales; any other is other income. */
export const SALES_SECTION = 'Income';

/** The detail type of QuickBooks' Undeposited Funds account. */
export const UNDEPOSITED_FUNDS_SUBTYPE = 'UndepositedFunds';

/** The trailing year ending on `today` (a UTC `YYYY-MM-DD`): `today − 364` to `today`. */
export function sizingWindow(today: string): LedgerWindow {
  const day = dayNumber(today);
  return { from: isoOf(day - (SIZING_WINDOW_DAYS - 1)), to: today };
}

/** One deductions-like account's amount on the profit and loss. */
export interface SizingContribution {
  readonly account: LedgerAccount;
  readonly side: 'revenue' | 'expense';
  /** The sum of the account's lines, in the profit and loss's own sign. */
  readonly amountCents: Cents;
}

/** An account's current balance; absent when the ledger reported none — never zero. */
export interface SizingBalance {
  readonly account: LedgerAccount;
  readonly balanceCents?: Cents;
}

/** Why a profit and loss line counted towards nothing. */
export type UnmatchedReason =
  /** The ledger printed the row with no account id. */
  | 'no_account_id'
  /** The id is not an account in the chart read. */
  | 'not_in_chart'
  /** The account is in the chart and is classified neither Revenue nor Expense. */
  | 'not_revenue_or_expense';

export interface UnmatchedLine {
  readonly line: ProfitAndLossLine;
  readonly reason: UnmatchedReason;
}

export interface DeductionsSizing {
  readonly window: LedgerWindow;
  readonly basis?: string;
  readonly currency?: string;
  /** Revenue-classified accounts that do not look like deductions, printed under `Income`. */
  readonly grossSalesCents: Cents;
  /**
   * Revenue-classified accounts that do not look like deductions, printed
   * anywhere but `Income` — other income. Shown, and never in the rate.
   */
  readonly otherIncomeCents: Cents;
  /** Revenue-classified deductions-like accounts, signed: usually negative. */
  readonly revenueDeductionsCents: Cents;
  /** Expense-classified deductions-like accounts, signed: usually positive. */
  readonly expenseDeductionsCents: Cents;
  /** `|revenueDeductionsCents| + |expenseDeductionsCents|`. */
  readonly deductionsCents: Cents;
  /**
   * `deductionsCents ÷ grossSalesCents` in basis points, half up to 1 bp, or
   * `null` when gross sales are zero or less — a rate over no sales is not a
   * number, and is never shown as one.
   */
  readonly bps: bigint | null;
  /** Each deductions-like account the profit and loss printed, once, by side then name. */
  readonly contributions: readonly SizingContribution[];
  /** Lines that counted towards nothing, with why. Shown, never dropped. */
  readonly unmatchedLines: readonly UnmatchedLine[];
  readonly balances: {
    /** Every account receivable, in chart order. */
    readonly receivable: readonly SizingBalance[];
    /** Their sum — only when every one reported a balance; absent otherwise. */
    readonly receivableTotalCents?: Cents;
    readonly undepositedFunds: readonly SizingBalance[];
    /**
     * Balance-sheet accounts that look like deductions or that the account
     * map posts to (its Deductions Receivable), each once, in chart order.
     */
    readonly deductions: readonly (SizingBalance & { readonly posting: boolean })[];
  };
}

/**
 * The sizing card's figures.
 *
 * Every line of the profit and loss is joined to the chart by account id. A
 * Revenue account that does not look like deductions is gross sales when the
 * line is printed under `Income`, and other income (never in the rate)
 * anywhere else; a Revenue account that does look like deductions is a
 * deduction booked against revenue wherever it is printed; an Expense account that does is
 * a deduction booked as expense; any other Expense account is outside this
 * card. A line with no id, an id the chart does not have, or an account of
 * another classification is listed in `unmatchedLines` — never silently
 * dropped, because a sales figure missing a row reads exactly like a smaller
 * company.
 *
 * The rate is `(|deductions against revenue| + |deductions as expense|) ×
 * 10,000 ÷ gross sales`, exact in BigInt and rounded half up once.
 * `postingAccountIds` are the account map's posting accounts; those on the
 * balance sheet are listed with their balances. Pure, and the order of the
 * lines does not change any figure.
 */
export function deductionsSizing(
  chart: readonly LedgerAccount[],
  pnl: ProfitAndLoss,
  postingAccountIds: readonly string[] = [],
): DeductionsSizing {
  const byId = new Map(chart.map((account) => [account.externalId, account]));
  let grossSalesCents = cents(0);
  let otherIncomeCents = cents(0);
  let revenueDeductionsCents = cents(0);
  let expenseDeductionsCents = cents(0);
  const perAccount = new Map<string, { account: LedgerAccount; side: 'revenue' | 'expense'; amountCents: Cents }>();
  const unmatchedLines: UnmatchedLine[] = [];

  for (const line of pnl.lines) {
    if (line.accountExternalId === undefined) {
      unmatchedLines.push({ line, reason: 'no_account_id' });
      continue;
    }
    const account = byId.get(line.accountExternalId);
    if (account === undefined) {
      unmatchedLines.push({ line, reason: 'not_in_chart' });
      continue;
    }
    const side =
      account.classification === REVENUE_CLASSIFICATION
        ? 'revenue'
        : account.classification === EXPENSE_CLASSIFICATION
          ? 'expense'
          : undefined;
    if (side === undefined) {
      unmatchedLines.push({ line, reason: 'not_revenue_or_expense' });
      continue;
    }
    if (!isDeductions(account)) {
      if (side === 'revenue') {
        if (line.section === SALES_SECTION) {
          grossSalesCents = addCents(grossSalesCents, line.amountCents);
        } else {
          otherIncomeCents = addCents(otherIncomeCents, line.amountCents);
        }
      }
      continue;
    }
    if (side === 'revenue') {
      revenueDeductionsCents = addCents(revenueDeductionsCents, line.amountCents);
    } else {
      expenseDeductionsCents = addCents(expenseDeductionsCents, line.amountCents);
    }
    const seen = perAccount.get(account.externalId);
    perAccount.set(account.externalId, {
      account,
      side,
      amountCents: addCents(seen?.amountCents ?? cents(0), line.amountCents),
    });
  }

  const deductionsCents = addCents(abs(revenueDeductionsCents), abs(expenseDeductionsCents));
  const contributions = [...perAccount.values()].sort(
    (a, b) =>
      (a.side === b.side ? 0 : a.side === 'revenue' ? -1 : 1) ||
      compareText(a.account.fullyQualifiedName, b.account.fullyQualifiedName) ||
      compareText(a.account.externalId, b.account.externalId),
  );

  const posting = new Set(postingAccountIds);
  const balanceOf = (account: LedgerAccount): SizingBalance => ({
    account,
    ...(account.currentBalanceCents === undefined
      ? {}
      : { balanceCents: account.currentBalanceCents }),
  });
  const receivable = chart.filter(isReceivable).map(balanceOf);
  const receivableTotalCents = receivable.every((one) => one.balanceCents !== undefined)
    ? receivable.reduce<Cents>((total, one) => addCents(total, one.balanceCents ?? cents(0)), cents(0))
    : undefined;
  const undepositedFunds = chart
    .filter((account) => account.accountSubType === UNDEPOSITED_FUNDS_SUBTYPE)
    .map(balanceOf);
  const deductions = chart
    .filter(
      (account) =>
        !isReceivable(account) &&
        account.accountSubType !== UNDEPOSITED_FUNDS_SUBTYPE &&
        account.classification !== undefined &&
        BALANCE_SHEET_CLASSIFICATIONS.includes(account.classification) &&
        (posting.has(account.externalId) || looksLikeDeductionsAccount(account)),
    )
    .map((account) => ({ ...balanceOf(account), posting: posting.has(account.externalId) }));

  return {
    window: pnl.window,
    ...(pnl.basis === undefined ? {} : { basis: pnl.basis }),
    ...(pnl.currency === undefined ? {} : { currency: pnl.currency }),
    grossSalesCents,
    otherIncomeCents,
    revenueDeductionsCents,
    expenseDeductionsCents,
    deductionsCents,
    bps: grossSalesCents > 0 ? rateBps(deductionsCents, grossSalesCents) : null,
    contributions,
    unmatchedLines,
    balances: {
      receivable,
      ...(receivableTotalCents === undefined || receivable.length === 0
        ? {}
        : { receivableTotalCents }),
      undepositedFunds,
      deductions,
    },
  };
}

/**
 * `part × 10,000 ÷ whole`, half up to one basis point, exactly. `whole` must
 * be positive and `part` not negative; anything else is a caller's error.
 */
export function rateBps(part: Cents, whole: Cents): bigint {
  if (whole <= 0) throw new RangeError('a rate is taken over a positive whole');
  if (part < 0) throw new RangeError('a rate is taken of an amount that is not negative');
  const numerator = BigInt(part) * 10_000n;
  const denominator = BigInt(whole);
  return (numerator * 2n + denominator) / (denominator * 2n);
}

/** Basis points as a percentage to two places: `642n` is `6.42%`. Text only, no float. */
export function formatBps(value: bigint): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const whole = magnitude / 100n;
  const fraction = (magnitude % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole.toLocaleString('en-US')}.${fraction}%`;
}

function isReceivable(account: LedgerAccount): boolean {
  return account.accountType === RECEIVABLE_ACCOUNT_TYPE;
}

/** `booksAccountRoles`' rule: a receivable is never a deductions account. */
function isDeductions(account: LedgerAccount): boolean {
  return !isReceivable(account) && looksLikeDeductionsAccount(account);
}

function abs(amount: Cents): Cents {
  return amount < 0 ? cents(-amount) : amount;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function dayNumber(iso: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (match === null) throw new RangeError('a sizing date is YYYY-MM-DD');
  const [, year, month, day] = match;
  return Math.round(Date.UTC(Number(year), Number(month) - 1, Number(day)) / 86_400_000);
}

function isoOf(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

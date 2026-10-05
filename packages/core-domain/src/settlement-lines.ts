/**
 * The journal lines a settlement decision carries (ADR 0068): the shape a
 * person may edit before a second person approves, the rule an edited set must
 * pass, and what differs from the computed set.
 *
 * Pure. Nothing here reads a clock, a database or an accounting system: the
 * chart of accounts is handed in by whoever read it, and every amount is
 * integer cents (invariant 3). A memo is text a person typed on the prepare
 * form — never text off a document (invariant 4) — and this file only bounds
 * it.
 */

import { cents, sumCents, type Cents } from './money';
import { JournalInputError, type AccountRole, type DraftEntry, type JournalStage } from './journal';
import type { ReasonFamily } from './reason-codes';

/** An entry has a debit and a credit at least, and no more lines than a page holds. */
export const SETTLEMENT_MIN_LINES = 2;
export const SETTLEMENT_MAX_LINES = 20;
/** The founder's to change (ADR 0068, decision 2). Migration 0041's check agrees. */
export const SETTLEMENT_MEMO_MAX_LENGTH = 500;

/** One journal line: an account, one side, and what a person typed about it. */
export interface SettlementLine {
  /** 1-based, in the order the entry is posted. */
  readonly lineNo: number;
  /** The ledger's own id for the account. */
  readonly accountExternalId: string;
  readonly debitCents: Cents;
  readonly creditCents: Cents;
  readonly memo: string | undefined;
}

/** A line as it is stored: with the account's name and type as the chart reported them. */
export interface StoredSettlementLine extends SettlementLine {
  readonly accountNameAsReported: string;
  readonly accountTypeAsReported: string;
}

/** What a form or a caller hands in: no line number (order is the number). */
export interface SettlementLineInput {
  readonly accountExternalId: string;
  readonly debitCents: number;
  readonly creditCents: number;
  readonly memo?: string | undefined;
}

/** One account of a chart, as the accounting system reports it. */
export interface SettlementChartAccount {
  readonly externalId: string;
  readonly name: string;
  /** The ledger's account type, verbatim. */
  readonly accountType: string;
  readonly active: boolean;
}

/** The account ids a tenant's map names: `LedgerAccountMap`'s shape. */
export interface SettlementAccountIds {
  readonly arAccountId: string;
  readonly deductionsReceivableAccountId: string;
  readonly writeoffByFamily: Readonly<Record<ReasonFamily, string>>;
  readonly unclassifiedWriteoff: string;
}

/**
 * Which accounts an edited line may use (ADR 0068 §4). Account types are the
 * ledger's own words, so the caller that knows the ledger supplies them.
 */
export interface SettlementAccountPolicy {
  /** The map's receivable account: its lines are the case's, not the editor's. */
  readonly receivableAccountId: string;
  /** The types that mean "a receivable": only `receivableAccountId` may have one. */
  readonly receivableAccountTypes: readonly string[];
  /** Types no line may be on at all. */
  readonly refusedAccountTypes: readonly string[];
}

export const SETTLEMENT_LINE_PROBLEMS = [
  'too_few_lines',
  'too_many_lines',
  'not_integer_cents',
  'both_sides',
  'no_side',
  'account_missing',
  'account_unknown',
  'account_inactive',
  'account_type_refused',
  'receivable_changed',
  'memo_too_long',
  'memo_control_character',
  'unbalanced',
  'moves_more_than_computed',
] as const;
export type SettlementLineProblemCode = (typeof SETTLEMENT_LINE_PROBLEMS)[number];

/** A refusal: a code from a closed set and, where one line is at fault, its number. */
export interface SettlementLineProblem {
  readonly code: SettlementLineProblemCode;
  readonly lineNo?: number;
}

export type SettlementLinesVerdict =
  | { readonly ok: true; readonly lines: readonly StoredSettlementLine[] }
  | { readonly ok: false; readonly problems: readonly SettlementLineProblem[] };

/** The stages a settlement entry carries (ADR 0060 §1). */
export function settlementEntryStages(includeFound: boolean): readonly JournalStage[] {
  return includeFound ? ['found', 'recovered', 'written_off'] : ['recovered', 'written_off'];
}

function accountFor(
  role: AccountRole,
  family: ReasonFamily | undefined,
  accounts: SettlementAccountIds,
): string {
  switch (role) {
    // The draft's `Dr Cash` becomes `Dr AR`: we never debit a cash account.
    case 'accounts_receivable':
    case 'cash':
      return accounts.arAccountId;
    case 'deductions_receivable':
      return accounts.deductionsReceivableAccountId;
    case 'writeoff_expense':
      return family === undefined ? accounts.unclassifiedWriteoff : accounts.writeoffByFamily[family];
  }
}

/**
 * The computed settlement entry in the editable shape: `draftEntries` output,
 * the stages a settlement posts, and the tenant's account ids. Line for line
 * what the posting has always sent (`entryLines` in `@recouple/qbo`; a test
 * there holds the two to one answer). No memo: a memo is a person's.
 */
export function settlementLinesFrom(
  entries: readonly DraftEntry[],
  accounts: SettlementAccountIds,
  options: { readonly includeFound: boolean },
): readonly SettlementLine[] {
  const stages = settlementEntryStages(options.includeFound);
  const lines: SettlementLine[] = [];
  const push = (accountExternalId: string, debit: Cents, credit: Cents): void => {
    lines.push({
      lineNo: lines.length + 1,
      accountExternalId,
      debitCents: debit,
      creditCents: credit,
      memo: undefined,
    });
  };
  const zero = cents(0);
  for (const entry of entries) {
    if (!stages.includes(entry.stage)) continue;
    for (const line of entry.lines) {
      const account = accountFor(line.role, entry.tag, accounts);
      if (line.debit > 0) push(account, line.debit, zero);
      if (line.credit > 0) push(account, zero, line.credit);
    }
  }
  if (lines.length === 0) {
    throw new JournalInputError(`no draft lines for ${stages.join(', ')}`);
  }
  return lines;
}

/** Both sides' totals. Throws only on a value `cents` refuses. */
export function settlementTotals(
  lines: readonly { readonly debitCents: number; readonly creditCents: number }[],
): { readonly debitCents: Cents; readonly creditCents: Cents; readonly balanced: boolean } {
  const debitCents = sumCents(lines.map((line) => cents(line.debitCents)));
  const creditCents = sumCents(lines.map((line) => cents(line.creditCents)));
  return { debitCents, creditCents, balanced: debitCents === creditCents };
}

/**
 * A memo as it is stored: trimmed, and absent when nothing was typed. Returns
 * the problem instead when it is too long or carries a control character or a
 * line break — a memo is one line of a journal entry.
 */
export function normaliseSettlementMemo(
  memo: string | undefined,
): { readonly memo: string | undefined } | { readonly problem: 'memo_too_long' | 'memo_control_character' } {
  if (memo === undefined) return { memo: undefined };
  const trimmed = memo.trim();
  if (trimmed === '') return { memo: undefined };
  if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(trimmed)) return { problem: 'memo_control_character' };
  // UTF-16 units, never fewer than the characters the database counts.
  if (trimmed.length > SETTLEMENT_MEMO_MAX_LENGTH) return { problem: 'memo_too_long' };
  return { memo: trimmed };
}

const sideKey = (line: { readonly debitCents: number; readonly creditCents: number }): string =>
  line.debitCents > 0 ? `D${line.debitCents}` : `C${line.creditCents}`;

/**
 * Whether a set of lines may be a settlement decision's (ADR 0068 §4), and if
 * so the lines as they are stored, each with its account's name and type from
 * `chart`.
 *
 * - 2 to 20 lines; each one side only, positive safe-integer cents (a float,
 *   a NaN, a negative and a zero are all refused); debits equal credits.
 * - Every account is in the chart and active.
 * - The lines on the policy's receivable account are exactly `computed`'s —
 *   the same sides and cents — and no other line is on an account of a
 *   receivable type, or of a refused type.
 * - The entry moves no more than the computed one: total debits at most
 *   `computed`'s.
 *
 * Every problem found is returned, not only the first, so a form can say all
 * of them.
 */
export function validateSettlementLines(
  input: readonly SettlementLineInput[],
  chart: readonly SettlementChartAccount[],
  options: {
    readonly computed: readonly SettlementLine[];
    readonly policy: SettlementAccountPolicy;
  },
): SettlementLinesVerdict {
  const problems: SettlementLineProblem[] = [];
  if (input.length < SETTLEMENT_MIN_LINES) problems.push({ code: 'too_few_lines' });
  if (input.length > SETTLEMENT_MAX_LINES) problems.push({ code: 'too_many_lines' });

  const byId = new Map<string, SettlementChartAccount>();
  for (const account of chart) byId.set(account.externalId, account);
  const { policy, computed } = options;

  const stored: StoredSettlementLine[] = [];
  let amountsReadable = true;
  input.forEach((line, index) => {
    const lineNo = index + 1;
    const fail = (code: SettlementLineProblemCode): void => {
      problems.push({ code, lineNo });
    };

    const { debitCents: debit, creditCents: credit } = line;
    let sided = false;
    if (!Number.isSafeInteger(debit) || !Number.isSafeInteger(credit) || debit < 0 || credit < 0) {
      fail('not_integer_cents');
      amountsReadable = false;
    } else if (debit > 0 && credit > 0) {
      fail('both_sides');
    } else if (debit === 0 && credit === 0) {
      fail('no_side');
    } else {
      sided = true;
    }

    const memo = normaliseSettlementMemo(line.memo);
    if ('problem' in memo) fail(memo.problem);

    const id = typeof line.accountExternalId === 'string' ? line.accountExternalId.trim() : '';
    const account = id === '' ? undefined : byId.get(id);
    if (id === '') {
      fail('account_missing');
    } else if (account === undefined) {
      fail('account_unknown');
    } else if (!account.active) {
      fail('account_inactive');
    } else if (
      policy.refusedAccountTypes.includes(account.accountType) ||
      (policy.receivableAccountTypes.includes(account.accountType) && id !== policy.receivableAccountId) ||
      // The map's receivable account must still be one, as the chart reports it now.
      (id === policy.receivableAccountId && !policy.receivableAccountTypes.includes(account.accountType))
    ) {
      fail('account_type_refused');
    }

    if (sided && account !== undefined && !('problem' in memo)) {
      stored.push({
        lineNo,
        accountExternalId: id,
        accountNameAsReported: account.name,
        accountTypeAsReported: account.accountType,
        debitCents: cents(debit),
        creditCents: cents(credit),
        memo: memo.memo,
      });
    }
  });

  if (amountsReadable) {
    const usable = input.filter((line) => (line.debitCents > 0) !== (line.creditCents > 0));
    let totals: ReturnType<typeof settlementTotals> | undefined;
    try {
      totals = settlementTotals(usable);
    } catch {
      // A sum past a safe integer is not cents anybody can post.
      problems.push({ code: 'not_integer_cents' });
    }
    if (totals !== undefined) {
      if (!totals.balanced) problems.push({ code: 'unbalanced' });
      if (totals.debitCents > settlementTotals(computed).debitCents) {
        problems.push({ code: 'moves_more_than_computed' });
      }
    }

    // The receivable lines, as two multisets of side-and-cents.
    const receivable = (
      lines: readonly { accountExternalId: string; debitCents: number; creditCents: number }[],
    ): string[] =>
      lines
        .filter((line) => String(line.accountExternalId).trim() === policy.receivableAccountId)
        .map(sideKey)
        .sort();
    const mine = receivable(usable);
    const theirs = receivable(computed);
    if (mine.length !== theirs.length || mine.some((key, index) => key !== theirs[index])) {
      problems.push({ code: 'receivable_changed' });
    }
  }

  return problems.length === 0 ? { ok: true, lines: stored } : { ok: false, problems };
}

export type SettlementLineChange = 'account' | 'amount' | 'memo' | 'added' | 'removed';

export interface SettlementLineDifference {
  readonly lineNo: number;
  readonly changes: readonly SettlementLineChange[];
}

/**
 * What a decision's stored lines changed from the computed ones, line by line
 * in order: the account, the amount (side or cents), a memo typed, a line
 * added past the computed ones, or a computed line that is not there. Empty
 * when the stored lines are the computed lines with no memo.
 */
export function diffSettlementLines(
  stored: readonly SettlementLine[],
  computed: readonly SettlementLine[],
): readonly SettlementLineDifference[] {
  const out: SettlementLineDifference[] = [];
  const length = Math.max(stored.length, computed.length);
  for (let index = 0; index < length; index += 1) {
    const mine = stored[index];
    const theirs = computed[index];
    const lineNo = index + 1;
    if (mine === undefined) {
      out.push({ lineNo, changes: ['removed'] });
      continue;
    }
    const changes: SettlementLineChange[] = [];
    if (theirs === undefined) {
      changes.push('added');
    } else {
      if (mine.accountExternalId !== theirs.accountExternalId) changes.push('account');
      if (mine.debitCents !== theirs.debitCents || mine.creditCents !== theirs.creditCents) {
        changes.push('amount');
      }
    }
    if (mine.memo !== undefined && mine.memo !== theirs?.memo) changes.push('memo');
    if (changes.length > 0) out.push({ lineNo, changes });
  }
  return out;
}

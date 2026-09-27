/**
 * Draft journal entries a case implies for the books, stage by stage — found,
 * recovered, written off. Drafts only: nothing here posts, and nothing reads a
 * clock. Every amount is integer cents (invariant 3), and every entry balances.
 */
import { cents, subCents, sumCents, type Cents } from './money';
import type { ReasonFamily } from './reason-codes';

export type JournalStage = 'found' | 'recovered' | 'written_off';
export type AccountRole =
  | 'accounts_receivable'
  | 'deductions_receivable'
  | 'cash'
  | 'writeoff_expense';

export interface JournalLine {
  account: string;
  role: AccountRole;
  debit: Cents;
  credit: Cents;
  memo: string;
}

export interface DraftEntry {
  stage: JournalStage;
  lines: readonly JournalLine[];
  tag: ReasonFamily | undefined;
}

export interface AccountMap {
  accountsReceivable: string;
  deductionsReceivable: string;
  cash: string;
  writeoffByFamily: Readonly<Record<ReasonFamily, string>>;
  unclassifiedWriteoff: string;
}

/**
 * Suggested default account names, not a chart of accounts. A customer's own
 * ledger names its accounts; a per-tenant map is deferred.
 */
export const DEFAULT_ACCOUNT_MAP: AccountMap = {
  accountsReceivable: 'Accounts Receivable',
  deductionsReceivable: 'Deductions Receivable',
  cash: 'Undeposited Funds',
  writeoffByFamily: {
    promotion: 'Trade Promotion Expense',
    freight: 'Freight Deductions Expense',
    shortage: 'Shortage Deductions Expense',
    pricing: 'Pricing Deductions Expense',
    compliance: 'Compliance Fines Expense',
    returns: 'Returns & Allowances',
    quality: 'Quality Deductions Expense',
    duplicate: 'Deductions Write-off Expense',
    post_audit: 'Deductions Write-off Expense',
    other: 'Deductions Write-off Expense',
  },
  unclassifiedWriteoff: 'Deductions Write-off Expense (unclassified)',
};

const FAMILY_WORDS: Readonly<Record<ReasonFamily, string>> = {
  shortage: 'Shortage',
  pricing: 'Pricing',
  compliance: 'Compliance fine',
  duplicate: 'Duplicate deduction',
  returns: 'Returns',
  promotion: 'Trade promotion',
  freight: 'Freight',
  quality: 'Quality',
  post_audit: 'Post-audit claim',
  other: 'Other deduction',
};

export class JournalInputError extends Error {
  override readonly name = 'JournalInputError';
}

export function writeoffAccountFor(
  family: ReasonFamily | undefined,
  map: AccountMap = DEFAULT_ACCOUNT_MAP,
): string {
  return family === undefined ? map.unclassifiedWriteoff : map.writeoffByFamily[family];
}

export function isBalanced(entry: DraftEntry): boolean {
  return (
    sumCents(entry.lines.map((l) => l.debit)) === sumCents(entry.lines.map((l) => l.credit))
  );
}

function pair(
  stage: JournalStage,
  amount: Cents,
  debit: { account: string; role: AccountRole },
  credit: { account: string; role: AccountRole },
  memo: string,
  tag: ReasonFamily | undefined,
): DraftEntry {
  const zero = cents(0);
  return {
    stage,
    tag,
    lines: [
      { ...debit, debit: amount, credit: zero, memo },
      { ...credit, debit: zero, credit: amount, memo },
    ],
  };
}

export function draftEntries(input: {
  amountCents: Cents;
  recoveredCents?: Cents | undefined;
  outcome?: 'won' | 'partial' | 'lost' | 'declined' | undefined;
  family?: ReasonFamily | undefined;
  printedReasonCode?: string | undefined;
  map?: AccountMap | undefined;
}): readonly DraftEntry[] {
  const map = input.map ?? DEFAULT_ACCOUNT_MAP;
  const { amountCents: a, outcome, family } = input;
  if (!Number.isSafeInteger(a) || a <= 0) {
    throw new JournalInputError(`the deducted amount must be positive integer cents, got ${a}`);
  }
  const rIn = input.recoveredCents;
  if (rIn !== undefined && (!Number.isSafeInteger(rIn) || rIn < 0)) {
    throw new JournalInputError(`the recovered amount must be non-negative integer cents, got ${rIn}`);
  }
  if (rIn !== undefined && rIn > a) {
    throw new JournalInputError(`recovered ${rIn} is more than the ${a} deducted`);
  }
  if ((outcome === 'lost' || outcome === 'declined') && rIn !== undefined && rIn !== 0) {
    throw new JournalInputError(`a ${outcome} case recovers nothing, got ${rIn}`);
  }
  if (outcome === 'won' && rIn !== a) {
    throw new JournalInputError(`a won case recovers the whole ${a}, got ${rIn ?? 'nothing'}`);
  }
  const r = rIn ?? cents(0);

  const dr = { account: map.deductionsReceivable, role: 'deductions_receivable' as const };
  const memo =
    family !== undefined
      ? FAMILY_WORDS[family]
      : input.printedReasonCode !== undefined
        ? `Payer reason as printed: ${input.printedReasonCode}`
        : 'Reason not chosen yet';

  const entries: DraftEntry[] = [
    pair('found', a, dr, { account: map.accountsReceivable, role: 'accounts_receivable' }, memo, family),
  ];
  if (r > 0) {
    entries.push(
      pair('recovered', r, { account: map.cash, role: 'cash' }, dr, 'Recovered from the payer', family),
    );
  }
  const rest = subCents(a, r);
  if (outcome !== undefined && rest > 0) {
    entries.push(
      pair(
        'written_off',
        rest,
        { account: writeoffAccountFor(family, map), role: 'writeoff_expense' },
        dr,
        'Not recovered',
        family,
      ),
    );
  }
  return entries;
}

export function projectedEntries(
  amountCents: Cents,
  family?: ReasonFamily,
  map?: AccountMap,
): { won: readonly DraftEntry[]; lost: readonly DraftEntry[] } {
  return {
    won: draftEntries({ amountCents, recoveredCents: amountCents, outcome: 'won', family, map }),
    lost: draftEntries({ amountCents, outcome: 'lost', family, map }),
  };
}

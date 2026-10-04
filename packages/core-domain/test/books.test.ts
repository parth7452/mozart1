import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  DEDUCTION_ACCOUNT_NAME_WORDS,
  DEDUCTION_ACCOUNT_SUBTYPES,
  RECONCILIATION_CANDIDATE_DAYS,
  booksAccountRoles,
  cents,
  lineAmountCents,
  looksLikeDeductionsAccount,
  reconcileDeductions,
  totalLineAmountCents,
  trialBalanceDifferenceCents,
  windowDays,
  type BooksCase,
  type GeneralLedgerLine,
  type LedgerAccount,
} from '../src/index';

/**
 * The Books page's two pure questions (ADR 0066 §2, §3): which accounts are
 * the ones to look at, and which ledger lines are which of our cases. The
 * second asserts a match only when arithmetic and the calendar leave no other
 * reading; everything else is a candidate.
 */

function account(
  externalId: string,
  fullyQualifiedName: string,
  accountType: string,
  accountSubType?: string,
): LedgerAccount {
  return {
    sourceKind: 'qbo',
    externalId,
    name: fullyQualifiedName.split(':').pop() as string,
    fullyQualifiedName,
    accountType,
    ...(accountSubType === undefined ? {} : { accountSubType }),
    active: true,
  };
}

function line(
  date: string,
  debit: number,
  credit = 0,
  more: Partial<GeneralLedgerLine> = {},
): GeneralLedgerLine {
  return {
    accountExternalId: '96',
    accountName: 'Distributor Chargebacks',
    date,
    debitCents: cents(debit),
    creditCents: cents(credit),
    ...more,
  };
}

function aCase(caseId: string, amount: number, date?: string): BooksCase {
  return {
    caseId,
    claimId: `CLM-${caseId}`,
    amountCents: cents(amount),
    payerName: 'Sysco Baltimore, LLC',
    ...(date === undefined ? {} : { date }),
  };
}

describe('which accounts the Books page looks at', () => {
  const chart = [
    account('35', 'Checking', 'Bank', 'Checking'),
    account('84', 'Accounts Receivable (A/R)', 'Accounts Receivable', 'AccountsReceivable'),
    account('85', 'Deductions in A/R', 'Accounts Receivable', 'AccountsReceivable'),
    account('91', 'Deductions Receivable', 'Other Current Asset', 'OtherCurrentAssets'),
    account('92', 'Reserve', 'Other Current Asset', 'AllowanceForBadDebts'),
    account('95', 'Returns', 'Income', 'DiscountsRefundsGiven'),
    account('96', 'Trade:Distributor Chargebacks', 'Income', 'SalesOfProductIncome'),
    account('97', 'Customer Write-offs', 'Expense', 'OtherMiscellaneousServiceCost'),
    account('98', 'Promotional Allowances', 'Expense', 'AdvertisingPromotional'),
    account('60', 'Freight Out', 'Expense', 'ShippingFreightDelivery'),
    account('61', 'Compromise Settlements', 'Expense'),
  ];

  it('names the receivable, the posting accounts and the ones that look like deductions', () => {
    const roles = booksAccountRoles(chart, ['91', '97']);
    expect(Object.fromEntries(roles)).toEqual({
      '84': ['receivable'],
      '85': ['receivable'],
      '91': ['posting', 'deductions'],
      '92': ['deductions'],
      '95': ['deductions'],
      '96': ['deductions'],
      '97': ['posting'],
      '98': ['deductions'],
    });
    // Checking, Freight Out and a name that only contains "promo" mid-word: none.
    expect(roles.has('35')).toBe(false);
    expect(roles.has('60')).toBe(false);
    expect(roles.has('61')).toBe(false);
  });

  it('never calls a receivable a deductions account, whatever its name', () => {
    expect(booksAccountRoles(chart, []).get('85')).toEqual(['receivable']);
  });

  it('guesses by exactly the written lists', () => {
    expect(DEDUCTION_ACCOUNT_SUBTYPES).toEqual(['DiscountsRefundsGiven', 'AllowanceForBadDebts']);
    for (const word of DEDUCTION_ACCOUNT_NAME_WORDS) {
      expect(looksLikeDeductionsAccount(account('1', `Sales:${word} account`, 'Income'))).toBe(true);
      expect(looksLikeDeductionsAccount(account('1', word.toUpperCase(), 'Expense'))).toBe(true);
    }
    expect(looksLikeDeductionsAccount(account('1', 'Sales of Product Income', 'Income'))).toBe(false);
    expect(looksLikeDeductionsAccount(account('1', 'Compromise', 'Expense'))).toBe(false);
  });
});

describe('reconcileDeductions', () => {
  it('matches the same cents on the same day, one line to one case', () => {
    const lines = [line('2026-09-01', 127_000), line('2026-09-10', 50_000)];
    const cases = [aCase('a', 127_000, '2026-09-01'), aCase('b', 32_000, '2026-09-22')];
    const rows = reconcileDeductions(lines, cases);

    expect(rows.map((row) => row.kind)).toEqual(['matched', 'books_only', 'case_only']);
    expect(rows[0]).toMatchObject({ kind: 'matched', amountCents: 127_000, case: { caseId: 'a' } });
    expect(rows[1]).toMatchObject({ kind: 'books_only', amountCents: 50_000, candidates: [] });
    expect(rows[2]).toMatchObject({ kind: 'case_only', case: { caseId: 'b' }, candidates: [] });
  });

  it('reads a credit as the same amount as a debit: what moved, whichever side', () => {
    expect(lineAmountCents(line('2026-09-01', 0, 50_000))).toBe(50_000);
    expect(lineAmountCents(line('2026-09-01', 70_000, 20_000))).toBe(50_000);
    const rows = reconcileDeductions([line('2026-09-01', 0, 50_000)], [aCase('a', 50_000, '2026-09-01')]);
    expect(rows.map((row) => row.kind)).toEqual(['matched']);
  });

  it('asserts nothing a day apart: the pair are candidates for each other', () => {
    const rows = reconcileDeductions([line('2026-09-02', 50_000)], [aCase('a', 50_000, '2026-09-01')]);
    expect(rows.map((row) => row.kind)).toEqual(['books_only', 'case_only']);
    expect(rows[0]).toMatchObject({ candidates: [{ caseId: 'a' }] });
    expect(rows[1]).toMatchObject({ candidates: [{ date: '2026-09-02' }] });
  });

  it('asserts nothing a cent apart, and offers no candidate either', () => {
    const rows = reconcileDeductions([line('2026-09-01', 50_001)], [aCase('a', 50_000, '2026-09-01')]);
    expect(rows.map((row) => row.kind)).toEqual(['books_only', 'case_only']);
    expect(rows[0]).toMatchObject({ candidates: [] });
    expect(rows[1]).toMatchObject({ candidates: [] });
  });

  it('asserts nothing when two lines could be the one case', () => {
    const lines = [
      line('2026-09-01', 50_000, 0, { documentNumber: 'CM-1' }),
      line('2026-09-01', 50_000, 0, { documentNumber: 'CM-2' }),
    ];
    const rows = reconcileDeductions(lines, [aCase('a', 50_000, '2026-09-01')]);
    expect(rows.map((row) => row.kind)).toEqual(['books_only', 'books_only', 'case_only']);
    expect(rows[0]).toMatchObject({ candidates: [{ caseId: 'a' }] });
    expect(rows[2]).toMatchObject({ candidates: [{ documentNumber: 'CM-1' }, { documentNumber: 'CM-2' }] });
  });

  it('asserts nothing when two cases could be the one line', () => {
    const cases = [aCase('a', 50_000, '2026-09-01'), aCase('b', 50_000, '2026-09-01')];
    const rows = reconcileDeductions([line('2026-09-01', 50_000)], cases);
    expect(rows.map((row) => row.kind)).toEqual(['books_only', 'case_only', 'case_only']);
    expect(rows[0]).toMatchObject({ candidates: [{ caseId: 'a' }, { caseId: 'b' }] });
  });

  it('never matches a case with no date, and lists it as a candidate by amount', () => {
    const rows = reconcileDeductions([line('2026-09-01', 50_000)], [aCase('a', 50_000)]);
    expect(rows.map((row) => row.kind)).toEqual(['books_only', 'case_only']);
    expect(rows[0]).toMatchObject({ candidates: [{ caseId: 'a' }] });
    expect(rows[1]).toMatchObject({ candidates: [{ date: '2026-09-01' }] });
  });

  it('offers a candidate only within the candidate window', () => {
    const far = `2026-09-${String(1 + RECONCILIATION_CANDIDATE_DAYS + 1).padStart(2, '0')}`;
    const edge = `2026-09-${String(1 + RECONCILIATION_CANDIDATE_DAYS).padStart(2, '0')}`;
    expect(
      reconcileDeductions([line(far, 50_000)], [aCase('a', 50_000, '2026-09-01')])[0],
    ).toMatchObject({ candidates: [] });
    expect(
      reconcileDeductions([line(edge, 50_000)], [aCase('a', 50_000, '2026-09-01')])[0],
    ).toMatchObject({ candidates: [{ caseId: 'a' }] });
  });

  it('matches nothing to a line that moved nothing', () => {
    const rows = reconcileDeductions([line('2026-09-01', 5_000, 5_000)], [aCase('a', 0, '2026-09-01')]);
    expect(rows.map((row) => row.kind)).toEqual(['books_only', 'case_only']);
    expect(rows[0]).toMatchObject({ amountCents: 0, candidates: [] });
  });

  it('accounts for every line and every case exactly once, in any order', () => {
    const day = fc.integer({ min: 1, max: 28 }).map((d) => `2026-09-${String(d).padStart(2, '0')}`);
    const amount = fc.constantFrom(0, 1, 50_000, 50_001, 127_000);
    const lineArb = fc.tuple(day, amount, amount).map(([date, debit, credit]) => line(date, debit, credit));
    const caseArb = fc
      .tuple(fc.uuid(), amount, fc.option(day, { nil: undefined }))
      .map(([id, cents_, date]) => aCase(id, cents_, date));

    fc.assert(
      fc.property(fc.array(lineArb, { maxLength: 12 }), fc.array(caseArb, { maxLength: 12 }), (lines, cases) => {
        const rows = reconcileDeductions(lines, cases);
        const matched = rows.filter((row) => row.kind === 'matched');
        const booksOnly = rows.filter((row) => row.kind === 'books_only');
        const caseOnly = rows.filter((row) => row.kind === 'case_only');
        expect(matched.length + booksOnly.length).toBe(lines.length);
        expect(matched.length + caseOnly.length).toBe(cases.length);

        for (const row of matched) {
          if (row.kind !== 'matched') continue;
          // Exact, and the only pairing on that amount and day.
          expect(row.case.amountCents).toBe(lineAmountCents(row.line));
          expect(row.case.date).toBe(row.line.date);
          expect(row.amountCents).toBeGreaterThan(0);
          expect(lines.filter((l) => l.date === row.line.date && lineAmountCents(l) === row.amountCents)).toHaveLength(1);
          expect(cases.filter((c) => c.date === row.line.date && c.amountCents === row.amountCents)).toHaveLength(1);
        }

        // The same answer whatever order the two lists arrive in.
        const again = reconcileDeductions([...lines].reverse(), [...cases].reverse());
        expect(again.map((row) => row.kind)).toEqual(rows.map((row) => row.kind));
        expect(again.filter((row) => row.kind === 'matched')).toEqual(matched);
      }),
    );
  });
});

describe('small sums', () => {
  it('counts a window by days, both ends included', () => {
    expect(windowDays({ from: '2026-09-01', to: '2026-09-01' })).toBe(1);
    expect(windowDays({ from: '2026-08-27', to: '2026-09-30' })).toBe(35);
    expect(windowDays({ from: '2024-02-28', to: '2024-03-01' })).toBe(3);
    expect(() => windowDays({ from: '09/01/2026', to: '2026-09-30' })).toThrow(RangeError);
  });

  it('adds line amounts and subtracts a trial balance in integer cents', () => {
    expect(totalLineAmountCents([line('2026-09-01', 127_000), line('2026-09-10', 0, 50_000)])).toBe(177_000);
    expect(
      trialBalanceDifferenceCents({
        sourceKind: 'qbo',
        asOf: '2026-09-30',
        lines: [],
        totalDebitCents: cents(10_001),
        totalCreditCents: cents(10_000),
      }),
    ).toBe(1);
  });
});

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  SIZING_WINDOW_DAYS,
  cents,
  deductionsSizing,
  formatBps,
  rateBps,
  sizingWindow,
  windowDays,
  type LedgerAccount,
  type ProfitAndLoss,
  type ProfitAndLossLine,
} from '../src/index';

/**
 * The sizing card's one question (ADR 0073): how big are the deductions beside
 * the sales. The rate is integer arithmetic end to end, and every line of the
 * profit and loss either counts once or is listed as counting for nothing.
 */

function account(
  externalId: string,
  fullyQualifiedName: string,
  accountType: string,
  more: Partial<LedgerAccount> = {},
): LedgerAccount {
  return {
    sourceKind: 'qbo',
    externalId,
    name: fullyQualifiedName.split(':').pop() as string,
    fullyQualifiedName,
    accountType,
    active: true,
    ...more,
  };
}

const CHART: readonly LedgerAccount[] = [
  account('84', 'Accounts Receivable (A/R)', 'Accounts Receivable', {
    classification: 'Asset',
    currentBalanceCents: cents(413_025),
  }),
  account('85', 'A/R - Canada Allowance', 'Accounts Receivable', { classification: 'Asset' }),
  account('4', 'Undeposited Funds', 'Other Current Asset', {
    accountSubType: 'UndepositedFunds',
    classification: 'Asset',
    currentBalanceCents: cents(12_000),
  }),
  account('91', 'Deductions Receivable', 'Other Current Asset', {
    classification: 'Asset',
    currentBalanceCents: cents(127_000),
  }),
  account('92', 'Allowance for Doubtful Accounts', 'Other Current Asset', {
    accountSubType: 'AllowanceForBadDebts',
    classification: 'Asset',
  }),
  account('79', 'Sales of Product Income', 'Income', { classification: 'Revenue' }),
  account('95', 'Trade Deductions', 'Income', {
    accountSubType: 'DiscountsRefundsGiven',
    classification: 'Revenue',
  }),
  account('96', 'Trade Deductions:Distributor Chargebacks', 'Income', {
    accountSubType: 'DiscountsRefundsGiven',
    classification: 'Revenue',
  }),
  account('97', 'Customer Deductions', 'Expense', { classification: 'Expense' }),
  account('60', 'Freight Out', 'Expense', { classification: 'Expense' }),
  account('33', 'Opening Balance Equity', 'Equity', { classification: 'Equity' }),
];

function line(id: string | undefined, amount: number, section = 'Income'): ProfitAndLossLine {
  return {
    ...(id === undefined ? {} : { accountExternalId: id }),
    accountName: `account ${id ?? 'none'}`,
    section,
    amountCents: cents(amount),
  };
}

const WINDOW = { from: '2025-10-08', to: '2026-10-07' };

function pnl(lines: readonly ProfitAndLossLine[]): ProfitAndLoss {
  return { sourceKind: 'qbo', window: WINDOW, basis: 'Accrual', currency: 'USD', lines };
}

describe('sizingWindow', () => {
  it('is the trailing 365 days, both ends counted, across a leap day', () => {
    expect(sizingWindow('2026-10-07')).toEqual(WINDOW);
    expect(windowDays(sizingWindow('2026-10-07'))).toBe(SIZING_WINDOW_DAYS);
    expect(sizingWindow('2028-03-01')).toEqual({ from: '2027-03-03', to: '2028-03-01' });
    expect(() => sizingWindow('07/10/2026')).toThrow(RangeError);
  });
});

describe('deductionsSizing', () => {
  it('splits sales from deductions by the chart, and takes the rate over gross sales', () => {
    const sizing = deductionsSizing(
      CHART,
      pnl([
        line('79', 10_000_000),
        line('95', -40_000),
        line('96', -250_000),
        line('97', 32_000, 'Expenses'),
        line('60', 75_000, 'Expenses'),
      ]),
      ['91', '97'],
    );
    expect(sizing.grossSalesCents).toBe(10_000_000);
    expect(sizing.revenueDeductionsCents).toBe(-290_000);
    expect(sizing.expenseDeductionsCents).toBe(32_000);
    expect(sizing.deductionsCents).toBe(322_000);
    expect(sizing.bps).toBe(322n);
    expect(formatBps(sizing.bps as bigint)).toBe('3.22%');
    expect(sizing.contributions.map((one) => [one.account.externalId, one.side, one.amountCents])).toEqual([
      ['95', 'revenue', -40_000],
      ['96', 'revenue', -250_000],
      ['97', 'expense', 32_000],
    ]);
    expect(sizing.unmatchedLines).toEqual([]);
    expect(sizing).toMatchObject({ window: WINDOW, basis: 'Accrual', currency: 'USD' });
  });

  it('lists a line with no id, an unknown id or a balance-sheet account, never dropping it', () => {
    const sizing = deductionsSizing(
      CHART,
      pnl([line('79', 100_000), line(undefined, 5_000), line('999', 7_000), line('33', 1)]),
    );
    expect(sizing.grossSalesCents).toBe(100_000);
    expect(sizing.unmatchedLines.map((one) => one.reason)).toEqual([
      'no_account_id',
      'not_in_chart',
      'not_revenue_or_expense',
    ]);
  });

  it('never counts other income as a sale, while a deduction counts wherever it is printed', () => {
    const base = [line('79', 10_000_000), line('96', -642_000)];
    const without = deductionsSizing(CHART, pnl(base));
    const withOther = deductionsSizing(
      CHART,
      pnl([...base, line('79', 5_000_000, 'OtherIncome'), line('95', -1_000, 'OtherIncome')]),
    );
    expect(without.bps).toBe(642n);
    expect(withOther.grossSalesCents).toBe(10_000_000);
    expect(withOther.otherIncomeCents).toBe(5_000_000);
    expect(withOther.revenueDeductionsCents).toBe(-643_000);
    expect(withOther.bps).toBe(643n);
    // Other income alone is no sales.
    expect(deductionsSizing(CHART, pnl([line('79', 1_000, 'OtherIncome'), line('96', -1)])).bps).toBeNull();
  });

  it('gives no rate over no sales, or over a loss of sales', () => {
    expect(deductionsSizing(CHART, pnl([line('95', -500)])).bps).toBeNull();
    expect(deductionsSizing(CHART, pnl([line('79', -1), line('95', -500)])).bps).toBeNull();
    expect(deductionsSizing(CHART, pnl([])).bps).toBeNull();
  });

  it('reports balances, and says "not reported" rather than zero', () => {
    const sizing = deductionsSizing(CHART, pnl([]), ['91', '97']);
    expect(sizing.balances.receivable.map((one) => [one.account.externalId, one.balanceCents])).toEqual([
      ['84', 413_025],
      ['85', undefined],
    ]);
    // One receivable reported nothing, so there is no total.
    expect(sizing.balances.receivableTotalCents).toBeUndefined();
    expect(sizing.balances.undepositedFunds.map((one) => one.balanceCents)).toEqual([12_000]);
    expect(
      sizing.balances.deductions.map((one) => [one.account.externalId, one.balanceCents, one.posting]),
    ).toEqual([
      ['91', 127_000, true],
      ['92', undefined, false],
    ]);

    const reported = deductionsSizing(
      CHART.filter((one) => one.externalId !== '85'),
      pnl([]),
    );
    expect(reported.balances.receivableTotalCents).toBe(413_025);
    // Without the map, Deductions Receivable is still listed by its name, but not as a posting account.
    expect(reported.balances.deductions.map((one) => [one.account.externalId, one.posting])).toEqual([
      ['91', false],
      ['92', false],
    ]);
  });

  it('never counts a receivable as a deductions account, whatever its name', () => {
    const sizing = deductionsSizing(CHART, pnl([line('85', 1_000)]));
    expect(sizing.contributions).toEqual([]);
    expect(sizing.unmatchedLines.map((one) => one.reason)).toEqual(['not_revenue_or_expense']);
  });
});

describe('rateBps and formatBps', () => {
  it('rounds half up to one basis point', () => {
    expect(rateBps(cents(1), cents(20_000))).toBe(1n); // exactly 0.5 bp
    expect(rateBps(cents(1), cents(20_001))).toBe(0n);
    expect(rateBps(cents(642), cents(10_000))).toBe(642n);
    expect(rateBps(cents(0), cents(1))).toBe(0n);
    expect(formatBps(642n)).toBe('6.42%');
    expect(formatBps(5n)).toBe('0.05%');
    expect(formatBps(123_456n)).toBe('1,234.56%');
    expect(() => rateBps(cents(1), cents(0))).toThrow(RangeError);
    expect(() => rateBps(cents(-1), cents(10))).toThrow(RangeError);
  });

  it('matches exact rational rounding, half up, without a float', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 15n }),
        fc.bigInt({ min: 1n, max: 10n ** 15n }),
        (part, whole) => {
          const got = rateBps(cents(Number(part)), cents(Number(whole)));
          // got is the integer nearest part×10⁴/whole, ties up: |2·(got·whole − part·10⁴)| ≤ whole,
          // with equality only on the low side.
          const twice = 2n * (got * whole - part * 10_000n);
          expect(twice <= whole && twice > -whole).toBe(true);
        },
      ),
    );
  });
});

describe('deductionsSizing, properties', () => {
  const ids = ['79', '95', '96', '97', '60', '84', '33', '999'];
  const sectionArb = fc.constantFrom('Income', 'OtherIncome', 'Expenses', 'COGS', 'OtherExpenses');
  const lineArb = fc
    .tuple(
      fc.option(fc.constantFrom(...ids), { nil: undefined }),
      fc.integer({ min: -10_000_000, max: 10_000_000 }),
      sectionArb,
    )
    .map(([id, amount, section]) => line(id, amount, section));

  it('is additive: two halves of a profit and loss add up to the whole', () => {
    fc.assert(
      fc.property(fc.array(lineArb), fc.array(lineArb), (a, b) => {
        const left = deductionsSizing(CHART, pnl(a));
        const right = deductionsSizing(CHART, pnl(b));
        const both = deductionsSizing(CHART, pnl([...a, ...b]));
        expect(both.grossSalesCents).toBe(left.grossSalesCents + right.grossSalesCents);
        expect(both.otherIncomeCents).toBe(left.otherIncomeCents + right.otherIncomeCents);
        expect(both.revenueDeductionsCents).toBe(left.revenueDeductionsCents + right.revenueDeductionsCents);
        expect(both.expenseDeductionsCents).toBe(left.expenseDeductionsCents + right.expenseDeductionsCents);
        expect(both.unmatchedLines).toHaveLength(left.unmatchedLines.length + right.unmatchedLines.length);
      }),
    );
  });

  it('counts each account once, and every line exactly once somewhere', () => {
    fc.assert(
      fc.property(fc.array(lineArb), (lines) => {
        const sizing = deductionsSizing(CHART, pnl(lines));
        const accounts = sizing.contributions.map((one) => one.account.externalId);
        expect(new Set(accounts).size).toBe(accounts.length);
        const contributed = sizing.contributions.reduce((total, one) => total + one.amountCents, 0);
        expect(contributed).toBe(sizing.revenueDeductionsCents + sizing.expenseDeductionsCents);

        // Every line is sales, a deduction, another expense, or listed as unmatched.
        const otherExpense = lines
          .filter((one) => one.accountExternalId === '60')
          .reduce((total, one) => total + one.amountCents, 0);
        const unmatched = sizing.unmatchedLines.reduce((total, one) => total + one.line.amountCents, 0);
        const all = lines.reduce((total, one) => total + one.amountCents, 0);
        expect(sizing.grossSalesCents + sizing.otherIncomeCents + contributed + otherExpense + unmatched).toBe(
          all,
        );
      }),
    );
  });

  it('never moves the rate’s denominator for other income', () => {
    const otherArb = fc
      .tuple(fc.constantFrom('79', '95', '96', '97', '60'), fc.integer({ min: -10_000_000, max: 10_000_000 }))
      .map(([id, amount]) => line(id, amount, 'OtherIncome'));
    fc.assert(
      fc.property(fc.array(lineArb), fc.array(otherArb), (lines, other) => {
        const before = deductionsSizing(CHART, pnl(lines));
        const after = deductionsSizing(CHART, pnl([...lines, ...other]));
        expect(after.grossSalesCents).toBe(before.grossSalesCents);
        // With no deduction among it, other income leaves the rate exactly where it was.
        const deductionsAmongIt = other.some((one) => ['95', '96', '97'].includes(one.accountExternalId ?? ''));
        if (!deductionsAmongIt) expect(after.bps).toBe(before.bps);
      }),
    );
  });

  it('does not depend on the order of the lines', () => {
    fc.assert(
      fc.property(fc.array(lineArb), (lines) => {
        const forward = deductionsSizing(CHART, pnl(lines));
        const backward = deductionsSizing(CHART, pnl([...lines].reverse()));
        expect(backward.bps).toBe(forward.bps);
        expect(backward.contributions).toEqual(forward.contributions);
        expect(backward.grossSalesCents).toBe(forward.grossSalesCents);
      }),
    );
  });
});

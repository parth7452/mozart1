import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { cents } from '../src/money';
import { draftEntries } from '../src/journal';
import { REASON_FAMILIES, type ReasonFamily } from '../src/reason-codes';
import {
  SETTLEMENT_MAX_LINES,
  SETTLEMENT_MEMO_MAX_LENGTH,
  diffSettlementLines,
  normaliseSettlementMemo,
  settlementLinesFrom,
  settlementTotals,
  validateSettlementLines,
  type SettlementAccountIds,
  type SettlementAccountPolicy,
  type SettlementChartAccount,
  type SettlementLine,
  type SettlementLineInput,
} from '../src/settlement-lines';

/** ADR 0068 §4: what a person may change on a settlement entry, and what they may not. */

const accounts: SettlementAccountIds = {
  arAccountId: '84',
  deductionsReceivableAccountId: '90',
  writeoffByFamily: Object.fromEntries(REASON_FAMILIES.map((f, i) => [f, String(200 + i)])) as Record<
    ReasonFamily,
    string
  >,
  unclassifiedWriteoff: '299',
};

const chart: readonly SettlementChartAccount[] = [
  { externalId: '84', name: 'Accounts Receivable (A/R)', accountType: 'Accounts Receivable', active: true },
  { externalId: '85', name: 'Other receivable', accountType: 'Accounts Receivable', active: true },
  { externalId: '90', name: 'Deductions Receivable', accountType: 'Other Current Asset', active: true },
  ...REASON_FAMILIES.map((f, i) => ({
    externalId: String(200 + i),
    name: `Write-off ${f}`,
    accountType: 'Expense',
    active: true,
  })),
  { externalId: '299', name: 'Customer Deductions', accountType: 'Expense', active: true },
  { externalId: '300', name: 'Trade spend', accountType: 'Expense', active: true },
  { externalId: '301', name: 'Old expense', accountType: 'Expense', active: false },
  { externalId: '35', name: 'Checking', accountType: 'Bank', active: true },
  { externalId: '33', name: 'Accounts Payable (A/P)', accountType: 'Accounts Payable', active: true },
];

const policy: SettlementAccountPolicy = {
  receivableAccountId: '84',
  receivableAccountTypes: ['Accounts Receivable'],
  refusedAccountTypes: ['Accounts Payable', 'Bank'],
};

type Outcome = 'won' | 'partial' | 'lost' | 'declined';

function computedFor(a: number, r: number, outcome: Outcome, family?: ReasonFamily): readonly SettlementLine[] {
  const entries = draftEntries({
    amountCents: cents(a),
    recoveredCents: cents(r),
    outcome,
    family,
  });
  return settlementLinesFrom(entries, accounts, { includeFound: outcome === 'declined' });
}

const asInput = (lines: readonly SettlementLine[]): SettlementLineInput[] =>
  lines.map((l) => ({
    accountExternalId: l.accountExternalId,
    debitCents: l.debitCents,
    creditCents: l.creditCents,
    memo: l.memo,
  }));

const settled = fc
  .integer({ min: 1, max: 1_000_000_000_000 })
  .chain((a) =>
    fc.tuple(
      fc.constant(a),
      fc.oneof(
        fc.constant<[number, Outcome]>([a, 'won']),
        fc.constant<[number, Outcome]>([0, 'lost']),
        fc.constant<[number, Outcome]>([0, 'declined']),
        a > 1
          ? fc.integer({ min: 1, max: a - 1 }).map((r): [number, Outcome] => [r, 'partial'])
          : fc.constant<[number, Outcome]>([0, 'lost']),
      ),
      fc.option(fc.constantFrom(...REASON_FAMILIES), { nil: undefined }),
    ),
  );

const codes = (verdict: ReturnType<typeof validateSettlementLines>): string[] =>
  verdict.ok ? [] : verdict.problems.map((p) => p.code);

describe('settlementLinesFrom', () => {
  it('gives balanced, one-sided, numbered lines for every way a case settles', () => {
    fc.assert(
      fc.property(settled, ([a, [r, outcome], family]) => {
        const lines = computedFor(a, r, outcome, family);
        expect(lines.map((l) => l.lineNo)).toEqual(lines.map((_, i) => i + 1));
        for (const l of lines) {
          expect(l.debitCents > 0 !== l.creditCents > 0).toBe(true);
          expect(l.memo).toBeUndefined();
        }
        expect(settlementTotals(lines).balanced).toBe(true);
      }),
    );
  });

  it('never names a cash account: a recovery debits the receivable', () => {
    const lines = computedFor(50_000, 20_000, 'partial', 'shortage');
    expect(lines).toEqual([
      { lineNo: 1, accountExternalId: '84', debitCents: 20_000, creditCents: 0, memo: undefined },
      { lineNo: 2, accountExternalId: '90', debitCents: 0, creditCents: 20_000, memo: undefined },
      { lineNo: 3, accountExternalId: '200', debitCents: 30_000, creditCents: 0, memo: undefined },
      { lineNo: 4, accountExternalId: '90', debitCents: 0, creditCents: 30_000, memo: undefined },
    ]);
  });

  it('a declined case carries the found lines too; a filed one does not', () => {
    expect(computedFor(50_000, 0, 'declined')).toHaveLength(4);
    expect(computedFor(50_000, 0, 'lost')).toHaveLength(2);
  });
});

describe('validateSettlementLines', () => {
  it("accepts the computed lines as they are, with the chart's names and types", () => {
    fc.assert(
      fc.property(settled, ([a, [r, outcome], family]) => {
        const computed = computedFor(a, r, outcome, family);
        const verdict = validateSettlementLines(asInput(computed), chart, { computed, policy });
        expect(verdict.ok).toBe(true);
        if (!verdict.ok) return;
        expect(
          verdict.lines.map(({ accountNameAsReported: _n, accountTypeAsReported: _t, ...l }) => l),
        ).toEqual(computed);
        for (const l of verdict.lines) {
          const account = chart.find((c) => c.externalId === l.accountExternalId);
          expect(l.accountNameAsReported).toBe(account?.name);
          expect(l.accountTypeAsReported).toBe(account?.accountType);
        }
        expect(diffSettlementLines(verdict.lines, computed)).toEqual([]);
      }),
    );
  });

  it('whatever it accepts balances to the cent, on integer cents, one side a line', () => {
    const line = fc.record({
      accountExternalId: fc.constantFrom('90', '200', '299', '300'),
      debitCents: fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 60_000 })),
      creditCents: fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 60_000 })),
    });
    const computed = computedFor(50_000, 0, 'lost', 'shortage');
    fc.assert(
      fc.property(fc.array(line, { minLength: 0, maxLength: 6 }), (lines) => {
        const verdict = validateSettlementLines(lines, chart, { computed, policy });
        if (!verdict.ok) return;
        const totals = settlementTotals(verdict.lines);
        expect(totals.balanced).toBe(true);
        expect(totals.debitCents).toBeLessThanOrEqual(50_000);
        expect(verdict.lines.length).toBe(lines.length);
        for (const l of verdict.lines) {
          expect(Number.isSafeInteger(l.debitCents) && Number.isSafeInteger(l.creditCents)).toBe(true);
          expect(l.debitCents > 0 !== l.creditCents > 0).toBe(true);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('accepts some edited set in that search, so the property above is not vacuous', () => {
    const computed = computedFor(50_000, 0, 'lost', 'shortage');
    const verdict = validateSettlementLines(
      [
        { accountExternalId: '300', debitCents: 49_999, creditCents: 0 },
        { accountExternalId: '90', debitCents: 0, creditCents: 49_999 },
      ],
      chart,
      { computed, policy },
    );
    expect(verdict.ok).toBe(true);
  });

  it('refuses a set one cent out, on either side', () => {
    fc.assert(
      fc.property(settled, fc.boolean(), ([a, [r, outcome], family], onDebit) => {
        const computed = computedFor(a, r, outcome, family);
        const edited = asInput(computed);
        // Not a receivable line: that one has its own refusal.
        const index = edited.findIndex(
          (l) => l.accountExternalId !== '84' && (onDebit ? l.debitCents > 0 : l.creditCents > 0),
        );
        fc.pre(index >= 0);
        const target = edited[index] as SettlementLineInput;
        edited[index] = onDebit
          ? { ...target, debitCents: target.debitCents + 1 }
          : { ...target, creditCents: target.creditCents + 1 };
        expect(codes(validateSettlementLines(edited, chart, { computed, policy }))).toContain('unbalanced');
      }),
    );
  });

  it('refuses a float, a NaN, an infinity, a negative and an unsafe integer as cents', () => {
    const computed = computedFor(50_000, 0, 'lost');
    for (const bad of [0.5, 100.01, Number.NaN, Number.POSITIVE_INFINITY, -1, 2 ** 53]) {
      const edited = asInput(computed);
      edited[0] = { ...(edited[0] as SettlementLineInput), debitCents: bad };
      const verdict = validateSettlementLines(edited, chart, { computed, policy });
      expect(codes(verdict)).toContain('not_integer_cents');
    }
  });

  it('refuses a line with both sides, and one with neither', () => {
    const computed = computedFor(50_000, 0, 'lost');
    const both = asInput(computed);
    both[0] = { ...(both[0] as SettlementLineInput), creditCents: 1 };
    expect(codes(validateSettlementLines(both, chart, { computed, policy }))).toContain('both_sides');
    const neither = [...asInput(computed), { accountExternalId: '300', debitCents: 0, creditCents: 0 }];
    expect(codes(validateSettlementLines(neither, chart, { computed, policy }))).toContain('no_side');
  });

  it('refuses fewer than two lines and more than twenty', () => {
    const computed = computedFor(50_000, 0, 'lost');
    expect(codes(validateSettlementLines([], chart, { computed, policy }))).toContain('too_few_lines');
    expect(
      codes(validateSettlementLines(asInput(computed).slice(0, 1), chart, { computed, policy })),
    ).toContain('too_few_lines');
    const many: SettlementLineInput[] = [];
    for (let i = 0; i < SETTLEMENT_MAX_LINES; i += 1) {
      many.push({ accountExternalId: '300', debitCents: 1, creditCents: 0 });
    }
    many.push({ accountExternalId: '90', debitCents: 0, creditCents: SETTLEMENT_MAX_LINES });
    expect(codes(validateSettlementLines(many, chart, { computed, policy }))).toContain('too_many_lines');
  });

  it('lets the write-off go to another expense account, or be split across two', () => {
    const computed = computedFor(50_000, 0, 'lost', 'shortage');
    const moved = validateSettlementLines(
      [
        { accountExternalId: '300', debitCents: 50_000, creditCents: 0, memo: '  Agreed with the buyer ' },
        { accountExternalId: '90', debitCents: 0, creditCents: 50_000 },
      ],
      chart,
      { computed, policy },
    );
    expect(moved.ok).toBe(true);
    if (moved.ok) {
      expect(moved.lines[0]).toMatchObject({
        accountNameAsReported: 'Trade spend',
        accountTypeAsReported: 'Expense',
        memo: 'Agreed with the buyer',
      });
      expect(diffSettlementLines(moved.lines, computed)).toEqual([{ lineNo: 1, changes: ['account', 'memo'] }]);
    }
    const split = validateSettlementLines(
      [
        { accountExternalId: '200', debitCents: 30_000, creditCents: 0 },
        { accountExternalId: '300', debitCents: 20_000, creditCents: 0 },
        { accountExternalId: '90', debitCents: 0, creditCents: 50_000 },
      ],
      chart,
      { computed, policy },
    );
    expect(split.ok).toBe(true);
    if (split.ok) {
      expect(diffSettlementLines(split.lines, computed)).toEqual([
        { lineNo: 1, changes: ['amount'] },
        { lineNo: 2, changes: ['account', 'amount'] },
        { lineNo: 3, changes: ['added'] },
      ]);
    }
  });

  it('refuses an account the chart does not report, an inactive one, and no account', () => {
    const computed = computedFor(50_000, 0, 'lost');
    const withAccount = (id: string) =>
      validateSettlementLines(
        [
          { accountExternalId: id, debitCents: 50_000, creditCents: 0 },
          { accountExternalId: '90', debitCents: 0, creditCents: 50_000 },
        ],
        chart,
        { computed, policy },
      );
    expect(withAccount('9999')).toEqual({ ok: false, problems: [{ code: 'account_unknown', lineNo: 1 }] });
    expect(withAccount('301')).toEqual({ ok: false, problems: [{ code: 'account_inactive', lineNo: 1 }] });
    expect(withAccount(' ')).toEqual({ ok: false, problems: [{ code: 'account_missing', lineNo: 1 }] });
  });

  it('refuses a payable, a bank and a second receivable account', () => {
    const computed = computedFor(50_000, 0, 'lost');
    for (const id of ['33', '35', '85']) {
      const verdict = validateSettlementLines(
        [
          { accountExternalId: id, debitCents: 50_000, creditCents: 0 },
          { accountExternalId: '90', debitCents: 0, creditCents: 50_000 },
        ],
        chart,
        { computed, policy },
      );
      expect(verdict).toEqual({ ok: false, problems: [{ code: 'account_type_refused', lineNo: 1 }] });
    }
  });

  it("keeps the receivable lines the case's: not moved, not resized, not added, not split", () => {
    const computed = computedFor(50_000, 20_000, 'partial', 'shortage');
    const base = asInput(computed);
    // Resized, with the other side following so it still balances.
    const resized = base.map((l, i) =>
      i === 0 ? { ...l, debitCents: 10_000 } : i === 1 ? { ...l, creditCents: 10_000 } : l,
    );
    expect(codes(validateSettlementLines(resized, chart, { computed, policy }))).toEqual(['receivable_changed']);
    // Moved to an expense account.
    const moved = base.map((l, i) => (i === 0 ? { ...l, accountExternalId: '300' } : l));
    expect(codes(validateSettlementLines(moved, chart, { computed, policy }))).toEqual(['receivable_changed']);
    // A lost case has none, and gains none.
    const lost = computedFor(50_000, 0, 'lost');
    const added = [
      { accountExternalId: '84', debitCents: 50_000, creditCents: 0 },
      { accountExternalId: '90', debitCents: 0, creditCents: 50_000 },
    ];
    expect(codes(validateSettlementLines(added, chart, { computed: lost, policy }))).toEqual(['receivable_changed']);
    // Split in two is still not the computed line.
    const split = [
      { accountExternalId: '84', debitCents: 10_000, creditCents: 0 },
      { accountExternalId: '84', debitCents: 10_000, creditCents: 0 },
      ...base.slice(1),
    ];
    expect(codes(validateSettlementLines(split, chart, { computed, policy }))).toEqual(['receivable_changed']);
  });

  it("refuses the map's receivable account when the chart no longer reports it as one", () => {
    const computed = computedFor(50_000, 50_000, 'won');
    const retyped = chart.map((c) => (c.externalId === '84' ? { ...c, accountType: 'Other Current Asset' } : c));
    expect(codes(validateSettlementLines(asInput(computed), retyped, { computed, policy }))).toEqual([
      'account_type_refused',
    ]);
  });

  it('refuses an entry that moves more than the computed one, and accepts one that moves less', () => {
    const computed = computedFor(50_000, 0, 'lost');
    const padded = [
      ...asInput(computed),
      { accountExternalId: '300', debitCents: 1, creditCents: 0 },
      { accountExternalId: '90', debitCents: 0, creditCents: 1 },
    ];
    expect(codes(validateSettlementLines(padded, chart, { computed, policy }))).toEqual(['moves_more_than_computed']);
    // Netting a declined case's four lines to two moves less.
    const declined = computedFor(50_000, 0, 'declined');
    const netted = [
      { accountExternalId: '299', debitCents: 50_000, creditCents: 0 },
      { accountExternalId: '84', debitCents: 0, creditCents: 50_000 },
    ];
    expect(validateSettlementLines(netted, chart, { computed: declined, policy }).ok).toBe(true);
  });

  it('bounds a memo: 500 characters, one line, nothing when blank', () => {
    expect(normaliseSettlementMemo(undefined)).toEqual({ memo: undefined });
    expect(normaliseSettlementMemo('   ')).toEqual({ memo: undefined });
    expect(normaliseSettlementMemo(' ok ')).toEqual({ memo: 'ok' });
    expect(normaliseSettlementMemo('m'.repeat(SETTLEMENT_MEMO_MAX_LENGTH))).toEqual({
      memo: 'm'.repeat(SETTLEMENT_MEMO_MAX_LENGTH),
    });
    expect(normaliseSettlementMemo('m'.repeat(SETTLEMENT_MEMO_MAX_LENGTH + 1))).toEqual({
      problem: 'memo_too_long',
    });
    for (const bad of ['a\nb', 'a\tb', 'a\u0000b', 'a b', 'a\u0085b']) {
      expect(normaliseSettlementMemo(bad)).toEqual({ problem: 'memo_control_character' });
    }
    const computed = computedFor(50_000, 0, 'lost');
    const edited = asInput(computed);
    edited[1] = { ...(edited[1] as SettlementLineInput), memo: 'x'.repeat(501) };
    expect(validateSettlementLines(edited, chart, { computed, policy })).toEqual({
      ok: false,
      problems: [{ code: 'memo_too_long', lineNo: 2 }],
    });
  });

  it('a memo within bounds is kept exactly as typed, trimmed', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (text) => {
        const verdict = normaliseSettlementMemo(text);
        if ('problem' in verdict) {
          expect(/[\p{Cc}\p{Zl}\p{Zp}]/u.test(text.trim())).toBe(true);
        } else {
          expect(verdict.memo).toBe(text.trim() === '' ? undefined : text.trim());
        }
      }),
    );
  });
});

describe('diffSettlementLines', () => {
  it('names a computed line that is not there', () => {
    const computed = computedFor(50_000, 0, 'declined');
    expect(diffSettlementLines(computed.slice(0, 2), computed)).toEqual([
      { lineNo: 3, changes: ['removed'] },
      { lineNo: 4, changes: ['removed'] },
    ]);
  });
});

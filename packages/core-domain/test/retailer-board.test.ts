import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  foldRetailerBoard,
  retailerBoardTotals,
  retailerMatchKey,
  RetailerBoardError,
  type PayerTotals,
  type RawPayerGroup,
} from '../src';

/**
 * The board's fold. Property-tested because the claim is about every set of
 * rows the database could return: no cent and no case is gained or lost by
 * folding, each row lands in exactly one group, the groups come in the stated
 * order whatever order the rows arrived in, and a payer's cases come in the
 * database's order with the cut counted.
 */

const count = fc.integer({ min: 0, max: 5_000 });
const money = fc.integer({ min: 0, max: 100_000_000_000 });

const totals: fc.Arbitrary<PayerTotals> = fc
  .record({
    openCases: count,
    closedCases: count,
    declinedCases: count,
    awaitingApprovalCases: count,
    inDisputeCents: money,
    recoveredCents: money,
    recoveredUnrecordedCases: count,
    declinedCents: money,
    atRiskCases: count,
    atRiskCents: money,
    oldestOpenDays: fc.option(fc.integer({ min: -2, max: 4_000 }), { nil: undefined }),
    listableCases: count,
  })
  .map(({ oldestOpenDays, ...rest }) => ({
    ...rest,
    ...(oldestOpenDays !== undefined ? { oldestOpenDays } : {}),
  }));

/** Names that fold together, names that do not, and names with nothing left in them. */
const printedName = fc.oneof(
  fc.constantFrom(
    'Sysco',
    'SYSCO',
    'Sysco, Inc.',
    'sysco corp',
    'Sysco Eastern Maryland, LLC',
    'SYSCO EASTERN MARYLAND',
    'Walmart',
    'WALMART STORES, INC.',
    'Café Río',
    'Cafe Rio',
    '---',
    '***',
    'unknown',
  ),
  fc.string({ maxLength: 12 }),
);

type Row = RawPayerGroup<string>;

/**
 * Rows as the database returns them: at most one per debtor, one per exact
 * printed name, at most one for no name, and every listed case at a position
 * no other case has.
 */
const rawRows: fc.Arbitrary<Row[]> = fc
  .record({
    debtors: fc.uniqueArray(fc.uuid(), { maxLength: 6 }),
    debtorNames: fc.array(fc.constantFrom('Walmart', 'Sysco', 'KeHE', 'unknown'), {
      minLength: 6,
      maxLength: 6,
    }),
    printed: fc.uniqueArray(printedName, { maxLength: 10 }),
    withUnknown: fc.boolean(),
    figures: fc.array(fc.tuple(totals, fc.integer({ min: 0, max: 6 })), {
      minLength: 17,
      maxLength: 17,
    }),
  })
  .map(({ debtors, debtorNames, printed, withUnknown, figures }) => {
    let position = 0;
    let n = 0;
    const next = (): Pick<Row, 'totals' | 'cases' | 'caseCount'> => {
      const [t, listed] = figures[n++] as [PayerTotals, number];
      const cases = Array.from({ length: listed }, () => {
        position += 1;
        return { position, case: `case-${position}` };
      });
      return {
        // A row lists no more cases than it has to list.
        totals: { ...t, listableCases: Math.max(t.listableCases, listed) },
        cases,
        caseCount: t.openCases + t.closedCases + t.declinedCases,
      };
    };
    const rows: Row[] = [
      ...debtors.map((id, i) => ({ debtor: { id, name: debtorNames[i] as string }, ...next() })),
      ...printed.map((name) => ({ printedName: name, ...next() })),
      ...(withUnknown ? [next()] : []),
    ];
    // Positions are the database's over every case; interleave them so a
    // group's rows do not hold consecutive runs.
    const all = rows.flatMap((row) => row.cases.map((c) => c.position)).sort((a, b) => b - a);
    let k = 0;
    return rows.map((row) => ({
      ...row,
      cases: row.cases
        .map((c) => ({ ...c, position: (all[k++] as number) * 7 % 1009 + (all[k - 1] as number) * 1009 }))
        .sort((a, b) => a.position - b.position),
    }));
  });

const rowsAndAShuffle = rawRows.chain((rows) =>
  fc.tuple(fc.constant(rows), fc.shuffledSubarray(rows, { minLength: rows.length })),
);

const SUMMED = [
  'openCases',
  'closedCases',
  'declinedCases',
  'awaitingApprovalCases',
  'inDisputeCents',
  'recoveredCents',
  'recoveredUnrecordedCases',
  'declinedCents',
  'atRiskCases',
  'atRiskCents',
  'listableCases',
] as const;

function sumOf(rows: readonly { totals: PayerTotals }[], field: (typeof SUMMED)[number]): number {
  return rows.reduce((n, row) => n + row.totals[field], 0);
}

describe('the retailer board’s fold', () => {
  it('gains and loses nothing: every figure is the rows’ added up', () => {
    fc.assert(
      fc.property(rawRows, fc.integer({ min: 0, max: 10 }), (rows, limit) => {
        const groups = foldRetailerBoard(rows, limit);
        const board = retailerBoardTotals(groups);
        for (const field of SUMMED) {
          expect(sumOf(groups, field)).toBe(sumOf(rows, field));
          expect(board[field]).toBe(sumOf(rows, field));
          expect(Number.isSafeInteger(board[field])).toBe(true);
        }
        const ages = rows.flatMap((row) => row.totals.oldestOpenDays ?? []);
        expect(board.oldestOpenDays).toBe(ages.length === 0 ? undefined : Math.max(...ages));
      }),
    );
  });

  it('puts each row in exactly one group: a debtor’s own, a folded name’s, or unknown', () => {
    fc.assert(
      fc.property(rawRows, (rows) => {
        const groups = foldRetailerBoard(rows);
        expect(new Set(groups.map((g) => g.key)).size).toBe(groups.length);
        for (const row of rows) {
          const mine = groups.filter((g) =>
            row.debtor !== undefined
              ? g.kind === 'matched' && g.debtorId === row.debtor.id
              : row.printedName !== undefined
                ? g.kind === 'unmatched' && g.printedNames.includes(row.printedName)
                : g.kind === 'unknown',
          );
          expect(mine).toHaveLength(1);
        }
        for (const g of groups) {
          if (g.kind === 'matched') {
            // A debtor is never folded with another, even under one name.
            expect(rows.filter((row) => row.debtor?.id === g.debtorId)).toHaveLength(1);
            expect(g.printedNames).toEqual([]);
          }
          if (g.kind === 'unmatched') {
            const keys = new Set(g.printedNames.map(retailerMatchKey));
            expect(keys.size).toBe(1);
            // A name with nothing left after folding is never a match for another.
            if (keys.has('')) expect(g.printedNames).toHaveLength(1);
            expect(g.name).toBe(g.printedNames[0]);
            expect(g.debtorId).toBeUndefined();
          }
          if (g.kind === 'unknown') expect(g.name).toBeUndefined();
        }
        expect(groups.filter((g) => g.kind === 'unknown').length).toBeLessThanOrEqual(1);
      }),
    );
  });

  it('orders the groups matched, unmatched, unknown, and by dollars in dispute within each', () => {
    fc.assert(
      fc.property(rowsAndAShuffle, ([rows, shuffled]) => {
        const groups = foldRetailerBoard(rows);
        const rank = { matched: 0, unmatched: 1, unknown: 2 } as const;
        for (let i = 1; i < groups.length; i += 1) {
          const before = groups[i - 1] as (typeof groups)[number];
          const after = groups[i] as (typeof groups)[number];
          expect(rank[before.kind]).toBeLessThanOrEqual(rank[after.kind]);
          if (before.kind === after.kind) {
            expect(before.totals.inDisputeCents).toBeGreaterThanOrEqual(after.totals.inDisputeCents);
          }
        }
        // The order the rows arrived in decides nothing.
        expect(foldRetailerBoard(shuffled)).toEqual(groups);
      }),
    );
  });

  it('lists a group’s cases in the database’s order, cut at the limit and counted', () => {
    fc.assert(
      fc.property(rawRows, fc.integer({ min: 0, max: 10 }), (rows, limit) => {
        const position = new Map(rows.flatMap((row) => row.cases.map((c) => [c.case, c.position])));
        for (const g of foldRetailerBoard(rows, limit)) {
          const members = rows.filter((row) =>
            g.kind === 'matched'
              ? row.debtor?.id === g.debtorId
              : g.kind === 'unmatched'
                ? row.debtor === undefined &&
                  row.printedName !== undefined &&
                  g.printedNames.includes(row.printedName)
                : row.debtor === undefined && row.printedName === undefined,
          );
          const expected = members
            .flatMap((row) => row.cases)
            .sort((a, b) => a.position - b.position)
            .slice(0, limit)
            .map((c) => c.case);
          expect(g.cases).toEqual(expected);
          const places = g.cases.map((c) => position.get(c) as number);
          expect([...places].sort((a, b) => a - b)).toEqual(places);
          expect(g.cases.length).toBeLessThanOrEqual(limit);
          expect(g.moreCases).toBe(g.totals.listableCases - g.cases.length);
          expect(g.moreCases).toBeGreaterThanOrEqual(0);
        }
      }),
    );
  });

  it('names an unmatched group by the spelling most cases carry, and keeps the others', () => {
    const row = (printedName: string, caseCount: number, inDisputeCents: number): Row => ({
      printedName,
      caseCount,
      totals: {
        openCases: caseCount,
        closedCases: 0,
        declinedCases: 0,
        awaitingApprovalCases: 0,
        inDisputeCents,
        recoveredCents: 0,
        recoveredUnrecordedCases: 0,
        declinedCents: 0,
        atRiskCases: 0,
        atRiskCents: 0,
        oldestOpenDays: caseCount,
        listableCases: caseCount,
      },
      cases: [],
    });
    const [sysco, walmart, ...rest] = foldRetailerBoard([
      row('WALMART STORES, INC.', 1, 500),
      row('Sysco, Inc.', 1, 100),
      row('SYSCO', 3, 900),
      row('sysco corp', 3, 50),
    ]);
    expect(rest).toEqual([]);
    expect(sysco).toMatchObject({
      kind: 'unmatched',
      key: 'printed:sysco',
      name: 'SYSCO',
      printedNames: ['SYSCO', 'sysco corp', 'Sysco, Inc.'],
      moreCases: 7,
    });
    expect(sysco?.totals).toMatchObject({ openCases: 7, inDisputeCents: 1_050, oldestOpenDays: 3 });
    // "walmart stores" is not "walmart": whether they are one payer is data.
    expect(walmart).toMatchObject({ key: 'printed:walmart stores', name: 'WALMART STORES, INC.' });
  });

  it('refuses what the database never returns rather than counting it twice', () => {
    const empty: PayerTotals = {
      openCases: 0,
      closedCases: 0,
      declinedCases: 0,
      awaitingApprovalCases: 0,
      inDisputeCents: 0,
      recoveredCents: 0,
      recoveredUnrecordedCases: 0,
      declinedCents: 0,
      atRiskCases: 0,
      atRiskCents: 0,
      listableCases: 0,
    };
    const debtor = { id: 'd-1', name: 'Walmart' };
    const one: Row = { debtor, caseCount: 0, totals: empty, cases: [] };
    expect(() => foldRetailerBoard([one, one])).toThrow(RetailerBoardError);
    expect(() =>
      foldRetailerBoard([
        { caseCount: 0, totals: empty, cases: [] },
        { caseCount: 0, totals: empty, cases: [] },
      ]),
    ).toThrow(RetailerBoardError);
    expect(() => foldRetailerBoard([one], 1.5)).toThrow(RetailerBoardError);
    expect(() => foldRetailerBoard([one], -1)).toThrow(RetailerBoardError);
    // Money is integer cents (invariant 3): a fraction is refused, not rounded.
    expect(() =>
      foldRetailerBoard([{ ...one, totals: { ...empty, inDisputeCents: 10.5 } }]),
    ).toThrow();
    expect(() => foldRetailerBoard([{ ...one, totals: { ...empty, openCases: -1 } }])).toThrow(
      RetailerBoardError,
    );
  });
});

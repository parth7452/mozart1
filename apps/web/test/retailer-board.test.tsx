import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  foldRetailerBoard,
  retailerBoardTotals,
  type PayerGroup,
  type PayerTotals,
  type RawPayerGroup,
} from '@recouple/core-domain';
import type { CaseSummary, RetailerBoard as RetailerBoardRead } from '@recouple/store-postgres';
import {
  openPayerGroups,
  payerGroupTitle,
  payerLedgerHref,
  RetailerBoard,
} from '../components/retailer-board';
import { CaseTable } from '../components/case-table';
import { ledgerSearchHref } from '../lib/case-presentation';
import { NO_BOARD, NO_TOTALS } from './retailer-board-fixture';

/**
 * The board by payer, as a component: a pure function of what the store read.
 *
 * What a reviewer acts on is tested: each payer's figures as dollars and
 * counts, no rate anywhere, the three kinds of group said apart, the cases
 * under a payer in the order they were given, the cut said out loud, and that
 * a name printed on somebody else's document is text and not markup.
 */

const today = new Date('2026-09-23T15:00:00Z');

function summary(id: string, overrides: Partial<CaseSummary> = {}): CaseSummary {
  return {
    deductionId: `${id.padEnd(8, '0')}-1111-2222-3333-444444444444`,
    state: 'classified',
    claimId: `CLM-${id}`,
    deductionAmountCents: 10_000,
    discoveredVia: 'notice',
    documentCount: 2,
    createdAt: '2026-09-01',
    ...overrides,
  };
}

function raw(
  who: Pick<RawPayerGroup<CaseSummary>, 'debtor' | 'printedName'>,
  totals: Partial<PayerTotals>,
  listed: readonly [number, CaseSummary][] = [],
): RawPayerGroup<CaseSummary> {
  const full = { ...NO_TOTALS, ...totals };
  return {
    ...who,
    caseCount: full.openCases + full.closedCases + full.declinedCases,
    totals: { ...full, listableCases: Math.max(full.listableCases, listed.length) },
    cases: listed.map(([position, c]) => ({ position, case: c })),
  };
}

/** A board the way the store builds one: database rows through the fold. */
function boardOf(rows: readonly RawPayerGroup<CaseSummary>[], casesPerGroup = 8): RetailerBoardRead {
  const groups = foldRetailerBoard(rows, casesPerGroup);
  return { groups, totals: retailerBoardTotals(groups), casesPerGroup };
}

const walmart = raw(
  { debtor: { id: 'dddddddd-0000-0000-0000-000000000001', name: 'Walmart' } },
  {
    openCases: 3,
    closedCases: 2,
    declinedCases: 1,
    awaitingApprovalCases: 1,
    inDisputeCents: 3_611_100,
    recoveredCents: 1_100_050,
    declinedCents: 250_000,
    atRiskCases: 1,
    atRiskCents: 1_000_000,
    oldestOpenDays: 100,
    listableCases: 4,
  },
  [
    [1, summary('aaaa', { disputeDeadline: '2026-09-26', deductionAmountCents: 1_000_000 })],
    [4, summary('bbbb', { state: 'awaiting_approval', disputeDeadline: '2026-10-23' })],
    [9, summary('cccc', { declined: true })],
    [12, summary('dddd', { state: 'submitted' })],
  ],
);
const syscoLlc = raw(
  { printedName: 'Sysco Eastern Maryland, LLC' },
  { openCases: 1, inDisputeCents: 600_000, oldestOpenDays: 7 },
  [[6, summary('eeee')]],
);
const syscoCaps = raw(
  { printedName: 'SYSCO EASTERN MARYLAND' },
  { openCases: 2, inDisputeCents: 450_000, oldestOpenDays: 2 },
  [
    [3, summary('ffff')],
    [20, summary('abab')],
  ],
);
const target = raw({ printedName: 'Target Corp' }, { closedCases: 1 });
const unknown = raw({}, { openCases: 1, inDisputeCents: 30_000, oldestOpenDays: 3 }, [
  [30, summary('acac')],
]);

function render(board: RetailerBoardRead): string {
  return renderToStaticMarkup(<RetailerBoard board={board} today={today} />);
}

/** The text of the page with the tags out, so a sentence split by markup still reads. */
function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

/** One payer's `<details>`, by its name. */
function section(html: string, name: string): string {
  const found = html
    .split('<details')
    .slice(1)
    .filter((part) => part.includes(`<span class="board-name">${name}</span>`));
  if (found.length !== 1) throw new Error(`${found.length} sections named ${name}`);
  return found[0] as string;
}

describe('the retailer board', () => {
  const board = boardOf([unknown, target, syscoLlc, walmart, syscoCaps]);
  const html = render(board);

  it('draws a section per payer: matched by dollars in dispute, then unmatched, then unknown', () => {
    const names = [...html.matchAll(/<span class="board-name">([^<]*)<\/span>/g)].map((m) => m[1]);
    expect(names).toEqual([
      'Walmart',
      'SYSCO EASTERN MARYLAND',
      'Target Corp',
      'Retailer unknown',
    ]);
    expect(html).toContain('id="retailers"');
    expect(text(html)).toContain(
      '4 payers · $46,911.00 in dispute across 7 cases · $11,000.50 recovered',
    );
  });

  it('shows each payer’s figures as counts and dollars, formatted from cents', () => {
    const w = text(section(html, 'Walmart'));
    expect(w).toContain('Open 3');
    expect(w).toContain('In dispute $36,111.00');
    expect(w).toContain('Awaiting approval 1');
    expect(w).toContain('Due in 14 days or overdue 1 · $10,000.00');
    expect(w).toContain('Closed 2');
    expect(w).toContain('Recovered $11,000.50');
    expect(w).toContain('Oldest open case opened 100 days ago.');
    expect(w).toContain('1 declined ($2,500.00), not counted as open.');

    const t = text(section(html, 'Target Corp'));
    expect(t).toContain('Open 0');
    expect(t).toContain('In dispute $0.00');
    expect(t).toContain('No open case.');
    // Nothing is at risk, so no dollar figure is hung on the zero.
    expect(t).toContain('Due in 14 days or overdue 0 Closed 1');
  });

  it('never shows a rate: dollars and counts only (ADR 0030)', () => {
    // The words a reader sees; a link's own `%20` is not one of them.
    expect(text(html)).not.toContain('%');
    expect(text(html).toLowerCase()).not.toMatch(/\brate\b/);
  });

  it('says a win with no recorded amount is not in the recovered figure', () => {
    const one = render(
      boardOf([raw({ printedName: 'KeHE' }, { closedCases: 2, recoveredUnrecordedCases: 1 })]),
    );
    expect(text(one)).toContain(
      '1 case won or partly won with no amount recorded, not in the recovered figure.',
    );
    expect(text(html)).not.toContain('no amount recorded');
  });

  it('marks an unmatched name, lists its other spellings, and says how link:retailer fixes it', () => {
    const s = section(html, 'SYSCO EASTERN MARYLAND');
    expect(s).toContain('<span class="board-tag">not matched</span>');
    expect(s).toContain('<code>pnpm link:retailer</code>');
    expect(text(s)).toContain('docs/ONBOARDING.md, section 3');
    expect(text(s)).toContain('Also printed as Sysco Eastern Maryland, LLC .');
    expect(s).toContain('href="/?q=Sysco%20Eastern%20Maryland%2C%20LLC#ledger"');
    // The two spellings' figures are one payer's.
    expect(text(s)).toContain('Open 3');
    expect(text(s)).toContain('In dispute $10,500.00');

    const w = section(html, 'Walmart');
    expect(w).not.toContain('board-tag');
    expect(w).not.toContain('link:retailer');

    const u = section(html, 'Retailer unknown');
    expect(u).not.toContain('board-tag');
    expect(text(u)).toContain('No payer name was read from the documents on these cases.');
    // Nothing to search the ledger by, so no link pretends to.
    expect(u).not.toContain('#ledger');
  });

  it('links each payer to the ledger searched by its name', () => {
    expect(section(html, 'Walmart')).toContain('href="/?q=Walmart#ledger"');
    expect(text(section(html, 'Walmart'))).toContain('Every Walmart case in the ledger');
    expect(section(html, 'SYSCO EASTERN MARYLAND')).toContain(
      'href="/?q=SYSCO%20EASTERN%20MARYLAND#ledger"',
    );
    expect(section(html, 'Target Corp')).toContain('href="/?q=Target%20Corp#ledger"');
  });

  it('lists a payer’s cases in the order the store gave them, each linked by its claim', () => {
    const w = section(html, 'Walmart');
    const claims = [...w.matchAll(/href="\/cases\/([0-9a-f]{4})/g)].map((m) => m[1]);
    expect(claims).toEqual(['aaaa', 'bbbb', 'cccc', 'dddd']);
    expect(w).toContain('>CLM-aaaa</a>');
    expect(w).toContain('<span class="pill due-soon">3d left</span>');
    expect(w).toContain('awaiting approval');
    expect(w).toContain('<span class="pill declined">declined</span>');
    // The payer is said once, in the heading; a row does not repeat it.
    expect(w).not.toContain('Customer / retailer');
    expect(w).not.toContain('no name read');

    // Two spellings' cases are one list, by the database's position.
    const s = section(html, 'SYSCO EASTERN MARYLAND');
    expect([...s.matchAll(/href="\/cases\/([0-9a-f]{4})/g)].map((m) => m[1])).toEqual([
      'ffff',
      'eeee',
      'abab',
    ]);
    // A payer with nothing to list draws no table.
    expect(section(html, 'Target Corp')).not.toContain('<table');
  });

  it('says how many cases a payer’s list leaves out, and where they are', () => {
    const cut = render(boardOf([walmart, unknown], 2));
    const w = section(cut, 'Walmart');
    expect([...w.matchAll(/href="\/cases\/([0-9a-f]{4})/g)].map((m) => m[1])).toEqual([
      'aaaa',
      'bbbb',
    ]);
    expect(text(w)).toContain('2 more not listed here; these are the most urgent. See them in the ledger');
    expect(text(section(html, 'Walmart'))).not.toContain('more not listed');

    // The store counted more than it listed: the page says so even with no link.
    const many = render(boardOf([{ ...unknown, totals: { ...unknown.totals, listableCases: 40 } }]));
    expect(text(many)).toContain('39 more not listed here; these are the most urgent.');
    expect(many).not.toContain('See them in the ledger');
  });

  it('opens the payers with a deadline to watch, else the first with a case, and needs no script', () => {
    expect(section(html, 'Walmart').startsWith(' class="board-group kind-matched" open=""')).toBe(true);
    expect(section(html, 'SYSCO EASTERN MARYLAND')).not.toContain('open=""');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<form');

    const calm = boardOf([target, syscoLlc, unknown]);
    expect([...openPayerGroups(calm.groups)]).toEqual(['printed:sysco eastern maryland']);
    expect([...openPayerGroups(boardOf([target]).groups)]).toEqual([]);
    expect([...openPayerGroups(board.groups)]).toEqual([
      'debtor:dddddddd-0000-0000-0000-000000000001',
    ]);
  });

  it('renders a printed name as text, and links only a name the ledger would search for', () => {
    const hostile = '<img src=x onerror=alert(1)> & "Co"';
    const out = render(
      boardOf([
        raw({ printedName: hostile }, { openCases: 1 }, [[1, summary('aaaa')]]),
        raw({ printedName: `Bad\u0000Name` }, { openCases: 1 }),
        raw({ printedName: 'x'.repeat(201) }, { openCases: 1 }),
      ]),
    );
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;Co&quot;');
    expect(out).toContain(`href="/?q=${encodeURIComponent(hostile)}#ledger"`);
    // A control character or an over-long name: the page would drop the query
    // and show every case, so the board offers no link at all.
    expect([...out.matchAll(/#ledger"/g)]).toHaveLength(1);

    const group = (name: string | undefined, kind: PayerGroup<unknown>['kind']) =>
      ({ kind, key: 'k', ...(name === undefined ? {} : { name }), printedNames: [], totals: NO_TOTALS, cases: [], moreCases: 0 }) as PayerGroup<unknown>;
    expect(payerLedgerHref(group('Walmart', 'matched'))).toBe('/?q=Walmart#ledger');
    expect(payerLedgerHref(group(undefined, 'unknown'))).toBeUndefined();
    expect(payerLedgerHref(group('   ', 'unmatched'))).toBeUndefined();
    expect(payerGroupTitle(group(undefined, 'unknown'))).toBe('Retailer unknown');
    expect(ledgerSearchHref('  KeHE  ')).toBe('/?q=KeHE#ledger');
  });

  it('says so when there is no case at all', () => {
    const empty = render(NO_BOARD);
    expect(text(empty)).toContain('No payers yet');
    expect(text(empty)).toContain('A payer appears here with its first case.');
    expect(empty).not.toContain('<details');
  });
});

describe('the ledger’s rows after sharing one with the board', () => {
  it('still names the payer first and links the case by it', () => {
    const row = summary('aaaa', { debtorName: 'Walmart', invoiceNumber: 'INV-1' });
    const html = renderToStaticMarkup(
      <CaseTable cases={[row]} matching={1} filter={{}} todayISO={today.toISOString()} />,
    );
    expect(html).toContain(
      `<td><a class="customer-name case-name-link" href="/cases/${row.deductionId}">Walmart</a></td>`,
    );
    expect(html).toContain('<span class="mono case-claim">CLM-aaaa</span>');
    expect(html).toContain('invoice INV-1');
    expect(html).toContain('<th scope="col">Customer / retailer</th>');
  });
});

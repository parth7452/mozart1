import Link from 'next/link';
import { DUE_SOON_DAYS, type PayerGroup, type PayerTotals } from '@recouple/core-domain';
import type { CaseSummary, RetailerBoard as RetailerBoardRead } from '@recouple/store-postgres';
import { money } from '../lib/format';
import { ledgerSearchHref } from '../lib/case-presentation';
import { CaseRow } from './case-table';

/**
 * The case list, by payer: a section per retailer or distributor, each with
 * its figures and its most urgent cases.
 *
 * A pure function of what `PostgresStore.retailerBoard` returned. Nothing is
 * counted, summed, divided or ordered here: the database counted and summed,
 * `foldRetailerBoard` grouped and ordered, and the cases under a payer are in
 * the review queue's order as the database read them. This file only words it
 * and formats cents. There is no rate anywhere on it (ADR 0030): dollars in
 * dispute and dollars recovered are shown side by side and never divided.
 *
 * Each section is a `<details>`, so it opens and closes with no script. Every
 * member sees the board, `read_only` included; it offers no action of its own.
 * Payer names and claim ids came off somebody else's page and are rendered as
 * text.
 */

function count(n: number): string {
  return n.toLocaleString('en-US');
}

function cases(n: number): string {
  return `${count(n)} case${n === 1 ? '' : 's'}`;
}

/** What a group is called, in words, whichever kind it is. */
export function payerGroupTitle(group: PayerGroup<unknown>): string {
  return group.kind === 'unknown' ? 'Retailer unknown' : (group.name ?? 'Retailer unknown');
}

/**
 * Where a group's cases are in the ledger: its search, by the payer's name.
 * Nothing for a group with no name to search by, or a name the search would
 * drop (`ledgerFilterFrom`), so the board never links to an unfiltered ledger
 * while saying it is this payer's.
 */
export function payerLedgerHref(group: PayerGroup<unknown>): string | undefined {
  return group.kind === 'unknown' || group.name === undefined
    ? undefined
    : ledgerSearchHref(group.name);
}

/**
 * Which sections start open: every payer with a case due soon or overdue, and
 * otherwise the first payer that has a case to list — so the page never opens
 * on a board with every section shut.
 */
export function openPayerGroups(groups: readonly PayerGroup<unknown>[]): ReadonlySet<string> {
  const atRisk = groups.filter((group) => group.totals.atRiskCases > 0 && group.cases.length > 0);
  if (atRisk.length > 0) return new Set(atRisk.map((group) => group.key));
  const first = groups.find((group) => group.cases.length > 0);
  return new Set(first === undefined ? [] : [first.key]);
}

function Figures({ totals }: { totals: PayerTotals }) {
  return (
    <dl className="board-figures">
      <div>
        <dt>Open</dt>
        <dd>{count(totals.openCases)}</dd>
      </div>
      <div>
        <dt>In dispute</dt>
        <dd>{money(totals.inDisputeCents)}</dd>
      </div>
      <div>
        <dt>Awaiting approval</dt>
        <dd>{count(totals.awaitingApprovalCases)}</dd>
      </div>
      <div className={totals.atRiskCases > 0 ? 'at-risk' : undefined}>
        <dt>Due in {DUE_SOON_DAYS} days or overdue</dt>
        <dd>
          {count(totals.atRiskCases)}
          {totals.atRiskCases > 0 ? (
            <span className="board-figure-note"> · {money(totals.atRiskCents)}</span>
          ) : null}
        </dd>
      </div>
      <div>
        <dt>Closed</dt>
        <dd>{count(totals.closedCases)}</dd>
      </div>
      <div>
        <dt>Recovered</dt>
        <dd>{money(totals.recoveredCents)}</dd>
      </div>
    </dl>
  );
}

function Group({
  group,
  open,
  today,
}: {
  group: PayerGroup<CaseSummary>;
  open: boolean;
  today: Date;
}) {
  const title = payerGroupTitle(group);
  const href = payerLedgerHref(group);
  const { totals } = group;
  const otherSpellings = group.printedNames.slice(1);
  return (
    <details className={`board-group kind-${group.kind}`} open={open}>
      <summary>
        <span className="board-who">
          <span className="board-name">{title}</span>
          {group.kind === 'unmatched' ? <span className="board-tag">not matched</span> : null}
        </span>
        <Figures totals={totals} />
      </summary>
      <div className="board-body">
        <p className="board-notes">
          {totals.oldestOpenDays === undefined
            ? 'No open case.'
            : totals.oldestOpenDays <= 0
              ? 'Oldest open case opened today.'
              : `Oldest open case opened ${count(totals.oldestOpenDays)} day${
                  totals.oldestOpenDays === 1 ? '' : 's'
                } ago.`}
          {totals.declinedCases > 0
            ? ` ${count(totals.declinedCases)} declined (${money(totals.declinedCents)}), not counted as open.`
            : null}
          {totals.recoveredUnrecordedCases > 0
            ? ` ${cases(totals.recoveredUnrecordedCases)} won or partly won with no amount recorded, not in the recovered figure.`
            : null}
          {href === undefined ? null : (
            <>
              {' '}
              <Link href={href} className="text-button">
                Every {title} case in the ledger
              </Link>
            </>
          )}
        </p>
        {group.kind === 'unmatched' ? (
          <p className="board-notes">
            No customer record answers to this name, so these cases are grouped by the name as
            printed. An operator links it to a customer with <code>pnpm link:retailer</code>{' '}
            (docs/ONBOARDING.md, section 3), which adds the name as an alias and re-checks the cases
            already open.
            {otherSpellings.length === 0 ? null : (
              <>
                {' '}
                Also printed as{' '}
                {otherSpellings.map((spelling, index) => {
                  const spellingHref = ledgerSearchHref(spelling);
                  return (
                    <span key={spelling}>
                      {index === 0 ? null : ', '}
                      {spellingHref === undefined ? (
                        spelling
                      ) : (
                        <Link href={spellingHref} className="text-button">
                          {spelling}
                        </Link>
                      )}
                    </span>
                  );
                })}
                .
              </>
            )}
          </p>
        ) : null}
        {group.kind === 'unknown' ? (
          <p className="board-notes">
            No payer name was read from the documents on these cases. Each one says so on its own
            page.
          </p>
        ) : null}
        {group.cases.length === 0 ? null : (
          <div
            className="table-scroll"
            role="region"
            aria-label={`${title} cases`}
            tabIndex={0}
          >
            <table className="cases">
              <thead>
                <tr>
                  <th scope="col">Claim</th>
                  <th scope="col" className="money">
                    Deducted
                  </th>
                  <th scope="col">State</th>
                  <th scope="col">Evidence</th>
                  <th scope="col">Deadline</th>
                </tr>
              </thead>
              <tbody>
                {group.cases.map((row) => (
                  <CaseRow key={row.deductionId} row={row} today={today} payer={false} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {group.moreCases > 0 ? (
          <p className="queue-more">
            {count(group.moreCases)} more not listed here; these are the most urgent.
            {href === undefined ? null : (
              <>
                {' '}
                <Link href={href} className="text-button">
                  See them in the ledger
                </Link>
              </>
            )}
          </p>
        ) : null}
      </div>
    </details>
  );
}

export function RetailerBoard({ board, today }: { board: RetailerBoardRead; today: Date }) {
  const { groups, totals } = board;
  const open = openPayerGroups(groups);
  return (
    <section id="retailer-board" className="card ledger board" aria-labelledby="retailer-board-title">
      <div className="ledger-heading">
        <div>
          <h2 id="retailer-board-title">By retailer or distributor</h2>
          <p className="ledger-summary">
            {groups.length === 0
              ? 'No payers yet'
              : `${count(groups.length)} payer${groups.length === 1 ? '' : 's'} · ` +
                `${money(totals.inDisputeCents)} in dispute across ${cases(totals.openCases)} · ` +
                `${money(totals.recoveredCents)} recovered`}
          </p>
        </div>
        <span className="ledger-tag">BY PAYER</span>
      </div>
      {groups.length === 0 ? (
        <p className="empty">
          A payer appears here with its first case. Cases are grouped under the retailer or
          distributor that took the deduction.
        </p>
      ) : (
        groups.map((group) => (
          <Group key={group.key} group={group} open={open.has(group.key)} today={today} />
        ))
      )}
    </section>
  );
}

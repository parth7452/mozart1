import Link from 'next/link';
import { CASE_STATES } from '@recouple/core-domain';
import { CASE_SEARCH_QUERY_MAX, type CaseSummary } from '@recouple/store-postgres';
import { deadline, money, retailer } from '../lib/format';
import { isFiltered, stateLabel, type LedgerFilter } from '../lib/case-presentation';

/**
 * The ledger's table, with the search that chose its rows.
 *
 * The search is a GET form to this page, so it reaches every case the tenant
 * has through `PostgresStore.searchCases`, rather than filtering the rows
 * already here — which were the newest hundred, so an older case could not be
 * found at all. There is no filtering in the browser on top: a second matcher
 * over the loaded rows would have to agree with the SQL's in every case, and a
 * row the database returned would vanish wherever the two disagreed. Every
 * state is offered, from `CASE_STATES`, not only the states among the rows.
 */
export function CaseTable({
  cases,
  matching,
  filter,
  todayISO,
}: {
  /** The rows the store listed for `filter`, newest first. */
  cases: readonly CaseSummary[];
  /** How many cases answer to `filter`, however many `cases` holds. */
  matching: number;
  filter: LedgerFilter;
  todayISO: string;
}) {
  const today = new Date(todayISO);
  const filtered = isFiltered(filter);
  return (
    <>
      <form className="table-tools" role="search" method="get" action="/#ledger">
        <span className="table-tools-title">Search the ledger</span>
        <label className="search-control">
          <span aria-hidden="true">⌕</span>
          <span className="sr-only">Search deductions</span>
          <input
            type="search"
            name="q"
            placeholder="Claim, invoice, or retailer"
            defaultValue={filter.query ?? ''}
            maxLength={CASE_SEARCH_QUERY_MAX}
          />
        </label>
        <label className="state-control">
          <span className="sr-only">Filter by state</span>
          <select name="state" defaultValue={filter.state ?? ''}>
            <option value="">All states</option>
            {CASE_STATES.map((value) => (
              <option key={value} value={value}>
                {stateLabel(value)}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="search-submit">
          Search
        </button>
        {filtered ? (
          <Link href="/#ledger" className="text-button">
            Clear
          </Link>
        ) : null}
        <span className="results-count" role="status">
          {cases.length.toLocaleString('en-US')} of {matching.toLocaleString('en-US')} case
          {matching === 1 ? '' : 's'}
        </span>
      </form>
      <div className="table-scroll" role="region" aria-label="Deductions table" tabIndex={0}>
        <table className="cases">
          <thead>
            <tr>
              <th scope="col">Customer / retailer</th>
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
            {cases.map((row) => (
              <CaseRow key={row.deductionId} row={row} today={today} />
            ))}
          </tbody>
        </table>
      </div>
      {cases.length === 0 ? (
        <div className="empty filter-empty">
          <strong>No matching deductions</strong>
          <p>Try another claim, invoice, customer, or state.</p>
          <Link href="/#ledger" className="text-button">
            Clear filters
          </Link>
        </div>
      ) : null}
      <div className="table-foot">
        <span>Every claim has a paper trail.</span>
        <span>Amounts in USD</span>
      </div>
    </>
  );
}

/**
 * One case as a table row: the ledger's, and the retailer board's.
 *
 * With `payer` the first cell names the customer or retailer and links to the
 * case, as the ledger has always shown it. Without, that cell is left out —
 * the board prints the payer once, above its cases — and the claim is the
 * link. Everything a row prints came off somebody else's page and is text.
 */
export function CaseRow({
  row,
  today,
  payer = true,
}: {
  row: CaseSummary;
  today: Date;
  /** Whether the row names its payer. The board's rows sit under one already. */
  payer?: boolean;
}) {
  const due = deadline(row.disputeDeadline, today);
  const who = retailer(row, '—');
  const claim = row.claimId ?? row.deductionId.slice(0, 8);
  return (
    <tr className={payer ? 'case-row' : 'case-row no-payer'}>
      {payer ? (
        <td data-label="Retailer">
          <Link
            href={`/cases/${row.deductionId}`}
            className="customer-name case-name-link"
            aria-label={who.name === '—'
              ? `Review case ${claim}`
              : undefined}
          >
            {who.name === '—' ? claim : who.name}
          </Link>
          {/* Nothing was read for a name: say so, and link by the claim. */}
          {who.name === '—' ? <span className="unmatched">— no name read</span> : null}
          {who.matched ? null : <span className="unmatched">not matched</span>}
        </td>
      ) : null}
      <td data-label="Claim">
        {payer ? (
          <span className="mono case-claim">{claim}</span>
        ) : (
          <Link href={`/cases/${row.deductionId}`} className="mono case-claim case-name-link">
            {claim}
          </Link>
        )}
        {row.invoiceNumber === undefined ? null : (
          <div className="unmatched" style={{ marginLeft: 0 }}>
            invoice {row.invoiceNumber}
          </div>
        )}
      </td>
      <td className="money" data-label="Deducted">{money(row.deductionAmountCents)}</td>
      <td data-label="State">
        <span className={`pill state-${row.state}`}>
          {stateLabel(row.state)}
        </span>
        {/* A decline moves no state (ADR 0043): without this a
            declined case reads as a `classified` one waiting. */}
        {row.declined === true ? <span className="pill declined">declined</span> : null}
      </td>
      <td className="evidence-count" data-label="Evidence">
        {row.documentCount} doc{row.documentCount === 1 ? '' : 's'}
      </td>
      <td data-label="Deadline">
        {due === undefined ? (
          '—'
        ) : (
          <span className={`pill ${due.tone}`}>{due.label}</span>
        )}
      </td>
    </tr>
  );
}

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
        <label className="search-control">
          <span aria-hidden="true">⌕</span>
          <span className="sr-only">Search deductions</span>
          <input
            type="search"
            name="q"
            placeholder="Search claim, invoice or customer…"
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
            {cases.map((row) => {
              const due = deadline(row.disputeDeadline, today);
              const who = retailer(row, '—');
              return (
                <tr key={row.deductionId}>
                  <td>
                    <Link
                      href={`/cases/${row.deductionId}`}
                      className="customer-name case-name-link"
                      aria-label={who.name === '—'
                        ? `Review case ${row.claimId ?? row.deductionId.slice(0, 8)}`
                        : undefined}
                    >
                      {who.name}
                    </Link>
                    {who.matched ? null : <span className="unmatched">not matched</span>}
                  </td>
                  <td>
                    <span className="mono case-claim">{row.claimId ?? row.deductionId.slice(0, 8)}</span>
                    {row.invoiceNumber === undefined ? null : (
                      <div className="unmatched" style={{ marginLeft: 0 }}>
                        invoice {row.invoiceNumber}
                      </div>
                    )}
                  </td>
                  <td className="money">{money(row.deductionAmountCents)}</td>
                  <td>
                    <span className={`pill state-${row.state}`}>
                      {stateLabel(row.state)}
                    </span>
                  </td>
                  <td className="evidence-count">
                    {row.documentCount} doc{row.documentCount === 1 ? '' : 's'}
                  </td>
                  <td>
                    {due === undefined ? (
                      '—'
                    ) : (
                      <span className={`pill ${due.tone}`}>{due.label}</span>
                    )}
                  </td>
                </tr>
              );
            })}
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

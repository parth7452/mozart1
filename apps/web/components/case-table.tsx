'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { CaseSummary } from '@recouple/store-postgres';
import { deadline, money, retailer } from '../lib/format';
import { filterCases } from '../lib/case-presentation';

/** Filters only rows already authorised and read by the server route. */
export function CaseTable({
  cases,
  todayISO,
}: {
  cases: readonly CaseSummary[];
  todayISO: string;
}) {
  const [query, setQuery] = useState('');
  const [state, setState] = useState('all');
  const rows = filterCases(cases, query, state);
  const today = new Date(todayISO);
  const states = [...new Set(cases.map((row) => row.state))].sort();
  return (
    <>
      <div className="table-tools">
        <label className="search-control">
          <span aria-hidden="true">⌕</span>
          <span className="sr-only">Search deductions</span>
          <input
            type="search"
            placeholder="Search claim or customer…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label className="state-control">
          <span className="sr-only">Filter by state</span>
          <select value={state} onChange={(event) => setState(event.target.value)}>
            <option value="all">All states</option>
            {states.map((value) => (
              <option key={value} value={value}>
                {value.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </label>
        <span className="results-count" role="status">
          {rows.length} of {cases.length} cases
        </span>
      </div>
      <div className="table-scroll" role="region" aria-label="Deductions table" tabIndex={0}>
        <table className="cases">
          <thead>
            <tr>
              <th scope="col">Claim</th>
              <th scope="col">Customer / retailer</th>
              <th scope="col" className="money">
                Deducted
              </th>
              <th scope="col">State</th>
              <th scope="col">Evidence</th>
              <th scope="col">Deadline</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const due = deadline(row.disputeDeadline, today);
              const who = retailer(row, '—');
              return (
                <tr key={row.deductionId}>
                  <td>
                    <Link href={`/cases/${row.deductionId}`} className="mono claim-link">
                      {row.claimId ?? row.deductionId.slice(0, 8)}
                    </Link>
                    {row.invoiceNumber === undefined ? null : (
                      <div className="unmatched" style={{ marginLeft: 0 }}>
                        invoice {row.invoiceNumber}
                      </div>
                    )}
                  </td>
                  <td>
                    <span className="customer-name">{who.name}</span>
                    {who.matched ? null : <span className="unmatched">not matched</span>}
                  </td>
                  <td className="money">{money(row.deductionAmountCents)}</td>
                  <td>
                    <span className={`pill state-${row.state}`}>
                      {row.state.replace(/_/g, ' ')}
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
      {rows.length === 0 ? (
        <div className="empty filter-empty">
          <strong>No matching deductions</strong>
          <p>Try another claim, customer, or state.</p>
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setQuery('');
              setState('all');
            }}
          >
            Clear filters
          </button>
        </div>
      ) : null}
      <div className="table-foot">
        <span>Every claim has a paper trail.</span>
        <span>Amounts in USD</span>
      </div>
    </>
  );
}

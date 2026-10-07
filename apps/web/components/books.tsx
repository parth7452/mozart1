import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  DEDUCTION_ACCOUNT_NAME_WORDS,
  DEDUCTION_ACCOUNT_SUBTYPES,
  GENERAL_LEDGER_MAX_WINDOW_DAYS,
  RECONCILIATION_CANDIDATE_DAYS,
  trialBalanceDifferenceCents,
  type BooksAccountRole,
  type BooksCase,
  type GeneralLedgerAccount,
  type GeneralLedgerLine,
  type ReconciliationRow,
  type TrialBalance,
} from '@recouple/core-domain';
import type {
  BooksChart,
  BooksFailure,
  BooksLedger,
  BooksReconciliation,
  BooksRequest,
  BooksSection,
  ConnectionBooks,
} from '../lib/books';
import { money } from '../lib/format';
import { WorkspaceShell } from './workspace-shell';
import type { Viewer } from './case-list';

/**
 * The Books page, as a pure function of what was read (ADR 0066 §1–§3): each
 * connected company's chart of accounts, its trial balance as of today, its
 * general ledger over a window, and the deductions reconciliation.
 *
 * Three rules hold everywhere here. **Read, not kept** — every figure is what
 * the accounting system answered while the page loaded, and the page says so;
 * nothing on it has an action. **No money arithmetic** — every figure is cents
 * a reader or `core-domain` produced; this file only formats them. **Nothing
 * is asserted that arithmetic does not force** — a ledger line "matches" a
 * case only on the same cents and the same day, one to one; anything else is
 * a candidate and is labelled as one.
 */

/** How many postings one account lists. The count is always shown whole. */
export const LEDGER_LINES_SHOWN_PER_ACCOUNT = 500;

/** Where the proposal to keep snapshots is written down. */
export const SNAPSHOT_ADR_URL =
  'https://github.com/parth7452/mozart1/blob/main/docs/adr/0066-the-books-are-read-through-and-a-snapshot-is-proposed.md';

const FAILURE_WORDS: Readonly<Record<BooksFailure, string>> = {
  sign_in_refused:
    'QuickBooks refused the stored sign-in. An owner reconnects the company on Settings → QuickBooks.',
  sign_in_expired:
    'The stored QuickBooks sign-in has expired. An owner reconnects the company on Settings → QuickBooks.',
  not_authorised: 'QuickBooks did not accept the stored sign-in for this read.',
  refresh_needs_writer:
    'The QuickBooks sign-in is due its hourly refresh, and a read-only member’s view cannot ' +
    'store one. It will read once an owner, approver or analyst has opened this page, or after ' +
    'the next daily sync.',
  rate_limited: 'QuickBooks is rate-limiting this company. Try again in a few minutes.',
  busy: 'This company’s sign-in is being changed by another request. Try again in a minute.',
  chart_too_large:
    'The chart of accounts is longer than this page reads in one go, so none of it is shown ' +
    'rather than part of it.',
  report_too_large:
    'The report is larger than one read returns, so none of it is shown rather than part of ' +
    'it. Choose a shorter window, or the deductions accounts only.',
  unexpected_shape:
    'QuickBooks answered in a shape this page does not read, so nothing is shown rather than ' +
    'part of it. This is ours to fix, not yours.',
  window_refused: 'QuickBooks was not asked: the window is not one this page reads.',
  credential_unreadable: 'The stored QuickBooks sign-in could not be opened.',
  unreachable: 'QuickBooks did not answer, or answered with an error. Try again in a few minutes.',
  failed: 'This could not be read. Nothing is shown rather than part of it.',
};

const WINDOW_REFUSED_WORDS: Readonly<Record<NonNullable<BooksRequest['windowRefused']>, string>> = {
  not_dates: 'The window in the address was not two dates, so the default window is shown.',
  backwards: 'The window in the address ended before it began, so the default window is shown.',
  too_long:
    `A general ledger is read over at most ${GENERAL_LEDGER_MAX_WINDOW_DAYS} days, so the ` +
    'default window is shown.',
};

const ROLE_WORDS: Readonly<Record<BooksAccountRole, string>> = {
  receivable: 'RECEIVABLE',
  posting: 'POSTING ACCOUNT',
  deductions: 'LOOKS LIKE DEDUCTIONS',
};

export function BooksPage({
  viewer,
  books,
  request,
  asOf,
}: {
  viewer: Viewer;
  books: readonly ConnectionBooks[];
  request: BooksRequest;
  /** The day the trial balance was asked as of. */
  asOf: string;
}) {
  const query = `from=${request.window.from}&to=${request.window.to}`;
  return (
    <WorkspaceShell viewer={viewer} section="books">
      <main id="workspace-main" className="workspace-main books-main">
        <div className="page-heading">
          <div>
            <p className="eyebrow">BOOKS, READ FROM QUICKBOOKS</p>
            <h1>The chart, the trial balance, the ledger.</h1>
            <p className="page-description">
              Read from QuickBooks as this page loaded, and not kept: every figure here is what
              QuickBooks answered just now. Nothing on this page changes anything in QuickBooks.
            </p>
          </div>
        </div>

        {request.windowRefused === undefined ? null : (
          <p className="notice bad" role="alert">
            {WINDOW_REFUSED_WORDS[request.windowRefused]}
          </p>
        )}

        <section className="card connection" aria-label="Ledger window">
          <h2>General ledger window</h2>
          <form method="get" action="/books">
            <div className="books-window">
              <div>
                <label htmlFor="books-from">From</label>
                <input id="books-from" type="date" name="from" defaultValue={request.window.from} />
              </div>
              <div>
                <label htmlFor="books-to">To</label>
                <input id="books-to" type="date" name="to" defaultValue={request.window.to} />
              </div>
              {request.scope === 'all' ? <input type="hidden" name="accounts" value="all" /> : null}
              <button type="submit" className="primary">
                Read this window
              </button>
            </div>
          </form>
          <p className="empty">
            {request.window.from} to {request.window.to}, both days included. The default is the
            last 35 days, the window the daily sync reads. At most {GENERAL_LEDGER_MAX_WINDOW_DAYS}{' '}
            days. The trial balance is always as of today ({asOf}, UTC).
          </p>
        </section>

        {books.length === 0 ? (
          <section className="card connection" aria-label="No connection">
            <h2>No QuickBooks company is connected</h2>
            <p className="empty">
              There are no books to read. An owner connects a company on{' '}
              <Link href="/settings/quickbooks">Settings → QuickBooks</Link>.
            </p>
          </section>
        ) : (
          books.map((connection) => (
            <ConnectionBooksView
              key={connection.connectionId}
              connection={connection}
              request={request}
              query={query}
            />
          ))
        )}

        <p className="empty" role="note">
          Nothing on this page is stored — it is a snapshot of your books at the moment you opened it.
        </p>
      </main>
    </WorkspaceShell>
  );
}

function ConnectionBooksView({
  connection,
  request,
  query,
}: {
  connection: ConnectionBooks;
  request: BooksRequest;
  query: string;
}) {
  const company = `company ${connection.realmId}`;
  if (connection.kind === 'not_configured') {
    return (
      <section className="card connection" aria-label={`Books, ${company}`}>
        <h2>QuickBooks {company}</h2>
        <p className="empty">
          This deployment is not set up to read QuickBooks, so nothing was asked of it. For your
          administrator: the Intuit app credentials and the token key — see
          docs/qbo-credentials.md.
        </p>
      </section>
    );
  }
  return (
    <>
      <section className="card connection" aria-label={`Chart of accounts, ${company}`}>
        <h2>Chart of accounts — QuickBooks {company}</h2>
        <Section section={connection.chart} what="The chart of accounts">
          {(chart) => <ChartTable chart={chart} mapped={connection.mapped} />}
        </Section>
      </section>

      <section className="card connection" aria-label={`Trial balance, ${company}`}>
        <h2>Trial balance — QuickBooks {company}</h2>
        <Section section={connection.trialBalance} what="The trial balance">
          {(trialBalance) => <TrialBalanceTable trialBalance={trialBalance} />}
        </Section>
      </section>

      <section className="card connection" aria-label={`General ledger, ${company}`}>
        <h2>General ledger — QuickBooks {company}</h2>
        <Section section={connection.ledger} what="The general ledger">
          {(ledger) => <LedgerTables ledger={ledger} request={request} query={query} />}
        </Section>
      </section>

      <section className="card connection" aria-label={`Deductions reconciliation, ${company}`}>
        <h2>Deductions reconciliation — QuickBooks {company}</h2>
        <Section section={connection.reconciliation} what="The reconciliation">
          {(reconciliation) => (
            <ReconciliationTable reconciliation={reconciliation} request={request} />
          )}
        </Section>
      </section>
    </>
  );
}

/** A read, or the fixed words for why there is none. Never an empty table for a failure. */
function Section<T>({
  section,
  what,
  children,
}: {
  section: BooksSection<T>;
  what: string;
  children: (value: T) => ReactNode;
}) {
  if (section.kind === 'read') return <>{children(section.value)}</>;
  if (section.kind === 'skipped') {
    return (
      <p className="empty" role="status">
        {what} was not read, because a read it depends on could not be made — see above.
      </p>
    );
  }
  return (
    <p className="notice bad" role="alert">
      {what} could not be read. {FAILURE_WORDS[section.failure]}
    </p>
  );
}

function ChartTable({ chart, mapped }: { chart: BooksChart; mapped: boolean }) {
  if (chart.accounts.length === 0) {
    return <p className="empty">QuickBooks answered with a chart of no accounts.</p>;
  }
  const inactive = chart.accounts.filter((account) => !account.active).length;
  return (
    <>
      <p className="empty">
        {chart.accounts.length.toLocaleString('en-US')} accounts, {inactive.toLocaleString('en-US')}{' '}
        of them inactive.{' '}
        {mapped
          ? 'The accounts this workspace’s account map posts deductions to are marked.'
          : 'This workspace has saved no account map, so no posting account is marked.'}{' '}
        “Looks like deductions” is a guess, by detail type ({DEDUCTION_ACCOUNT_SUBTYPES.join(', ')})
        or a name containing one of: {DEDUCTION_ACCOUNT_NAME_WORDS.join(', ')}.
      </p>
      <div className="table-scroll" role="region" aria-label="Chart of accounts" tabIndex={0}>
        <table className="cases books-chart">
          <thead>
            <tr>
              <th scope="col">Code</th>
              <th scope="col">Account</th>
              <th scope="col">Type</th>
              <th scope="col">Detail type</th>
              <th scope="col">Active</th>
              <th scope="col">On this page</th>
            </tr>
          </thead>
          <tbody>
            {chart.accounts.map((account) => {
              const roles = chart.roles[account.externalId] ?? [];
              const posting = roles.includes('posting');
              return (
                <tr
                  key={account.externalId}
                  {...(posting ? { 'data-posting-account': 'true', style: { background: '#f7f9f5' } } : {})}
                >
                  <td>{account.code ?? '—'}</td>
                  <td>{posting ? <strong>{account.fullyQualifiedName}</strong> : account.fullyQualifiedName}</td>
                  <td>{account.accountType}</td>
                  <td>{account.accountSubType ?? '—'}</td>
                  <td>{account.active ? 'Active' : 'Inactive'}</td>
                  <td>
                    {roles.length === 0
                      ? ''
                      : roles.map((role) => (
                          <span className="ledger-tag" key={role}>
                            {ROLE_WORDS[role]}{' '}
                          </span>
                        ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function TrialBalanceTable({ trialBalance }: { trialBalance: TrialBalance }) {
  const difference = trialBalanceDifferenceCents(trialBalance);
  return (
    <>
      <p className="empty">
        As of {trialBalance.asOf}
        {trialBalance.basis === undefined ? '' : `, ${trialBalance.basis.toLowerCase()} basis`}
        {trialBalance.currency === undefined ? '' : `, ${trialBalance.currency}`}.{' '}
        {trialBalance.periodStart === undefined
          ? ''
          : `QuickBooks reported the period ${trialBalance.periodStart} to ${trialBalance.asOf}: ` +
            'balance-sheet accounts at its end, income and expense accounts over it.'}
      </p>
      {difference === 0 ? (
        <p className="notice sent" role="status">
          In balance: debits and credits are both {money(trialBalance.totalDebitCents)}.
        </p>
      ) : (
        <p className="notice bad" role="alert">
          <strong>Out of balance by {money(Math.abs(difference))}.</strong> Debits are{' '}
          {money(trialBalance.totalDebitCents)} and credits are {money(trialBalance.totalCreditCents)}{' '}
          — {difference > 0 ? 'debits are the larger' : 'credits are the larger'}. These are
          QuickBooks’ own totals, shown as it reported them.
        </p>
      )}
      {trialBalance.lines.length === 0 ? (
        <p className="empty">QuickBooks reported no balances for this period.</p>
      ) : (
        <div className="table-scroll" role="region" aria-label="Trial balance" tabIndex={0}>
          <table className="cases books-trial">
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col" className="money">
                  Debit
                </th>
                <th scope="col" className="money">
                  Credit
                </th>
              </tr>
            </thead>
            <tbody>
              {trialBalance.lines.map((line, index) => (
                <tr key={`${line.accountExternalId ?? 'row'}-${index}`}>
                  <td>{line.accountName}</td>
                  <td className="money">{line.debitCents === 0 ? '' : money(line.debitCents)}</td>
                  <td className="money">{line.creditCents === 0 ? '' : money(line.creditCents)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">Total, as QuickBooks reported it</th>
                <td className="money">
                  <strong>{money(trialBalance.totalDebitCents)}</strong>
                </td>
                <td className="money">
                  <strong>{money(trialBalance.totalCreditCents)}</strong>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </>
  );
}

function LedgerTables({
  ledger,
  request,
  query,
}: {
  ledger: BooksLedger;
  request: BooksRequest;
  query: string;
}) {
  const accounts = ledger.ledger.accounts;
  const lineCount = accounts.reduce((count, account) => count + account.lines.length, 0);
  return (
    <>
      <p className="empty">
        {request.window.from} to {request.window.to}
        {ledger.ledger.basis === undefined ? '' : `, ${ledger.ledger.basis.toLowerCase()} basis`}:{' '}
        {lineCount.toLocaleString('en-US')} {lineCount === 1 ? 'posting' : 'postings'} across{' '}
        {accounts.length.toLocaleString('en-US')} {accounts.length === 1 ? 'account' : 'accounts'}.{' '}
        {ledger.scope === 'all' ? (
          <>
            Every account is shown.{' '}
            <Link href={`/books?${query}`}>Show only the receivable and deductions accounts</Link>.
          </>
        ) : (
          <>
            Only the receivable, the posting accounts and the accounts that look like deductions
            accounts are shown. <Link href={`/books?${query}&accounts=all`}>Show every account</Link>.
          </>
        )}
      </p>
      {accounts.length === 0 ? (
        <p className="empty">QuickBooks has no postings on these accounts in this window.</p>
      ) : (
        accounts.map((account, index) => (
          <LedgerAccountTable key={`${account.accountExternalId ?? 'account'}-${index}`} account={account} />
        ))
      )}
    </>
  );
}

function LedgerAccountTable({ account }: { account: GeneralLedgerAccount }) {
  const shown = account.lines.slice(0, LEDGER_LINES_SHOWN_PER_ACCOUNT);
  return (
    <>
      <h3 className="section">
        {account.accountName} — {account.lines.length.toLocaleString('en-US')}{' '}
        {account.lines.length === 1 ? 'posting' : 'postings'}
      </h3>
      {account.lines.length > shown.length ? (
        <p className="notice bad" role="status">
          Showing the first {shown.length.toLocaleString('en-US')} of{' '}
          {account.lines.length.toLocaleString('en-US')} postings. Choose a shorter window to see
          the rest.
        </p>
      ) : null}
      <div className="table-scroll" role="region" aria-label={`${account.accountName} postings`} tabIndex={0}>
        <table className="cases books-ledger">
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Type</th>
              <th scope="col">No.</th>
              <th scope="col">Name</th>
              <th scope="col">Memo</th>
              <th scope="col" className="money">
                Debit
              </th>
              <th scope="col" className="money">
                Credit
              </th>
              <th scope="col" className="money">
                Balance
              </th>
            </tr>
          </thead>
          <tbody>
            {account.beginningBalanceCents === undefined ? null : (
              <tr>
                <td colSpan={7}>Balance brought forward</td>
                <td className="money">{money(account.beginningBalanceCents)}</td>
              </tr>
            )}
            {shown.length === 0 ? (
              <tr>
                <td colSpan={8}>No postings in this window.</td>
              </tr>
            ) : (
              shown.map((line, index) => (
                <tr key={`${line.transactionExternalId ?? 'line'}-${index}`}>
                  <td>{line.date}</td>
                  <td>{line.transactionType ?? ''}</td>
                  <td>{line.documentNumber ?? ''}</td>
                  <td>{line.name ?? ''}</td>
                  <td>{line.memo ?? ''}</td>
                  <td className="money">{line.debitCents === 0 ? '' : money(line.debitCents)}</td>
                  <td className="money">{line.creditCents === 0 ? '' : money(line.creditCents)}</td>
                  <td className="money">
                    {line.balanceCents === undefined ? '' : money(line.balanceCents)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function caseLabel(one: BooksCase): string {
  return one.claimId ?? `case ${one.caseId.slice(0, 8)}`;
}

function CaseLink({ one }: { one: BooksCase }) {
  return <Link href={`/cases/${one.caseId}`}>{caseLabel(one)}</Link>;
}

function lineLabel(line: GeneralLedgerLine): string {
  return [line.date, line.transactionType, line.documentNumber].filter(Boolean).join(' · ');
}

function ReconciliationTable({
  reconciliation,
  request,
}: {
  reconciliation: BooksReconciliation;
  request: BooksRequest;
}) {
  const count = (kind: ReconciliationRow['kind']): number =>
    reconciliation.rows.filter((row) => row.kind === kind).length;
  return (
    <>
      <p className="empty">
        QuickBooks’ postings on the posting and deductions accounts, {request.window.from} to{' '}
        {request.window.to}, beside this workspace’s cases dated in the same window:{' '}
        {reconciliation.linesCompared.toLocaleString('en-US')} postings and{' '}
        {reconciliation.casesCompared.toLocaleString('en-US')} cases. {count('matched')} match,{' '}
        {count('books_only')} in the books with no case, {count('case_only')} cases not in the
        books.
      </p>
      <p className="empty">
        A posting matches a case only when the amount is the same to the cent, the date is the
        same day, and no other posting or case shares that amount and day. Anything else is listed
        as a candidate — the same amount within {RECONCILIATION_CANDIDATE_DAYS} days, or a case
        with no printed date — for a person to check. A candidate is not a match. Names are shown
        and never compared. Nothing here is written to a case or to QuickBooks.
      </p>
      {reconciliation.casesTotal > reconciliation.casesCompared ? (
        <p className="notice bad" role="alert">
          Only the first {reconciliation.casesCompared.toLocaleString('en-US')} of{' '}
          {reconciliation.casesTotal.toLocaleString('en-US')} cases in this window were compared, so
          “in books, no case” below may be wrong for the rest. Choose a shorter window.
        </p>
      ) : null}
      {reconciliation.rows.length === 0 ? (
        <p className="empty">
          Nothing to reconcile: no postings on those accounts and no cases in this window.
        </p>
      ) : (
        <div className="table-scroll" role="region" aria-label="Reconciliation" tabIndex={0}>
          <table className="cases books-reconciliation">
            <thead>
              <tr>
                <th scope="col">Result</th>
                <th scope="col">In QuickBooks</th>
                <th scope="col">Account</th>
                <th scope="col">Name in QuickBooks</th>
                <th scope="col" className="money">
                  Amount in QuickBooks
                </th>
                <th scope="col">Our case</th>
                <th scope="col">Payer</th>
                <th scope="col">Case date</th>
                <th scope="col" className="money">
                  Case amount
                </th>
              </tr>
            </thead>
            <tbody>
              {reconciliation.rows.map((row, index) => (
                <ReconciliationRowView key={index} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function ReconciliationRowView({ row }: { row: ReconciliationRow }) {
  if (row.kind === 'matched') {
    return (
      <tr data-reconciliation="matched">
        <td>
          Matches case <CaseLink one={row.case} />
        </td>
        <LineCells line={row.line} amountCents={row.amountCents} />
        <CaseCells one={row.case} />
      </tr>
    );
  }
  if (row.kind === 'books_only') {
    return (
      <tr data-reconciliation="books_only">
        <td>
          <strong>In books, no case</strong>
          {row.candidates.length === 0 ? null : (
            <>
              <br />
              Candidate{row.candidates.length === 1 ? '' : 's'}, not asserted:{' '}
              {row.candidates.map((candidate, index) => (
                <span key={candidate.caseId}>
                  {index === 0 ? '' : ', '}
                  <CaseLink one={candidate} />
                  {candidate.date === undefined ? ' (no date)' : ` (${candidate.date})`}
                </span>
              ))}
            </>
          )}
        </td>
        <LineCells line={row.line} amountCents={row.amountCents} />
        <td colSpan={4} />
      </tr>
    );
  }
  return (
    <tr data-reconciliation="case_only">
      <td>
        <strong>Case, not in books</strong>
        {row.candidates.length === 0 ? null : (
          <>
            <br />
            Candidate{row.candidates.length === 1 ? '' : 's'}, not asserted:{' '}
            {row.candidates.map((candidate) => lineLabel(candidate)).join('; ')}
          </>
        )}
      </td>
      <td colSpan={4} />
      <CaseCells one={row.case} />
    </tr>
  );
}

function LineCells({ line, amountCents }: { line: GeneralLedgerLine; amountCents: number }) {
  return (
    <>
      <td>
        {lineLabel(line)}
        {line.memo === undefined ? null : (
          <>
            <br />
            {line.memo}
          </>
        )}
      </td>
      <td>{line.accountName}</td>
      <td>{line.name ?? ''}</td>
      <td className="money">
        {money(amountCents)} {line.debitCents >= line.creditCents ? 'debit' : 'credit'}
      </td>
    </>
  );
}

function CaseCells({ one }: { one: BooksCase }) {
  return (
    <>
      <td>
        <CaseLink one={one} />
      </td>
      <td>{one.payerName ?? 'Payer not read'}</td>
      <td>{one.date ?? 'No date printed'}</td>
      <td className="money">{money(one.amountCents)}</td>
    </>
  );
}

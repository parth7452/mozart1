import Link from 'next/link';
import type {
  CoverageMonthRow,
  CoverageReport,
  LedgerFindings,
  LedgerRunRow,
  LedgerSyncHealth,
} from '@recouple/store-postgres';
import { money, monthLabel, percent } from '../lib/format';
import {
  ANOMALY_GUIDE,
  countedBeforePaymentWindow,
  errorClassGuide,
  isChannel,
  OUTCOME_LABELS,
  sourceLabel,
  syncOverdue,
} from '../lib/coverage-presentation';
import { WorkspaceShell } from './workspace-shell';
import type { Viewer } from './case-list';

/**
 * The coverage page, as a pure function of two reads (ADR 0030, ADR 0038, ADR
 * 0035): what we found and what we filed, per channel, and how the ledger sync
 * that finds the deductions nobody sends has been doing.
 *
 * Three rules hold everywhere here. **Per channel, never blended** — there is
 * no all-channels rate on this page, and it says why. **No money arithmetic** —
 * every figure is a cents value or a ratio the database produced; this file
 * only formats them. **Nothing is hidden** — the dollars no channel can claim,
 * the duplicates still counted twice and a month that filed more than it found
 * are each shown and explained rather than left for a reader to trip over.
 */
export function CoveragePage({
  viewer,
  coverage,
  ledger,
  environment,
  now,
}: {
  viewer: Viewer;
  coverage: CoverageReport;
  ledger: LedgerSyncHealth;
  /** Which QuickBooks this deployment reads, when it is set up to read one. */
  environment?: 'sandbox' | 'production' | undefined;
  now: Date;
}) {
  const channels = coverage.trailing.filter((row) => isChannel(row.discoveredFrom));
  const unrecorded = coverage.trailing.find((row) => !isChannel(row.discoveredFrom));

  return (
    <WorkspaceShell viewer={viewer} section="coverage">
      <main id="workspace-main" className="workspace-main">
        <div className="page-heading">
          <div>
            <p className="eyebrow">COVERAGE, BY CHANNEL</p>
            <h1>What we found. What we filed.</h1>
            <p className="page-description">
              Of the deductions we examined — not of every one that exists. Each channel has its
              own rate: a combined rate would move whenever the mix of channels does, and read as
              progress when nothing improved.
            </p>
          </div>
        </div>

        {channels.length === 0 && unrecorded === undefined ? (
          <section className="card connection" aria-label="Coverage">
            <p className="empty">
              Nothing found yet. Coverage starts when a deduction arrives by upload or email, or
              when a connected ledger is read.
            </p>
          </section>
        ) : (
          <>
            <section className="metrics by-channel" aria-label="Coverage over the last 12 months, by channel">
              {channels.map((row) => (
                <div className="metric" key={row.discoveredFrom}>
                  <span className="metric-label">{sourceLabel(row.discoveredFrom).toUpperCase()}</span>
                  <strong>
                    {row.coverageOfDiscovered === undefined ? '—' : percent(row.coverageOfDiscovered)}
                  </strong>
                  <span className="metric-note">
                    {money(row.filedCents)} filed of {money(row.discoveredCents)} found, last{' '}
                    {coverage.months} months
                    {row.discoveredFrom === 'erp_sync' && environment === 'sandbox'
                      ? ' — from a QuickBooks sandbox company, so test data'
                      : ''}
                  </span>
                </div>
              ))}
            </section>

            {unrecorded === undefined || unrecorded.discoveredCents === 0 ? null : (
              <p className="notice bad">
                {money(unrecorded.discoveredCents)} found in these months arrived without a record
                of how. It is counted in the monthly totals below but credited to no channel, so no
                rate above includes it. An operator can record where each of those documents came
                from.
              </p>
            )}

            {coverage.countedTwice.cases === 0 ? null : <CountedTwiceNotice coverage={coverage} />}

            <MonthlyTable coverage={coverage} />
          </>
        )}

        <LedgerHealth ledger={ledger} now={now} />

        <footer className="workspace-footer">
          <span>YOUR REVENUE. ORCHESTRATED.</span>
          <span>mozart.</span>
        </footer>
      </main>
    </WorkspaceShell>
  );
}

function CountedTwiceNotice({ coverage }: { coverage: CoverageReport }) {
  const { countedTwice } = coverage;
  return (
    <div className="notice bad">
      <p>
        {countedTwice.cases === 1
          ? '1 case you confirmed as a duplicate still counts twice'
          : `${countedTwice.cases} cases you confirmed as duplicates still count twice`}
        : {money(countedTwice.cents)} of found dollars appear twice until cases can be merged
        {countedTwice.byChannel.length === 0
          ? '.'
          : ` — in ${countedTwice.byChannel
              .map((row) => `${sourceLabel(row.discoveredFrom)} (${money(row.cents)})`)
              .join(', ')}.`}
      </p>
      <p>
        {countedTwice.listed.map((row, index) => (
          <span key={row.deductionId}>
            {index === 0 ? '' : ', '}
            <Link href={`/cases/${row.deductionId}`}>{row.claimId ?? 'no claim id'}</Link>
          </span>
        ))}
        {countedTwice.cases > countedTwice.listed.length
          ? ` and ${countedTwice.cases - countedTwice.listed.length} more`
          : ''}
      </p>
    </div>
  );
}

function MonthlyTable({ coverage }: { coverage: CoverageReport }) {
  const periods = [...new Set(coverage.bySource.map((row) => row.period))];
  return (
    <section className="card ledger" aria-label="Coverage by month and channel">
      <div className="ledger-heading">
        <div>
          <h2>By month and channel</h2>
          <p className="ledger-summary">
            Found: every case opened in the month, plus declines that never became a case. Filed:
            cases filed in the month, whenever they were found.
          </p>
        </div>
        <span className="ledger-tag">LAST {coverage.months} MONTHS</span>
      </div>
      <div className="table-scroll" role="region" aria-label="Coverage table" tabIndex={0}>
        <table className="cases">
          <thead>
            <tr>
              <th>MONTH</th>
              <th>CHANNEL</th>
              <th className="money">OPENED</th>
              <th className="money">DECLINED</th>
              <th className="money">FOUND</th>
              <th className="money">FILED</th>
              <th className="money">COVERAGE</th>
            </tr>
          </thead>
          <tbody>
            {periods.map((period) => {
              const rows = coverage.bySource.filter((row) => row.period === period);
              const total = coverage.totals.find((row) => row.period === period);
              return [
                ...rows.map((row, index) => (
                  <MonthRow
                    key={`${period}:${row.discoveredFrom}`}
                    row={row}
                    first={index === 0}
                    current={period === coverage.currentMonth}
                  />
                )),
                total === undefined || rows.length < 2 ? null : (
                  <tr key={`${period}:total`} className="coverage-total">
                    <td />
                    <td>All channels — dollars only</td>
                    <td className="money">{money(total.openedCents)}</td>
                    <td className="money">{money(total.declinedCents)}</td>
                    <td className="money">{money(total.discoveredCents)}</td>
                    <td className="money">{money(total.filedCents)}</td>
                    <td className="money">—</td>
                  </tr>
                ),
              ];
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function MonthRow({
  row,
  first,
  current,
}: {
  row: CoverageMonthRow;
  first: boolean;
  current: boolean;
}) {
  const rate = isChannel(row.discoveredFrom) ? row.coverageOfDiscovered : undefined;
  return (
    <tr>
      <td>
        {first ? (
          <>
            {monthLabel(row.period)}
            {current ? <span className="coverage-month-tag">month to date</span> : null}
          </>
        ) : null}
      </td>
      <td>{sourceLabel(row.discoveredFrom)}</td>
      <td className="money">
        {row.openedCount} · {money(row.openedCents)}
      </td>
      <td className="money">
        {row.declinedCount} · {money(row.declinedCents)}
      </td>
      <td className="money">{money(row.discoveredCents)}</td>
      <td className="money">
        {row.filedCount} · {money(row.filedCents)}
      </td>
      <td className="money">
        {rate === undefined ? '—' : percent(rate)}
        {rate !== undefined && rate > 1 ? (
          <span className="hint">
            More filed than found this month — most likely filings for cases found in an earlier
            month.
          </span>
        ) : null}
      </td>
    </tr>
  );
}

function LedgerHealth({ ledger, now }: { ledger: LedgerSyncHealth; now: Date }) {
  const latest = ledger.runs[0];
  return (
    <section id="ledger" aria-label="Ledger sync">
      <h2 className="section">LEDGER SYNC</h2>
      {latest === undefined ? (
        <section className="card connection">
          <p className="empty">
            No ledger sync has run. The deductions a ledger would find are the ones nobody sends
            us — <Link href="/settings/quickbooks">connect QuickBooks</Link> to read them.
          </p>
        </section>
      ) : (
        <>
          {syncOverdue(latest.startedAt, now) ? (
            <p className="notice bad">
              No sync has run since {latest.startedAt.slice(0, 16).replace('T', ' ')} UTC. The
              daily run is at 07:00 UTC — this deployment may not be running it.
            </p>
          ) : null}
          {ledger.findings.map((finding) => (
            <Findings key={finding.connectionId} finding={finding} />
          ))}
          <RunsTable runs={ledger.runs} />
          <p className="hint">
            Connection status and reconnecting are under{' '}
            <Link href="/settings/quickbooks">Settings → QuickBooks</Link>.
          </p>
        </>
      )}
    </section>
  );
}

function Findings({ finding }: { finding: LedgerFindings }) {
  const { run, anomalies } = finding;
  const kinds = [...new Set(anomalies.map((anomaly) => anomaly.kind))];
  return (
    <section
      className="card ledger"
      aria-label={`What needs a look in QuickBooks company ${finding.providerAccountId}`}
    >
      <div className="ledger-heading">
        <div>
          <h2>Needs a look in QuickBooks</h2>
          <p className="ledger-summary">
            Company <span className="mono">{finding.providerAccountId}</span> · the run of{' '}
            {run.startedAt.slice(0, 10)}, which read payments and credits from {run.windowFrom} to{' '}
            {run.windowTo}
          </p>
        </div>
        <span className="ledger-tag">LATEST COMPLETED RUN</span>
      </div>
      <div className="anomaly-body">
        {!run.itemised ? (
          <p className="hint">
            {run.anomalyCount} {run.anomalyCount === 1 ? 'anomaly was' : 'anomalies were'} counted
            before the app kept their IDs; the next run lists them.
          </p>
        ) : anomalies.length === 0 ? (
          <p className="hint">Nothing needed a look in that run.</p>
        ) : (
          <>
            {kinds.map((kind) => {
              const guide = ANOMALY_GUIDE[kind];
              return (
                <div className="anomaly-group" key={kind}>
                  <h3>{guide.title}</h3>
                  <p>
                    {guide.meaning} {guide.whatToDo} No case is opened for it until the ledger adds
                    up.
                  </p>
                  <ul>
                    {anomalies
                      .filter((anomaly) => anomaly.kind === kind)
                      .map((anomaly) => (
                        <li
                          className="mono"
                          key={`${anomaly.invoiceExternalId}:${anomaly.transactionExternalId ?? ''}`}
                        >
                          Invoice ID {anomaly.invoiceExternalId}
                          {anomaly.transactionExternalId === undefined
                            ? ''
                            : ` · payment or credit ID ${anomaly.transactionExternalId}`}
                        </li>
                      ))}
                  </ul>
                </div>
              );
            })}
            <p className="hint">
              These are QuickBooks&rsquo; internal IDs, not the invoice numbers on the page. An
              anomaly missing from a later run may have been fixed — or its payment may only have
              left the 35 days each run reads.
            </p>
          </>
        )}
      </div>
    </section>
  );
}

function RunsTable({ runs }: { runs: readonly LedgerRunRow[] }) {
  return (
    <section className="card ledger" aria-label="Recent sync runs">
      <div className="ledger-heading">
        <div>
          <h2>Recent runs</h2>
          <p className="ledger-summary">
            Each run reads the last 35 days of payments and credits, so consecutive runs overlap
            and a case already open is recognised rather than opened again.
          </p>
        </div>
        <span className="ledger-tag">NEWEST FIRST</span>
      </div>
      <div className="table-scroll" role="region" aria-label="Sync runs table" tabIndex={0}>
        <table className="cases">
          <thead>
            <tr>
              <th>STARTED (UTC)</th>
              <th>COMPANY</th>
              <th>OUTCOME</th>
              <th className="money">INVOICES READ</th>
              <th className="money">OPENED</th>
              <th className="money">ALREADY OPEN</th>
              <th className="money">DECLINED</th>
              <th className="money">ANOMALIES</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => {
              const outcome = OUTCOME_LABELS[run.outcome];
              const guide = errorClassGuide(run.errorClass, run.outcome);
              const oldCount = countedBeforePaymentWindow(run.startedAt);
              // What a run means goes on a row of its own, full width, so the
              // counts keep their columns on a laptop screen.
              const note =
                guide === '' && !oldCount ? null : (
                  <tr className="run-note" key={`${run.runId}:note`}>
                    <td colSpan={8}>
                      {guide}
                      {run.errorClass === undefined ? null : (
                        <>
                          {' '}
                          <span className="mono">({run.errorClass})</span>
                        </>
                      )}
                      {oldCount
                        ? `${guide === '' ? '' : ' '}Counted before the 2026-09-22 change to how a run reads the ledger, so its numbers do not compare with later runs.`
                        : null}
                    </td>
                  </tr>
                );
              return [
                <tr key={run.runId} className={note === null ? undefined : 'has-note'}>
                  <td>{run.startedAt.slice(0, 16).replace('T', ' ')}</td>
                  <td className="mono">{run.providerAccountId}</td>
                  <td>
                    <span className={`pill ${outcome.tone}`}>{outcome.label}</span>
                  </td>
                  <td className="money">{run.invoicesExamined}</td>
                  <td className="money">{run.openedCount}</td>
                  <td className="money">{run.skippedCount}</td>
                  <td className="money">{run.declinedCount}</td>
                  <td className="money">{run.anomalyCount}</td>
                </tr>,
                note,
              ];
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

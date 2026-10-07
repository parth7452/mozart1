import {
  DISPUTE_WINDOW_MAX_DAYS,
  PAYER_CODE_CONFIDENCES,
  PAYER_CODE_SOURCE_NOTE_MAX_LENGTH,
  PAYER_CODE_SOURCES,
  type PayerCodeSource,
} from '@recouple/core-domain';
import type { DisputeWindowListed, MappableDebtor, PayerWithoutWindow } from '@recouple/store-postgres';
import {
  addWindowHref,
  DISPUTE_WINDOWS_PATH,
  resolveDisputeWindowNotice,
} from '../lib/dispute-window-words';
import { WorkspaceShell } from './workspace-shell';
import type { Viewer } from './case-list';

/**
 * Payer dispute windows, as a person sees them (ADR 0071). Pure functions of
 * what the store returned; a window fills a deadline only when a case opens,
 * and nothing here writes to a case.
 */

const SOURCE_LABEL: Readonly<Record<PayerCodeSource, string>> = {
  payer_guide_url: "The payer's own guide",
  customer_confirmed: 'Confirmed by the customer',
  glimpse_guide: "Glimpse's published guide",
  operator: 'A Mozart operator',
};

export function DisputeWindowsPage({
  viewer,
  current,
  debtors,
  without,
  mayRecord,
  prefill,
  today,
  notice,
}: {
  viewer: Viewer;
  current: readonly DisputeWindowListed[];
  debtors: readonly MappableDebtor[];
  without: readonly PayerWithoutWindow[];
  /** An owner or approver: may add a window. */
  mayRecord: boolean;
  prefill?: { readonly debtorId?: string } | undefined;
  /** `YYYY-MM-DD`: the day "in force" was asked for, and the form's default start. */
  today: string;
  notice?: string | undefined;
}) {
  const said = resolveDisputeWindowNotice(notice);
  const prefillDebtor = debtors.find((d) => d.debtorId === prefill?.debtorId)?.debtorId;

  return (
    <WorkspaceShell viewer={viewer} section="dispute-windows">
      <main id="workspace-main" className="workspace-main">
        <div className="page-heading">
          <div>
            <p className="eyebrow">SETTINGS</p>
            <h1>Dispute windows</h1>
            <p className="page-description">
              How long each payer gives you to dispute a deduction. A case opened after a window is
              recorded gets its deadline filled in from it.
            </p>
          </div>
        </div>

        {said === undefined ? null : (
          <p className={said.tone === 'good' ? 'notice sent' : 'notice bad'}>{said.text}</p>
        )}

        <section className="card dispute-windows" aria-label="Windows in force">
          <h2>Windows in force today</h2>
          {current.length === 0 ? (
            <p className="empty">No window has been added yet.</p>
          ) : (
            <table className="cases">
              <thead>
                <tr>
                  <th scope="col">Payer</th>
                  <th scope="col">Days</th>
                  <th scope="col">From</th>
                  <th scope="col">In force</th>
                  <th scope="col">Source</th>
                  <th scope="col">Confidence</th>
                </tr>
              </thead>
              <tbody>
                {current.map((w) => (
                  <tr key={w.id}>
                    <td>{w.debtorName}</td>
                    <td>{w.windowDays}</td>
                    <td>the deduction date</td>
                    <td>
                      {w.effectiveFrom}
                      {w.effectiveTo === undefined ? ' onwards' : ` to ${w.effectiveTo}`}
                    </td>
                    <td>
                      {SOURCE_LABEL[w.source]}
                      {w.sourceNote === undefined ? '' : `: ${w.sourceNote}`}
                    </td>
                    <td>{w.confidence}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="card dispute-windows" aria-label="Payers with no window">
          <h2>Payers with no window</h2>
          {without.length === 0 ? (
            <p className="empty">Every payer with an open case has a window in force.</p>
          ) : (
            <table className="cases">
              <thead>
                <tr>
                  <th scope="col">Payer</th>
                  <th scope="col">Open cases</th>
                  <th scope="col">Of which without a deadline</th>
                  <th scope="col">
                    <span className="sr-only">Add a window</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {without.map((p) => (
                  <tr key={p.debtorId}>
                    <td>{p.displayName}</td>
                    <td>{p.openCases}</td>
                    <td>{p.openCasesWithoutDeadline}</td>
                    <td>{mayRecord ? <a href={addWindowHref(p.debtorId)}>Add a window</a> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="empty">
            A window recorded now fills in cases opened from now on. A case already open keeps what it
            has; its page offers the date the window gives, for a person to record.
          </p>
        </section>

        {mayRecord ? (
          <section id="add-window" className="card dispute-windows" aria-label="Add a window">
            <h2>Add a window</h2>
            {debtors.length === 0 ? (
              <p className="empty">This workspace has no payers yet. Add the payer first.</p>
            ) : (
              <form action={`${DISPUTE_WINDOWS_PATH}/add`} method="post">
                <label htmlFor="windows-debtor">Payer</label>
                <select id="windows-debtor" name="debtorId" required defaultValue={prefillDebtor ?? ''}>
                  <option value="" disabled>
                    Choose a payer…
                  </option>
                  {debtors.map((debtor) => (
                    <option key={debtor.debtorId} value={debtor.debtorId}>
                      {debtor.displayName}
                    </option>
                  ))}
                </select>

                <label htmlFor="windows-days">Calendar days from the deduction date</label>
                <input
                  id="windows-days"
                  name="windowDays"
                  type="number"
                  required
                  min={1}
                  max={DISPUTE_WINDOW_MAX_DAYS}
                  step={1}
                />

                <label htmlFor="windows-from">In force from</label>
                <input id="windows-from" name="effectiveFrom" type="date" required defaultValue={today} />

                <label htmlFor="windows-to">Until (leave empty for no end)</label>
                <input id="windows-to" name="effectiveTo" type="date" />

                <label htmlFor="windows-source">Where this comes from</label>
                <select id="windows-source" name="source" required defaultValue="payer_guide_url">
                  {PAYER_CODE_SOURCES.map((source) => (
                    <option key={source} value={source}>
                      {SOURCE_LABEL[source]}
                    </option>
                  ))}
                </select>

                <label htmlFor="windows-note">Note: the link, the person or the page</label>
                <input
                  id="windows-note"
                  name="sourceNote"
                  type="text"
                  maxLength={PAYER_CODE_SOURCE_NOTE_MAX_LENGTH}
                  autoComplete="off"
                />

                <label htmlFor="windows-confidence">Confidence</label>
                <select id="windows-confidence" name="confidence" required defaultValue="medium">
                  {PAYER_CODE_CONFIDENCES.map((confidence) => (
                    <option key={confidence} value={confidence}>
                      {confidence}
                    </option>
                  ))}
                </select>

                <button type="submit" className="primary">
                  Add window
                </button>
              </form>
            )}
            <p className="empty">
              A window is never edited: to change one, add another with a later start date, and it
              takes over from that day. Your name is recorded on it.
            </p>
          </section>
        ) : (
          <p className="empty">Only an owner or approver can add a window.</p>
        )}
      </main>
    </WorkspaceShell>
  );
}

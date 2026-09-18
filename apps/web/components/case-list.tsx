import Link from 'next/link';
import type { CaseSummary } from '@recouple/store-postgres';
import { deadline, money } from '../lib/format';

export interface Viewer {
  readonly email: string;
  readonly orgName: string;
  readonly role: string;
}

/**
 * The case list, as a pure function of what the database said.
 *
 * The route reads; this renders. Keeping them apart is what makes the rendering
 * testable without a signed-in browser — and the parts worth testing are the ones
 * a reviewer acts on: the money, the deadline, and the fact that text which came
 * out of somebody else's document is text and not markup.
 */
export function CaseList({
  viewer,
  cases,
  today,
  mayUpload,
  notice,
}: {
  viewer: Viewer;
  cases: readonly CaseSummary[];
  today: Date;
  /** Whether this member's role may add a document; the database decides too. */
  mayUpload: boolean;
  /** What happened to the last upload, when something did. */
  notice?: string | undefined;
}) {
  const total = cases.reduce((sum, row) => sum + row.deductionAmountCents, 0);

  return (
    <>
      <header className="top">
        <h1>Recouple</h1>
        <span className="pill">{viewer.orgName}</span>
        <span className="who">
          {viewer.email} · {viewer.role.replace('_', ' ')}
        </span>
      </header>
      <main>
        {notice !== undefined ? <p className="notice bad">{notice}</p> : null}
        {mayUpload ? (
          <form className="card upload" action="/upload" method="post" encType="multipart/form-data">
            <label htmlFor="file">
              <strong>Add a document</strong>
              <span>
                A deduction notice opens a case. Anything else is read and waits for a case to be
                attached to. Nothing is submitted anywhere either way.
              </span>
            </label>
            <div>
              <input id="file" type="file" name="file" accept=".pdf,.png,.jpg,.jpeg,.tif,.tiff" required />
              <button className="primary" type="submit">
                Read it
              </button>
            </div>
          </form>
        ) : null}
        <div className="card">
          <h2 className="section" style={{ marginTop: 0 }}>
            {cases.length === 0
              ? 'No cases yet'
              : `${cases.length} case${cases.length === 1 ? '' : 's'} · ${money(total)} deducted`}
          </h2>
          {cases.length === 0 ? (
            <p className="empty">
              A case opens when a deduction notice arrives — by upload, or by email to this
              workspace&rsquo;s inbound address. Nothing is submitted anywhere until a person
              approves it.
            </p>
          ) : (
            <table className="cases">
              <thead>
                <tr>
                  <th>Claim</th>
                  <th>Retailer</th>
                  <th className="money">Deducted</th>
                  <th>State</th>
                  <th>Evidence</th>
                  <th>Deadline</th>
                </tr>
              </thead>
              <tbody>
                {cases.map((row) => {
                  const due = deadline(row.disputeDeadline, today);
                  return (
                    <tr key={row.deductionId}>
                      <td>
                        <Link href={`/cases/${row.deductionId}`} className="mono">
                          {row.claimId ?? row.deductionId.slice(0, 8)}
                        </Link>
                      </td>
                      <td>{row.debtorName ?? '—'}</td>
                      <td className="money">{money(row.deductionAmountCents)}</td>
                      <td>
                        <span className="pill">{row.state.replace(/_/g, ' ')}</span>
                      </td>
                      <td>
                        {row.documentCount} doc{row.documentCount === 1 ? '' : 's'}
                      </td>
                      <td>
                        {due === undefined ? '—' : <span className={`pill ${due.tone}`}>{due.label}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </main>
    </>
  );
}

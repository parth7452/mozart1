import Link from 'next/link';
import type { CaseSummary } from '@recouple/store-postgres';
import { MAX_CASES_REMOVED_AT_ONCE } from '@recouple/pipeline';
import { requireSession, storeFor } from '../../../lib/session';
import { mayApprove } from '../../../lib/workflow';
import { money, retailer } from '../../../lib/format';
import { resolveNotice } from '../../../lib/notices';
import { viewerOf } from '../../../lib/viewer';
import { WorkspaceShell } from '../../../components/workspace-shell';
import { REMOVE_REASON_MAX_LENGTH, removalIdsFrom, whyNotRemovable } from '../../../lib/remove-cases';

export const dynamic = 'force-dynamic';

/** The notices this page may show, and no other (`lib/notices.ts`). */
const REMOVE_NOTICES = new Set(['remove_refused', 'remove_reason_too_long', 'remove_none', 'remove_role']);

/**
 * "Delete this case?" (ADR 0072): the confirmation a removal goes through.
 *
 * A GET that writes nothing. It reads each case named through RLS, says what
 * removal does, lists any case that cannot be removed and why — leaving it out
 * of the form — and posts the rest to `/cases/remove/confirm`. A case another
 * tenant holds reads as no case at all.
 */
export default async function RemoveCasesPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string | string[]; notice?: string }>;
}) {
  const session = await requireSession();
  const params = await searchParams;
  const viewer = viewerOf(session);
  const notice =
    typeof params.notice === 'string' && REMOVE_NOTICES.has(params.notice)
      ? resolveNotice(params.notice)
      : undefined;

  const shell = (body: React.ReactNode) => (
    <WorkspaceShell viewer={viewer} detail>
      <main id="workspace-main" className="workspace-main">
        <div
          className="modal is-open"
          role="dialog"
          aria-modal="true"
          aria-labelledby="remove-cases-title"
        >
          <Link href="/" className="modal-backdrop" aria-label="Cancel" tabIndex={-1}></Link>
          <div className="modal-panel narrow">
            <div className="modal-body">
              <Link href="/" className="modal-close" aria-label="Cancel">
                ×
              </Link>
              {notice === undefined ? null : (
                <p className={notice.tone === 'good' ? 'notice sent' : 'notice bad'}>{notice.text}</p>
              )}
              {body}
            </div>
          </div>
        </div>
      </main>
    </WorkspaceShell>
  );

  if (!mayApprove(session.org.role)) {
    return shell(
      <>
        <h2 id="remove-cases-title">Delete cases</h2>
        <p className="notice bad">Only an owner or an approver can delete a case.</p>
        <p>
          <Link href="/">Back to the deductions</Link>
        </p>
      </>,
    );
  }

  const selection = removalIdsFrom(params.id);
  if ('refused' in selection) {
    return shell(
      <>
        <h2 id="remove-cases-title">Delete cases</h2>
        <p className="notice bad">
          {selection.refused === 'none'
            ? 'No case was selected. Tick one or more cases in the queue first.'
            : selection.refused === 'too_many'
              ? `At most ${MAX_CASES_REMOVED_AT_ONCE} cases can be deleted at once.`
              : 'That selection does not name a case.'}
        </p>
        <p>
          <Link href="/">Back to the deductions</Link>
        </p>
      </>,
    );
  }

  const store = storeFor(session);
  let found: { id: string; summary: CaseSummary | undefined }[];
  try {
    found = [];
    for (const id of selection.ids) found.push({ id, summary: await store.caseSummary(id) });
  } finally {
    await store.close();
  }
  const removable = found.filter(
    (row): row is { id: string; summary: CaseSummary } =>
      row.summary !== undefined && whyNotRemovable(row.summary.state) === undefined,
  );
  const refused = found.filter(
    (row) => row.summary === undefined || whyNotRemovable(row.summary.state) !== undefined,
  );
  const n = removable.length;

  return shell(
    <>
      <h2 id="remove-cases-title">{n === 1 ? 'Delete this case?' : `Delete these ${n} cases?`}</h2>
      {n === 0 ? null : (
        <>
          <ul className="remove-list">
            {removable.map(({ id, summary }) => (
              <li key={id}>
                <span className="mono">{summary.claimId ?? id.slice(0, 8)}</span> ·{' '}
                {retailer(summary, 'payer unknown').name} · {money(summary.deductionAmountCents)}
              </li>
            ))}
          </ul>
          <p className="hint">
            They will be removed from every list and total. Their record is kept for audit. This
            can&rsquo;t be undone from the app.
          </p>
        </>
      )}
      {refused.length === 0 ? null : (
        <>
          <h3>Not deleted</h3>
          <ul className="remove-list">
            {refused.map(({ id, summary }) => (
              <li key={id}>
                <span className="mono">{summary?.claimId ?? id.slice(0, 8)}</span> —{' '}
                {summary === undefined ? 'no such case' : whyNotRemovable(summary.state)}
              </li>
            ))}
          </ul>
        </>
      )}
      {n === 0 ? (
        <p>
          <Link href="/">Back to the deductions</Link>
        </p>
      ) : (
        <form method="post" action="/cases/remove/confirm" className="modal-form">
          {removable.map(({ id }) => (
            <input key={id} type="hidden" name="id" value={id} />
          ))}
          <div className="setting-row wide">
            <div className="setting-label">
              <label htmlFor="remove-reason">Reason</label>
              <p className="setting-description">Optional. Kept with the record.</p>
            </div>
            <div className="setting-control">
              <textarea id="remove-reason" name="reason" maxLength={REMOVE_REASON_MAX_LENGTH} />
            </div>
          </div>
          <div className="modal-footer">
            <Link href="/" className="modal-cancel">
              Cancel
            </Link>
            <button type="submit" className="danger">
              Delete
            </button>
          </div>
        </form>
      )}
    </>,
  );
}

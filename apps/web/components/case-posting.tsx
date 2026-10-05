import { formatCents } from '@recouple/core-domain';
import type { CasePosting } from '@recouple/store-postgres';
import { SETTLE_PARAMS } from '../lib/settlement-fields';
import { StoredSettlementLines } from './settlement-editor';

const METHOD_LABEL = {
  journal_entry: 'Journal entry',
  payment_application: 'Payment linking it to the invoice',
} as const;

/**
 * The case's postings to QuickBooks (ADR 0060): each writeback row and what
 * became of it, a retry for any that failed or wait, and moment 2's approval:
 * the settlement a person prepared, line by line as it will be posted, what
 * they changed from the computed entry, and — for a second person — the one
 * button (ADR 0068). Preparing it is the draft-accounting card's form.
 * Rendered only on a deployment that posts at all; the database is the
 * referee for every act.
 */
export function CasePostingCard({
  deductionId,
  posting,
  mayAct,
  mayApprove,
  viewerUserId,
}: {
  deductionId: string;
  posting: CasePosting;
  mayAct: boolean;
  mayApprove: boolean;
  viewerUserId: string;
}) {
  const live =
    posting.connection !== undefined && posting.connection.postingEnabled && posting.connection.hasMap;
  const settlement = posting.settlement;
  const entrySucceeded = new Set(
    posting.writebacks
      .filter((w) => w.method === 'journal_entry' && w.status === 'succeeded')
      .map((w) => w.decisionId),
  );
  return (
    <div className="card act" style={{ marginTop: 18 }} aria-label="QuickBooks postings">
      <h2 className="section" style={{ marginTop: 0 }}>
        QuickBooks postings
      </h2>
      {live ? null : (
        <p className="hint">Posting is off for this workspace&apos;s QuickBooks company.</p>
      )}
      {posting.writebacks.length === 0 ? (
        <p className="hint">Nothing has been posted for this case.</p>
      ) : (
        <ul>
          {posting.writebacks.map((w) => {
            const retryable =
              w.status === 'failed' ||
              (w.status === 'pending' && w.method === 'payment_application' && entrySucceeded.has(w.decisionId));
            return (
              <li key={w.writebackId}>
                {METHOD_LABEL[w.method]}
                {w.amountCents === undefined ? '' : `, ${formatCents(w.amountCents)}`}: {w.status}
                {w.qboTxnId === undefined ? '' : ` (QuickBooks ${w.qboTxnId})`}
                {retryable && mayAct ? (
                  <form action={`/cases/${deductionId}/retry-writeback`} method="post" style={{ display: 'inline', marginLeft: 8 }}>
                    <input type="hidden" name="writebackId" value={w.writebackId} />
                    <button type="submit">{w.status === 'failed' ? 'Check QuickBooks and retry' : 'Send'}</button>
                  </form>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {settlement !== undefined ? (
        <div className="settlement-prepared">
          <p className="hint">
            Settlement {settlement.approved ? 'approved' : 'prepared'}: {settlement.outcome},{' '}
            {formatCents(settlement.recoveredCents)} recovered, invoice{' '}
            <span className="mono">{settlement.invoiceId}</span>.
          </p>
          {settlement.lines === undefined ? (
            <p className="hint">
              This settlement was prepared without journal lines of its own, so the computed entry
              is what is posted.
            </p>
          ) : (
            <StoredSettlementLines lines={settlement.lines} computed={settlement.computedLines} />
          )}
        </div>
      ) : null}

      {live && settlement !== undefined && !settlement.approved ? (
        mayApprove && settlement.preparedBy !== viewerUserId ? (
          <form action={`/cases/${deductionId}/settle`} method="post">
            <input type="hidden" name="intent" value="approve" />
            <input type="hidden" name="decisionId" value={settlement.decisionId} />
            <button className="primary" type="submit">
              Approve the settlement and post it to QuickBooks
            </button>
          </form>
        ) : (
          <p className="hint">
            {settlement.preparedBy === viewerUserId
              ? 'You prepared this settlement, so a second person approves it.'
              : 'A settlement is prepared and waiting on an owner or an approver.'}
          </p>
        )
      ) : null}

      {live && mayAct && settlement !== undefined && !settlement.approved ? (
        <p className="hint">
          <a href={`/cases/${deductionId}?${SETTLE_PARAMS.again}=1#settlement`}>
            Prepare it again with different lines
          </a>{' '}
          — the lines above are not changed; a new settlement replaces this one.
        </p>
      ) : null}
    </div>
  );
}

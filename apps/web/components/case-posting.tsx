import { formatCents } from '@recouple/core-domain';
import type { CasePosting, CaseWriteback } from '@recouple/store-postgres';
import { SETTLE_PARAMS } from '../lib/settlement-fields';
import { StoredSettlementLines } from './settlement-editor';

const METHOD_LABEL = {
  journal_entry: 'Journal entry',
  payment_application: 'Payment linking it to the invoice',
} as const;

/**
 * Why an attempt ended, in fixed wording keyed on the reason constant the job
 * recorded (ADR 0069 §2). Never anything QuickBooks or a document said.
 */
const REASON_WORDING: Readonly<Record<string, string>> = {
  no_invoice: 'The settlement names no QuickBooks invoice.',
  invoice_not_found: 'QuickBooks has no invoice with the id this settlement names.',
  invoice_lookup_failed: 'The invoice could not be read from QuickBooks.',
  build_failed: 'The entry could not be built from the approved settlement.',
  lines_changed: 'The entry no longer matches the lines that were approved.',
  send_failed: 'QuickBooks refused the entry.',
  unknown_outcome: 'QuickBooks did not answer after the entry was sent.',
  readback_failed: 'The entry could not be read back from QuickBooks.',
  readback_mismatch: 'What QuickBooks holds does not match what was approved.',
  ambiguous_reference: 'QuickBooks holds more than one entry carrying this posting\u2019s reference.',
};

/** The one-word state of a posting, saying "not sent" apart from "unknown". */
export function postingStatusLabel(w: CaseWriteback): string {
  if (w.voided) return w.status === 'succeeded' ? 'posted' : 'voided — never sent';
  if (w.status === 'succeeded') return 'posted';
  if (w.status === 'pending') return w.stale ? 'waiting — no result recorded' : 'waiting';
  if (w.nothingSent) return 'not sent — nothing reached QuickBooks';
  return w.lastReason === 'send_failed'
    ? 'failed — QuickBooks refused it'
    : 'outcome unknown — it may have reached QuickBooks';
}

export function postingStatusDetail(w: CaseWriteback): string | undefined {
  if (w.status === 'succeeded') return undefined;
  if (w.status === 'pending') {
    return w.stale && !w.voided
      ? 'It has waited more than a few minutes. Check QuickBooks and retry reads QuickBooks before it sends anything.'
      : undefined;
  }
  const why = w.lastReason === undefined ? undefined : REASON_WORDING[w.lastReason];
  if (w.voided || w.nothingSent) return why;
  return `${why ?? ''} Check QuickBooks and retry reads QuickBooks first and sends only if nothing there carries it.`.trim();
}

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
  // The settlement whose entry failed before anything was sent, and whose
  // other rows were never tried: the one a person may void (ADR 0069 §3).
  const voidable =
    settlement !== undefined &&
    settlement.approved &&
    settlement.voided !== true &&
    posting.writebacks.some(
      (w) => w.decisionId === settlement.decisionId && w.method === 'journal_entry' && w.nothingSent,
    ) &&
    posting.writebacks.every(
      (w) => w.decisionId !== settlement.decisionId || w.nothingSent || (w.status === 'pending' && w.attempts === 0),
    )
      ? settlement.decisionId
      : undefined;
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
              !w.voided &&
              (w.status === 'failed' ||
                (w.status === 'pending' && w.stale) ||
                (w.status === 'pending' && w.method === 'payment_application' && entrySucceeded.has(w.decisionId)));
            return (
              <li key={w.writebackId}>
                {METHOD_LABEL[w.method]}
                {w.amountCents === undefined ? '' : `, ${formatCents(w.amountCents)}`}:{' '}
                <strong>{postingStatusLabel(w)}</strong>
                {w.qboTxnId === undefined ? '' : ` (QuickBooks ${w.qboTxnId})`}
                {postingStatusDetail(w) === undefined ? null : (
                  <span className="hint"> {postingStatusDetail(w)}</span>
                )}
                {retryable && mayAct ? (
                  <form action={`/cases/${deductionId}/retry-writeback`} method="post" style={{ display: 'inline', marginLeft: 8 }}>
                    <input type="hidden" name="writebackId" value={w.writebackId} />
                    <button type="submit">
                      {w.status === 'failed' || w.method === 'journal_entry' ? 'Check QuickBooks and retry' : 'Send'}
                    </button>
                  </form>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {voidable !== undefined ? (
        mayApprove ? (
          <form action={`/cases/${deductionId}/void-posting`} method="post">
            <input type="hidden" name="decisionId" value={voidable} />
            <p className="hint">
              Nothing was sent to QuickBooks for this settlement. Voiding it checks QuickBooks once
              more, then sets the settlement aside so the case can be settled again. The approval
              and this failed posting stay on the record.
            </p>
            <button type="submit">Void this posting and settle the case again</button>
          </form>
        ) : (
          <p className="hint">
            Nothing was sent to QuickBooks for this settlement. An owner or an approver can void it
            so the case can be settled again.
          </p>
        )
      ) : null}

      {settlement !== undefined ? (
        <div className="settlement-prepared">
          <p className="hint">
            Settlement{' '}
            {settlement.voided === true
              ? 'approved, then voided before anything reached QuickBooks'
              : settlement.approved
                ? 'approved'
                : 'prepared'}
            : {settlement.outcome}, {formatCents(settlement.recoveredCents)} recovered, invoice{' '}
            {settlement.invoiceNumber === undefined ? null : (
              <>
                <span className="mono">{settlement.invoiceNumber}</span>, QuickBooks id{' '}
              </>
            )}
            <span className="mono">{settlement.invoiceId}</span>.
            {settlement.voided === true ? ' Prepare a new settlement in the draft accounting card.' : ''}
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

import { REASON_FAMILIES, formatCents } from '@recouple/core-domain';
import type { CasePosting, SettlementOutcome } from '@recouple/store-postgres';

/** The store's `SETTLEMENT_OUTCOMES`, as a type-only import keeps pg out of the view. */
const SETTLEMENT_OUTCOMES: readonly SettlementOutcome[] = ['won', 'partial', 'lost', 'declined'];

const METHOD_LABEL = {
  journal_entry: 'Journal entry',
  payment_application: 'Payment linking it to the invoice',
} as const;

/**
 * The case's postings to QuickBooks (ADR 0060): each writeback row and what
 * became of it, a retry for any that failed or wait, and moment 2 — preparing
 * a settlement and, for a second person, approving it. Rendered only on a
 * deployment that posts at all; the database is the referee for every act.
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

      {live && settlement !== undefined && !settlement.approved ? (
        mayApprove && settlement.preparedBy !== viewerUserId ? (
          <form action={`/cases/${deductionId}/settle`} method="post">
            <input type="hidden" name="intent" value="approve" />
            <input type="hidden" name="decisionId" value={settlement.decisionId} />
            <p className="hint">
              Settlement prepared: {settlement.outcome}, {formatCents(settlement.recoveredCents)} recovered,
              invoice <span className="mono">{settlement.invoiceId}</span>.
            </p>
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

      {live && mayAct && settlement === undefined ? (
        <form action={`/cases/${deductionId}/settle`} method="post">
          <input type="hidden" name="intent" value="prepare" />
          <label htmlFor="settle-outcome">How it settled</label>
          <select id="settle-outcome" name="outcome" required>
            {SETTLEMENT_OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
          <label htmlFor="settle-recovered">Recovered</label>
          <input id="settle-recovered" name="recovered" placeholder="$0.00" />
          <label htmlFor="settle-family">Reason family</label>
          <select id="settle-family" name="family">
            <option value="">unclassified</option>
            {REASON_FAMILIES.map((f) => (
              <option key={f} value={f}>
                {f.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
          <label htmlFor="settle-invoice">QuickBooks invoice id</label>
          <input
            id="settle-invoice"
            name="invoiceId"
            required
            pattern="[0-9]{1,20}"
            defaultValue={posting.ledgerInvoiceId ?? ''}
          />
          <button type="submit">Prepare the settlement</button>
        </form>
      ) : null}
    </div>
  );
}

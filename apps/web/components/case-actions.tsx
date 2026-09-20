import {
  familyOf,
  type CanonicalReasonCode,
  type CaseState,
  type ReasonFamily,
} from '@recouple/core-domain';
import type { CaseWorkflow } from '@recouple/pipeline';

/**
 * The reasons a deduction is disputed, in a reviewer's words.
 *
 * The values are `CanonicalReasonCode`s and nothing else (ADR 0020 §1): a
 * retailer's own code maps onto one of these through playbook data, and a
 * reason outside the taxonomy is a row that can be stored and never counted.
 * The list is a subset on purpose — it is what an analyst picks from, not the
 * whole taxonomy — and the type is what stops it drifting away from it.
 *
 * The labels are in this file because they are how a person reads a code, and
 * the codes are the thing the rest of the system agrees on. A retailer's
 * *rules* are not here and never will be: they are versioned, effective-dated
 * playbook data.
 */
const DISPUTE_REASONS: readonly (readonly [CanonicalReasonCode, string])[] = [
  ['shortage_quantity', 'They took a shortage for units we shipped'],
  ['shortage_never_received', 'They say the shipment never arrived'],
  ['shortage_concealed', 'A concealed shortage claimed after receipt'],
  ['price_discrepancy', 'They paid a price we did not agree'],
  ['unauthorised_deduction_no_basis', 'A deduction with no basis given'],
  ['cost_increase_not_honoured', 'An agreed cost increase was not honoured'],
  ['compliance_otif', 'An OTIF or fill-rate fine we can disprove'],
  ['compliance_late_delivery', 'A late-delivery fine we can disprove'],
  ['compliance_asn_missing', 'An ASN penalty we can disprove'],
  ['duplicate_claim', 'The same claim, taken twice'],
  ['duplicate_invoice_deduction', 'The same invoice, deducted twice'],
  ['return_unauthorised', 'A return nobody authorised'],
  ['promo_not_agreed', 'A promotion or allowance we never agreed'],
  ['promo_rate_mismatch', 'An allowance taken at the wrong rate'],
  ['freight_prepaid_billed', 'Freight billed on a prepaid shipment'],
  ['freight_rate_mismatch', 'Freight charged at the wrong rate'],
  ['quality_damaged_in_transit', 'Damage that happened after it left us'],
  ['post_audit_pricing', 'A post-audit pricing claim we can answer'],
  ['post_audit_allowance', 'A post-audit allowance claim we can answer'],
  ['unknown_uncoded', 'Something else — the rationale says what'],
];

/**
 * The same list, grouped by the family each code belongs to. Computed rather
 * than written down a second time, so a code cannot end up under a heading its
 * taxonomy disagrees with.
 */
const REASON_GROUPS: readonly (readonly [
  ReasonFamily,
  readonly (readonly [CanonicalReasonCode, string])[],
])[] = (() => {
  const groups = new Map<ReasonFamily, (readonly [CanonicalReasonCode, string])[]>();
  for (const entry of DISPUTE_REASONS) {
    const family = familyOf(entry[0]);
    const bucket = groups.get(family) ?? [];
    bucket.push(entry);
    groups.set(family, bucket);
  }
  return [...groups.entries()];
})();

export { DISPUTE_REASONS };

export interface CaseActionsProps {
  readonly deductionId: string;
  readonly state: CaseState;
  /** One `getWorkflow` read. Each part is absent until it has happened. */
  readonly workflow: CaseWorkflow | undefined;
  /** Whether this member's role may write at all (`owner`, `approver`, `analyst`). */
  readonly mayAct: boolean;
  /** Whether this member's role may approve (`owner`, `approver`). */
  readonly mayApprove: boolean;
  /** Who is looking, so the page can tell them they prepared this themselves. */
  readonly viewerUserId: string;
  /** Filenames for the documents in the packet, from the fields already read. */
  readonly filenames: ReadonlyMap<string, string>;
}

/**
 * What a reviewer can do with this case, from deciding to recording what came
 * back.
 *
 * One card per state, and a card is shown only where the state machine says the
 * action is legal and the member's role may take it. Neither is the
 * enforcement: the database refuses an approval by the preparer, a submission
 * with no approval, and a write by a `read_only` member whatever this component
 * renders. Hiding a button is the difference between a refusal and a dead end.
 *
 * A pure function of what the store returned — the page reads, this renders.
 */
export function CaseActions({
  deductionId,
  state,
  workflow,
  mayAct,
  mayApprove,
  viewerUserId,
  filenames,
}: CaseActionsProps) {
  const decision = workflow?.decision;
  const packet = workflow?.packet;
  const approval = workflow?.approval;
  const submission = workflow?.submission;
  const isPreparer = decision !== undefined && decision.preparedBy === viewerUserId;

  return (
    <>
      {/* 1. Decide to dispute. Beside the decline card and against it: a case
          is fought or it is logged as declined, never both. */}
      {state === 'classified' && decision === undefined && mayAct ? (
        <div className="card act" style={{ marginTop: 18 }}>
          <h2 className="section" style={{ marginTop: 0 }}>
            Dispute this deduction
          </h2>
          <p className="hint">
            Your decision, recorded as yours: it is written with your name on it, and the person
            who approves it cannot be you. Nothing is sent by deciding — the packet comes next,
            and a second person authorises that.
          </p>
          <form action={`/cases/${deductionId}/decide`} method="post">
            <label htmlFor="dispute-reason">Why this deduction is invalid</label>
            <select id="dispute-reason" name="reason" required defaultValue="">
              <option value="" disabled>
                Choose a reason…
              </option>
              {REASON_GROUPS.map(([family, reasons]) => (
                <optgroup key={family} label={family.replace(/_/g, ' ')}>
                  {reasons.map(([code, label]) => (
                    <option key={code} value={code}>
                      {label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>

            <label htmlFor="rationale">In one line, for whoever approves it</label>
            <input
              id="rationale"
              name="rationale"
              type="text"
              maxLength={500}
              required
              placeholder="The signed BOL shows all 30 cases delivered."
            />

            <button className="primary" type="submit">
              Decide to dispute
            </button>
          </form>
        </div>
      ) : null}

      {/* 2. Assemble the packet. */}
      {state === 'analyst_review' && decision !== undefined && packet === undefined && mayAct ? (
        <div className="card act" style={{ marginTop: 18 }}>
          <h2 className="section" style={{ marginTop: 0 }}>
            Assemble the packet
          </h2>
          <p className="hint">
            The notice, everything attached to this case, and a cover sheet our code writes from
            the fields already read off the page. No model writes it, so the same case always
            assembles to the same contents — which is what makes approving a hash mean something.
          </p>
          <form action={`/cases/${deductionId}/packet`} method="post">
            <input type="hidden" name="decisionId" value={decision.decisionId} />
            <button className="primary" type="submit">
              Assemble the packet
            </button>
          </form>
        </div>
      ) : null}

      {/* The packet itself, once there is one: what a person is being asked to
          authorise, in full, with every file reachable. */}
      {packet !== undefined ? (
        <div className="card packet" style={{ marginTop: 18 }}>
          <h2 className="section" style={{ marginTop: 0 }}>
            The packet · <span className="mono">{packet.contentHash.slice(0, 12)}</span>
          </h2>
          <pre className="narrative">{packet.narrative}</pre>
          <ul className="filelist">
            {packet.fileDocumentIds.map((documentId, index) => (
              <li key={documentId}>
                <a href={`/api/document/${documentId}`}>
                  {filenames.get(documentId) ?? `document ${index + 1}`}
                </a>
              </li>
            ))}
          </ul>
          <p className="hint" style={{ margin: '12px 0 0' }}>
            <a href={`/cases/${deductionId}/packet`}>Download cover sheet</a> — the narrative as
            markdown, served through the same policies as everything else here.
          </p>
        </div>
      ) : null}

      {/* 3. Approve. The one act the database refuses to let the preparer take,
          and the only thing that lets a submission exist at all. */}
      {state === 'awaiting_approval' && packet !== undefined && approval === undefined ? (
        <div className="card act approve" style={{ marginTop: 18 }}>
          <h2 className="section" style={{ marginTop: 0 }}>
            Approve for submission
          </h2>
          <p className="hint">
            Approval is a recorded act by a second person. It names the exact packet below —{' '}
            <span className="mono">{packet.contentHash.slice(0, 12)}</span> — and the database
            refuses a filing that has no approval for this decision, and refuses an approval from
            whoever prepared it.
          </p>
          {mayApprove && !isPreparer ? (
            <form action={`/cases/${deductionId}/approve`} method="post">
              <input type="hidden" name="decisionId" value={packet.decisionId} />
              <input type="hidden" name="packetId" value={packet.packetId} />
              <label htmlFor="approval-note">Anything a later reader would need (optional)</label>
              <textarea id="approval-note" name="note" rows={2} maxLength={2000} />
              <button className="primary" type="submit">
                Approve for submission
              </button>
            </form>
          ) : (
            <p className="hint" style={{ margin: 0 }}>
              {isPreparer
                ? 'You prepared this decision, so approving it is not yours to do. Separation of duties is the point of the gate, and the database refuses it too.'
                : 'Waiting on an owner or an approver. Your role can prepare a case and assemble its packet, but not authorise it.'}
            </p>
          )}
        </div>
      ) : null}

      {/* 4. Record what a person filed on the portal. */}
      {state === 'awaiting_approval' &&
      packet !== undefined &&
      approval !== undefined &&
      submission === undefined &&
      mayAct ? (
        <div className="card act" style={{ marginTop: 18 }}>
          <h2 className="section" style={{ marginTop: 0 }}>
            Record the filing
          </h2>
          <p className="hint">
            This app files nothing. A person files the dispute on the retailer&rsquo;s portal and
            records it here:
          </p>
          <ol className="steps">
            <li>Open the retailer&rsquo;s dispute portal and start a claim for this deduction.</li>
            <li>Attach the cover sheet and every document listed in the packet above.</li>
            <li>Paste back the confirmation number the portal gives you.</li>
          </ol>
          <p className="hint">
            Which portal it is, and what that retailer requires attached, is playbook data this app
            does not hold yet — follow the routing guide you already use for them.
          </p>
          <form action={`/cases/${deductionId}/submit`} method="post">
            <input type="hidden" name="decisionId" value={packet.decisionId} />
            <input type="hidden" name="packetId" value={packet.packetId} />
            <input type="hidden" name="approvalId" value={approval.approvalId} />

            <label htmlFor="channel-fixed">How it was filed</label>
            <input id="channel-fixed" type="text" value="manual portal" readOnly disabled />

            <label htmlFor="confirmationNumber">Confirmation number</label>
            <input
              id="confirmationNumber"
              name="confirmationNumber"
              type="text"
              maxLength={120}
              required
            />

            <label htmlFor="submittedAt">Filed on</label>
            <input id="submittedAt" name="submittedAt" type="date" required />

            <button className="primary" type="submit">
              Record this filing
            </button>
          </form>
        </div>
      ) : null}

      {/* 5. Record what came back. */}
      {state === 'submitted' && mayAct ? (
        <div className="card act" style={{ marginTop: 18 }}>
          <h2 className="section" style={{ marginTop: 0 }}>
            Record the outcome
          </h2>
          <p className="hint">
            What the retailer did with it. The amount is stored as whole cents, and this is where
            an attributable recovery is read from when the contingency fee is worked out — so it
            is the number, not an estimate of it.
          </p>
          <form action={`/cases/${deductionId}/outcome`} method="post">
            <label htmlFor="outcome">What came back</label>
            <select id="outcome" name="outcome" required defaultValue="">
              <option value="" disabled>
                Choose…
              </option>
              <option value="won">Won — they paid all of it</option>
              <option value="partial">Partial — they paid some of it</option>
              <option value="lost">Lost — they paid none of it</option>
            </select>

            <label htmlFor="recovered">Recovered amount</label>
            <input
              id="recovered"
              name="recovered"
              type="text"
              inputMode="decimal"
              maxLength={20}
              placeholder="1,800.00"
            />
            <span className="hint" style={{ display: 'block', margin: '4px 0 0' }}>
              Dollars and cents, as written. Leave it empty for a case they paid nothing on.
            </span>

            <label htmlFor="outcome-note">Anything a later reader would need (optional)</label>
            <textarea id="outcome-note" name="note" rows={2} maxLength={2000} />

            <button className="primary" type="submit">
              Record this outcome
            </button>
          </form>
        </div>
      ) : null}
    </>
  );
}

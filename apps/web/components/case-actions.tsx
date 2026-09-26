import {
  DISPUTE_REASONS,
  MAX_RATIONALE_LENGTH,
  familyOf,
  type CanonicalReasonCode,
  type CaseState,
  type ReasonFamily,
} from '@recouple/core-domain';
import type { CaseWorkflow, ServingRefusal } from '@recouple/pipeline';
import { CONFIRMATION_MAX_LENGTH, NOTE_MAX_LENGTH } from '../lib/notices';
import { SERVING_REFUSED } from '../lib/serve-document';

/**
 * The reasons a deduction is disputed, as the form offers them.
 *
 * The values are `CanonicalReasonCode`s and nothing else (ADR 0020 §1), and the
 * words are `core-domain`'s `REASON_WORDS` — the same words the dispute letter
 * tells the payer, so what a person picks here is what the payer reads. A
 * payer's *rules* are not here and never will be: they are versioned,
 * effective-dated playbook data.
 */
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
  /**
   * The case's documents whose bytes are not served, and why (`servingRefusal`).
   * Listed without a link, and the zip is not offered while the packet holds
   * one: both routes would answer 409.
   */
  readonly unservable: ReadonlyMap<string, ServingRefusal>;
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
  unservable,
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
            {/* The cap is the packet narrative's, not a number this file chose:
                `MAX_RATIONALE_LENGTH` is what the cover sheet has room for, and
                it is what the store refuses on — before the append-only
                `decisions` row is written, so a rationale the packet could not
                hold cannot wedge the case. A browser stopping at some other
                number would be this form disagreeing with the one referee. */}
            <input
              id="rationale"
              name="rationale"
              type="text"
              maxLength={MAX_RATIONALE_LENGTH}
              required
              placeholder="The signed BOL shows all 30 cases delivered."
            />

            <button className="primary" type="submit">
              Decide to dispute
            </button>
          </form>
        </div>
      ) : null}

      {/* 2. Assemble the packet — and again while it waits for approval, so
          evidence attached after the first assembly can get in. The store
          allows it until an approval exists, and only the latest packet can be
          approved (`PacketSupersededError`). */}
      {decision !== undefined &&
      mayAct &&
      ((state === 'analyst_review' && packet === undefined) ||
        (state === 'awaiting_approval' && packet !== undefined && approval === undefined)) ? (
        <div className="card act" style={{ marginTop: 18 }}>
          <h2 className="section" style={{ marginTop: 0 }}>
            {packet === undefined ? 'Assemble the packet' : 'Assemble the packet again'}
          </h2>
          <p className="hint">
            {packet === undefined
              ? 'The notice, everything attached to this case, and a dispute letter our code writes from the fields already read off the page. No model writes it, so the same case always assembles to the same contents — which is what makes approving a hash mean something.'
              : 'Attached something since the packet below was assembled? Assemble again to include it. The new packet replaces this one for approval; the old one stays on the record.'}
          </p>
          <form action={`/cases/${deductionId}/packet`} method="post">
            <input type="hidden" name="decisionId" value={decision.decisionId} />
            <button className={packet === undefined ? 'primary' : undefined} type="submit">
              {packet === undefined ? 'Assemble the packet' : 'Assemble again'}
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
            {packet.fileDocumentIds.map((documentId, index) => {
              const name = filenames.get(documentId) ?? `document ${index + 1}`;
              const refusal = unservable.get(documentId);
              return (
                <li key={documentId}>
                  {refusal === undefined ? (
                    <a href={`/api/document/${documentId}`}>{name}</a>
                  ) : (
                    <>
                      {name} — {SERVING_REFUSED[refusal]}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="hint" style={{ margin: '12px 0 0' }}>
            <a href={`/cases/${deductionId}/packet/letter`}>Printable letter</a> (print or save
            as PDF) ·{' '}
            {packet.fileDocumentIds.some((documentId) => unservable.has(documentId)) ? (
              <>no enclosures zip while a document above is not served</>
            ) : (
              <a href={`/cases/${deductionId}/packet/enclosures`}>All enclosures (.zip)</a>
            )}{' '}
            · <a href={`/cases/${deductionId}/packet`}>Letter as text</a> — each exactly this
            packet, served through the same policies as everything else here.
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
              {/* The same number the route refuses on, from the same constant:
                  a browser that stopped at a different one would hand the
                  handler a note the person thought they had finished. */}
              <textarea id="approval-note" name="note" rows={2} maxLength={NOTE_MAX_LENGTH} />
              <button className="primary" type="submit">
                Approve for submission
              </button>
            </form>
          ) : (
            <p className="hint" style={{ margin: 0 }}>
              {isPreparer
                ? 'You prepared this decision, so approving it is not yours to do. Separation of duties is the point of the gate, and the database refuses it too.'
                : mayAct
                  ? 'Waiting on an owner or an approver. Your role can prepare a case and assemble its packet, but not authorise it.'
                  : // A `read_only` member is neither the approver nor the
                    // analyst the other sentence is addressed to, and telling
                    // them they can assemble a packet would be telling them to
                    // go and press a button the write policies refuse.
                    'Waiting on an owner or an approver. Your role can read this case but not act on it.'}
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
            <li>Attach the dispute letter and every document listed in the packet above.</li>
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
              maxLength={CONFIRMATION_MAX_LENGTH}
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
            <textarea id="outcome-note" name="note" rows={2} maxLength={NOTE_MAX_LENGTH} />

            <button className="primary" type="submit">
              Record this outcome
            </button>
          </form>
        </div>
      ) : null}
    </>
  );
}

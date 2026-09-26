import type { ReactNode } from 'react';
import type { CaseWorkflow } from '@recouple/pipeline';
import { declineReasonLabel, missingEvidenceLabel } from '../lib/decline-labels';
import { money } from '../lib/format';

/**
 * When something happened, in UTC, spelled the same way everywhere.
 *
 * Not a locale format: this renders on a server whose locale is nobody's, and a
 * date that reads differently depending on where it was rendered is a date two
 * people will disagree about in an audit.
 */
export function at(when: Date): string {
  return `${when.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * Who did it.
 *
 * The workflow port carries user ids and not names — the identity a page could
 * show belongs to Supabase Auth, and a view that guessed at it would be putting
 * a name on a recorded act. So: "you" when it was this reviewer, and the first
 * eight characters of the id when it was somebody else, which is enough to tell
 * two people apart and honest about being an id.
 */
export function who(userId: string, viewerUserId: string): string {
  return userId === viewerUserId ? 'you' : userId.slice(0, 8);
}

/**
 * Who declined it. A decline records the session's email rather than a user id
 * (the decline route's `decidedBy`), so `who` does not apply: "you" when it is
 * this reviewer's address, compared without case, and the address otherwise.
 */
export function whoByEmail(email: string, viewerEmail: string): string {
  return viewerEmail !== '' && email.toLowerCase() === viewerEmail.toLowerCase() ? 'you' : email;
}

interface Entry {
  readonly key: string;
  readonly what: string;
  readonly detail: ReactNode;
  readonly by: string;
  /** When it happened, for the order; `when` is the same instant, spelled out. */
  readonly at: Date;
  readonly when: string;
}

/**
 * What has happened to this case, in the order it happened.
 *
 * A pure function of one `getWorkflow` read. Each part is absent until it
 * happens, and an absent part is simply not a row: this is a record of acts, so
 * an empty timeline says nothing has been done rather than that something is
 * pending.
 *
 * Sorted by time rather than by kind: a case declined before the rule that a
 * decided case cannot be declined existed may carry both, and the record reads
 * in the order the two were done.
 *
 * Every piece of text here is escaped by React — the rationale, the note and a
 * decline's detail are typed by a person, and the packet's narrative quotes
 * somebody else's document.
 */
export function CaseTimeline({
  workflow,
  viewerUserId,
  viewerEmail = '',
}: {
  readonly workflow: CaseWorkflow | undefined;
  readonly viewerUserId: string;
  /** Who is looking, by the address a decline records its author under. */
  readonly viewerEmail?: string;
}) {
  const entries: Entry[] = [];

  const decision = workflow?.decision;
  if (decision !== undefined) {
    entries.push({
      key: 'decision',
      what: 'Decided to dispute',
      detail: (
        <>
          <span className="mono">{decision.reason}</span>
          <span className="said">{decision.rationale}</span>
        </>
      ),
      by: who(decision.preparedBy, viewerUserId),
      at: decision.decidedAt,
      when: at(decision.decidedAt),
    });
  }

  // A decline moves no state (ADR 0043), so without this entry a declined
  // case read "nothing yet" once the notice that said so was gone.
  const decline = workflow?.decline;
  if (decline !== undefined) {
    entries.push({
      key: 'decline',
      what: 'Declined, not fought',
      detail: (
        <>
          {`${declineReasonLabel(decline.reason)} · ${money(decline.estimatedRecoverableCents)} ` +
            'not pursued' +
            (decline.missingEvidence.length === 0
              ? ''
              : ` · missing: ${decline.missingEvidence.map(missingEvidenceLabel).join(', ')}`)}
          {decline.detail === undefined ? null : <span className="said">{decline.detail}</span>}
        </>
      ),
      by: whoByEmail(decline.decidedBy, viewerEmail),
      at: decline.decidedAt,
      when: at(decline.decidedAt),
    });
  }

  const packet = workflow?.packet;
  if (packet !== undefined) {
    entries.push({
      key: 'packet',
      what: 'Packet assembled',
      detail: (
        <>
          <span className="mono">{packet.contentHash.slice(0, 12)}</span> ·{' '}
          {packet.fileDocumentIds.length} document
          {packet.fileDocumentIds.length === 1 ? '' : 's'}
        </>
      ),
      by: who(packet.assembledBy, viewerUserId),
      at: packet.assembledAt,
      when: at(packet.assembledAt),
    });
  }

  const approval = workflow?.approval;
  if (approval !== undefined) {
    entries.push({
      key: 'approval',
      what: 'Approved for submission',
      detail: (
        <>
          <span className="mono">{approval.packetHash.slice(0, 12)}</span>
          {approval.note === undefined ? null : <span className="said">{approval.note}</span>}
        </>
      ),
      by: who(approval.approverId, viewerUserId),
      at: approval.approvedAt,
      when: at(approval.approvedAt),
    });
  }

  const submission = workflow?.submission;
  if (submission !== undefined) {
    entries.push({
      key: 'submission',
      what: 'Filed',
      detail: (
        <>
          {submission.channel.replace(/_/g, ' ')} · confirmation{' '}
          <span className="mono">{submission.confirmationNumber}</span>
        </>
      ),
      // A submission's actor is not on the record the port returns; the
      // approval above names the person who authorised it, which is the one
      // the gate cares about.
      by: '',
      at: submission.submittedAt,
      when: at(submission.submittedAt),
    });
  }

  const outcome = workflow?.outcome;
  if (outcome !== undefined) {
    entries.push({
      key: 'outcome',
      what: `Outcome: ${outcome.outcome}`,
      detail: (
        <>
          {money(outcome.recoveredCents)} recovered
          {outcome.note === undefined ? null : <span className="said">{outcome.note}</span>}
        </>
      ),
      by: who(outcome.recordedBy, viewerUserId),
      at: outcome.recordedAt,
      when: at(outcome.recordedAt),
    });
  }
  // Stable, so two acts at the same instant keep the order they are pushed in.
  entries.sort((a, b) => a.at.getTime() - b.at.getTime());

  return (
    <div className="card" style={{ marginTop: 18 }}>
      <h2 className="section" style={{ marginTop: 0 }}>
        What has happened
      </h2>
      {entries.length === 0 ? (
        <p className="empty" style={{ padding: '6px 0' }}>
          Nothing yet. This case has been read and nothing else.
        </p>
      ) : (
        <ol className="timeline">
          {entries.map((entry) => (
            <li key={entry.key}>
              <strong>{entry.what}</strong>
              <span className="stamp">
                {entry.by === '' ? entry.when : `${entry.by} · ${entry.when}`}
              </span>
              <span className="detail">{entry.detail}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

import Link from 'next/link';
import type { Finding, Reconciliation } from '@recouple/extraction';
import type { CaseWorkflow } from '@recouple/pipeline';
import {
  DECLINE_REASONS,
  MISSING_EVIDENCE_TYPES,
  type CaseSummary,
  type MissingEvidence,
  type StoredField,
} from '@recouple/store-postgres';
import { deadline, fieldLabel, fieldValue, money, retailer } from '../lib/format';
import { DECLINE_DETAIL_MAX_LENGTH, resolveNotice } from '../lib/notices';
import { CaseActions } from './case-actions';
import { CaseTimeline } from './case-timeline';
import type { Viewer } from './case-list';

/** Which document a reviewer looks at first: the notice the case came from. */
const DOC_ORDER: readonly string[] = [
  'deduction_notice',
  'remittance',
  'invoice',
  'po',
  'bol',
  'pod',
];

function orderOf(docType: string | null): number {
  const index = DOC_ORDER.indexOf(docType ?? '');
  return index === -1 ? DOC_ORDER.length : index;
}

/**
 * Three answers, not two. "No text to check against" is a different claim from
 * "checked and the quote was not there", and a reviewer is owed the difference —
 * one means unverifiable, the other means the reading is probably wrong.
 */
export function markFor(verified: boolean | null): { label: string; tone: string } {
  if (verified === true) return { label: 'quote found', tone: 'verified' };
  if (verified === false) return { label: 'quote not found', tone: 'unverified' };
  return { label: 'not checked', tone: 'unchecked' };
}

export interface CaseReviewProps {
  readonly viewer: Viewer;
  readonly summary: CaseSummary;
  readonly fields: readonly StoredField[];
  readonly reconciliation: Reconciliation | undefined;
  readonly costMicros: number;
  readonly today: Date;
  /** Whether this member's role may add documents and decide. */
  readonly mayAct: boolean;
  /**
   * Whether this member's role may approve a packet (`owner`, `approver`).
   * Defaults to no: a view that cannot tell should not offer the one button
   * the database exists to refuse.
   */
  readonly mayApprove?: boolean;
  /** Who is looking, so a preparer can be told why they see no approve button. */
  readonly viewerUserId?: string;
  /** Everything that has happened to this case, from one `getWorkflow` read. */
  readonly workflow?: CaseWorkflow | undefined;
  /**
   * The outcome of the action just taken, carried back on the redirect as a
   * notice *key* out of `lib/notices.ts` — never as the sentence, which arrives
   * in a query string anybody can write. A key this app does not know shows
   * nothing at all.
   */
  readonly notice?: string | undefined;
  /** The validated fragments the key's text names, in order. */
  readonly noticeAbout?: readonly string[] | undefined;
}

/**
 * The reasons a case can be declined, in the words a reviewer uses rather than
 * the enum's. The values are the enum's — the database is the referee, and an
 * unknown one is refused there.
 */
const DECLINE_LABELS: Readonly<Record<(typeof DECLINE_REASONS)[number], string>> = {
  below_economic_floor: 'Not worth the work',
  deadline_passed: 'The dispute window has closed',
  evidence_unavailable: 'What would prove it cannot be got',
  deduction_valid: 'They were right — nothing to recover',
  duplicate_of_other: 'Same deduction, already handled',
  below_confidence_floor: 'We could not read it well enough to act',
  tenant_declined: 'The customer said not to',
  other: 'Something else',
};

/**
 * Evidence a reviewer can say was missing, in a person's words. The values are
 * the canonical ones the store will accept — the point of recording them is to
 * add them up later, so "no POD" has to be one thing across a thousand declines
 * rather than a hundred spellings. `detail` is where the prose goes.
 */
const MISSING_EVIDENCE_LABELS: Readonly<Record<MissingEvidence, string>> = {
  proof_of_delivery: 'Proof of delivery',
  bill_of_lading: 'Bill of lading',
  invoice: 'Invoice',
  purchase_order: 'Purchase order',
  receiving_report: 'Receiving report',
  timesheet: 'Timesheet',
  rate_agreement: 'Rate or pricing agreement',
  correspondence: 'Correspondence with the customer',
};

/**
 * A reviewer's workspace for one case.
 *
 * Every value carries the document and page it was read from and the quote as
 * printed, because the reviewer's job is to check the reading rather than trust
 * it. The actions beside it are one card per state, and approving is a card
 * only a second person ever sees: it is a recorded act that the database's gate
 * makes meaningful, and a button that only looked like one would be worse than
 * none.
 *
 * A pure function of what the store returned. Nothing here reads, decides or
 * formats money any way but `money()` over integer cents.
 */
export function CaseReview({
  viewer,
  summary,
  fields,
  reconciliation,
  costMicros,
  today,
  mayAct,
  mayApprove = false,
  viewerUserId = '',
  workflow,
  notice,
  noticeAbout,
}: CaseReviewProps) {
  const byDocument = new Map<string, StoredField[]>();
  for (const field of fields) {
    const bucket = byDocument.get(field.documentId) ?? [];
    bucket.push(field);
    byDocument.set(field.documentId, bucket);
  }
  const documents = [...byDocument.entries()].sort(
    (a, b) => orderOf(a[1][0]?.docType ?? null) - orderOf(b[1][0]?.docType ?? null),
  );
  const primary = documents[0];
  const due = deadline(summary.disputeDeadline, today);
  // The debtor when one matched, otherwise the name the notice printed, marked
  // as unmatched — and only "Retailer unknown" when nothing was read at all.
  const who = retailer(summary, 'Retailer unknown');
  const findings: readonly Finding[] = reconciliation?.findings ?? [];
  // The packet lists document ids; the fields already carry what each document
  // was called. Nothing is looked up for this — it is the same read.
  const filenames = new Map(fields.map((f) => [f.documentId, f.filename]));
  const said = resolveNotice(notice, noticeAbout ?? []);

  return (
    <>
      <header className="top">
        <h1>
          <Link href="/">Recouple</Link>
        </h1>
        <span className="mono">{summary.claimId ?? summary.deductionId.slice(0, 8)}</span>
        <span className="pill">{summary.state.replace(/_/g, ' ')}</span>
        {due !== undefined ? <span className={`pill ${due.tone}`}>{due.label}</span> : null}
        <span className="who">
          {viewer.email} · {viewer.role.replace('_', ' ')}
        </span>
      </header>
      <main>
        <div className="review">
          <div>
            <div className="card">
              <h2 className="section" style={{ marginTop: 0 }}>
                {who.name}
                {who.matched ? null : (
                  <span className="unmatched">not matched to a debtor</span>
                )}{' '}
                · {money(summary.deductionAmountCents)} deducted
              </h2>
              {primary === undefined ? (
                <p className="empty">No document has been read for this case yet.</p>
              ) : (
                <div className="doc">
                  {/* The bytes come back through the same policies as the rest of
                      the page, sandboxed so a document cannot do anything but be
                      looked at. The type is the document's own: a notice that
                      arrived in an email body is text, not a PDF. */}
                  <embed
                    src={`/api/document/${primary[0]}`}
                    type={primary[1][0]?.mimeType ?? 'application/pdf'}
                    height={820}
                  />
                </div>
              )}
            </div>

            {findings.length > 0 ? (
              <div className="card" style={{ marginTop: 18 }}>
                <h2 className="section" style={{ marginTop: 0 }}>
                  What the documents say together
                </h2>
                <ul className="findings">
                  {findings.map((finding) => (
                    <li key={finding.code}>
                      <span
                        className={`mark ${finding.severity === 'info' ? 'unchecked' : 'unverified'}`}
                      >
                        {finding.severity.replace(/_/g, ' ')}
                      </span>{' '}
                      {finding.message}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>

          <div>
            {documents.map(([documentId, documentFields]) => (
              <div className="card" key={documentId} style={{ marginBottom: 18 }}>
                <h2 className="section" style={{ marginTop: 0 }}>
                  {(documentFields[0]?.docType ?? 'document').replace(/_/g, ' ')} ·{' '}
                  <span className="mono">{documentFields[0]?.filename}</span>
                </h2>
                <dl className="fields">
                  {documentFields.map((field) => {
                    const mark = markFor(field.quoteVerified);
                    return (
                      <div key={`${documentId}:${field.fieldPath}`}>
                        <dt>{fieldLabel(field.fieldPath)}</dt>
                        <dd>
                          {fieldValue(field.value)}
                          <span className={`mark ${mark.tone}`}>{mark.label}</span>
                          <span className="quote">
                            p{field.sourcePage}: &ldquo;{field.sourceQuote}&rdquo;
                          </span>
                        </dd>
                      </div>
                    );
                  })}
                </dl>
              </div>
            ))}

            {/* What the last action came back saying — a decline recorded, a
                duplicate claim the upload route sent us here to explain. Same
                treatment as the case list's, because it is the same kind of
                answer, and in the tone the notice carries: a packet assembled
                and a packet refused are not the same news, and both in red
                taught a reviewer to read red as "ignore me". */}
            {said === undefined ? null : (
              <p className={said.tone === 'good' ? 'notice sent' : 'notice bad'}>{said.text}</p>
            )}

            {mayAct ? (
              <div className="card" style={{ marginTop: 18 }}>
                <h2 className="section" style={{ marginTop: 0 }}>
                  Add evidence
                </h2>
                <p className="hint">
                  What would prove this deduction wrong — the delivery receipt, the signed
                  agreement, the invoice they short-paid. It is read the same way the notice was,
                  and attached to this case.
                </p>
                <form action="/upload" method="post" encType="multipart/form-data">
                  {/* The case this belongs to travels with the file rather than
                      being inferred later: a document with no case is the thing
                      that sits unread forever. */}
                  <input type="hidden" name="attachToCase" value={summary.deductionId} />
                  <input type="file" name="file" required />
                  <button className="primary" type="submit">
                    Attach to this case
                  </button>
                </form>
              </div>
            ) : null}

            <CaseActions
              deductionId={summary.deductionId}
              state={summary.state}
              workflow={workflow}
              mayAct={mayAct}
              mayApprove={mayApprove}
              viewerUserId={viewerUserId}
              filenames={filenames}
            />

            {/* Fighting and declining are the two answers to the same
                question, so they are offered together and only while the
                question is open. Once a decision is recorded the case has left
                `classified`, and declining a case somebody decided to dispute
                is not a thing to offer. */}
            {mayAct && summary.state === 'classified' && workflow?.decision === undefined ? (
              <div className="card decline" style={{ marginTop: 18 }}>
                <h2 className="section" style={{ marginTop: 0 }}>
                  Not worth fighting?
                </h2>
                <p className="hint">
                  Recording a decline keeps the case and writes down what it was worth and what was
                  missing. It is not a delete — coverage is a ratio of dollars, and discarding the
                  ones we lost is how that ratio gets flattered.
                </p>
                <form action={`/cases/${summary.deductionId}/decline`} method="post">
                  <label htmlFor="reason">Why</label>
                  <select id="reason" name="reason" required defaultValue="">
                    <option value="" disabled>
                      Choose a reason…
                    </option>
                    {DECLINE_REASONS.map((reason) => (
                      <option key={reason} value={reason}>
                        {DECLINE_LABELS[reason]}
                      </option>
                    ))}
                  </select>

                  <fieldset>
                    <legend>What was missing, if anything</legend>
                    {MISSING_EVIDENCE_TYPES.map((item) => (
                      <label key={item} className="check">
                        <input type="checkbox" name="missing" value={item} />
                        {MISSING_EVIDENCE_LABELS[item]}
                      </label>
                    ))}
                  </fieldset>

                  <label htmlFor="detail">Anything a later reader would need</label>
                  <textarea
                    id="detail"
                    name="detail"
                    rows={3}
                    maxLength={DECLINE_DETAIL_MAX_LENGTH}
                  />

                  <button type="submit">Record this decline</button>
                </form>
              </div>
            ) : null}

            <CaseTimeline workflow={workflow} viewerUserId={viewerUserId} />

            <div className="gate">
              Nothing leaves this app. A dispute is filed by a person on the retailer&rsquo;s
              portal and recorded here, and the database refuses a submission that has no approval
              row for this exact decision — so the approve card is a second person&rsquo;s, and it
              is the only way this case moves.
              <br />
              <br />
              Read so far: {money(Math.round(costMicros / 10_000))} of model spend on{' '}
              {documents.length} document{documents.length === 1 ? '' : 's'}, {fields.length}{' '}
              fields.
            </div>
          </div>
        </div>
      </main>
    </>
  );
}

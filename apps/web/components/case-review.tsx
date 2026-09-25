import Link from 'next/link';
import { isMoneyFieldPath, type Finding, type Reconciliation } from '@recouple/extraction';
import type {
  CaseMerges,
  CaseWorkflow,
  PossibleDuplicatePair,
  UnattachedDocument,
} from '@recouple/pipeline';
import {
  DECLINE_REASONS,
  MISSING_EVIDENCE_TYPES,
  type CaseDocument,
  type CaseSummary,
  type MissingEvidence,
  type StoredField,
} from '@recouple/store-postgres';
import { displaysInline } from '../lib/document-types';
import { deadline, fieldLabel, fieldValue, money, retailer } from '../lib/format';
import { browserUploadNotices, DECLINE_DETAIL_MAX_LENGTH, resolveNotice } from '../lib/notices';
import { MultiUpload } from './multi-upload';
import { CaseActions } from './case-actions';
import { CaseTimeline } from './case-timeline';
import { CaseMergeNotes, DuplicateNotice } from './possible-duplicates';
import type { Viewer } from './case-list';
import { AttachReadDocuments } from './unattached-documents';
import { WorkspaceShell } from './workspace-shell';

/**
 * The order evidence is listed in, after the document the case was opened from.
 * Which document that is is the link's answer (`role`), not a doc type's: a
 * remittance-opened case's notice is a `remittance_advice` (ADR 0028).
 */
const DOC_ORDER: readonly string[] = [
  'deduction_notice',
  'remittance_advice',
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
 *
 * A money field is checked for more than its quote: the page has to print the
 * amount itself, whole and to the cent, where it was quoted (ADR 0050). So a
 * refusal names the amount, since a quote can be on the page and the amount
 * not. A pass says only "quote found": only the verdict is stored, and a row
 * read before ADR 0050 passed without its amount being looked for.
 */
export function markFor(
  verified: boolean | null,
  fieldPath?: string,
): { label: string; tone: string } {
  const money = fieldPath !== undefined && isMoneyFieldPath(fieldPath);
  if (verified === true) return { label: 'quote found', tone: 'verified' };
  if (verified === false) {
    return { label: money ? 'amount not on page' : 'quote not found', tone: 'unverified' };
  }
  return { label: 'not checked', tone: 'unchecked' };
}

/**
 * The fields of the document a case was opened from, narrowed to this case's
 * line when that document is a remittance.
 *
 * A remittance opens one case per short-paid line (ADR 0028), so the rest of
 * the advice is other invoices — other cases, or short-pays under the floor —
 * and forty-one of them on a forty-two-line advice would bury the one this
 * case is about. The line is the one whose invoice is the invoice this case
 * recorded when it opened (`deduction_identifiers`). It narrows only when
 * exactly one line answers; otherwise every field is shown, because hiding a
 * line we could not place is worse than showing one too many.
 */
export function fieldsOfThisLine(
  documentFields: readonly StoredField[],
  summary: Pick<CaseSummary, 'discoveredVia' | 'invoiceNumber'>,
): { readonly shown: readonly StoredField[]; readonly otherLines: number } {
  const all = { shown: documentFields, otherLines: 0 };
  const invoice = summary.invoiceNumber?.trim();
  if (summary.discoveredVia !== 'remittance_line' || invoice === undefined) return all;
  if (documentFields[0]?.docType !== 'remittance_advice') return all;

  const lineOf = (path: string): number | undefined => {
    const match = /^lines\[(\d+)\]\./.exec(path);
    return match?.[1] === undefined ? undefined : Number(match[1]);
  };
  const lines = new Set<number>();
  const matching = new Set<number>();
  for (const field of documentFields) {
    const line = lineOf(field.fieldPath);
    if (line === undefined) continue;
    lines.add(line);
    if (
      field.fieldPath === `lines[${line}].invoice_number` &&
      typeof field.value === 'string' &&
      field.value.trim() === invoice
    ) {
      matching.add(line);
    }
  }
  const [only, ...more] = [...matching];
  if (only === undefined || more.length > 0) return all;
  return {
    shown: documentFields.filter((field) => {
      const line = lineOf(field.fieldPath);
      return line === undefined || line === only;
    }),
    otherLines: lines.size - 1,
  };
}

/**
 * The remittance line the case was opened from, reconciled against itself:
 * what was owed less what was paid, against what the line says was deducted
 * (ADR 0040). `undefined` for any other case — a notice line's working is not
 * carried on the reconciliation.
 */
export function reconciledLine(
  reconciliation: Reconciliation | undefined,
): { readonly sentence: string; readonly verdict: string; readonly tone: string } | undefined {
  const line = reconciliation?.lines.find((l) => l.grossCents !== undefined);
  if (line === undefined) return undefined;
  const label = line.sku;
  const printed =
    line.claimedCents !== null && line.deltaCents !== null ? line.claimedCents : undefined;
  const tone =
    line.verdict === 'matches' ? 'verified' : line.verdict === 'differs' ? 'unverified' : 'unchecked';
  const verdict = line.verdict.replace(/_/g, ' ');
  if (
    line.grossCents === null ||
    line.grossCents === undefined ||
    line.netCents === null ||
    line.netCents === undefined ||
    line.expectedShortageCents === null
  ) {
    return {
      sentence:
        `${label}: ` +
        (line.claimedCents === null
          ? 'the line prints no amount this case can be checked against'
          : `the line says ${money(line.claimedCents)} was deducted, and prints no gross and ` +
            'paid amount to check that against'),
      verdict,
      tone,
    };
  }
  const working =
    `${label}: ${money(line.grossCents)} gross less ${money(line.netCents)} paid is ` +
    `${money(line.expectedShortageCents)} withheld`;
  return {
    sentence:
      printed === undefined
        ? `${working}; the line prints no deduction of its own, so this case is for that difference`
        : `${working}, and the line says ${money(printed)} was deducted`,
    verdict,
    tone,
  };
}

/**
 * What the case's reads cost, said so that the figure and the documents it
 * covers agree.
 *
 * `costMicros` is spend recorded against this case. A document read before it
 * was on this case — a remittance, whose one read serves every case it opens
 * (ADR 0028); a held notice a person opened (ADR 0044); evidence attached from
 * "Read, not on a case" — is on the page and not in that figure, and the
 * sentence says so rather than implying the figure covers it. A document no
 * model reads — a ledger extract (ADR 0029) — cost nothing, and needs no
 * caveat.
 */
export function spendSentence(input: {
  readonly costMicros: number;
  readonly documents: readonly { readonly read: boolean; readonly readForCase: boolean }[];
  readonly fieldCount: number;
}): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const total = input.documents.length;
  const earlier = input.documents.filter((d) => d.read && !d.readForCase).length;
  const read =
    `Read so far: ${plural(input.fieldCount, 'field')} from ${plural(total, 'document')} on ` +
    `this case, and ${money(Math.round(input.costMicros / 10_000))} of model spend recorded ` +
    'against it.';
  if (earlier === 0) return read;
  const which =
    earlier === total
      ? total === 1
        ? 'It was'
        : `All ${total} were`
      : earlier === 1
        ? 'One of them was'
        : `${earlier} of them were`;
  return (
    `${read} ${which} read before ${earlier === 1 ? 'it was' : 'they were'} on this case, so ` +
    `${earlier === 1 ? 'that read is' : 'those reads are'} not in the figure.`
  );
}

export interface CaseReviewProps {
  readonly viewer: Viewer;
  readonly summary: CaseSummary;
  /**
   * The documents on the case, from `caseDocuments`: which one it was opened
   * from, what each is called, and whose spend each read is. The list, rather
   * than whatever documents the fields happen to name — a ledger extract is a
   * case's notice and has no fields (ADR 0029).
   */
  readonly documents: readonly CaseDocument[];
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
   * The unanswered pairs this case is one half of (ADR 0032). Shown to every
   * reader, because "another case may be this same deduction" is something to
   * know before deciding anything about it; only a member who may write is
   * offered the two answers.
   */
  readonly duplicates?: readonly PossibleDuplicatePair[] | undefined;
  /**
   * What this case was merged into, what was merged into it, and the confirmed
   * pairs that are not merged (ADR 0042), from one `mergesFor` read.
   */
  readonly merges?: CaseMerges | undefined;
  /**
   * The documents that were read and are on no case, offered to be filed on
   * this one (`unattachedDocuments`). The page asks only for a member who may
   * write and a case still open; absent or empty, nothing is offered.
   */
  readonly attachable?: readonly UnattachedDocument[] | undefined;
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
  documents,
  fields,
  reconciliation,
  costMicros,
  today,
  mayAct,
  mayApprove = false,
  viewerUserId = '',
  workflow,
  duplicates,
  merges,
  attachable,
  notice,
  noticeAbout,
}: CaseReviewProps) {
  const byDocument = new Map<string, StoredField[]>();
  for (const field of fields) {
    const bucket = byDocument.get(field.documentId) ?? [];
    bucket.push(field);
    byDocument.set(field.documentId, bucket);
  }
  // One card per document that has fields: the one the case was opened from
  // first — the link says which, and a remittance's doc type is no notice's —
  // then the evidence by kind. A field whose document the list does not name
  // (attached between the two reads) still gets its card.
  const listed = new Map(documents.map((d) => [d.documentId, d] as const));
  const cards = [...byDocument.entries()]
    .map(([documentId, own]) => ({
      documentId,
      notice: listed.get(documentId)?.role === 'notice',
      fields: own,
    }))
    .sort(
      (a, b) =>
        Number(!a.notice) - Number(!b.notice) ||
        orderOf(a.fields[0]?.docType ?? null) - orderOf(b.fields[0]?.docType ?? null),
    );
  // Only the notice is the original, and it is the original whether or not a
  // model read it: a ledger extract has no fields and is still the document the
  // deduction arrived as (ADR 0029). Evidence embedded under that title is how
  // a carrier invoice came to be shown as a remittance case's deduction.
  const primary = documents.find((d) => d.role === 'notice');
  const line = reconciledLine(reconciliation);
  const due = deadline(summary.disputeDeadline, today);
  // The debtor when one matched, otherwise the name the notice printed, marked
  // as unmatched — and only "Retailer unknown" when nothing was read at all.
  const who = retailer(summary, 'Retailer unknown');
  const findings: readonly Finding[] = reconciliation?.findings ?? [];
  // The packet lists document ids; the case's documents say what each is
  // called, the ones with no fields included. A name nobody recorded is left
  // out rather than rendered as an empty link.
  const filenames = new Map<string, string>();
  for (const named of [...fields, ...documents]) {
    if (named.filename !== '') filenames.set(named.documentId, named.filename);
  }
  const said = resolveNotice(notice, noticeAbout ?? []);

  return (
    <WorkspaceShell viewer={viewer} detail>
      <main id="workspace-main" className="workspace-main case-main">
        <Link className="back-link" href="/">
          ← All deductions
        </Link>
        <div className="page-heading case-heading">
          <div>
            <p className="eyebrow">THE DETAILS BEHIND THE DEDUCTION</p>
            <h1>{summary.claimId ?? summary.deductionId.slice(0, 8)}</h1>
            <p className="page-description">
              {who.name} · {money(summary.deductionAmountCents)} deducted
            </p>
          </div>
          <div className="case-badges">
            <span className={`pill state-${summary.state}`}>
              {summary.state.replace(/_/g, ' ')}
            </span>
            {due !== undefined ? <span className={`pill ${due.tone}`}>{due.label}</span> : null}
          </div>
        </div>
        <div className="review">
          <div>
            <div className="card">
              <h2 className="section" style={{ marginTop: 0 }}>
                {who.name}
                {who.matched ? null : (
                  <span className="unmatched">not matched to a debtor</span>
                )} · {money(summary.deductionAmountCents)} deducted
              </h2>
              {/* What the document printed about this deduction beyond its
                  amount. A remittance-line case has both (ADR 0028); a notice
                  case has the invoice where its notice printed one. Both are
                  untrusted text, shown as printed and never mapped — turning a
                  payer's code into a canonical one is playbook data. */}
              {summary.invoiceNumber === undefined &&
              summary.reasonCodeAsPrinted === undefined ? null : (
                <p className="mono" style={{ marginTop: -6 }}>
                  {summary.invoiceNumber === undefined
                    ? null
                    : `invoice ${summary.invoiceNumber}`}
                  {summary.invoiceNumber !== undefined &&
                  summary.reasonCodeAsPrinted !== undefined
                    ? ' · '
                    : null}
                  {summary.reasonCodeAsPrinted === undefined
                    ? null
                    : `code ${summary.reasonCodeAsPrinted}`}
                </p>
              )}
              {primary === undefined ? (
                <p className="empty">
                  {documents.length === 0
                    ? 'No document is on this case yet.'
                    : 'This case has no record of the document it was opened from.'}
                </p>
              ) : displaysInline(primary.mimeType) ? (
                <div className="doc">
                  {/* The bytes come back through the same policies as the rest of
                      the page, sandboxed so a document cannot do anything but be
                      looked at. The type is the document's own: a notice that
                      arrived in an email body is text, not a PDF, and a ledger
                      extract is JSON. */}
                  <embed
                    title="Original deduction document"
                    src={`/api/document/${primary.documentId}`}
                    type={primary.mimeType}
                    height={820}
                  />
                </div>
              ) : (
                // A type the route will not show in place downloads instead, and
                // an embed of it would start that download on opening the case.
                <p className="empty">
                  The original document cannot be shown here:{' '}
                  <a href={`/api/document/${primary.documentId}`}>
                    {primary.filename === '' ? 'download it' : primary.filename}
                  </a>
                  .
                </p>
              )}
            </div>

            {findings.length > 0 || line !== undefined ? (
              <div className="card" style={{ marginTop: 18 }}>
                <h2 className="section" style={{ marginTop: 0 }}>
                  What the documents say together
                </h2>
                {/* The claim's own arithmetic before anything is compared with
                    it: a remittance prints the short-pay twice, and the two have
                    to agree (ADR 0040). Computed in cents by reconcile, only
                    formatted here. */}
                {line === undefined ? null : (
                  <p className="line-check">
                    <span className={`mark ${line.tone}`}>{line.verdict}</span> {line.sentence}
                  </p>
                )}
                <ul className="findings">
                  {/* Not keyed by code alone: one message can move two
                      appointments, and a reading of LOG-001's does, so two
                      findings share `appointment_superseded`. The order is
                      reconcile's own and stable, so the position disambiguates. */}
                  {findings.map((finding, index) => (
                    <li key={`${finding.code}:${index}`}>
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
            {cards.map(({ documentId, notice, fields: documentFields }) => {
              const { shown, otherLines } = notice
                ? fieldsOfThisLine(documentFields, summary)
                : { shown: documentFields, otherLines: 0 };
              return (
                <div className="card" key={documentId} style={{ marginBottom: 18 }}>
                  <h2 className="section" style={{ marginTop: 0 }}>
                    {(documentFields[0]?.docType ?? 'document').replace(/_/g, ' ')} ·{' '}
                    <span className="mono">{documentFields[0]?.filename}</span>
                  </h2>
                  {otherLines === 0 ? null : (
                    <p className="hint">
                      This case&rsquo;s line only. The advice&rsquo;s {otherLines} other line
                      {otherLines === 1 ? ' is another invoice' : 's are other invoices'} — other
                      cases, or short-pays under the floor.
                    </p>
                  )}
                  <dl className="fields">
                    {shown.map((field) => {
                      const mark = markFor(field.quoteVerified, field.fieldPath);
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
              );
            })}

            {/* What the last action came back saying — a decline recorded, a
                duplicate claim the upload route sent us here to explain. Same
                treatment as the case list's, because it is the same kind of
                answer, and in the tone the notice carries: a packet assembled
                and a packet refused are not the same news, and both in red
                taught a reviewer to read red as "ignore me". */}
            {said === undefined ? null : (
              <p className={said.tone === 'good' ? 'notice sent' : 'notice bad'}>{said.text}</p>
            )}

            <CaseMergeNotes deductionId={summary.deductionId} merges={merges} mayAct={mayAct} />

            {/* Not on a case merged into another (ADR 0042): the database
                refuses the link, and it would refuse it after the read had
                been paid for. Evidence belongs on the case it was merged
                into, which the banner above links to. */}
            {mayAct && summary.state !== 'merged' ? (
              <div className="card" style={{ marginTop: 18 }}>
                <h2 className="section" style={{ marginTop: 0 }}>
                  Add evidence
                </h2>
                <p className="hint">
                  What would prove this deduction wrong — the delivery receipt, the signed
                  agreement, the invoice they short-paid. It is read the same way the notice was,
                  and attached to this case.
                </p>
                <MultiUpload
                  attachToCase={summary.deductionId}
                  inputId="evidence-file"
                  buttonLabel="Attach to this case"
                  notices={browserUploadNotices()}
                />
                <AttachReadDocuments deductionId={summary.deductionId} documents={attachable ?? []} />
              </div>
            ) : null}

            <DuplicateNotice
              deductionId={summary.deductionId}
              pairs={duplicates ?? []}
              mayAct={mayAct}
            />

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
              Nothing leaves this app. A dispute is filed by a person on the retailer&rsquo;s portal
              and recorded here, and the database refuses a submission that has no approval row for
              this exact decision — so the approve card is a second person&rsquo;s, and it is the
              only way this case moves.
              <br />
              <br />
              {spendSentence({ costMicros, documents, fieldCount: fields.length })}
            </div>
          </div>
        </div>
      </main>
    </WorkspaceShell>
  );
}

import Link from 'next/link';
import type { Finding, Reconciliation } from '@recouple/extraction';
import type { CaseSummary, StoredField } from '@recouple/store-postgres';
import { deadline, fieldLabel, fieldValue, money } from '../lib/format';
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
}

/**
 * A reviewer's workspace for one case.
 *
 * Every value carries the document and page it was read from and the quote as
 * printed, because the reviewer's job is to check the reading rather than trust
 * it. There is no approve button: approving is a recorded act by a second person
 * that the database's gate makes meaningful, and a button that only looked like
 * one would be worse than none.
 */
export function CaseReview({
  viewer,
  summary,
  fields,
  reconciliation,
  costMicros,
  today,
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
  const findings: readonly Finding[] = reconciliation?.findings ?? [];

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
                {summary.debtorName ?? 'Retailer unknown'} · {money(summary.deductionAmountCents)}{' '}
                deducted
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

            <div className="gate">
              Nothing has been sent anywhere. Approving a case is a separate, recorded act by a
              second person, and the database refuses a submission that has no approval row — so
              there is no approve button here until that action exists.
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

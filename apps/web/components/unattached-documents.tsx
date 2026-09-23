import { isTerminal } from '@recouple/core-domain';
import type { UnattachedDocument } from '@recouple/pipeline';
import type { CaseSummary } from '@recouple/store-postgres';
import { docTypeLabel, money } from '../lib/format';

/**
 * The documents that were read and that no case holds, and a way to file each
 * one where it belongs.
 *
 * This section exists because of what a reviewer saw in production: a delivery
 * receipt and a rate confirmation uploaded from this list were read — they are
 * evidence, not notices, so they opened nothing — and then appeared nowhere.
 * The upload had said a case would appear; none did, and nothing said why.
 *
 * Attaching here files the reading that already exists. Nothing is read again
 * and nothing is charged, which is the difference from uploading the same file
 * on the case page (`attachReadDocument`).
 *
 * A pure function of what the store returned. The filename is the one piece of
 * somebody else's text here, and React escapes it.
 */
export function UnattachedDocuments({
  documents,
  cases,
}: {
  documents: readonly UnattachedDocument[];
  /** The tenant's cases, to choose from. A closed case is not offered. */
  cases: readonly CaseSummary[];
}) {
  if (documents.length === 0) return null;
  const open = cases.filter((summary) => !isTerminal(summary.state));

  return (
    <div className="card unattached">
      <h2 className="section" style={{ marginTop: 0 }}>
        Read, not on a case
      </h2>
      <p className="empty">
        These were read and are kept, but no case holds them. A deduction notice or a short-paid
        remittance opens its own case; a delivery receipt, an invoice or a rate confirmation is
        evidence for one. Attaching files what was already read — it is not read again.
      </p>
      <table className="cases">
        <thead>
          <tr>
            <th>Document</th>
            <th>Read as</th>
            <th>Received</th>
            <th>Attach to</th>
          </tr>
        </thead>
        <tbody>
          {documents.map((document) => (
            <tr key={document.documentId}>
              <td>{document.filename === '' ? '—' : document.filename}</td>
              <td>{docTypeLabel(document.docType)}</td>
              <td>{document.createdAt.slice(0, 10)}</td>
              <td>
                {open.length === 0 ? (
                  <span className="empty">No open case yet</span>
                ) : (
                  // A POST, not a link: it writes to a case, and a thing that
                  // writes is not something a crawler or a prefetch may do by
                  // visiting a URL.
                  <form action={`/documents/${document.documentId}/attach`} method="post">
                    <label className="sr-only" htmlFor={`attach-${document.documentId}`}>
                      Case for {document.filename === '' ? 'this document' : document.filename}
                    </label>
                    <select id={`attach-${document.documentId}`} name="caseId" required defaultValue="">
                      <option value="" disabled>
                        Choose a case
                      </option>
                      {open.map((summary) => (
                        <option key={summary.deductionId} value={summary.deductionId}>
                          {caseLabel(summary)}
                        </option>
                      ))}
                    </select>
                    <button type="submit">Attach</button>
                  </form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * How a case reads in the picker: its claim, who took the money, and how much.
 *
 * The claim id and the printed retailer name come off somebody else's document,
 * and an option's text is text — React escapes it like any other child.
 */
export function caseLabel(summary: CaseSummary): string {
  const claim = summary.claimId ?? 'no claim id';
  const who = summary.debtorName ?? summary.retailerNameAsPrinted ?? 'retailer unknown';
  return `${claim} · ${who} · ${money(summary.deductionAmountCents)}`;
}

import { isClosed } from '@recouple/core-domain';
import type { DocumentHold, UnattachedDocument } from '@recouple/pipeline';
import type { CaseSummary } from '@recouple/store-postgres';
import { confidencePercent, docTypeLabel, fieldLabel, money } from '../lib/format';

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
 * A notice or a remittance a read *held* (ADR 0044) is here too, with a line
 * saying why: the classifier was less sure than this workspace's floor, or the
 * reading does not fit what it was read as. A person can open the case from it
 * — nothing is read again, and a field the reading lacked stays empty on the
 * case, the way the automatic path has always opened one. The one exception is
 * a remittance whose reading has no lines: there is nothing to open, so the
 * page offers no button, and the document can still be attached as evidence.
 *
 * A pure function of what the store returned. The filename is the one piece of
 * somebody else's text here, and React escapes it. A hold's numbers are the
 * hold's own, formatted and never computed here.
 */
export function UnattachedDocuments({
  documents,
  cases,
}: {
  documents: readonly UnattachedDocument[];
  /** The tenant's cases, to choose from. A closed or merged-away case is not offered. */
  cases: readonly CaseSummary[];
}) {
  if (documents.length === 0) return null;
  const open = cases.filter((summary) => !isClosed(summary.state));

  return (
    <div className="card unattached">
      <h2 className="section" style={{ marginTop: 0 }}>
        Read, not on a case
      </h2>
      <p className="empty">
        These were read and are kept, but no case holds them. A deduction notice or a short-paid
        remittance opens its own case when the reading is sure; one that is held says why, and a
        person decides. A delivery receipt, an invoice or a rate confirmation is evidence for a
        case. Attaching files what was already read — it is not read again.
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
              <td>
                {docTypeLabel(document.docType)}
                {document.hold === undefined ? (
                  // How sure the classifier was, as the classification row
                  // recorded it — shown, never decided with here.
                  <span className="confidence"> · read at {confidencePercent(document.confidence)}</span>
                ) : (
                  <p className="hold">{holdLine(document.hold)}</p>
                )}
              </td>
              <td>{document.createdAt.slice(0, 10)}</td>
              <td>
                {document.hold !== undefined && mayOpenFrom(document.hold) ? (
                  // A POST, for the attach form's reason. It reads nothing:
                  // the case is opened from the reading already recorded.
                  <form
                    action={`/documents/${document.documentId}/open-case`}
                    method="post"
                    className="open-held"
                  >
                    <button type="submit">Open a case from it</button>
                  </form>
                ) : null}
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
 * Whether the page offers "Open a case from it" for a hold.
 *
 * Every held notice, and every held remittance except one whose reading has no
 * lines — a remittance opens a case per line, so with none there is nothing to
 * open, and the route refuses it (`HeldReadingUnusableError`). The page does not
 * offer a button whose only answer is no. A reading that merely lacks a field
 * opens with that field empty (ADR 0044).
 */
export function mayOpenFrom(hold: DocumentHold): boolean {
  return !hasNoLines(hold);
}

/** A held remittance whose reading has no lines: the hold names `lines` among what did not fit. */
function hasNoLines(hold: DocumentHold): boolean {
  return hold.docType === 'remittance_advice' && (hold.fields ?? []).includes('lines');
}

/**
 * Why a document is held, in one sentence: what it was read as, how sure the
 * classifier was against this workspace's floor, and which fields did not fit.
 *
 * The numbers are the hold's — what the gate compared — and the fields are
 * schema paths said in words (`fieldLabel`), never a value off the page.
 */
export function holdLine(hold: DocumentHold): string {
  const readAs = `read as a ${docTypeLabel(hold.docType)}`;
  const misfit =
    hold.fields === undefined
      ? undefined
      : hold.fields.length === 0
        ? 'the reading does not fit that type'
        : `the reading does not fit that type (missing: ${hold.fields.map(fieldLabel).join(', ')})`;

  const why =
    hold.reason === 'type_did_not_fit'
      ? `Held: ${readAs}, but ${misfit ?? 'the reading does not fit that type'}.`
      : `Held: ${readAs} at ${confidencePercent(hold.confidence)} confidence; this workspace ` +
        `opens a case on its own at ${confidencePercent(hold.floor)} or above.` +
        (misfit === undefined ? '' : ` Also, ${misfit}.`);

  if (hasNoLines(hold)) {
    return `${why} With no lines there is nothing to open a case from — attach it to a case as evidence instead.`;
  }
  if (misfit !== undefined) {
    return (
      `${why} Opening a case from it opens one with what was read, and the missing fields ` +
      'stay empty; or attach it to a case as evidence.'
    );
  }
  return why;
}

/**
 * How a case reads in the picker: what names it, who took the money, and how
 * much.
 *
 * A claim id when the notice printed one. A case the ledger sync or a
 * remittance line opened has none — nobody filed a claim, an invoice was paid
 * short — so it is named by that invoice instead, which is what a reviewer
 * holding a delivery receipt would look for. "no claim id" said only what the
 * case lacked.
 *
 * The claim id, the invoice number and the printed name come off somebody
 * else's document or ledger, and an option's text is text — React escapes it
 * like any other child.
 */
export function caseLabel(summary: CaseSummary): string {
  const named =
    summary.claimId ??
    (summary.invoiceNumber !== undefined ? `invoice ${summary.invoiceNumber}` : 'no claim id');
  const who = summary.debtorName ?? summary.retailerNameAsPrinted ?? 'retailer unknown';
  return `${named} · ${who} · ${money(summary.deductionAmountCents)}`;
}

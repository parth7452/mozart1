import { isClosed } from '@recouple/core-domain';
import type { DocumentHold, UnattachedDocument } from '@recouple/pipeline';
import type { AttachTargets, CaseSummary, SuggestedCase } from '@recouple/store-postgres';
import { confidencePercent, docTypeLabel, fieldLabel, money, unattachedCount } from '../lib/format';
import {
  SUGGESTIONS_SHOWN,
  basisField,
  groupByPayer,
  suggestedCaseName,
  suggestionLead,
  suggestionReason,
  type UnattachedDocumentWithSuggestions,
} from '../lib/document-suggestions';
import { emailLine } from './inbound-email';

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
 * Where the store suggested a case for a document (`suggestionsForUnattached`),
 * the suggestion comes first — "Matches case DN-2609-003 on invoice 44817
 * (exact)" with **Attach to this case** — and the full picker stays beneath it
 * as "or pick another case". Nothing is attached without that press, whatever
 * the strength: a link cannot be undone, so an exact match is still a person's
 * to confirm. The list is then grouped by the suggested case's payer, with the
 * documents nothing was suggested for under "Unmatched" at the end.
 *
 * A pure function of what the store returned. The filename and a matched
 * identifier are somebody else's text here, and React escapes them. A hold's
 * numbers are the hold's own, formatted and never computed here.
 */
export function UnattachedDocuments({
  documents,
  targets,
}: {
  /** Each may carry `suggestions` (`withSuggestions`); without any, the list is flat. */
  documents: readonly UnattachedDocumentWithSuggestions[];
  /**
   * The cases to choose from: the store's own read of every open case, most
   * urgent first (`attachTargets`) — not the case list's rows, which stop at
   * the newest hundred. A closed or merged-away case is not offered.
   */
  targets: AttachTargets;
}) {
  if (documents.length === 0) return null;
  const open = targets.rows.filter((summary) => !isClosed(summary.state));
  const groups = groupByPayer(documents);

  return (
    <div id="unattached-documents" className="card unattached">
      <p className="eyebrow">Read, not on a case</p>
      <h2 className="section" style={{ marginTop: 0 }}>
        Documents awaiting a case <span className="document-count">({unattachedCount(documents.length)})</span>
      </h2>
      <p className="document-intro">
        Attach evidence to a case or review a held notice. Attaching uses the reading already
        recorded; it is not read again.
      </p>
      <details className="document-help">
        <summary>How these documents are handled</summary>
        <p>
          A deduction notice or short-paid remittance can open a case when the reading is sure.
          A held document needs a person to decide. Delivery receipts, invoices and rate
          agreements can be attached as evidence.
        </p>
      </details>
      {open.length === 0 ? null : <p className="empty">{offeredLine(open.length, targets)}</p>}
      {/* A list on the review queue's grid (ADR 0043) rather than a table: on a
          phone a row stacks, so its actions are never scrolled out of reach. */}
      <div className="unattached-columns" aria-hidden="true">
        <span>Document</span>
        <span>Read as</span>
        <span>Received</span>
        <span>Attach to</span>
      </div>
      {groups === undefined ? (
        <ul className="unattached-list">
          {documents.map((document) => (
            <UnattachedRow key={document.documentId} document={document} open={open} />
          ))}
        </ul>
      ) : (
        groups.map((group) => (
          <section
            key={group.heading ?? 'unmatched'}
            className="unattached-group"
            aria-label={group.heading ?? 'Unmatched'}
          >
            {/* One heading per payer (`groupByPayer`), the unmatched last. */}
            <h3 className="unattached-group-heading">
              {group.heading ?? 'Unmatched'}{' '}
              <span className="document-count">({group.documents.length.toLocaleString('en-US')})</span>
            </h3>
            {group.heading === undefined ? (
              <p className="empty">No open case was suggested for these.</p>
            ) : null}
            <ul className="unattached-list">
              {group.documents.map((document) => (
                <UnattachedRow key={document.documentId} document={document} open={open} />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

/** One document's row: what it is, what it was read as, and where it can go. */
function UnattachedRow({
  document,
  open,
}: {
  document: UnattachedDocumentWithSuggestions;
  open: readonly CaseSummary[];
}) {
  const suggestions = document.suggestions ?? [];
  return (
    <li className="unattached-row">
      <span className="unattached-name">{document.filename === '' ? '—' : document.filename}</span>
      <span className="unattached-read">
        {docTypeLabel(document.docType)}
        {document.hold === undefined ? (
          // How sure the classifier was, as the classification row
          // recorded it — shown, never decided with here.
          <span className="confidence"> · read at {confidencePercent(document.confidence)}</span>
        ) : (
          <span className="hold">{holdLine(document.hold)}</span>
        )}
        {document.email === undefined ? null : (
          // What the email claimed about its sender (ADR 0047 §7): shown
          // to the person deciding, and it decides nothing.
          <span className="hold">{emailLine(document.email)}</span>
        )}
      </span>
      <span className="unattached-received">
        <span className="unattached-received-label">Received </span>
        {document.createdAt.slice(0, 10)}
      </span>
      <div className="unattached-actions">
        {document.hold?.reason === 'no_mapping' ? (
          // A spreadsheet nobody mapped (ADR 0056): a person says which
          // column is which, and its rows are read by code.
          <a className="map-columns" href={`/documents/${document.documentId}/map`}>
            Map these columns
          </a>
        ) : null}
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
        <SuggestedCases document={document} suggestions={suggestions} />
        {open.length === 0 ? (
          <span className="empty">No open case yet</span>
        ) : (
          // A POST, not a link: it writes to a case, and a thing that
          // writes is not something a crawler or a prefetch may do by
          // visiting a URL.
          <form action={`/documents/${document.documentId}/attach`} method="post">
            {suggestions.length === 0 ? null : <span className="or-pick">or pick another case</span>}
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
      </div>
    </li>
  );
}

/**
 * The cases the store suggested for a document, strongest first, each with the
 * one button that files it there.
 *
 * Every strength is labelled and every one needs the press: `exact` is one
 * open case carrying an identifier the document prints, `ambiguous` is several
 * carrying it, `probable` is the same payer and amount or an unlabelled
 * reference. The case's name links to its page, so it can be looked at before
 * a link that cannot be undone is made.
 *
 * The form posts to the attach route with the case preselected and a hidden
 * `basis` naming the kinds that agreed. The route does not record that field:
 * it recomputes the suggestion and records its own answer.
 */
function SuggestedCases({
  document,
  suggestions,
}: {
  document: UnattachedDocument;
  suggestions: readonly SuggestedCase[];
}) {
  if (suggestions.length === 0) return null;
  const ambiguous = suggestions.filter((s) => s.strength === 'ambiguous').length;
  const shown = suggestions.slice(0, SUGGESTIONS_SHOWN);
  const more = suggestions.length - shown.length;
  return (
    <ul className="suggested-cases">
      {shown.map((suggestion) => (
        <li key={suggestion.caseId} className={`suggested-case suggested-${suggestion.strength}`}>
          <span className="suggested-line">
            {suggestionLead(suggestion.strength)}{' '}
            <a href={`/cases/${suggestion.caseId}`}>{suggestedCaseName(suggestion.case)}</a>{' '}
            {suggestionReason(suggestion, ambiguous)}
          </span>
          <form action={`/documents/${document.documentId}/attach`} method="post">
            <input type="hidden" name="caseId" value={suggestion.caseId} />
            <input type="hidden" name="basis" value={basisField(suggestion.basis)} />
            <button type="submit">
              Attach to this case
              <span className="sr-only">
                {' '}
                {suggestedCaseName(suggestion.case)}:{' '}
                {document.filename === '' ? 'this document' : document.filename}
              </span>
            </button>
          </form>
        </li>
      ))}
      {more > 0 ? (
        <li className="empty">
          and {more.toLocaleString('en-US')} more possible {more === 1 ? 'case' : 'cases'} — pick from
          the list
        </li>
      ) : null}
    </ul>
  );
}

/**
 * Which cases the picker lists, and in what order — and, when the store cut
 * the list at its limit, how many open cases it is not listing and where the
 * rest are reached from. Every number is the store's or a count of what is
 * drawn; none is estimated here.
 */
export function offeredLine(listed: number, targets: AttachTargets): string {
  const order = 'Open cases are listed most urgent first, as the review queue orders them.';
  if (targets.total <= targets.rows.length) return order;
  const count = (n: number) => n.toLocaleString('en-US');
  return (
    `${order} This workspace has ${count(targets.total)}: the first ${count(listed)} are ` +
    `listed, and the other ${count(targets.total - targets.rows.length)} are not. Any open ` +
    'case can take one of these from its own page.'
  );
}

/**
 * The same documents, offered from the other end: on a case's own page, each
 * one read and on no case, with a button that files it on *this* case.
 *
 * The case list's picker stops at `ATTACH_TARGETS_LIMIT`, so without this a
 * case past it could only get a document by uploading the file again. Here the
 * case is fixed and only the documents are listed, which the store already
 * bounds (`unattachedDocuments`, the same read and the same limit as the
 * list's section) — so no case is out of reach however many there are.
 *
 * It posts to the same `/documents/[id]/attach` route as the list's picker,
 * with the case id the route would otherwise be chosen: one door, the same
 * checks, nothing read again. A document the store suggested this case for
 * comes first and says what agreed, and its button carries the `basis` field
 * the list's suggestion button does. A pure function of what the store returned.
 */
export function AttachReadDocuments({
  deductionId,
  documents,
}: {
  deductionId: string;
  /** Each may carry `suggestions` (`withSuggestions`). */
  documents: readonly UnattachedDocumentWithSuggestions[];
}) {
  if (documents.length === 0) return null;
  // The documents the store suggested *this* case for rise to the top, in the
  // store's order, each saying what agreed; the rest follow as they were.
  const forThisCase = (document: UnattachedDocumentWithSuggestions) =>
    (document.suggestions ?? []).find((s) => s.caseId === deductionId);
  const ordered = [
    ...documents.filter((document) => forThisCase(document) !== undefined),
    ...documents.filter((document) => forThisCase(document) === undefined),
  ];
  return (
    <div className="attach-read">
      <p className="hint">
        Or file a document that was already read and is on no case. It is not read again.
      </p>
      <ul className="attach-read-list">
        {ordered.map((document) => {
          const suggestion = forThisCase(document);
          const ambiguous = (document.suggestions ?? []).filter((s) => s.strength === 'ambiguous').length;
          return (
          <li key={document.documentId} className={suggestion === undefined ? undefined : 'suggested-here'}>
            <span className="mono">{document.filename === '' ? '—' : document.filename}</span>{' '}
            · {docTypeLabel(document.docType)} · received {document.createdAt.slice(0, 10)}
            {suggestion === undefined ? null : (
              <span className="suggested-line">
                {' '}
                · {thisCaseLead(suggestion.strength)} this case {suggestionReason(suggestion, ambiguous)}
              </span>
            )}
            {/* A POST, for the list's reason: it writes to a case. */}
            <form action={`/documents/${document.documentId}/attach`} method="post">
              <input type="hidden" name="caseId" value={deductionId} />
              {suggestion === undefined ? null : (
                <input type="hidden" name="basis" value={basisField(suggestion.basis)} />
              )}
              <button type="submit">
                Attach
                <span className="sr-only">
                  {' '}
                  {document.filename === '' ? 'this document' : document.filename}
                </span>
              </button>
            </form>
          </li>
          );
        })}
      </ul>
    </div>
  );
}

/** "Matches this case", "May match this case", "Possibly this case". */
function thisCaseLead(strength: SuggestedCase['strength']): string {
  if (strength === 'exact') return 'Matches';
  if (strength === 'ambiguous') return 'May match';
  return 'Possibly';
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
  // An unmapped spreadsheet has no reading to open from until it is mapped.
  return hold.reason !== 'no_mapping' && !hasNoLines(hold);
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

  if (hold.reason === 'no_mapping') {
    return (
      'Held: a spreadsheet whose header row no confirmed column mapping matches' +
      (hold.sheet === undefined || hold.sheet === '' ? '' : ` (sheet “${hold.sheet}”)`) +
      '. Map its columns once and its rows are read by code, this time and every time after.'
    );
  }
  const why =
    hold.reason === 'by_email'
      ? // ADR 0047 §7: no email opens a case by itself, however sure the reading.
        `Held: ${readAs}, and it arrived by email. No email opens a case on its own — ` +
        'a person decides each time.' +
        (misfit === undefined ? '' : ` Also, ${misfit}.`)
      : hold.reason === 'by_portal'
        ? // ADR 0057 §10: a page a portal runner fetched opens no case by itself.
          `Held: ${readAs}, and it was fetched from a portal. No portal capture opens a case on ` +
          'its own — a person decides each time.' +
          (misfit === undefined ? '' : ` Also, ${misfit}.`)
      : hold.reason === 'type_did_not_fit'
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

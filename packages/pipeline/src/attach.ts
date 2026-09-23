/**
 * Filing a document that was already read against a case, without reading it
 * again.
 *
 * The case this is for came from production: a delivery receipt and a rate
 * confirmation were uploaded from the case list, read, and — being evidence
 * rather than notices — opened nothing. They were stored, classified and
 * extracted, and they appeared nowhere. The only way to put one on its case was
 * to upload the same file again from the case page, which reads it a second
 * time: `recordedRead` sends an attachment to a case the document is not on
 * through the read, on purpose, because that is where an upload's link and its
 * `evidence.uploaded` event are written.
 *
 * Attaching from the list starts from a document id rather than from bytes, so
 * there is nothing to read "again". What the case needs of the document — its
 * type and its fields — is already recorded, and a case reads a document's
 * fields by document (`latestExtraction`), so a link is all that is missing.
 * No page is fetched and no model is called; the read's spend stays recorded
 * against no case, where it was written (ADR 0028's rule for a read that is
 * not one case's).
 */

import type { DocType } from '@recouple/extraction';
import type { EvidenceAttachStore } from './ports';
import { CaseMergedAwayError } from './ports';
import { CaseNotFoundError } from './steps';
import { DocumentNotFoundError } from './jobs';

/**
 * The document was never read, so there is nothing recorded to attach.
 *
 * Refused rather than read here: this path spends nothing by design, and a
 * document that has not been read is one the "Read again" button is for.
 */
export class DocumentNotReadError extends Error {
  constructor(readonly documentId: string) {
    super(`document ${documentId} has not been read, so there is no reading to attach`);
    this.name = 'DocumentNotReadError';
  }
}

export interface AttachedEvidence {
  readonly deductionId: string;
  readonly documentId: string;
  /** What the recorded read classified it as. */
  readonly docType: DocType;
  /** `false` when the case already held the document and nothing was written. */
  readonly attached: boolean;
}

/**
 * Files an already-read document against a case as evidence.
 *
 * Each refusal is named and comes before the one write:
 *
 * - a case this tenant cannot resolve is `CaseNotFoundError` — `getCase`
 *   cannot tell "no such case" from "another tenant's", and neither is a case
 *   to attach to;
 * - a case merged into another is `CaseMergedAwayError` (ADR 0042) — the
 *   database refuses the link as well, and this names it first;
 * - a document it cannot see is `DocumentNotFoundError`, asked with a
 *   `select 1` rather than by fetching the bytes;
 * - a document with no recorded read is `DocumentNotReadError`.
 *
 * The link and the event are one transaction in the store, so a case never
 * holds a document with no record of how it got there, and a second press
 * writes neither.
 */
export async function attachReadDocument(
  store: EvidenceAttachStore,
  input: { readonly deductionId: string; readonly documentId: string },
): Promise<AttachedEvidence> {
  const target = await store.getCase(input.deductionId);
  if (target === undefined) throw new CaseNotFoundError(input.deductionId);
  if (target.state === 'merged') throw new CaseMergedAwayError(input.deductionId);

  if (!(await store.documentIsVisible(input.documentId))) {
    throw new DocumentNotFoundError(input.documentId);
  }

  const recorded = await store.latestExtraction(input.documentId);
  if (recorded === undefined) throw new DocumentNotReadError(input.documentId);

  const attached = await store.attachEvidence({
    // The case's tenant, as the row says — the same org the claims name, since
    // the case was found under them.
    orgId: target.orgId,
    deductionId: target.deductionId,
    documentId: input.documentId,
    docType: recorded.docType,
  });

  return {
    deductionId: target.deductionId,
    documentId: input.documentId,
    docType: recorded.docType,
    attached,
  };
}

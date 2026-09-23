/**
 * A person opens a case from a held document, without reading it again
 * (ADR 0044).
 *
 * A notice or a remittance whose classification was below the tenant's floor —
 * or whose reading did not fit its type — is held: read, recorded, on no case,
 * and listed under "Read, not on a case" with what the classifier said and why
 * it was not enough. This is the button beside it.
 *
 * It spends nothing. The reading is already recorded, and it is the reading the
 * person looked at: it is restored from the store (`latestExtraction`, through
 * `restoreDocument`) and handed to the same `openCaseFromNotice` or
 * `openCasesFromRemittance` the read would have called, with no classifier and
 * no extractor anywhere in reach (`CaseOpeningDeps` is the store and nothing
 * else). The case it opens says it was opened on a doubted reading and who
 * decided to (`case.discovered` → `held`, `confirmed_by`).
 */

import type { DocType } from '@recouple/extraction';
import type { CaseRecord, HeldDocumentStore } from './ports';
import { WrongRoleError } from './ports';
import { DocumentNotFoundError } from './jobs';
import { DocumentNotReadError } from './attach';
import { opensCaseOnItsOwn, typeFits, type DocumentHold, type HoldConfirmation } from './hold';
import {
  openCaseFromNotice,
  openCasesFromRemittance,
  type CaseOpeningReading,
  type RemittanceRead,
} from './steps';

/** Nothing holds this document: it was never held, or a person already released it. */
export class DocumentNotHeldError extends Error {
  constructor(readonly documentId: string) {
    super(`document ${documentId} is not held for review, so there is no hold to open a case from`);
    this.name = 'DocumentNotHeldError';
  }
}

/** A case already holds this document; opening another from it would be a second case for one page. */
export class DocumentAlreadyOnCaseError extends Error {
  constructor(
    readonly documentId: string,
    readonly deductionId: string,
  ) {
    super(`document ${documentId} is already on case ${deductionId}`);
    this.name = 'DocumentAlreadyOnCaseError';
  }
}

/**
 * The recorded reading will not open a case: it does not fit the type it was
 * read as, or a required field did not survive being stored (`flattenExtraction`
 * writes no row for a value with no page or no quote). A case
 * opened from it would be missing what makes it a case. It can still go on a
 * case as evidence, which is what the refusal says to do.
 *
 * `fields` are schema paths from `typeFits`, never values.
 */
export class HeldReadingUnusableError extends Error {
  constructor(
    readonly documentId: string,
    readonly docType: DocType,
    readonly fields: readonly string[],
  ) {
    super(
      `the recorded reading of document ${documentId} does not fit a ${docType}` +
        (fields.length > 0 ? ` (${fields.join(', ')})` : '') +
        '; attach it to a case as evidence instead',
    );
    this.name = 'HeldReadingUnusableError';
  }
}

/**
 * Somebody else holds this document's read claim right now — a read, or a
 * second press of the same button. Nothing was done; the answer is to look again
 * in a moment rather than to wait here for somebody else's work.
 */
export class DocumentBusyError extends Error {
  constructor(readonly documentId: string) {
    super(`document ${documentId} is being read or opened by another request right now`);
    this.name = 'DocumentBusyError';
  }
}

export interface OpenedFromHold {
  readonly documentId: string;
  readonly docType: 'deduction_notice' | 'remittance_advice';
  /** The hold this released. */
  readonly hold: DocumentHold;
  /** Cases opened, in page order: one for a notice, one per short-paid line for a remittance. */
  readonly opened: readonly CaseRecord[];
  /** Cases a remittance's lines joined rather than duplicated (ADR 0028). */
  readonly mergedInto: readonly string[];
  /** What a remittance's lines came to, for a remittance. */
  readonly remittance?: RemittanceRead;
}

/**
 * Opens the case(s) a held document would have opened, on a person's say-so.
 *
 * Every refusal is named and comes before anything is opened:
 *
 * - `WrongRoleError` — the database says this member may not write here;
 * - `DocumentNotFoundError` — not a document this tenant can see (a `select 1`);
 * - `DocumentBusyError` — its read claim is held elsewhere right now;
 * - `DocumentAlreadyOnCaseError` — a case holds it already;
 * - `DocumentNotHeldError` — nothing holds it;
 * - `DocumentNotReadError` — the hold names a document with no reading;
 * - `HeldReadingUnusableError` — the recorded reading does not fit its type.
 *
 * What opening can itself raise is let through: `DuplicateCaseError` (the claim
 * is already a case — the hold then stands, and the document can go on that
 * case as evidence) and `CaseMergedAwayError` (ADR 0042).
 *
 * **The release comes after the case, and not in its transaction.** Opening a
 * case is several store calls, each its own transaction, so "both or neither"
 * is not on offer without changing every store. The order is chosen for what a
 * crash leaves: case opened and release unwritten is a document on a case under
 * a stale hold, which `caseForDocument` answers before anything reads the hold;
 * the other order would leave an unheld notice on no case, which the next
 * delivery would read and pay for again.
 */
export async function openHeldDocument(
  store: HeldDocumentStore,
  input: { readonly orgId: string; readonly documentId: string; readonly confirmedBy: string },
): Promise<OpenedFromHold> {
  // The database's answer to "may this person write here", before anything.
  // The Postgres store refuses to answer for anybody but its own caller, so a
  // `confirmedBy` that is not the session is a thrown error here, not a case.
  if (!(await store.memberMayWrite({ orgId: input.orgId, userId: input.confirmedBy }))) {
    throw new WrongRoleError(input.confirmedBy, 'open a case from a held document', [
      'owner',
      'approver',
      'analyst',
    ]);
  }
  if (!(await store.documentIsVisible(input.documentId))) {
    throw new DocumentNotFoundError(input.documentId);
  }

  // Under the document's read claim: a press racing a read of the same
  // document, or a second press, would otherwise both find it held and on no
  // case, and open two cases for one page (ADR 0021's reason, again).
  const lease = await store.withDocumentRead(input.documentId, async () => {
    const onCase = await store.caseForDocument(input.documentId);
    if (onCase !== undefined) throw new DocumentAlreadyOnCaseError(input.documentId, onCase);

    const hold = await store.documentHold(input.documentId);
    if (hold === undefined) throw new DocumentNotHeldError(input.documentId);
    // RLS already says so on Postgres; a store without it is asked here, and a
    // hold of another tenant's is a document this caller cannot see.
    if (hold.orgId !== input.orgId) throw new DocumentNotFoundError(input.documentId);

    const recorded = await store.latestExtraction(input.documentId);
    if (recorded === undefined) throw new DocumentNotReadError(input.documentId);
    const docType = recorded.docType;
    if (!opensCaseOnItsOwn(docType) || docType !== hold.docType) {
      // A hold is only ever written for one of the two, and the person was
      // shown the hold's type. A latest reading of another type is not the
      // reading they confirmed, and it is not opened on their say-so.
      throw new HeldReadingUnusableError(input.documentId, docType, []);
    }

    // Asked of the reading as it comes back out of the store, not of the hold:
    // a required field stored without provenance comes back absent, and a case
    // is opened from what comes back.
    const fit = typeFits(docType, recorded);
    if (!fit.fits) throw new HeldReadingUnusableError(input.documentId, docType, fit.fields);

    const document = { documentId: input.documentId, orgId: hold.orgId };
    const reading: CaseOpeningReading = {
      docType,
      document: recorded.document,
      ...(recorded.schemaVersion !== undefined ? { schemaVersion: recorded.schemaVersion } : {}),
    };
    const confirmation: HoldConfirmation = {
      confirmedBy: input.confirmedBy,
      held: { confidence: hold.confidence, floor: hold.floor, reason: hold.reason },
    };

    let opened: readonly CaseRecord[];
    let mergedInto: readonly string[];
    let remittance: RemittanceRead | undefined;
    if (docType === 'deduction_notice') {
      opened = [await openCaseFromNotice(document, reading, { store }, { confirmation })];
      mergedInto = [];
    } else {
      remittance = await openCasesFromRemittance(document, reading, { store }, { confirmation });
      opened = remittance.opened;
      mergedInto = [...new Set(remittance.mergedInto)];
    }

    await store.releaseHold({
      orgId: hold.orgId,
      documentId: input.documentId,
      releasedBy: input.confirmedBy,
      reason: hold.reason,
      deductionIds: [...new Set([...opened.map((c) => c.deductionId), ...mergedInto])],
    });

    return {
      documentId: input.documentId,
      docType,
      hold,
      opened,
      mergedInto,
      ...(remittance !== undefined ? { remittance } : {}),
    } satisfies OpenedFromHold;
  });

  if (!lease.held) throw new DocumentBusyError(input.documentId);
  return lease.result;
}

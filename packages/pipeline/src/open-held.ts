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
 *
 * **It opens from whatever survived**, the way the automatic path always has.
 * A reading that did not fit its type — a notice with no deduction date, a line
 * with no reason code — or a required field that lost its provenance in storage
 * opens a case with those fields empty, and the case names them
 * (`held.fields`, `fields_missing_on_open`). "Better a case with no deadline
 * than no case" was the rule before any of this, and a person's confirmation
 * does not make it stricter. The one reading that is refused is the one with
 * nothing to open: a remittance with no lines.
 */

import type { DocType } from '@recouple/extraction';
import type { CaseRecord, HeldDocumentStore } from './ports';
import { WrongRoleError } from './ports';
import { DocumentNotFoundError } from './jobs';
import { DocumentNotReadError } from './attach';
import {
  hasLines,
  opensCaseOnItsOwn,
  typeFits,
  type DocumentHold,
  type HoldConfirmation,
} from './hold';
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
 * There is nothing in the recorded reading to open a case from: a remittance
 * whose reading has no lines (`fields` is `['lines']`) — it opens one case per
 * line, and there are none — or a reading that is no longer the type the hold
 * named (`fields` empty), which is not the reading the person confirmed.
 *
 * Not refused for a missing field. A notice with no deduction date, or a field
 * stored without provenance, opens its case with the gap named on it, as the
 * automatic path does. This is only for the reading that cannot open anything.
 * It can still go on a case as evidence, which is what the refusal says to do.
 *
 * `fields` are schema paths, never values.
 */
export class HeldReadingUnusableError extends Error {
  constructor(
    readonly documentId: string,
    readonly docType: DocType,
    readonly fields: readonly string[],
  ) {
    super(
      `the recorded reading of document ${documentId} has nothing a ${docType} case can be ` +
        'opened from' +
        (fields.length > 0 ? ` (${fields.join(', ')})` : ' (it is not the type it was held as)') +
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
 * - `HeldReadingUnusableError` — a remittance whose recorded reading has no
 *   lines, or a reading that is no longer the type the hold named.
 *
 * A reading that merely does not fit its type is *not* refused: it opens with
 * what was read, and `fields_missing_on_open` on `case.discovered` names what
 * was not.
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

    // Nothing to open: a remittance opens one case per line, and this one's
    // reading, as it comes back out of the store, has none.
    if (docType === 'remittance_advice' && !hasLines(recorded.document)) {
      throw new HeldReadingUnusableError(input.documentId, docType, ['lines']);
    }

    // Anything else opens, with whatever is missing named on the case. Asked of
    // the reading as it comes back out of the store rather than of the hold: a
    // required field stored without provenance comes back absent, and the case
    // is opened from what comes back.
    const fit = typeFits(docType, recorded);

    const document = { documentId: input.documentId, orgId: hold.orgId };
    const reading: CaseOpeningReading = {
      docType,
      document: recorded.document,
      ...(recorded.schemaVersion !== undefined ? { schemaVersion: recorded.schemaVersion } : {}),
    };
    const confirmation: HoldConfirmation = {
      confirmedBy: input.confirmedBy,
      held: {
        confidence: hold.confidence,
        floor: hold.floor,
        reason: hold.reason,
        ...(hold.fields !== undefined ? { fields: hold.fields } : {}),
      },
      ...(fit.fits ? {} : { missingOnOpen: fit.fields }),
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

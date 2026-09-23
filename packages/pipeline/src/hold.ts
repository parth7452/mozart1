/**
 * A doubtful classification is held for a person (ADR 0044).
 *
 * Two documents open cases on their own: a `deduction_notice` (one case per
 * claim) and a `remittance_advice` (one per short-paid line, ADR 0028). Until
 * this existed they did so on the document type alone, whatever the classifier's
 * confidence and whether or not the reading fitted the type it was read as — so
 * a notice misread as a remittance at 0.75 opened a case per line instead of one
 * per claim, and nothing in the product had read the tenant's
 * `min_classification_confidence` since migration 0002 put it there.
 *
 * Everything here is pure: the decision, the words the audit row is written
 * with, and the parse that reads it back. The steps that act on it are in
 * `steps.ts` (the gate, and the read that answers a held document from the
 * record) and `open-held.ts` (a person opening a case from one).
 */

import { classificationIsActionable } from '@recouple/core-domain';
import {
  describeFields,
  schemaFor,
  templatePath,
  type DocType,
  type ExtractionResult,
  type FieldDescriptor,
} from '@recouple/extraction';
import { fieldPathOf } from './field-path';

/** The `audit_log.action` a hold is written as. */
export const DOCUMENT_HELD = 'document.held';

/** The `audit_log.action` a person's release of a hold is written as. */
export const DOCUMENT_HOLD_RELEASED = 'document.hold_released';

/** What `DocumentRead.haltedBecause` says for a held document. A word, not a sentence. */
export const HELD_FOR_REVIEW = 'held_for_review';

/** The document types that open a case with nobody asking — the only ones a hold applies to. */
export const CASE_OPENING_DOC_TYPES = ['deduction_notice', 'remittance_advice'] as const;
export type CaseOpeningDocType = (typeof CASE_OPENING_DOC_TYPES)[number];

export function opensCaseOnItsOwn(docType: DocType): docType is CaseOpeningDocType {
  return (CASE_OPENING_DOC_TYPES as readonly string[]).includes(docType);
}

/**
 * Why a document was held.
 *
 *  - `below_floor` — the classifier was less sure than this tenant's floor.
 *    Recorded whenever it applies, even if the reading also did not fit: a
 *    reading the classifier doubted is the more basic reason.
 *  - `type_did_not_fit` — the classifier was sure enough, and the reading does
 *    not satisfy the type it was read as.
 */
export const HOLD_REASONS = ['below_floor', 'type_did_not_fit'] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];

export function isHoldReason(value: unknown): value is HoldReason {
  return typeof value === 'string' && (HOLD_REASONS as readonly string[]).includes(value);
}

/**
 * Whether a reading fits the type it was read as, and if not, which fields
 * say so.
 *
 * Field paths only (`claim_id`, `lines[0].invoice_number`), never a value.
 */
export type TypeFit =
  | { readonly fits: true }
  | { readonly fits: false; readonly fields: readonly string[] };

/**
 * A reading fits when it validated against the type it was read as — and, for
 * a remittance, carries at least one line.
 *
 * `validated` is the reader's own verdict (`reassemble` against the type's
 * schema), and it is the verdict this trusts. The field list is re-derived from
 * the schema's own complaint about the document rather than read off
 * `issues`, because `issues` also carries the paths `reassemble` dropped — and
 * those are paths a model wrote, which is text off somebody else's page
 * (invariant 4). What survives is filtered once more against the fields the
 * document type declares, so nothing this returns is anything but one of ours.
 *
 * A remittance with no lines is a misfit even when it validated: it opens
 * nothing, so calling it a remittance is not a reading anyone can act on — and
 * it is the shape a notice read as a remittance can take.
 *
 * A notice with no lines is not: `openCaseFromNotice` opens its case from the
 * claim and the total, and a notice with a single total and no line detail is a
 * real notice.
 */
export function typeFits(
  docType: DocType,
  reading: Pick<ExtractionResult, 'document' | 'validated'>,
): TypeFit {
  // `lines` is named whenever a remittance has none, validated or not: it is
  // the one misfit that leaves nothing to open a case from (`openHeldDocument`
  // refuses it, and the list offers no button), so it must never be hidden
  // behind a schema complaint about some other field.
  const noLines = docType === 'remittance_advice' && !hasLines(reading.document);
  if (reading.validated === true && !noLines) return { fits: true };
  const fields = reading.validated === true ? [] : misfitFields(docType, reading.document);
  return {
    fits: false,
    fields: noLines && !fields.includes('lines') ? [...fields, 'lines'].sort() : fields,
  };
}

/**
 * Whether a remittance reading has at least one line — the thing it opens a
 * case per. Without one there is nothing a case could be opened from.
 */
export function hasLines(document: unknown): boolean {
  const lines =
    document !== null && typeof document === 'object'
      ? (document as { readonly lines?: unknown }).lines
      : undefined;
  return Array.isArray(lines) && lines.length > 0;
}

/** What a read decided to hold, and why. Absent means the case opens. */
export interface HoldDecision {
  readonly reason: HoldReason;
  /**
   * Present exactly when the reading did not fit its type — alongside
   * `below_floor` as well as for `type_did_not_fit` — so a reader of the hold can
   * tell "doubted, but fits" from "does not fit" without a second flag. It lists
   * the fields `typeFits` could name, which can be none.
   */
  readonly fields?: readonly string[];
}

/**
 * The gate, as a pure function: open, or hold and say why.
 *
 * Opens only when the classifier is at or above the floor (inclusive) *and* the
 * reading fits. `classificationIsActionable` fails closed on a confidence or a
 * floor that is not a probability, so a number no classifier produced holds.
 */
export function holdFor(input: {
  readonly docType: CaseOpeningDocType;
  readonly confidence: number;
  readonly floor: number;
  readonly reading: Pick<ExtractionResult, 'document' | 'validated'>;
}): HoldDecision | undefined {
  const actionable = classificationIsActionable(input.confidence, input.floor);
  const fit = typeFits(input.docType, input.reading);
  if (actionable && fit.fits) return undefined;
  return {
    reason: actionable ? 'type_did_not_fit' : 'below_floor',
    ...(fit.fits ? {} : { fields: fit.fields }),
  };
}

/**
 * A hold, as a store reads it back: the latest `document.held` row for a
 * document that no `document.hold_released` row has followed.
 */
export interface DocumentHold {
  readonly documentId: string;
  /** The row's own tenant, which is the document's. */
  readonly orgId: string;
  readonly docType: CaseOpeningDocType;
  /** The classifier's confidence as the gate compared it — before any rounding. */
  readonly confidence: number;
  /** This tenant's floor at the moment of the read. */
  readonly floor: number;
  readonly reason: HoldReason;
  /** As `HoldDecision.fields`: present exactly when the reading did not fit. */
  readonly fields?: readonly string[];
  /** When the hold was written, ISO-8601. Absent where a store cannot say. */
  readonly heldAt?: string;
  /** The member whose read it was. Absent where a store has no actor. */
  readonly heldBy?: string;
}

/** What a hold looks like to the thing that decided it, before a store writes it. */
export type HoldRecord = Pick<
  DocumentHold,
  'documentId' | 'orgId' | 'docType' | 'confidence' | 'floor' | 'reason' | 'fields'
>;

/**
 * A person's say-so, carried onto every `case.discovered` a released hold
 * writes, so the case says it was opened on a doubted reading and who decided.
 */
export interface HoldConfirmation {
  readonly confirmedBy: string;
  readonly held: {
    readonly confidence: number;
    readonly floor: number;
    readonly reason: HoldReason;
    /** The hold's own `fields`: what the read could not fit, when it could not. Paths only. */
    readonly fields?: readonly string[];
  };
  /**
   * The fields the reading lacked when the person opened the case from it, as
   * `typeFits` names them on the *restored* reading — the hold's own `fields`
   * plus any required field whose value was stored without provenance and so
   * did not come back. Absent when the restored reading fits. Paths only.
   *
   * The case opens anyway, with those fields empty, the way the automatic path
   * has always opened one ("better a case with no deadline than no case"); this
   * is what says which ones.
   */
  readonly missingOnOpen?: readonly string[];
}

/**
 * The payload a `document.held` audit row carries. A doc type (one of two
 * constants), two numbers, a reason from a closed set and schema field paths —
 * nothing off the page.
 */
export function holdAuditPayload(hold: HoldRecord): Record<string, unknown> {
  return {
    doc_type: hold.docType,
    confidence: hold.confidence,
    floor: hold.floor,
    reason: hold.reason,
    ...(hold.fields !== undefined ? { fields: [...hold.fields] } : {}),
  };
}

/**
 * A `document.held` row's payload, read back and checked rather than cast.
 *
 * Only this package writes one, and only through `holdAuditPayload`. A row that
 * is not that shape is not a hold anybody should act on, and the answer is a
 * named error, not a guess: the case list would otherwise offer a button over a
 * number nobody wrote.
 */
export function holdFromAuditPayload(
  payload: unknown,
  row: {
    readonly documentId: string;
    readonly orgId: string;
    readonly heldAt?: string;
    readonly heldBy?: string;
  },
): DocumentHold {
  const refuse = (problem: string): never => {
    throw new HoldRecordUnreadableError(row.documentId, problem);
  };
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return refuse('the payload is not an object');
  }
  const raw = payload as Record<string, unknown>;
  const docType = raw.doc_type;
  if (typeof docType !== 'string' || !(CASE_OPENING_DOC_TYPES as readonly string[]).includes(docType)) {
    return refuse('doc_type is not a notice or a remittance');
  }
  if (!isProbabilityNumber(raw.confidence)) return refuse('confidence is not a number in [0, 1]');
  if (!isProbabilityNumber(raw.floor)) return refuse('floor is not a number in [0, 1]');
  if (!isHoldReason(raw.reason)) return refuse('reason is not one of the hold reasons');
  let fields: readonly string[] | undefined;
  if (raw.fields !== undefined) {
    if (!Array.isArray(raw.fields) || !raw.fields.every((f) => typeof f === 'string' && FIELD_PATH.test(f))) {
      return refuse('fields is not a list of field paths');
    }
    fields = raw.fields as string[];
  }
  return {
    documentId: row.documentId,
    orgId: row.orgId,
    docType: docType as CaseOpeningDocType,
    confidence: raw.confidence,
    floor: raw.floor,
    reason: raw.reason,
    ...(fields !== undefined ? { fields } : {}),
    ...(row.heldAt !== undefined ? { heldAt: row.heldAt } : {}),
    ...(row.heldBy !== undefined ? { heldBy: row.heldBy } : {}),
  };
}

/**
 * A `document.held` row this code could not have written.
 *
 * The problem is in our own words; nothing from the row is quoted, because a row
 * that is not what we wrote is a row whose contents we know nothing about.
 */
export class HoldRecordUnreadableError extends Error {
  constructor(
    readonly documentId: string,
    readonly problem: string,
  ) {
    super(`the hold recorded for document ${documentId} cannot be read: ${problem}`);
    this.name = 'HoldRecordUnreadableError';
  }
}

/**
 * This tenant's classification floor could not be read.
 *
 * Raised before a page is fetched or a model is called, so it costs nothing —
 * and it is raised rather than defaulted, because a default here would be a
 * threshold nobody set deciding which documents open cases (invariant 7). The
 * detail is in our words: the column's text is not repeated.
 */
export class ClassificationFloorError extends Error {
  constructor(
    readonly orgId: string,
    readonly reason: 'missing' | 'unreadable',
  ) {
    super(
      reason === 'missing'
        ? `org ${orgId} has no org_settings row, so it has no classification floor; ` +
            'a notice or remittance is not read without one (ADR 0044)'
        : `org ${orgId}'s min_classification_confidence is not a number in [0, 1] (ADR 0044)`,
    );
    this.name = 'ClassificationFloorError';
  }
}

/**
 * The column's text, parsed exactly: `numeric(4,3)` arrives from the driver as
 * a string such as `0.950`, and anything that is not a plain decimal in [0, 1]
 * is refused rather than coerced. `Number('')` is 0 and `Number(' 1 ')` is 1;
 * neither is a floor anybody set.
 */
export function parseClassificationFloor(text: unknown, orgId: string): number {
  if (typeof text !== 'string' || !/^(0(\.\d{1,6})?|1(\.0{1,6})?)$/.test(text)) {
    throw new ClassificationFloorError(orgId, 'unreadable');
  }
  const value = Number(text);
  if (!isProbabilityNumber(value)) throw new ClassificationFloorError(orgId, 'unreadable');
  return value;
}

// ---------------------------------------------------------------------------

/** `claim_id`, `lines[0].invoice_number`: our own schema's shape of path, nothing else. */
const FIELD_PATH = /^[a-z][a-z0-9_]*(\[\d{1,4}\])?(\.[a-z][a-z0-9_]*(\[\d{1,4}\])?)*$/;

function isProbabilityNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** The field list for a document type, worked out once — `restore.ts`'s cache, for the same reason. */
const descriptorCache = new Map<DocType, readonly FieldDescriptor[]>();

function descriptorsFor(docType: DocType): readonly FieldDescriptor[] {
  const cached = descriptorCache.get(docType);
  if (cached !== undefined) return cached;
  const descriptors = describeFields(schemaFor(docType));
  descriptorCache.set(docType, descriptors);
  return descriptors;
}

/**
 * The fields the schema complained about, as field paths, restricted to fields
 * this document type declares (and its repeating groups).
 */
function misfitFields(docType: DocType, document: unknown): readonly string[] {
  const parsed = schemaFor(docType).safeParse(document);
  if (parsed.success) return [];

  const descriptors = descriptorsFor(docType);
  const templates = new Set(descriptors.map((d) => d.path));
  const groups = new Set(
    descriptors.map((d) => d.group).filter((group): group is string => group !== undefined),
  );
  const known = (path: string): boolean => {
    const template = templatePath(path);
    return templates.has(template) || groups.has(template) || groups.has(template.replace(/\[\]$/, ''));
  };

  const fields = new Set<string>();
  for (const issue of parsed.error.issues) {
    const path = fieldPathOf(issue.path.map(String));
    if (path !== '' && FIELD_PATH.test(path) && known(path)) fields.add(path);
  }
  return [...fields].sort();
}

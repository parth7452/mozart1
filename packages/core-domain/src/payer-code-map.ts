/**
 * A payer's printed reason code mapped to a canonical one (ADR 0067).
 *
 * The mapping itself is tenant data in `payer_code_maps`: a row per tenant,
 * debtor, code and start date, with a source, a confidence and an author.
 * Nothing in this file knows any payer's codes. What is here is the one
 * normalisation rule, the rule for which row applies on a date, and a loader
 * that turns a playbook draft's code table into *proposed* rows for a person
 * to load or not.
 *
 * A lookup is an exact match on the normalised code. Never the nearest, never
 * a prefix, never a model: a wrong mapping is a wrong dispute basis.
 */

import {
  CANONICAL_REASON_CODE_LIST,
  isCanonicalReasonCode,
  type CanonicalReasonCode,
} from './reason-codes';

export const PAYER_CODE_SOURCES = [
  'payer_guide_url',
  'customer_confirmed',
  'glimpse_guide',
  'operator',
] as const;
export type PayerCodeSource = (typeof PAYER_CODE_SOURCES)[number];

export const PAYER_CODE_CONFIDENCES = ['low', 'medium', 'high'] as const;
export type PayerCodeConfidence = (typeof PAYER_CODE_CONFIDENCES)[number];

/** Where a mapping came from, in words a person reads. */
export const PAYER_CODE_SOURCE_WORDS = {
  payer_guide_url: "the payer's own guide",
  customer_confirmed: 'the customer',
  glimpse_guide: "Glimpse's published guide",
  operator: 'a Mozart operator',
} as const satisfies Record<PayerCodeSource, string>;

export function isPayerCodeSource(value: unknown): value is PayerCodeSource {
  return typeof value === 'string' && (PAYER_CODE_SOURCES as readonly string[]).includes(value);
}

export function isPayerCodeConfidence(value: unknown): value is PayerCodeConfidence {
  return typeof value === 'string' && (PAYER_CODE_CONFIDENCES as readonly string[]).includes(value);
}

/** The column's own limits (migration 0040). */
export const PAYER_CODE_MAX_LENGTH = 64;
export const PAYER_CODE_SOURCE_NOTE_MAX_LENGTH = 500;

/**
 * The one normalisation rule: trim, collapse every run of whitespace to one
 * space, uppercase.
 *
 * Nothing else. Punctuation stays, so `CB-203` and `CB203` are two codes;
 * whether they are one is data a person adds as a second row. Idempotent
 * (property-tested): a stored code normalises to itself.
 */
export function normalisePayerCode(printed: string): string {
  return printed.trim().replace(/\s+/gu, ' ').toUpperCase();
}

/**
 * Whether a normalised code is one the table will take: non-empty, at most
 * `PAYER_CODE_MAX_LENGTH` characters, no control character, and already in
 * normal form. Asked before an insert so a refusal has a name.
 */
export function isStorablePayerCode(code: string): boolean {
  if (code === '' || [...code].length > PAYER_CODE_MAX_LENGTH) return false;
  if (/[\u0000-\u001f\u007f]/u.test(code)) return false;
  return normalisePayerCode(code) === code;
}

/** One `payer_code_maps` row. Dates are `YYYY-MM-DD`. */
export interface PayerCodeMapRow {
  readonly id: string;
  readonly orgId: string;
  readonly debtorId: string;
  /** Normalised by {@link normalisePayerCode}. */
  readonly payerCode: string;
  readonly canonicalCode: CanonicalReasonCode;
  readonly effectiveFrom: string;
  readonly effectiveTo?: string;
  readonly source: PayerCodeSource;
  readonly sourceNote?: string;
  readonly confidence: PayerCodeConfidence;
  readonly recordedBy: string;
  /** ISO timestamp. */
  readonly createdAt: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const at = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === value;
}

/**
 * The mapping in force for a printed code on a date, or undefined.
 *
 * The rule, the same one `app.payer_code_maps_as_of()` states in SQL: among
 * the rows for this code (and this debtor, when one is named) whose
 * `effectiveFrom` is on or before the date and whose `effectiveTo` is absent
 * or on or after it, the one with the latest `effectiveFrom`. So a later row
 * supersedes an earlier one, and a row past its `effectiveTo` never applies.
 *
 * `payerCode` is normalised here; the rows' codes are taken as stored. Pass
 * one debtor's rows, or name the debtor. Two rows of one debtor cannot share
 * an `effectiveFrom` (the table's unique key); given such input anyway, the
 * later `createdAt` and then the greater id wins, so the answer never depends
 * on the order of the list.
 */
export function resolveCanonicalCode(
  maps: readonly PayerCodeMapRow[],
  query: { readonly payerCode: string; readonly asOf: string; readonly debtorId?: string },
): PayerCodeMapRow | undefined {
  if (!isIsoDate(query.asOf)) throw new RangeError(`asOf is not a YYYY-MM-DD date: ${query.asOf}`);
  const code = normalisePayerCode(query.payerCode);
  let best: PayerCodeMapRow | undefined;
  for (const row of maps) {
    if (row.payerCode !== code) continue;
    if (query.debtorId !== undefined && row.debtorId !== query.debtorId) continue;
    if (row.effectiveFrom > query.asOf) continue;
    if (row.effectiveTo !== undefined && row.effectiveTo < query.asOf) continue;
    if (best === undefined || supersedes(row, best)) best = row;
  }
  return best;
}

function supersedes(a: PayerCodeMapRow, b: PayerCodeMapRow): boolean {
  if (a.effectiveFrom !== b.effectiveFrom) return a.effectiveFrom > b.effectiveFrom;
  if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt;
  return a.id > b.id;
}

// ---------------------------------------------------------------------------
// Proposed rows from a playbook draft
// ---------------------------------------------------------------------------

/** A row a draft proposes. Nothing is written by proposing it. */
export interface ProposedPayerCodeMap {
  /** As the draft printed it. */
  readonly printed: string;
  /** Normalised by {@link normalisePayerCode}. */
  readonly payerCode: string;
  readonly canonicalCode: CanonicalReasonCode;
  readonly source: 'glimpse_guide';
  readonly confidence: 'low';
  readonly sourceNote: string;
}

export type DraftSkipReason =
  /** The draft maps it to nothing (`canonical: null`). */
  | 'unmapped_in_draft'
  /** The draft's code is not in our taxonomy. */
  | 'not_canonical'
  /** A shape such as `MCB(yyyymmdd)`, not a code a document prints. */
  | 'shape_not_code'
  /** Empty, too long or carrying a control character once normalised. */
  | 'not_storable'
  /** Two entries normalise to one code and name different reasons. */
  | 'conflicting_in_draft'
  /** The same code and reason as an earlier entry. */
  | 'repeated_in_draft';

export interface SkippedDraftEntry {
  readonly printed: string;
  readonly reason: DraftSkipReason;
  readonly detail?: string;
}

export interface DraftCodeTable {
  readonly retailerKey?: string;
  readonly proposed: readonly ProposedPayerCodeMap[];
  readonly skipped: readonly SkippedDraftEntry[];
}

/**
 * A printed form that stands for many codes: `<invoice#>-111`, `LCPV(PO#)`,
 * `MCB(yyyymmdd)`. An angle-bracket placeholder, a `#`, or a parenthesised
 * date mask (only the letters m, d and y). An exact match cannot map one, so
 * it is reported and not proposed.
 */
const SHAPE = /<[^<>]+>|#|\([mdy]+\)/u;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function entriesOf(value: unknown): readonly Record<string, unknown>[] {
  const list = record(value)?.entries;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => {
    const r = record(entry);
    return r === undefined ? [] : [r];
  });
}

/**
 * Reads a playbook draft's code table (`docs/competitive/glimpse/playbook-drafts/*.yaml`,
 * already parsed) into proposed rows: `source: 'glimpse_guide'`,
 * `confidence: 'low'`.
 *
 * Takes `code_map.entries` and `code_map.freight_accessorials_claimed.entries`:
 * the two places a draft pairs one printed form with one canonical code.
 * `categories_claimed` is not read, since a category with several candidate
 * codes is not a pair. Every entry that is not proposed is returned with why.
 */
export function proposedPayerCodeMapsFromDraft(draft: unknown): DraftCodeTable {
  const root = record(draft);
  if (root === undefined) throw new TypeError('a playbook draft is a mapping at its top level');
  const retailerKey = typeof root.retailer_key === 'string' ? root.retailer_key : undefined;
  const version = typeof root.version === 'string' ? root.version : undefined;

  const urls = new Map<string, string>();
  if (Array.isArray(root.drafted_from)) {
    for (const item of root.drafted_from) {
      const r = record(item);
      if (r !== undefined && typeof r.id === 'string' && typeof r.source_url === 'string') {
        urls.set(r.id, r.source_url);
      }
    }
  }

  const codeMap = record(root.code_map);
  const accessorials = record(codeMap?.freight_accessorials_claimed);
  const accessorialSource = accessorials?.source;
  const entries = [
    ...entriesOf(codeMap).map((entry) => ({ entry, fallbackSource: undefined as unknown })),
    ...entriesOf(accessorials).map((entry) => ({ entry, fallbackSource: accessorialSource })),
  ];

  const proposed: ProposedPayerCodeMap[] = [];
  const skipped: SkippedDraftEntry[] = [];
  const seen = new Map<string, CanonicalReasonCode>();
  const conflicted = new Set<string>();

  for (const { entry, fallbackSource } of entries) {
    const printed = entry.printed;
    if (typeof printed !== 'string') continue;
    const canonical = entry.canonical;
    if (canonical === null || canonical === undefined) {
      const why = entry.why_unmapped;
      skipped.push({
        printed,
        reason: 'unmapped_in_draft',
        ...(typeof why === 'string' ? { detail: why } : {}),
      });
      continue;
    }
    if (typeof canonical !== 'string' || !isCanonicalReasonCode(canonical)) {
      skipped.push({ printed, reason: 'not_canonical', detail: String(canonical) });
      continue;
    }
    if (SHAPE.test(printed)) {
      skipped.push({ printed, reason: 'shape_not_code', detail: canonical });
      continue;
    }
    const payerCode = normalisePayerCode(printed);
    if (!isStorablePayerCode(payerCode)) {
      skipped.push({ printed, reason: 'not_storable' });
      continue;
    }
    const earlier = seen.get(payerCode);
    if (earlier !== undefined) {
      if (earlier === canonical) {
        skipped.push({ printed, reason: 'repeated_in_draft' });
      } else {
        conflicted.add(payerCode);
        skipped.push({ printed, reason: 'conflicting_in_draft', detail: `${earlier} and ${canonical}` });
      }
      continue;
    }
    seen.set(payerCode, canonical);

    const sourceId = typeof entry.source === 'string' ? entry.source : fallbackSource;
    const where = typeof sourceId === 'string' ? (urls.get(sourceId) ?? sourceId) : undefined;
    const note = [
      `Glimpse playbook draft${retailerKey === undefined ? '' : ` ${retailerKey}`}${
        version === undefined ? '' : ` ${version}`
      }`,
      ...(where === undefined ? [] : [where]),
    ].join(': ');
    proposed.push({
      printed,
      payerCode,
      canonicalCode: canonical,
      source: 'glimpse_guide',
      confidence: 'low',
      sourceNote: [...note].slice(0, PAYER_CODE_SOURCE_NOTE_MAX_LENGTH).join(''),
    });
  }

  // A code the draft maps two ways is proposed neither way.
  const kept = proposed.filter((row) => {
    if (!conflicted.has(row.payerCode)) return true;
    skipped.push({ printed: row.printed, reason: 'conflicting_in_draft' });
    return false;
  });

  return { ...(retailerKey === undefined ? {} : { retailerKey }), proposed: kept, skipped };
}

/** Every canonical code, for a form that offers the whole taxonomy. */
export const MAPPABLE_REASON_CODES: readonly CanonicalReasonCode[] = CANONICAL_REASON_CODE_LIST;

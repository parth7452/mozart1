/**
 * Which case a read document probably belongs on — a suggestion, never a link.
 *
 * An evidence document (an invoice, a delivery receipt, a bill of lading, a
 * purchase order, an agreement, a message) that is read and opens nothing sits
 * under "Read, not on a case" until a person files it. This module answers one
 * question about such a document — which open case does it name? — in
 * deterministic code, with no I/O and no model.
 *
 * Three things bind it (CLAUDE.md):
 *
 * - **Document text is untrusted** (invariant 4). A document may *select* a
 *   case through an identifier the case already carries. It never opens one,
 *   never names a debtor and never adds an identifier.
 * - **A link cannot be undone.** `deduction_documents` is append-only, so a
 *   wrong attach stays on the case for good. Nothing here attaches: every
 *   answer, `exact` included, is shown to a person who presses a button.
 * - **Only an exact match is called one** (ADR 0025, ADR 0028). An identifier
 *   equal to a case's identifier *of the same kind*, after the fold identity
 *   resolution uses (`identifierMatchKey` — reused, not copied). Several cases
 *   carrying it is `ambiguous` and all are listed: we do not choose, the rule
 *   `resolveIdentity` and `resolveDebtorId` already apply. Anything looser is
 *   `probable` and ranked below.
 *
 * It differs from `resolveIdentity` in one deliberate way: an invoice number
 * *is* matched here. ADR 0025 §6 refuses it as an exact key for deciding that
 * two deductions are one, because one invoice carries many deductions. Here
 * that is the `ambiguous` answer rather than a wrong merge — an invoice is
 * evidence for every deduction taken against it.
 */

import { identifierMatchKey, type IdentifierKind } from './identity';
import { parseMoneyToCents, type Cents } from './money';
import { retailerMatchKey } from './retailers';
import { isClosed, type CaseState } from './state-machine';

/** The kinds of name a document and a case can share exactly. */
export type DocumentMatchKind = 'claim_id' | 'invoice_number' | 'po_number' | 'bol_number';

/**
 * What agreed. A closed set of constants: these are what is written on the
 * `evidence.attached` event, and nothing off a page goes there.
 *
 * - the four `DocumentMatchKind`s: an identifier of that kind is equal;
 * - `reference`: an identifier the document names without saying what kind it
 *   is (a message's "references") equals one of the case's;
 * - `payer`: the payer the document names is the case's debtor, by a name a
 *   person gave it, or folds to the name printed on the case;
 * - `amount_cents`: an amount on the document equals the case's, to the cent.
 */
export type DocumentMatchBasisKind = DocumentMatchKind | 'reference' | 'payer' | 'amount_cents';

export const DOCUMENT_MATCH_BASIS_KINDS: readonly DocumentMatchBasisKind[] = [
  'claim_id',
  'invoice_number',
  'po_number',
  'bol_number',
  'reference',
  'payer',
  'amount_cents',
];

export type DocumentMatchStrength = 'exact' | 'ambiguous' | 'probable';

export const DOCUMENT_MATCH_STRENGTHS: readonly DocumentMatchStrength[] = [
  'exact',
  'ambiguous',
  'probable',
];

/**
 * Where a document type prints what a case can be found by, as schema paths
 * (`packages/extraction/src/schemas.ts`). `[]` stands for any row of a
 * repeating group. This is a fact about our own schemas, not about any payer.
 */
export interface DocumentMatchFields {
  /** Identifier fields, each with the one kind it can equal. */
  readonly identifiers: readonly { readonly path: string; readonly kind: DocumentMatchKind }[];
  /** Identifiers the document names without a kind we can rely on. */
  readonly references: readonly string[];
  /** Who the document says the payer is. */
  readonly payerNames: readonly string[];
  /** Money fields that could be a deduction's amount. */
  readonly amounts: readonly string[];
}

const NOTHING: DocumentMatchFields = { identifiers: [], references: [], payerNames: [], amounts: [] };

/**
 * One entry per document type the reader knows. Keyed by string because
 * `core-domain` does not import the extraction package; a test in
 * `store-postgres`, which imports both, holds the keys to `DOC_TYPES`.
 *
 * A bill of lading and a proof of delivery print their own number as
 * `document_number`. No schema has a PRO number or a claim id outside the
 * notice, so neither is listed: a field that does not exist cannot match.
 */
export const DOCUMENT_MATCH_FIELDS: Readonly<Record<string, DocumentMatchFields>> = {
  deduction_notice: {
    identifiers: [
      { path: 'claim_id', kind: 'claim_id' },
      { path: 'invoice_number', kind: 'invoice_number' },
      { path: 'po_number', kind: 'po_number' },
    ],
    references: [],
    payerNames: ['retailer_name'],
    amounts: ['deduction_total', 'lines[].deduction_amount'],
  },
  remittance_advice: {
    identifiers: [{ path: 'lines[].invoice_number', kind: 'invoice_number' }],
    references: [],
    payerNames: ['payer_name'],
    amounts: ['lines[].deduction_amount'],
  },
  invoice: {
    identifiers: [
      { path: 'invoice_number', kind: 'invoice_number' },
      { path: 'po_number', kind: 'po_number' },
    ],
    references: [],
    payerNames: ['customer_name'],
    amounts: ['invoice_total', 'lines[].extended_amount'],
  },
  po: {
    identifiers: [{ path: 'po_number', kind: 'po_number' }],
    references: [],
    payerNames: ['buyer_name'],
    amounts: [],
  },
  bol: {
    identifiers: [
      { path: 'document_number', kind: 'bol_number' },
      { path: 'po_number', kind: 'po_number' },
    ],
    references: [],
    payerNames: [],
    amounts: [],
  },
  pod: {
    identifiers: [
      { path: 'document_number', kind: 'bol_number' },
      { path: 'po_number', kind: 'po_number' },
    ],
    references: [],
    payerNames: [],
    amounts: [],
  },
  asn: {
    identifiers: [{ path: 'po_number', kind: 'po_number' }],
    references: [],
    payerNames: [],
    amounts: [],
  },
  correspondence: {
    identifiers: [],
    references: ['references[].value'],
    payerNames: ['sender_organisation'],
    amounts: [],
  },
  promo_agreement: {
    identifiers: [],
    references: [],
    payerNames: ['counterparty'],
    amounts: ['terms[].amount'],
  },
  price_agreement: {
    identifiers: [],
    references: [],
    payerNames: ['counterparty'],
    amounts: ['terms[].amount'],
  },
  routing_guide: NOTHING,
  other: NOTHING,
};

/**
 * The case-side fields that carry a purchase order or a shipment number: a
 * case has no column for either, so they are read off the documents already
 * linked to it. `docTypes` undefined means any type.
 */
export const CASE_DOCUMENT_MATCH_FIELDS: readonly {
  readonly path: string;
  readonly kind: DocumentMatchKind;
  readonly docTypes?: readonly string[];
}[] = [
  { path: 'po_number', kind: 'po_number' },
  { path: 'document_number', kind: 'bol_number', docTypes: ['bol', 'pod'] },
];

/**
 * Which `deduction_identifiers` kind is comparable with which document kind.
 * A ledger's own invoice id, a credit memo id and an EDI reference are names
 * no document here prints, so they match nothing.
 */
export function documentMatchKindOf(kind: IdentifierKind): DocumentMatchKind | undefined {
  if (kind === 'claim_id' || kind === 'portal_claim_id') return 'claim_id';
  if (kind === 'invoice_number') return 'invoice_number';
  return undefined;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function patternSource(path: string): string {
  return path.split('[]').map(escapeRegExp).join('\\[\\d+\\]');
}

function pathMatches(pattern: string, path: string): boolean {
  return new RegExp(`^${patternSource(pattern)}$`).test(path);
}

/**
 * One regular expression matching every field path any document type lists —
 * so a store can read only those rows. The same source is valid in JavaScript
 * and in Postgres (`~`).
 */
export function documentMatchPathPattern(): string {
  const patterns = new Set<string>();
  for (const fields of Object.values(DOCUMENT_MATCH_FIELDS)) {
    for (const { path } of fields.identifiers) patterns.add(path);
    for (const path of [...fields.references, ...fields.payerNames, ...fields.amounts]) {
      patterns.add(path);
    }
  }
  return `^(${[...patterns].sort().map(patternSource).join('|')})$`;
}

/** A stored extraction field: its schema path and the value as stored. */
export interface DocumentMatchField {
  readonly path: string;
  readonly value: unknown;
}

/** An open-or-not case, as far as matching cares about it. */
export interface DocumentMatchCase {
  readonly caseId: string;
  readonly state: CaseState;
  readonly amountCents: Cents;
  readonly debtorId?: string;
  /** Every name a person gave the case's debtor: display name, key, aliases. */
  readonly debtorNames?: readonly string[];
  readonly retailerNameAsPrinted?: string;
  /** The case's own claim id column, when it has one. */
  readonly claimId?: string;
  /**
   * The names the case carries: its `deduction_identifiers` (a merged-away
   * case's mapped onto its survivor by the reader, ADR 0042) and the purchase
   * order and shipment numbers on its linked documents.
   */
  readonly identifiers: readonly {
    readonly kind: IdentifierKind | DocumentMatchKind;
    readonly value: string;
  }[];
}

/** One fact that agreed. `value` is the document's own text, for display only. */
export interface DocumentMatchBasis {
  readonly kind: DocumentMatchBasisKind;
  /** The document's schema path the fact was read from. */
  readonly field: string;
  /**
   * The identifier as the document printed it. Somebody else's text: a view
   * may render it (escaped), and it is never written to an event or a log.
   * Absent for `payer` and `amount_cents`.
   */
  readonly value?: string;
}

export interface DocumentCaseSuggestion {
  readonly caseId: string;
  readonly strength: DocumentMatchStrength;
  /** Never empty. */
  readonly basis: readonly DocumentMatchBasis[];
}

/** The basis as the constants an event may carry: kinds only, sorted, distinct. */
export function basisKinds(basis: readonly DocumentMatchBasis[]): readonly DocumentMatchBasisKind[] {
  const present = new Set(basis.map((b) => b.kind));
  return DOCUMENT_MATCH_BASIS_KINDS.filter((kind) => present.has(kind));
}

function isDocumentMatchKind(kind: string): kind is DocumentMatchKind {
  return kind === 'claim_id' || kind === 'invoice_number' || kind === 'po_number' || kind === 'bol_number';
}

function caseKind(kind: IdentifierKind | DocumentMatchKind): DocumentMatchKind | undefined {
  return isDocumentMatchKind(kind) ? kind : documentMatchKindOf(kind);
}

function printed(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function centsOf(value: unknown): Cents | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return parseMoneyToCents(value);
  } catch {
    // An amount we cannot read to the cent is one that cannot agree — not an
    // error here: the reading is stored either way and this only suggests.
    return undefined;
  }
}

/**
 * The open cases a read document names, strongest first.
 *
 * In order:
 *
 * 1. **exact** — a document identifier equals a case identifier of the same
 *    kind after `identifierMatchKey`. One open case: `exact`. Several:
 *    every one is listed as `ambiguous`.
 * 2. **probable** — for the cases no identifier matched: the payer agrees
 *    *and* an amount on the document equals the case's to the cent; or an
 *    identifier the document names without a kind equals one of the case's.
 *    A payer alone or an amount alone is never a suggestion.
 *
 * A closed case — finished or merged away — is never suggested. A document
 * type that lists no fields, a missing field and an unreadable amount all
 * contribute nothing and never throw. Every suggestion has a basis.
 *
 * Within a strength, the case that agreed on more comes first, then the case
 * id, so the answer does not depend on the order cases were read in.
 */
export function suggestCasesForDocument(input: {
  readonly documentType: string;
  readonly documentFields: readonly DocumentMatchField[];
  readonly cases: readonly DocumentMatchCase[];
}): readonly DocumentCaseSuggestion[] {
  const spec = DOCUMENT_MATCH_FIELDS[input.documentType];
  if (spec === undefined) return [];

  const identifiers: { kind: DocumentMatchKind; key: string; field: string; value: string }[] = [];
  const references: { key: string; field: string; value: string }[] = [];
  const payers: { key: string; field: string }[] = [];
  const amounts: { cents: Cents; field: string }[] = [];

  for (const field of input.documentFields) {
    for (const { path, kind } of spec.identifiers) {
      if (!pathMatches(path, field.path)) continue;
      const value = printed(field.value);
      const key = value === undefined ? '' : identifierMatchKey(value);
      if (value !== undefined && key !== '') identifiers.push({ kind, key, field: field.path, value });
    }
    if (spec.references.some((path) => pathMatches(path, field.path))) {
      const value = printed(field.value);
      const key = value === undefined ? '' : identifierMatchKey(value);
      if (value !== undefined && key !== '') references.push({ key, field: field.path, value });
    }
    if (spec.payerNames.some((path) => pathMatches(path, field.path))) {
      const value = printed(field.value);
      const key = value === undefined ? '' : retailerMatchKey(value);
      if (key !== '') payers.push({ key, field: field.path });
    }
    if (spec.amounts.some((path) => pathMatches(path, field.path))) {
      const cents = centsOf(field.value);
      if (cents !== undefined) amounts.push({ cents, field: field.path });
    }
  }

  const exact: { caseId: string; basis: DocumentMatchBasis[] }[] = [];
  const probable: { caseId: string; basis: DocumentMatchBasis[] }[] = [];
  const seen = new Set<string>();

  for (const candidate of input.cases) {
    if (isClosed(candidate.state)) continue;
    // One row per case, whatever the reader handed over twice.
    if (seen.has(candidate.caseId)) continue;
    seen.add(candidate.caseId);

    const carried = new Map<DocumentMatchKind, Set<string>>();
    const carry = (kind: DocumentMatchKind, value: string): void => {
      const key = identifierMatchKey(value);
      if (key === '') return;
      const keys = carried.get(kind) ?? new Set<string>();
      keys.add(key);
      carried.set(kind, keys);
    };
    if (candidate.claimId !== undefined) carry('claim_id', candidate.claimId);
    for (const known of candidate.identifiers) {
      const kind = caseKind(known.kind);
      if (kind !== undefined) carry(kind, known.value);
    }

    const exactBasis: DocumentMatchBasis[] = [];
    const noted = new Set<string>();
    for (const named of identifiers) {
      if (carried.get(named.kind)?.has(named.key) !== true) continue;
      const once = `${named.kind}\u0000${named.key}`;
      if (noted.has(once)) continue;
      noted.add(once);
      exactBasis.push({ kind: named.kind, field: named.field, value: named.value });
    }
    if (exactBasis.length > 0) {
      exact.push({ caseId: candidate.caseId, basis: exactBasis });
      continue;
    }

    const basis: DocumentMatchBasis[] = [];
    const reference = references.find((named) =>
      [...carried.values()].some((keys) => keys.has(named.key)),
    );
    if (reference !== undefined) {
      basis.push({ kind: 'reference', field: reference.field, value: reference.value });
    }

    const caseNames = new Set(
      [...(candidate.debtorNames ?? []), candidate.retailerNameAsPrinted ?? '']
        .map(retailerMatchKey)
        .filter((key) => key !== ''),
    );
    const payer = payers.find((named) => caseNames.has(named.key));
    const amount = amounts.find((named) => named.cents === candidate.amountCents);
    if (payer !== undefined && amount !== undefined) {
      basis.push({ kind: 'payer', field: payer.field }, { kind: 'amount_cents', field: amount.field });
    }
    if (basis.length > 0) probable.push({ caseId: candidate.caseId, basis });
  }

  const ranked = (rows: { caseId: string; basis: DocumentMatchBasis[] }[]) =>
    [...rows].sort(
      (a, b) => b.basis.length - a.basis.length || (a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0),
    );
  const exactStrength: DocumentMatchStrength = exact.length === 1 ? 'exact' : 'ambiguous';
  return [
    ...ranked(exact).map((row) => ({ ...row, strength: exactStrength })),
    ...ranked(probable).map((row) => ({ ...row, strength: 'probable' as const })),
  ];
}

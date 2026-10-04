import {
  basisKinds,
  retailerMatchKey,
  type DocumentMatchBasis,
  type DocumentMatchBasisKind,
} from '@recouple/core-domain';
import type { UnattachedDocument } from '@recouple/pipeline';
import type { CaseSummary, SuggestedCase, UnattachedSuggestions } from '@recouple/store-postgres';

/**
 * A document read and on no case, with the cases the store suggested for it.
 *
 * The suggestions ride on the document rather than beside it so the two lists
 * that already carry these documents to a view — the case list's and a case
 * page's — carry the suggestions too, with no second prop to keep in step.
 * Absent means none was asked for; empty means none was found.
 */
export type UnattachedDocumentWithSuggestions = UnattachedDocument & {
  readonly suggestions?: readonly SuggestedCase[];
};

/**
 * Puts each document's suggestions on it (`PostgresStore.suggestionsForUnattached`).
 *
 * The two reads are two transactions, so a document in one and not the other
 * is possible for a moment: a document the suggestions do not mention gets
 * none, and a suggestion for a document not listed is dropped.
 */
export function withSuggestions(
  documents: readonly UnattachedDocument[],
  suggestions: readonly UnattachedSuggestions[],
): readonly UnattachedDocumentWithSuggestions[] {
  const byDocument = new Map(suggestions.map((row) => [row.documentId, row.suggestions]));
  return documents.map((document) => ({
    ...document,
    suggestions: byDocument.get(document.documentId) ?? [],
  }));
}

/** How many suggested cases a row draws; the rest are counted and left to the picker. */
export const SUGGESTIONS_SHOWN = 3;

/** How a case is named in a suggestion: its claim, else its invoice, else when it was opened. */
export function suggestedCaseName(summary: CaseSummary): string {
  if (summary.claimId !== undefined) return summary.claimId;
  if (summary.invoiceNumber !== undefined) return `for invoice ${summary.invoiceNumber}`;
  return `opened ${summary.createdAt.slice(0, 10)}`;
}

const IDENTIFIER_WORDS: Readonly<Partial<Record<DocumentMatchBasisKind, string>>> = {
  claim_id: 'claim',
  invoice_number: 'invoice',
  po_number: 'purchase order',
  bol_number: 'shipment number',
};

/**
 * What agreed, in words: "invoice 44817", "purchase order PO-771 and shipment
 * number BOL-12", "the same payer and the same amount".
 *
 * The identifier is the document's own text, rendered as text like a filename
 * is. It is for the person deciding and goes nowhere else.
 */
export function basisWords(basis: readonly DocumentMatchBasis[]): string {
  const parts: string[] = [];
  for (const kind of basisKinds(basis)) {
    const first = basis.find((b) => b.kind === kind);
    const word = IDENTIFIER_WORDS[kind];
    if (word !== undefined) {
      parts.push(first?.value === undefined ? word : `${word} ${first.value.trim()}`);
    } else if (kind === 'reference') {
      parts.push(
        first?.value === undefined ? 'a reference it names' : `a reference it names, ${first.value.trim()}`,
      );
    } else if (kind === 'payer') {
      parts.push('the same payer');
    } else {
      parts.push('the same amount');
    }
  }
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * The words after the case's name in a suggestion line, ending with the
 * strength in brackets — which is said every time, because all three need the
 * same press and a person should know which they are confirming.
 */
export function suggestionReason(
  suggestion: Pick<SuggestedCase, 'strength' | 'basis'>,
  ambiguousAmong: number,
): string {
  const words = basisWords(suggestion.basis);
  if (suggestion.strength === 'exact') return `on ${words} (exact)`;
  if (suggestion.strength === 'ambiguous') {
    return `on ${words} — ${ambiguousAmong.toLocaleString('en-US')} open cases carry it (ambiguous)`;
  }
  return `on ${words} (probable)`;
}

/** The lead-in for each strength: only one case carrying an identifier "matches". */
export function suggestionLead(strength: SuggestedCase['strength']): string {
  if (strength === 'exact') return 'Matches case';
  if (strength === 'ambiguous') return 'May match case';
  return 'Possibly case';
}

/** The hidden `basis` field's value: the kinds, which the route recomputes rather than trusts. */
export function basisField(basis: readonly DocumentMatchBasis[]): string {
  return basisKinds(basis).join(',');
}

export interface PayerGroup<T> {
  /** `undefined` for the documents nothing was suggested for. */
  readonly heading: string | undefined;
  readonly documents: readonly T[];
}

/**
 * The documents grouped by the payer of each one's strongest suggested case,
 * payers in name order, then the documents whose suggested case names no
 * payer, then the ones with no suggestion ("Unmatched").
 *
 * A payer is the case's debtor, else the name printed on it, folded with
 * `retailerMatchKey` — so "KROGER CO." and a debtor called Kroger are one
 * heading, and "Walmart Stores" and Walmart are two until a person says
 * otherwise (ADR 0019). A grouping for reading, nothing more: it decides
 * nothing and is stored nowhere. Within a group the store's order is kept.
 *
 * `undefined` when no document has a suggestion: there is nothing to group by,
 * and the list is drawn as it always was.
 */
export function groupByPayer<T extends UnattachedDocumentWithSuggestions>(
  documents: readonly T[],
): readonly PayerGroup<T>[] | undefined {
  if (!documents.some((document) => (document.suggestions ?? []).length > 0)) return undefined;

  const named = new Map<string, { heading: string; documents: T[]; byDebtor: boolean }>();
  const unnamed: T[] = [];
  const unmatched: T[] = [];
  for (const document of documents) {
    const top = document.suggestions?.[0];
    if (top === undefined) {
      unmatched.push(document);
      continue;
    }
    const name = top.case.debtorName ?? top.case.retailerNameAsPrinted;
    const key = name === undefined ? '' : retailerMatchKey(name);
    if (name === undefined || key === '') {
      unnamed.push(document);
      continue;
    }
    const group = named.get(key);
    if (group === undefined) {
      named.set(key, { heading: name, documents: [document], byDebtor: top.case.debtorName !== undefined });
    } else {
      group.documents.push(document);
      // A person's name for the payer over a page's, whichever came first.
      if (!group.byDebtor && top.case.debtorName !== undefined) {
        group.heading = top.case.debtorName;
        group.byDebtor = true;
      }
    }
  }

  return [
    ...[...named.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, group]) => ({ heading: group.heading, documents: group.documents })),
    ...(unnamed.length > 0 ? [{ heading: 'Payer not named on the case', documents: unnamed }] : []),
    ...(unmatched.length > 0 ? [{ heading: undefined, documents: unmatched }] : []),
  ];
}

/** The two reads a page makes for these documents, as the store offers them. */
export interface UnattachedReads {
  unattachedDocuments(limit?: number): Promise<readonly UnattachedDocument[]>;
  suggestionsForUnattached(limit?: number): Promise<readonly UnattachedSuggestions[]>;
}

/**
 * The documents read and on no case, each with its suggested cases: the list
 * and then, only when it is not empty, the suggestions for the same limit — a
 * tenant with nothing waiting pays for one read, as before.
 */
export async function unattachedWithSuggestions(
  store: UnattachedReads,
  limit?: number,
): Promise<readonly UnattachedDocumentWithSuggestions[]> {
  const documents = await (limit === undefined
    ? store.unattachedDocuments()
    : store.unattachedDocuments(limit));
  if (documents.length === 0) return documents;
  const suggestions = await (limit === undefined
    ? store.suggestionsForUnattached()
    : store.suggestionsForUnattached(limit));
  return withSuggestions(documents, suggestions);
}

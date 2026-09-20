/**
 * Retailer names as they are printed on a document, and how one becomes a
 * debtor — when it becomes one at all (ADR 0019).
 *
 * The rule the whole file exists to hold: document text is untrusted
 * (invariant 4). It may *select* a debtor a human already created, through a
 * human-maintained alias. It may never create one, and it may never pick
 * between two.
 */

/**
 * Legal-form suffixes, stripped from the end of a name. This list is about
 * company naming in general, not about any retailer: whether "Walmart Stores"
 * is the same debtor as "Walmart" is a fact about a retailer, and it belongs in
 * an alias a human added, not here (CLAUDE.md: retailer rules are data).
 */
const LEGAL_SUFFIXES: ReadonlySet<string> = new Set([
  'inc',
  'incorporated',
  'corp',
  'corporation',
  'co',
  'company',
  'llc',
  'lc',
  'llp',
  'lp',
  'plc',
  'ltd',
  'limited',
  'gmbh',
  'ag',
  'nv',
  'bv',
  'sa',
  'srl',
  'pty',
  'pte',
]);

/**
 * Folds a retailer name to a key two spellings of the same name share.
 *
 * Case, accents, punctuation, whitespace and trailing legal-form suffixes only.
 * It knows no retailer, so `"WALMART STORES, INC."` folds to `walmart stores`,
 * which deliberately does *not* equal `walmart`.
 *
 * Used on both sides of the comparison in `openCase`: the extracted name, and a
 * debtor's `display_name`, `retailer_key` and aliases. Returns `''` for a name
 * with nothing left in it, which callers must treat as "no key", never as a
 * match (ADR 0019 §3).
 */
export function retailerMatchKey(name: string): string {
  const folded = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (folded === '') return '';

  let words = folded.split(' ');
  // Repeatedly, so "Acme Holdings Co., Ltd." loses both tails. Never strip the
  // last word standing: a debtor genuinely called "Co" keeps its name.
  while (words.length > 1) {
    const last = words[words.length - 1];
    if (last === undefined || !LEGAL_SUFFIXES.has(last)) break;
    words = words.slice(0, -1);
  }
  return words.join(' ');
}

/** One of the tenant's debtors, with every spelling it already answers to. */
export interface DebtorCandidate {
  readonly debtorId: string;
  /** `display_name`, `retailer_key` and every `debtor_aliases.alias`. */
  readonly names: readonly string[];
}

/**
 * Which debtor a printed retailer name refers to, or nothing.
 *
 * Nothing is the common answer and it is the safe one. Two debtors matching is
 * treated as no match: we do not choose between retailers, and a wrong merge of
 * two of them is far worse than two rows a human reconciles later by adding an
 * alias (ADR 0019 §2).
 *
 * The matching lives here, in `core-domain`, so the Postgres store and the
 * in-memory store answer the same question the same way. It is also why
 * normalisation is not written a second time in SQL: a tenant has tens of
 * debtors, so reading them to match is cheap, and one implementation cannot
 * drift from another that does not exist.
 */
export function resolveDebtorId(
  printedName: string,
  candidates: readonly DebtorCandidate[],
): string | undefined {
  const key = retailerMatchKey(printedName);
  if (key === '') return undefined;

  const matched = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.names.some((name) => retailerMatchKey(name) === key)) {
      matched.add(candidate.debtorId);
    }
  }
  if (matched.size !== 1) return undefined;
  const [only] = matched;
  return only;
}

import type { PostingConnectionView } from '@recouple/store-postgres';

/**
 * The accounts a saved map posts deductions to: held, and written off.
 *
 * One copy of the rule, for the two readers of it: the Books page's account
 * roles (ADR 0066 §2) and the daily sync's kept snapshot (ADR 0074), which
 * keeps postings on exactly the accounts the page reads by default. In a file
 * of its own so `ledger-sync.ts` can use it without importing the Books page's
 * module, which imports `ledger-sync.ts`.
 */
export function postingAccountIds(connection: PostingConnectionView): readonly string[] {
  const map = connection.map;
  if (map === undefined) return [];
  return [
    ...new Set([
      map.deductionsReceivableAccountId,
      map.unclassifiedWriteoff,
      ...Object.values(map.writeoffByFamily),
    ]),
  ];
}

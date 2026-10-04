/**
 * The inputs `suggestCasesForDocument` needs, gathered for the documents that
 * are read and on no case — and the rule left where it lives, in `core-domain`.
 *
 * Nothing here decides a match. The SQL narrows which cases are worth handing
 * to the rule (a case that carries one of the documents' identifiers under the
 * identity fold, or whose amount is one a document prints), and the rule then
 * answers over those rows exactly as it would over every case. Every query
 * runs on the caller's client: one tenant transaction as `app_rw`, RLS deciding
 * whose documents and whose cases these are, no `org_id` of its own.
 */

import type { PoolClient } from 'pg';
import {
  CASE_DOCUMENT_MATCH_FIELDS,
  CLOSED_STATES,
  DOCUMENT_MATCH_FIELDS,
  cents,
  documentMatchPathPattern,
  identifierMatchKey,
  parseMoneyToCents,
  suggestCasesForDocument,
  type CaseState,
  type DocumentCaseSuggestion,
  type DocumentMatchCase,
  type DocumentMatchField,
  type IdentifierKind,
  type DocumentMatchKind,
} from '@recouple/core-domain';

/** What one document was matched to: nothing, or its suggestions strongest first. */
export interface DocumentSuggestions {
  readonly documentId: string;
  readonly suggestions: readonly DocumentCaseSuggestion[];
}

/**
 * The most candidate cases one read hands the rule. Cases carrying one of the
 * documents' identifiers come first, so a cut here drops amount-only
 * candidates — which can only ever be `probable` — before it drops any case an
 * exact or ambiguous answer depends on.
 */
export const SUGGESTION_CANDIDATES_LIMIT = 1_000;

/**
 * The documents read and on no case, newest first: `unattachedDocuments`' own
 * two conditions and order, so a limit here cuts the list where that one does.
 * `unattached-suggestions.test.ts` holds the two reads to the same documents.
 */
export const UNATTACHED_DOCUMENT_IDS_SQL = `select d.id
   from documents d
  where exists (select 1 from extraction_results e where e.document_id = d.id)
    and not exists (select 1 from deduction_documents dd where dd.document_id = d.id)
  order by d.created_at desc, d.id desc
  limit $1`;

/**
 * `identifierMatchKey` in SQL, over a column named `value`. The store's
 * existing `FOLDED_IDENTIFIER` is the same expression over `i.identifier`.
 * Used only to narrow candidates; the rule folds again in TypeScript.
 */
const FOLDED_VALUE = "lower(regexp_replace(btrim(x.value), '\\s+', ' ', 'g'))";

interface DocumentFieldRow {
  id: string;
  doc_type: string;
  field_path: string | null;
  value_json: unknown;
}

interface CandidateRow {
  id: string;
  state: CaseState;
  amount: string;
  claim_id: string | null;
  debtor_id: string | null;
  retailer_name_as_printed: string | null;
  display_name: string | null;
  retailer_key: string | null;
  aliases: string[];
  identifiers: { kind: IdentifierKind | DocumentMatchKind; value: string }[];
}

/**
 * Suggestions for the given documents, in the order given.
 *
 * Three steps, one transaction:
 *
 * 1. each document's latest classification and the stored fields a suggestion
 *    can be read from (`documentMatchPathPattern`), the newest row per path;
 * 2. the open cases worth considering — one that carries any of those
 *    identifiers, or whose amount is one a document prints. A case's names are
 *    its `deduction_identifiers` **mapped through `deduction_merges_current`**
 *    (ADR 0042: a merged-away case's names are its survivor's), its own
 *    `claim_id`, and the purchase order and shipment numbers on the documents
 *    linked to it or to a case merged into it;
 * 3. `suggestCasesForDocument`, per document, over those cases.
 */
export async function suggestionsForDocuments(
  client: PoolClient,
  documentIds: readonly string[],
): Promise<readonly DocumentSuggestions[]> {
  if (documentIds.length === 0) return [];

  const { rows: fieldRows } = await client.query<DocumentFieldRow>(
    `with docs as (
       select d.id from documents d where d.id = any($1::uuid[])
     ), typed as (
       select docs.id, c.doc_type
         from docs
         join lateral (
           select doc_type from document_classifications dc
            where dc.document_id = docs.id order by dc.id desc limit 1
         ) c on true
     ), latest as (
       select distinct on (e.document_id, e.field_path)
              e.document_id, e.field_path, e.value_json
         from extraction_results e
        where e.document_id in (select id from typed)
          and e.field_path ~ $2
        order by e.document_id, e.field_path, e.id desc
     )
     select t.id, t.doc_type, l.field_path, l.value_json
       from typed t left join latest l on l.document_id = t.id`,
    [documentIds, documentMatchPathPattern()],
  );

  const documents = new Map<string, { docType: string; fields: DocumentMatchField[] }>();
  for (const row of fieldRows) {
    let document = documents.get(row.id);
    if (document === undefined) {
      document = { docType: row.doc_type, fields: [] };
      documents.set(row.id, document);
    }
    if (row.field_path !== null) document.fields.push({ path: row.field_path, value: row.value_json });
  }

  // What to narrow the cases by: every string the documents print in a field
  // the rule reads, folded, and every amount readable to the cent. A superset
  // of what any one document can match on — the rule sorts out which.
  const keys = new Set<string>();
  const amounts = new Set<number>();
  for (const { docType, fields } of documents.values()) {
    if (DOCUMENT_MATCH_FIELDS[docType] === undefined) continue;
    for (const field of fields) {
      if (typeof field.value !== 'string') continue;
      const key = identifierMatchKey(field.value);
      if (key !== '') keys.add(key);
      try {
        amounts.add(parseMoneyToCents(field.value));
      } catch {
        // Not an amount: most of these fields are identifiers and names.
      }
    }
  }

  const candidates: DocumentMatchCase[] = [];
  if (keys.size > 0 || amounts.size > 0) {
    const params: unknown[] = [
      [...keys],
      [...CLOSED_STATES],
      [...amounts],
      SUGGESTION_CANDIDATES_LIMIT,
    ];
    const param = (value: unknown): string => `$${params.push(value)}`;
    // Our own constants, bound rather than written into the statement.
    const linked = CASE_DOCUMENT_MATCH_FIELDS.map((field) => {
      const typed =
        field.docTypes === undefined
          ? ''
          : ` and (select dc.doc_type from document_classifications dc
                    where dc.document_id = dd.document_id
                    order by dc.id desc limit 1) = any(${param([...field.docTypes])}::text[])`;
      return `select coalesce(m.surviving_deduction_id, dd.deduction_id) as case_id,
                     ${param(field.kind)}::text as kind,
                     e.value_json #>> '{}' as value
                from deduction_documents dd
                left join deduction_merges_current m on m.merged_deduction_id = dd.deduction_id
                join extraction_results e on e.document_id = dd.document_id
               where e.field_path = ${param(field.path)}::text
                 and jsonb_typeof(e.value_json) = 'string'${typed}`;
    });
    const { rows } = await client.query<CandidateRow>(
      `with names as (
         -- Every reader of deduction_identifiers maps a merged-away case onto
         -- its survivor (ADR 0042).
         select coalesce(m.surviving_deduction_id, i.deduction_id) as case_id,
                i.identifier_kind as kind, i.identifier as value
           from deduction_identifiers i
           left join deduction_merges_current m on m.merged_deduction_id = i.deduction_id
         union
         select coalesce(m.surviving_deduction_id, d.id), 'claim_id', d.claim_id
           from deductions d
           left join deduction_merges_current m on m.merged_deduction_id = d.id
          where d.claim_id is not null
         union
         ${linked.join('\n         union\n         ')}
       ), carried as (
         select x.case_id, x.kind, x.value from names x where ${FOLDED_VALUE} = any($1::text[])
       )
       select d.id, d.state, d.deduction_amount_cents::text as amount, d.claim_id,
              d.debtor_id, d.retailer_name_as_printed, b.display_name, b.retailer_key,
              coalesce((select array_agg(a.alias order by a.alias) from debtor_aliases a
                         where a.debtor_id = d.debtor_id), '{}') as aliases,
              coalesce((select jsonb_agg(jsonb_build_object('kind', c.kind, 'value', c.value))
                          from carried c where c.case_id = d.id), '[]'::jsonb) as identifiers
         from deductions d
         left join debtors b on b.id = d.debtor_id
        where d.state <> all ($2::text[])
          and (exists (select 1 from carried c where c.case_id = d.id)
               or d.deduction_amount_cents = any($3::bigint[]))
        order by exists (select 1 from carried c where c.case_id = d.id) desc,
                 d.created_at desc, d.id
        limit $4`,
      params,
    );
    for (const row of rows) {
      candidates.push({
        caseId: row.id,
        state: row.state,
        amountCents: cents(Number(row.amount)),
        ...(row.claim_id !== null ? { claimId: row.claim_id } : {}),
        ...(row.debtor_id !== null ? { debtorId: row.debtor_id } : {}),
        debtorNames: [row.display_name, row.retailer_key, ...row.aliases].filter(
          (name): name is string => name !== null,
        ),
        ...(row.retailer_name_as_printed !== null
          ? { retailerNameAsPrinted: row.retailer_name_as_printed }
          : {}),
        identifiers: row.identifiers,
      });
    }
  }

  return documentIds.map((documentId) => {
    const document = documents.get(documentId);
    return {
      documentId,
      suggestions:
        document === undefined
          ? []
          : suggestCasesForDocument({
              documentType: document.docType,
              documentFields: document.fields,
              cases: candidates,
            }),
    };
  });
}

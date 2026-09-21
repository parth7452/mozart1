/**
 * A document read back out of the store, rebuilt the way the reader's was.
 *
 * `extraction_results` is one row per field, and deliberately holds no row for
 * a field whose value is null: absence is recorded by absence, not by a row
 * with no provenance (`flatten.ts`). The other half of that bargain is here —
 * whoever rebuilds the document has to *put the absence back*, as the explicit
 * `{ value: null, … }` an optional field has everywhere else.
 *
 * A rebuild that creates a key per row instead produces a different object from
 * the one the reader had: a line with no SKU comes back with no `sku_upc` key
 * at all, and any code that reads a field object directly throws on it. That
 * is not hypothetical — it is what took a review page down in production on
 * 2026-09-21 (case eef4fec8-940c-4f80-8313-4a754661d700), on a staffing notice
 * whose one line named no item.
 *
 * So the rows go back through `reassemble`, the same function the reader's own
 * output goes through: absent fields are filled with `absentField()`, unknown
 * paths are dropped with an issue rather than passed on, and the result is
 * *validated* against the document type's schema rather than cast to it. What
 * a store returns is then the same object, field for field, as what the model's
 * read produced — which is the only way a test against the in-memory store says
 * anything about production.
 */

import type { DocType, ExtractedField } from './ports';
import { describeFields, type FieldDescriptor } from './paths';
import { schemaFor } from './schemas';
import { reassemble, type Reassembly, type ReassemblyIssue, type WireField } from './wire';

/**
 * One stored field row: exactly what `recordExtraction` was given, which is
 * exactly what a store writes. `sourceBbox` and `quoteVerified` are not part of
 * the typed document (ADR 0008) and play no part in rebuilding it.
 */
export type StoredExtractionField = Pick<
  ExtractedField,
  'fieldPath' | 'value' | 'confidence' | 'sourcePage' | 'sourceQuote'
>;

/**
 * The stored value as the text the wire format carries.
 *
 * The round trip is deterministic in both directions: `reassemble` coerces by
 * the schema's own type, so a quantity stored as 30 comes back as the number
 * 30, a flag stored as true comes back as true, and money — which is text on
 * the page and text in the database — is never touched by either leg.
 */
function asWireText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/**
 * The field list for a document type, worked out once.
 *
 * `describeFields` compiles the schema to JSON Schema to derive it, and this
 * runs on a request path — a review page rebuilds every document on the case on
 * every view. The schemas are module constants, so the answer cannot change
 * within a process.
 */
const descriptorCache = new Map<DocType, readonly FieldDescriptor[]>();

function descriptorsFor(docType: DocType, schema: Parameters<typeof describeFields>[0]) {
  const cached = descriptorCache.get(docType);
  if (cached !== undefined) return cached;
  const descriptors = describeFields(schema);
  descriptorCache.set(docType, descriptors);
  return descriptors;
}

/**
 * Rebuilds and validates a stored document from its field rows.
 *
 * Returns the same `Reassembly` the reader's path returns, so a caller has the
 * same three facts: the document, whether it satisfied its schema, and what was
 * wrong with it if it did not. Nothing is thrown — a document that no longer
 * validates is still evidence a reviewer may look at; it is simply not
 * something downstream may treat as typed.
 *
 * The one value the wire format cannot carry is the empty string, and
 * `reassemble` reads it as "not present" — the same answer it gives the reader,
 * which is why the two legs agree rather than only nearly agreeing.
 */
export function restoreDocument(
  docType: DocType,
  rows: readonly StoredExtractionField[],
): Reassembly {
  const schema = schemaFor(docType);
  const issues: ReassemblyIssue[] = [];
  const wire: WireField[] = [];

  for (const row of rows) {
    const text = asWireText(row.value);
    if (text === undefined) {
      // A stored value of a shape the wire format cannot carry (null, an
      // object) is reported rather than guessed at. A null never gets a row in
      // the first place, so this is a row nothing here wrote.
      issues.push({
        path: row.fieldPath,
        problem: `stored value of type ${row.value === null ? 'null' : typeof row.value} cannot be read back as a field`,
      });
      continue;
    }
    wire.push({
      path: row.fieldPath,
      value: text,
      confidence: row.confidence,
      source_page: row.sourcePage,
      source_quote: row.sourceQuote,
    });
  }

  // Only paths the document type declares are written: `reassemble` looks each
  // one up in the schema's own descriptor list and drops what is not there with
  // an issue. That is also what keeps a row whose `field_path` says
  // `__proto__` from being walked as an object key — it is not a field of any
  // document type, so it never reaches the object at all.
  const rebuilt = reassemble(wire, descriptorsFor(docType, schema), schema);
  return { ...rebuilt, issues: [...issues, ...rebuilt.issues] };
}

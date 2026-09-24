/**
 * A validation path as a field path: `lines.0.deduction_amount.value` is the
 * field `lines[0].deduction_amount`.
 *
 * One function, because the same field is named at the write (the
 * `document.stored_without_provenance` event, a `document.held` audit row) and
 * at the read (a reconciliation finding, the hold line on the case list), and a
 * reviewer comparing the two should not have to work out that they mean the
 * same thing.
 *
 * Internal to the package on purpose — it is not re-exported from the index.
 * It formats paths; which paths are fit to be said anywhere is its callers'
 * decision (`typeFits` keeps only fields the document type declares).
 */
export function fieldPathOf(segments: readonly string[]): string {
  const withoutLeaf = segments.at(-1) === 'value' ? segments.slice(0, -1) : [...segments];
  return withoutLeaf.reduce(
    (path, segment) =>
      path === '' ? segment : /^\d+$/.test(segment) ? `${path}[${segment}]` : `${path}.${segment}`,
    '',
  );
}

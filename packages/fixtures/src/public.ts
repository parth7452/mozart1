/**
 * Real documents from public records (`packages/fixtures/public/`).
 *
 * Every other suite is synthetic: written here, written elsewhere for us, or
 * rendered from one of those. These are not. They come from ExtractBench
 * (run-llama/ExtractBench, Apache 2.0), a benchmark built from public records —
 * county and state purchase orders, municipal invoices, a state Medicaid
 * program's sample remittance advices, public rate schedules — each with an
 * answer its authors verified. Nobody wrote them for this pipeline, and no
 * layout here was chosen by us.
 *
 * The ground truth is theirs, mapped onto our field paths by
 * `scripts/import-extractbench.py` under rules fixed before anything was
 * recorded. It covers only the fields where their answer and ours are the same
 * question, so a document scores on fewer fields than we extract, and the
 * README says which fields and why.
 *
 * Two suites, because they need different keys to record:
 *   `public`          — pages with a clean text layer of their own.
 *   `public_scanned`  — scans, and ExtractBench's degraded captures of the same
 *                       documents: read through OCR, as production reads every
 *                       upload, so recording them needs `REDUCTO_API_KEY`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { FixtureDocument, TruthExpectation } from './cases';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export type PublicSuite = 'public' | 'public_scanned';

interface PublicPageEntry {
  readonly filename: string;
  readonly docType: string;
  readonly suite: PublicSuite;
  readonly pageText: readonly string[];
  readonly source: {
    readonly dataset: string;
    readonly revision: string;
    readonly id: string;
    readonly pdf: string;
    readonly pagesKept?: readonly number[];
    readonly tags: readonly string[];
  };
}

interface PublicTruthEntry {
  readonly truth: Readonly<Record<string, TruthExpectation>>;
  /** Fields their answer covers that the import left out, with the reason. */
  readonly skipped: readonly string[];
}

export interface PublicFixtureDocument extends FixtureDocument {
  readonly suite: PublicSuite;
  /** Where in ExtractBench the document and its answer came from. */
  readonly source: PublicPageEntry['source'];
  readonly skippedTruth: readonly string[];
}

let cache: readonly PublicFixtureDocument[] | undefined;

/** Both suites, in the order the import wrote them. */
export function publicDocuments(): readonly PublicFixtureDocument[] {
  if (cache !== undefined) return cache;
  const pages = JSON.parse(readFileSync(path.join(publicDir, 'pages.json'), 'utf8')) as Record<
    string,
    PublicPageEntry
  >;
  const truth = JSON.parse(readFileSync(path.join(publicDir, 'truth.json'), 'utf8')) as Record<
    string,
    PublicTruthEntry
  >;
  cache = Object.entries(pages).map(([key, entry]) => {
    const answer = truth[key];
    if (answer === undefined) throw new Error(`public fixture ${key} has no truth entry`);
    return {
      key,
      filename: entry.filename,
      mimeType: 'application/pdf' as const,
      docType: entry.docType,
      pageText: entry.pageText,
      bytes: new Uint8Array(readFileSync(path.join(publicDir, entry.filename))),
      truth: answer.truth,
      suite: entry.suite,
      source: entry.source,
      skippedTruth: answer.skipped,
    };
  });
  return cache;
}

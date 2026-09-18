/**
 * Simulated scans: the same documents, rasterised.
 *
 * Every other measurement in this repo is on a PDF with an intact text layer,
 * which is the easiest input the product will ever see. These are the same
 * documents rendered to an image and degraded — rotated a couple of degrees,
 * greyscaled, speckled, blurred and JPEG-compressed — so the model has to read
 * pixels and quote verification has nothing to check against.
 *
 * Two honest caveats. They are *simulated*: harder than clean text, and
 * strictly easier than a fax of a photocopy of a dot-matrix print. And they
 * share ground truth with their source document, which is the point — holding
 * content constant is what makes the difference in score attributable to the
 * rasterisation and nothing else.
 *
 * Regenerate with `pnpm render:scans`.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { authoredDocuments, type FixtureDocument } from './cases';
import { corpusDocuments } from './corpus';

const scanDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scans');

/** Source document key → how badly its scan was degraded, for the report. */
export const SCAN_TARGETS: Readonly<Record<string, string>> = {
  'walmart-apdp-notice': 'rotated −1.4°, JPEG quality 68',
  'carrier-bol': 'rotated 2.1°, JPEG quality 55, heavier speckle',
  'hl-case-01-notice': 'rotated −2.3°, JPEG quality 60',
  'hl-case-06-notice': 'rotated 1.7°, JPEG quality 50, heaviest degradation',
};

let cache: readonly FixtureDocument[] | undefined;

/**
 * A scanned twin carries its source's ground truth and no page text: a scan has
 * no text layer, so `quoteVerified` comes back null rather than false. That is
 * the honest answer — unverifiable is not the same as wrong — and it is why the
 * grounding rate is reported as "—" for this suite instead of as a failure.
 */
export function scannedDocuments(): readonly FixtureDocument[] {
  if (cache !== undefined) return cache;
  const sources = new Map(
    [...authoredDocuments(), ...corpusDocuments()].map((d) => [d.key, d] as const),
  );

  cache = Object.keys(SCAN_TARGETS).flatMap((sourceKey) => {
    const file = path.join(scanDir, `${sourceKey}-scan.jpg`);
    const source = sources.get(sourceKey);
    if (source === undefined || !existsSync(file)) return [];
    return [
      {
        key: `${sourceKey}-scan`,
        filename: `${sourceKey}-scan.jpg`,
        mimeType: 'image/jpeg' as unknown as 'application/pdf',
        docType: source.docType,
        pageText: [],
        bytes: new Uint8Array(readFileSync(file)),
        truth: source.truth,
        suite: 'scanned' as const,
      } as FixtureDocument,
    ];
  });
  return cache;
}

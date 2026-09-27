/** LOG-001's demo walk, shared by `log-001.test.ts` and `log-001-letter.test.ts`. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CassetteClassifier, CassetteExtractor, type Cassette } from '@recouple/extraction';
import {
  logisticsDocuments,
  scannedDocuments,
  type FixtureDocument,
} from '@recouple/fixtures';
import { processUpload, reconcileCase } from '../src/steps';
import type { PipelineDeps } from '../src/ports';
import { AlwaysCleanScanner, InMemoryStore } from '../src/testing/memory-store';

const cassetteDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'cassettes',
);

function cassette(key: string): Cassette {
  return JSON.parse(readFileSync(path.join(cassetteDir, `${key}.json`), 'utf8')) as Cassette;
}

function fixture(key: string): FixtureDocument {
  const found = [...logisticsDocuments(), ...scannedDocuments()].find((d) => d.key === key);
  if (found === undefined) throw new Error(`no fixture ${key}`);
  return found;
}

const ORG = 'org-1';

/** The five documents, in the order the demo uploads them. */
const SEQUENCE = [
  'log-001-short-pay-remittance',
  'log-001-carrier-invoice',
  'log-001-rate-confirmation',
  'log-001-appointment-change',
  'log-001-proof-of-delivery',
] as const;

/**
 * Deps that answer each upload from its own cassette, keyed by the filename the
 * reviewer uploaded. `readings` swaps a document's recording for another — the
 * scanned 04 is a second, independent reading of the same page.
 */
function harness(readings: Readonly<Record<string, string>> = {}) {
  const store = new InMemoryStore();
  const byFilename = new Map<string, Cassette>();
  const documents = SEQUENCE.map((key) => {
    const recordedAs = readings[key] ?? key;
    const document = fixture(recordedAs);
    const recorded = cassette(recordedAs);
    byFilename.set(document.filename, recorded);
    return {
      document,
      // A scan has no text layer of its own; the page text is the one OCR
      // produced when it was recorded, which is what its quotes were read from.
      pageText: recorded.ocr?.pages.map((page) => page.text) ?? document.pageText,
    };
  });
  const key = (payload: { readonly filename: string }) => payload.filename;
  const deps: PipelineDeps = {
    store,
    scanner: new AlwaysCleanScanner(),
    classifier: new CassetteClassifier(byFilename, key),
    extractor: new CassetteExtractor(byFilename, key),
    now: () => new Date('2026-09-23T12:00:00Z'),
  };
  return { store, deps, documents };
}

export async function walkTheDemo(readings: Readonly<Record<string, string>> = {}) {
  const { store, deps, documents } = harness(readings);
  const [remittance, ...evidence] = documents;
  if (remittance === undefined) throw new Error('no remittance');

  // §1: upload 01 from the case list. No case named; the document opens one.
  const first = await processUpload(
    {
      orgId: ORG,
      filename: remittance.document.filename,
      bytes: remittance.document.bytes,
      source: 'web_upload',
      pageText: remittance.pageText,
    },
    deps,
  );

  // §2: the other four, each attached from the case page.
  const deductionId = first.remittance?.opened[0]?.deductionId;
  if (deductionId === undefined) throw new Error('the remittance opened no case');
  for (const { document, pageText } of evidence) {
    await processUpload(
      { orgId: ORG, filename: document.filename, bytes: document.bytes, source: 'web_upload', pageText },
      deps,
      { attachToCase: deductionId },
    );
  }

  // §3: reload the case.
  const reconciliation = await reconcileCase(deductionId, deps);
  return { store, first, deductionId, reconciliation };
}


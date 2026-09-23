/**
 * LOG-001, end to end, the way `docs/DEMO.md` walks it.
 *
 * The demo uploads the short-pay remittance from the case list, attaches the
 * other four documents from the case page, and points at "What the documents say
 * together". Every step of that has its own test somewhere; none of them was
 * the demo, and the demo did not work: the remittance opened its case through
 * `openCasesFromRemittance` (ADR 0028), `reconcileCase` looked for a
 * `deduction_notice`, found none, and the page rendered no findings at all
 * (ADR 0040).
 *
 * So this replays the *recorded* readings — the cassettes `pnpm eval` scores,
 * classification included — through the real `processUpload`, the in-memory
 * store (which rebuilds every document from its stored fields exactly as
 * Postgres does), and the real `reconcileCase`. A stand-in reader that returned
 * a tidy document would have passed on the day the demo failed: the recorded
 * reading of 04 puts the waiver in a commitment of its own, with nothing it
 * supersedes, and that is the shape that made `charge_waived_in_writing`
 * unreachable.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CassetteClassifier, CassetteExtractor, type Cassette } from '@recouple/extraction';
import {
  LOG_001_DEDUCTION_CENTS,
  LOG_001_EXPECTED_FINDINGS,
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

async function walkTheDemo(readings: Readonly<Record<string, string>> = {}) {
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

describe('LOG-001, walked the way the demo walks it', () => {
  it('opens one case from the remittance, for the $600 it withheld', async () => {
    const { first, store } = await walkTheDemo();

    // A remittance, as recorded, and so not a notice: the case is the remittance
    // line's, and it arrives under `remittance` rather than `case`.
    expect(first.classification?.docType).toBe('remittance_advice');
    expect(first.case).toBeUndefined();
    expect(first.remittance?.opened).toHaveLength(1);

    const opened = first.remittance?.opened[0];
    expect(opened?.deductionAmountCents).toBe(LOG_001_DEDUCTION_CENTS);
    expect(opened?.claimId).toBe('ACH-91844:INV-AFS-260814');
    expect(opened?.reasonCodeAsPrinted).toBe('LATE-DEL');
    expect(store.cases.size).toBe(1);
  });

  it('files all four supporting documents on that case, as what they are', async () => {
    const { store, deductionId } = await walkTheDemo();
    const onCase = await store.documentsForCase(deductionId);
    const types = await Promise.all(
      onCase.map(async (d) => (await store.latestExtraction(d.documentId))?.docType),
    );
    expect(types).toEqual([
      'remittance_advice',
      'invoice',
      'price_agreement',
      'correspondence',
      'pod',
    ]);
  });

  it('says together what no one document says', async () => {
    const { reconciliation } = await walkTheDemo();
    const codes = reconciliation?.findings.map((f) => f.code) ?? [];

    for (const expected of LOG_001_EXPECTED_FINDINGS) expect(codes).toContain(expected);
  });

  it('reconciles the line that opened the case, and finds its arithmetic sound', async () => {
    const { reconciliation } = await walkTheDemo();

    // $4,800.00 gross less $4,200.00 paid is the $600.00 the line says it took.
    expect(reconciliation?.lines).toEqual([
      {
        sku: 'INV-AFS-260814',
        reasonCode: 'LATE-DEL',
        claimedCents: LOG_001_DEDUCTION_CENTS,
        expectedShortageCents: LOG_001_DEDUCTION_CENTS,
        deltaCents: 0,
        verdict: 'matches',
      },
    ]);
    expect(reconciliation?.claimedTotalCents).toBe(LOG_001_DEDUCTION_CENTS);
    // Nothing on the case contradicts itself, and nothing blocks.
    expect(reconciliation?.findings.filter((f) => f.severity === 'blocking')).toEqual([]);
    expect(reconciliation?.internallyConsistent).toBe(true);
  });

  it('quotes the customer’s own sentence for the waiver', async () => {
    const { reconciliation } = await walkTheDemo();
    const waiver = reconciliation?.findings.find((f) => f.code === 'charge_waived_in_writing');
    expect(waiver?.severity).toBe('supports_dispute');
    expect(waiver?.message).toContain(
      '“No carrier late-delivery charge applies for moving delivery to this revised appointment.”',
    );
    expect(waiver?.message).toMatch(/^Brookfield Supply Co\. stated in writing/);
  });

  it('measures the 18 minutes against the appointment in force', async () => {
    const { reconciliation } = await walkTheDemo();
    const early = reconciliation?.findings.find((f) => f.code === 'arrived_before_appointment');
    expect(early?.message).toBe(
      'gate check-in was 18 minutes before the confirmed appointment ' +
        '(August 13, 2026, 1:42 PM Eastern against August 13, 2026, 2:00 PM Eastern)',
    );
  });

  it('reaches the same three findings from the scanned reading of 04', async () => {
    // A second recording of the same page, through OCR. It reads the first
    // commitment differently and the waiver the same way: in its own
    // commitment, superseding nothing.
    const { reconciliation } = await walkTheDemo({
      'log-001-appointment-change': 'log-001-appointment-change-scan',
    });
    const codes = reconciliation?.findings.map((f) => f.code) ?? [];
    for (const expected of LOG_001_EXPECTED_FINDINGS) expect(codes).toContain(expected);
  });
});

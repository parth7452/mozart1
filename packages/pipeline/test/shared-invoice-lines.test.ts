/**
 * Two lines on one invoice are two deductions (ADR 0048).
 *
 * LOG-202's remittance advice prints invoice CF-260902 once, gross $5,600 and
 * paid $4,800, and then two deductions against it: "CB-202-A / LATE: $500.00"
 * and "CB-202-B / SHORT: $300.00". The recorded cassette reads that as one
 * $800 line. A reader that splits it into the two lines the page prints — each
 * repeating the invoice, the gross and the net — used to open the $500 case
 * and record the $300 as `mergedInto` it: the second line built the same
 * `payment_reference:invoice_number` claim id as the first and resolved as an
 * exact match. The $300 then appeared nowhere.
 *
 * Everything here goes through the real `processUpload` and `reconcileCase`
 * against the in-memory store, with the reader scripted to say exactly that.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildExtractionResult,
  type Cassette,
  type ClassificationResult,
  type Classifier,
  type DocType,
  type DocumentPayload,
  type ExtractionResult,
  type Extractor,
} from '@recouple/extraction';
import { everyDocument, type FixtureDocument } from '@recouple/fixtures';
import type { PipelineDeps } from '../src/ports';
import { processUpload, reconcileCase, type IngestInput } from '../src/steps';
import { AlwaysCleanScanner, InMemoryStore } from '../src/testing/memory-store';

const ORG = 'org-1';
const USER = 'user-7';

const cassetteDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'cassettes',
);

const ADVICE: FixtureDocument = (() => {
  const found = everyDocument().find((d) => d.key === 'log-202-remittance-advice');
  if (found === undefined) throw new Error('no fixture log-202-remittance-advice');
  return found;
})();

/** The recorded reading of LOG-202's advice: one $800 line. */
const RECORDED = (
  JSON.parse(
    readFileSync(path.join(cassetteDir, 'log-202-remittance-advice.json'), 'utf8'),
  ) as Cassette
).document as Record<string, unknown>;

type Line = Record<string, unknown>;

function quoted(value: string, quote: string): unknown {
  return { value, confidence: 0.95, source_page: 1, source_quote: quote };
}

const INVOICE_ROW = 'CF-260902 | Gross $5,600.00 | Paid $4,800.00';

/** One line of the advice as the page lays it out: the invoice's figures, then this deduction. */
function deductionLine(amount: string | null, reason: string, quote: string): Line {
  return {
    invoice_number: quoted('CF-260902', INVOICE_ROW),
    gross_amount: quoted('$5,600.00', INVOICE_ROW),
    net_amount: quoted('$4,800.00', INVOICE_ROW),
    ...(amount !== null ? { deduction_amount: quoted(amount, quote) } : {}),
    reason_code: quoted(reason, quote),
  };
}

const LATE = 'CB-202-A / LATE: $500.00. Original appointment missed.';
const SHORT = 'CB-202-B / SHORT: $300.00. Two cartons short.';

/** LOG-202's advice read as the two lines it prints; `null` prints no deduction on that line. */
function twoLines(
  late: string | null = '$500.00',
  short: string | null = '$300.00',
): Record<string, unknown> {
  return {
    ...RECORDED,
    lines: [deductionLine(late, 'CB-202-A', LATE), deductionLine(short, 'CB-202-B', SHORT)],
  };
}

class Scripted implements Classifier, Extractor {
  readonly name = 'scripted';
  constructor(private readonly reading: () => unknown) {}
  async classify(document: DocumentPayload): Promise<ClassificationResult> {
    return {
      docType: 'remittance_advice',
      confidence: 0.97,
      call: {
        purpose: 'classify',
        provider: 'anthropic',
        modelVersion: 'scripted',
        documentId: document.documentId,
        costMicros: 1_300,
        latencyMs: 1,
        outcome: 'ok',
      },
    };
  }
  async extract(document: DocumentPayload, docType: DocType): Promise<ExtractionResult> {
    return buildExtractionResult({
      docType,
      extractor: this.name,
      document: this.reading(),
      pageText: document.pageText,
      call: {
        purpose: 'extract',
        provider: 'anthropic',
        modelVersion: 'scripted',
        documentId: document.documentId,
        costMicros: 12_700,
        latencyMs: 1,
        outcome: 'ok',
      },
    });
  }
}

function harness(reading: () => unknown = () => twoLines()) {
  const store = new InMemoryStore();
  store.addMember(ORG, USER, 'analyst');
  const scripted = new Scripted(reading);
  const deps: PipelineDeps = {
    store,
    scanner: new AlwaysCleanScanner(),
    classifier: scripted,
    extractor: scripted,
    now: () => new Date('2026-09-24T12:00:00Z'),
  };
  return { store, deps };
}

/** The advice, uploaded; `salt` makes a second copy a different document. */
function upload(salt = 0): IngestInput {
  const bytes =
    salt === 0 ? ADVICE.bytes : new Uint8Array([...ADVICE.bytes, 0x0a, ...Array(salt).fill(0x20)]);
  return {
    orgId: ORG,
    filename: ADVICE.filename,
    bytes,
    source: ADVICE.mimeType === 'text/plain' ? 'email_body' : 'web_upload',
    uploadedBy: USER,
    pageText: ADVICE.pageText,
  };
}

const total = (cents: readonly (number | undefined)[]): number =>
  cents.reduce<number>((sum, c) => sum + (c ?? 0), 0);

describe('LOG-202 read as the two lines it prints', () => {
  it('opens a case for each deduction, $800 between them, and merges neither into the other', async () => {
    const { store, deps } = harness();

    const result = await processUpload(upload(), deps);

    const read = result.remittance;
    // The silent merge this ADR is about: were it back, `mergedInto` would name
    // the $500 case and only one case would exist.
    expect(read?.mergedInto).toEqual([]);
    expect(read?.lines.map((l) => l.outcome)).toEqual(['opened', 'opened']);
    expect(read?.opened.map((c) => c.deductionAmountCents)).toEqual([50_000, 30_000]);
    expect(total([...store.cases.values()].map((c) => c.deductionAmountCents))).toBe(80_000);
    expect(store.cases.size).toBe(2);
    expect(read?.opened.map((c) => c.claimId)).toEqual([
      'ACH-WP-202:CF-260902#1',
      'ACH-WP-202:CF-260902#2',
    ]);
    // Two lines side by side are not a possible duplicate of each other either.
    expect(read?.lines.every((l) => l.probableDuplicateOf === undefined)).toBe(true);
    expect(store.events.filter((e) => e.eventType === 'case.merged_duplicate_line')).toEqual([]);
  });

  it('reconciles each case against its own line, and the shared invoice adds up', async () => {
    const { deps } = harness();
    const result = await processUpload(upload(), deps);

    for (const [i, opened] of (result.remittance?.opened ?? []).entries()) {
      const reconciliation = await reconcileCase(opened.deductionId, deps);
      expect(reconciliation?.internallyConsistent).toBe(true);
      expect(reconciliation?.findings.filter((f) => f.severity === 'blocking')).toEqual([]);
      expect(reconciliation?.claimedTotalCents).toBe(i === 0 ? 50_000 : 30_000);
      expect(reconciliation?.lines[0]?.verdict).toBe('matches');
      expect(reconciliation?.lines[0]?.deltaCents).toBe(0);
      expect(reconciliation?.findings.map((f) => f.code)).toContain('remittance_invoice_shared');
    }
  });

  it('merges each line into its own case when the same advice arrives again', async () => {
    const { store, deps } = harness();
    const first = await processUpload(upload(), deps);
    const again = await processUpload(upload(1), deps);

    expect(again.remittance?.lines.map((l) => l.outcome)).toEqual(['merged', 'merged']);
    expect(again.remittance?.mergedInto).toEqual(first.remittance?.opened.map((c) => c.deductionId));
    expect(store.cases.size).toBe(2);
  });

  it('opens two cases for two equal deductions on one invoice', async () => {
    const { store, deps } = harness(() => twoLines('$400.00', '$400.00'));
    const result = await processUpload(upload(), deps);

    expect(result.remittance?.lines.map((l) => l.outcome)).toEqual(['opened', 'opened']);
    expect(store.cases.size).toBe(2);
    expect(result.remittance?.lines.every((l) => l.probableDuplicateOf === undefined)).toBe(true);
  });

  it('refuses to give each line the whole invoice when none prints its own deduction', async () => {
    // `gross − net` is $800 on both lines; given to each it would count $1,600.
    const { store, deps } = harness(() => twoLines(null, null));
    const result = await processUpload(upload(), deps);

    expect(result.remittance?.lines.map((l) => l.outcome)).toEqual(['unreadable', 'unreadable']);
    expect(result.remittance?.lines[0]?.detail).toContain('repeats its invoice');
    expect(store.cases.size).toBe(0);
  });

  it('refuses the whole invoice to lines that each print a dash for their deduction', async () => {
    // A dash is no deduction of its own, so `gross − net` is again the whole
    // invoice's $800 on both lines, and given to each it would count $1,600.
    const { store, deps } = harness(() => twoLines('-', '-'));
    const result = await processUpload(upload(), deps);

    expect(result.remittance?.lines.map((l) => l.outcome)).toEqual(['unreadable', 'unreadable']);
    expect(result.remittance?.lines[0]?.detail).toContain('repeats its invoice');
    expect(result.remittance?.lines[1]?.detail).toContain('repeats its invoice');
    expect(store.cases.size).toBe(0);
  });

  it('counts a dash beside the whole deduction as nothing, and the shared invoice adds up', async () => {
    const { store, deps } = harness(() => twoLines('$800.00', '-'));
    const result = await processUpload(upload(), deps);

    expect(result.remittance?.lines.map((l) => l.outcome)).toEqual(['opened', 'unreadable']);
    expect(store.cases.size).toBe(1);
    const opened = result.remittance?.opened[0];
    expect(opened?.deductionAmountCents).toBe(80_000);

    const reconciliation = await reconcileCase(opened?.deductionId ?? '', deps);
    expect(reconciliation?.findings.filter((f) => f.severity === 'blocking')).toEqual([]);
    expect(reconciliation?.lines[0]?.verdict).toBe('matches');
    expect(reconciliation?.findings.map((f) => f.code)).toContain('remittance_invoice_shared');
  });

  it('blocks a case whose shared invoice does not add up across its lines', async () => {
    // $500 + $200 against $800 withheld.
    const { deps } = harness(() => twoLines('$500.00', '$200.00'));
    const result = await processUpload(upload(), deps);
    const first = result.remittance?.opened[0];
    const reconciliation = await reconcileCase(first?.deductionId ?? '', deps);

    expect(reconciliation?.internallyConsistent).toBe(false);
    const blocking = reconciliation?.findings.find(
      (f) => f.code === 'remittance_line_does_not_add_up',
    );
    expect(blocking?.message).toContain('deduct $700.00 between them');
  });
});

describe('a case opened under the key the whole invoice used to share', () => {
  /** A case as ADR 0028 opened it from the first line: keyed `payment_reference:invoice_number`. */
  async function legacyCase(store: InMemoryStore, amountCents: number): Promise<string> {
    const upload = await store.recordUpload({ orgId: ORG, source: 'web_upload', createdBy: USER });
    const document = await store.putDocument({
      orgId: ORG,
      sha256: 'f'.repeat(64),
      filename: 'earlier-advice.pdf',
      mimeType: 'application/pdf',
      byteSize: 10,
      bytes: new Uint8Array([9]),
      uploadId: upload.uploadId,
      requiresSplit: false,
    });
    const opened = await store.openCase({
      orgId: ORG,
      claimId: 'ACH-WP-202:CF-260902',
      discoveredVia: 'remittance_line',
      deductionAmountCents: amountCents,
      deductionDate: '2026-09-18',
    });
    await store.recordIdentifiers({
      orgId: ORG,
      deductionId: opened.deductionId,
      documentId: document.documentId,
      identifiers: [
        { kind: 'claim_id', identifier: 'ACH-WP-202:CF-260902' },
        { kind: 'invoice_number', identifier: 'CF-260902' },
      ],
    });
    return opened.deductionId;
  }

  it('is the line whose amount it holds, and the dropped line opens beside it', async () => {
    const { store, deps } = harness();
    const legacy = await legacyCase(store, 50_000);

    const result = await processUpload(upload(), deps);

    expect(result.remittance?.lines.map((l) => l.outcome)).toEqual(['merged', 'opened']);
    expect(result.remittance?.lines[0]?.deductionId).toBe(legacy);
    expect(result.remittance?.opened.map((c) => c.deductionAmountCents)).toEqual([30_000]);
    // The $300 the old key dropped is a case now, and is not called a duplicate
    // of a case that belongs to the other line.
    expect(result.remittance?.lines[1]?.probableDuplicateOf).toBeUndefined();
    expect(total([...store.cases.values()].map((c) => c.deductionAmountCents))).toBe(80_000);
    // The old case keeps its key, and reconciles against the line that owns it.
    expect(store.cases.get(legacy)?.claimId).toBe('ACH-WP-202:CF-260902');
    const reconciliation = await reconcileCase(legacy, deps);
    expect(reconciliation?.claimedTotalCents).toBe(50_000);
    expect(reconciliation?.findings.map((f) => f.code)).not.toContain('remittance_line_not_found');
  });

  it('is named on every line when its amount is none of theirs', async () => {
    // Opened from the one-line $800 reading: neither $500 nor $300 is it, and
    // which dollars survive is a person's call.
    const { store, deps } = harness();
    const legacy = await legacyCase(store, 80_000);

    const result = await processUpload(upload(), deps);

    expect(result.remittance?.lines.map((l) => l.outcome)).toEqual([
      'probable_duplicate',
      'probable_duplicate',
    ]);
    expect(result.remittance?.lines.map((l) => l.probableDuplicateOf)).toEqual([[legacy], [legacy]]);
    const discovered = store.events.filter((e) => e.eventType === 'case.discovered').slice(-2);
    for (const event of discovered) {
      expect(event.payload['probable_duplicate_basis']).toContain('legacy_claim_id');
    }
  });
});

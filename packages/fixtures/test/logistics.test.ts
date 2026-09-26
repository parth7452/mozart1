import { describe, expect, it } from 'vitest';
import {
  LOG_001_DEDUCTION_CENTS,
  LOG_001_EXPECTED_FINDINGS,
  LOG_001_GROSS_CENTS,
  LOG_001_NET_CENTS,
  logisticsDocuments,
} from '../src/logistics';

/**
 * LOG-001 has to agree with itself before it can measure anything.
 *
 * The documents, the ground truth and the arithmetic are three separate claims
 * about the same case, and an eval scored against stale truth is worse than no
 * eval at all.
 */
describe('the LOG-001 dispute case', () => {
  const documents = logisticsDocuments();

  it('is five documents, each with readable text', () => {
    expect(documents).toHaveLength(5);
    for (const document of documents) {
      expect(document.pageText.join('').length, document.key).toBeGreaterThan(200);
      expect(document.bytes.byteLength, document.key).toBeGreaterThan(0);
      expect(document.suite).toBe('logistics');
    }
  });

  it('covers the document types the case actually needs', () => {
    // The message is the point: before `correspondence` existed it fell to
    // `other`, and the sentence that wins this case was read as prose.
    expect(documents.map((d) => d.docType).sort()).toEqual([
      'correspondence',
      'invoice',
      'pod',
      'price_agreement',
      'remittance_advice',
    ]);
  });

  it('asserts nothing that is not printed on the page it belongs to', () => {
    // The drift guard. Every text value in the ground truth has to appear in
    // that document's own text, or the truth is describing a document we no
    // longer have.
    for (const document of documents) {
      const page = document.pageText.join('\n');
      for (const [field, expectation] of Object.entries(document.truth)) {
        if (expectation.kind !== 'text') continue;
        expect(page, `${document.key}.${field}: “${expectation.value}” is not on the page`).toContain(
          expectation.value,
        );
      }
    }
  });

  it('adds up: gross − deduction = net', () => {
    // 4,800.00 − 600.00 = 4,200.00. The remittance states all three, so a
    // misread of any one of them fails an equation instead of looking plausible.
    expect(LOG_001_GROSS_CENTS - LOG_001_DEDUCTION_CENTS).toBe(LOG_001_NET_CENTS);
  });

  it('carries no synthetic banner a classifier could learn instead of the document', () => {
    // The OCR starter pack stamps every page "SYNTHETIC TRAINING SAMPLE", which
    // its own README warns can become a shortcut feature. These pages do not,
    // so classification here is measuring the document.
    for (const document of documents) {
      expect(document.pageText.join('').toUpperCase(), document.key).not.toContain('SYNTHETIC');
    }
  });

  it('states what a correct reading of the whole case must conclude', () => {
    // Not a field-accuracy number. These are the findings reconciliation has to
    // produce, and they are what this suite actually claims.
    expect([...LOG_001_EXPECTED_FINDINGS]).toEqual([
      'arrived_before_appointment',
      'appointment_superseded',
      'charge_waived_in_writing',
    ]);
  });
});

describe('every suite reaches the recorder and the eval gate', () => {
  it('includes LOG-001 in everyDocument()', async () => {
    // The bug this pins: `logistics.ts` was written, exported and tested, and
    // `everyDocument()` — the one list the recorder and the eval iterate — was
    // never told about it. The suite was invisible to both while looking
    // completely wired, and a cassette run recorded 26 documents and none of
    // these five.
    const { everyDocument } = await import('../src/corpus');
    const keys = new Set(everyDocument().map((d) => d.key));
    for (const document of logisticsDocuments()) {
      expect(keys.has(document.key), `${document.key} is not in everyDocument()`).toBe(true);
    }
  });

  it('has every declared suite represented, so a new one cannot be orphaned', async () => {
    const { everyDocument } = await import('../src/corpus');
    const suites = new Set(everyDocument().map((d) => d.suite));
    expect([...suites].sort()).toEqual([
      'authored',
      // Authored, and deliberately not in `authored`: it has no cassette, and a
      // suite's baseline row is a count of documents that were scored.
      'authored_pending',
      'customer',
      'dense',
      // Too dense for one reply, read in page ranges (ADR 0053).
      'dense_paged',
      'email_body',
      // Merged cells and an 812 printout (`formats.ts`).
      'formats',
      'held_out',
      'logistics',
      // Real documents from public records, with ExtractBench's verified
      // answers; `public_scanned` is the same source read through OCR
      // (`public.ts`).
      'public',
      'public_scanned',
      'scanned',
    ]);
  });
});

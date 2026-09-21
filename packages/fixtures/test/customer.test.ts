import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { parseMoneyToCents } from '@recouple/core-domain';
import { DOC_TYPES } from '@recouple/extraction';
import { acceptUpload } from '@recouple/ingest';
import { customerCases, customerDocuments } from '../src/customer';

/**
 * The customer pack has to agree with itself before it can measure anything.
 *
 * Three claims about the same fifteen documents — the files, the labels and the
 * case ground truth — and an eval scored against stale truth is worse than no
 * eval at all. These tests read the bytes, not the manifest's description of
 * them.
 */

/**
 * The text layer of a native PDF, read out of the PDF.
 *
 * The point is not to build a PDF reader; it is that "the label transcription is
 * this document's text layer" should be something the test proves rather than
 * something the label asserts about itself. ReportLab writes one
 * ASCII85 + Flate content stream per page and prints its strings with `Tj`, so
 * decoding it is short and exact, and anything unexpected throws.
 */
function ascii85Decode(input: string): Buffer {
  const clean = input.replace(/\s/g, '').replace(/^<~/, '').replace(/~>$/, '');
  const out: number[] = [];
  let tuple: number[] = [];
  const emit = (n: number, count: number): void => {
    const bytes = [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    out.push(...bytes.slice(0, count));
  };
  for (const ch of clean) {
    if (ch === 'z' && tuple.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    const digit = ch.charCodeAt(0) - 33;
    if (digit < 0 || digit > 84) throw new Error(`not ASCII85: ${JSON.stringify(ch)}`);
    tuple.push(digit);
    if (tuple.length === 5) {
      emit(tuple.reduce((n, d) => n * 85 + d, 0), 4);
      tuple = [];
    }
  }
  if (tuple.length === 1) throw new Error('truncated ASCII85 group');
  if (tuple.length > 1) {
    const missing = 5 - tuple.length;
    const padded = [...tuple, ...Array<number>(missing).fill(84)];
    emit(padded.reduce((n, d) => n * 85 + d, 0), 4 - missing);
  }
  return Buffer.from(out);
}

function pdfTextLayer(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString('latin1');
  const stream = /stream\r?\n([\s\S]*?)endstream/.exec(raw);
  if (stream === null) throw new Error('no content stream in this PDF');
  const content = inflateSync(ascii85Decode(stream[1] as string)).toString('latin1');
  return [...content.matchAll(/\((?:\\.|[^\\()])*\)\s*Tj/g)]
    .map((match) => match[0].replace(/\s*Tj$/, '').slice(1, -1).replace(/\\([()\\])/g, '$1'))
    .join('\n');
}

/**
 * Markers a classifier could learn instead of the document.
 *
 * The OCR starter pack stamps every page `SYNTHETIC TRAINING SAMPLE` and its own
 * README warns that the stamp can become a shortcut feature. This pack's README
 * says it carries no visible marker; that is asserted here rather than believed.
 */
const BANNED_MARKERS = ['SYNTHETIC', 'TRAINING SAMPLE', 'SPECIMEN', 'DO NOT USE', 'SAMPLE ONLY'];

const labelsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'customer', 'labels');

describe('the customer pack', () => {
  const documents = customerDocuments();
  const cases = customerCases();

  it('is fifteen documents across three cases, five each', () => {
    expect(documents).toHaveLength(15);
    expect(cases).toHaveLength(3);
    expect(cases.map((c) => c.caseId).sort()).toEqual(['LOG-202', 'STF-201', 'STF-203']);
    for (const fixtureCase of cases) {
      // The pack asks for a case's documents to stay in one split. They can
      // only do that if the case actually holds all five of them.
      expect(fixtureCase.documents, fixtureCase.caseId).toHaveLength(5);
    }
    expect(new Set(documents.map((d) => d.key)).size).toBe(15);
    for (const document of documents) {
      expect(document.suite).toBe('customer');
      expect(document.bytes.byteLength, document.key).toBeGreaterThan(0);
    }
  });

  it('covers every role a case is argued from', () => {
    // Not a type: what the document does. A case with no evidence is a case
    // with nothing to argue from, whatever the types say.
    for (const fixtureCase of cases) {
      const roles = fixtureCase.documents.map((d) => d.role);
      expect(roles, fixtureCase.caseId).toContain('evidence');
      expect(roles, fixtureCase.caseId).toContain('context');
      expect(
        roles.includes('notice') || roles.includes('remittance'),
        `${fixtureCase.caseId} has nothing that announced the deduction`,
      ).toBe(true);
    }
  });

  it('declares only document types extraction actually has', () => {
    for (const document of documents) {
      expect(DOC_TYPES as readonly string[], document.key).toContain(document.docType);
    }
    // The mapping this PR argues for, pinned so changing it is a decision.
    expect(documents.map((d) => `${d.documentId}=${d.docType}`)).toEqual([
      '01_stf-201=remittance_advice',
      '02_stf-201=invoice',
      '03_stf-201=other',
      '04_stf-201=correspondence',
      '05_stf-201=price_agreement',
      '06_log-202=remittance_advice',
      '07_log-202=invoice',
      '08_log-202=pod',
      '09_log-202=correspondence',
      '10_log-202=price_agreement',
      '11_stf-203=deduction_notice',
      '12_stf-203=invoice',
      '13_stf-203=other',
      // Not `correspondence`: an internal note is not a message between the
      // parties, and STF-203 turns on it not being customer approval.
      '14_stf-203=other',
      '15_stf-203=price_agreement',
    ]);
  });

  it('is the bytes it says it is', () => {
    // The declared type is a hint; the magic bytes are the fact. This is the
    // same front door an upload goes through, so a fixture that would be
    // refused in production is refused here.
    for (const document of documents) {
      const accepted = acceptUpload(document.bytes, document.filename, {
        declaredMimeType: document.mimeType,
      });
      expect(accepted.mimeType, document.key).toBe(document.mimeType);
      expect(accepted.warnings, document.key).toEqual([]);
      expect(accepted.requiresSplit, document.key).toBe(false);
    }
  });

  it('has a transcription for every document, and gives the model one only where a page has one', () => {
    for (const document of documents) {
      expect(document.labelText.trim().length, document.key).toBeGreaterThan(200);
      if (document.mimeType === 'application/pdf') {
        // A native PDF has a text layer, and it is the label.
        expect(document.pageText, document.key).toEqual([document.labelText]);
      } else {
        // A photograph does not. OCR supplies one at recording time; handing
        // the model a perfect transcription of a photograph would measure
        // nothing.
        expect(document.pageText, document.key).toEqual([]);
      }
    }
  });

  it('keeps each label’s word polygons on the same text the fixture reads', () => {
    // The pack ships the transcription twice: once in the `.txt` the fixture
    // loads, and once inside the `.json` that every word polygon is positioned
    // against. Edit one and the boxes a reviewer follows stop describing the
    // text the eval scores — silently, because nothing else compares them.
    //
    // The only difference allowed is the closing newline the `.txt` carries and
    // the JSON string does not (`build()` trims it); everything before it has
    // to match exactly.
    for (const document of documents) {
      const label = JSON.parse(
        readFileSync(path.join(labelsDir, `${document.documentId}.json`), 'utf8'),
      ) as { transcription: string; words: readonly { text: string }[] };
      const txt = readFileSync(path.join(labelsDir, `${document.documentId}.txt`), 'utf8');

      expect(txt, `${document.documentId}.txt does not match its label’s transcription`).toBe(
        `${label.transcription}\n`,
      );
      // And the transcription is what the fixture actually hands out, so a
      // truth checked against `labelText` is checked against the labelled page.
      expect(document.labelText, document.key).toBe(label.transcription);
      expect(label.words.length, `${document.documentId} has no word polygons`).toBeGreaterThan(0);
    }
  });

  it('proves the label is the PDF’s own text layer rather than taking its word', () => {
    const pdfs = documents.filter((d) => d.mimeType === 'application/pdf');
    expect(pdfs).toHaveLength(3);
    for (const document of pdfs) {
      expect(pdfTextLayer(document.bytes), document.key).toBe(document.labelText);
    }
  });

  it('carries no banner a classifier could learn instead of the document', () => {
    for (const document of documents) {
      const layers = [
        document.labelText.toUpperCase(),
        ...(document.mimeType === 'application/pdf'
          ? [pdfTextLayer(document.bytes).toUpperCase()]
          : []),
      ];
      for (const layer of layers) {
        for (const marker of BANNED_MARKERS) {
          expect(layer, `${document.key} carries “${marker}”`).not.toContain(marker);
        }
      }
    }
  });

  it('asserts nothing that is not printed on the document it belongs to', () => {
    // The drift guard. Every expectation has to be findable in that document's
    // own transcription, or the truth is describing a document we no longer
    // have. Two deliberate choices about how strictly to ask. Case matters,
    // because the ground truth is written in the page's own capitalisation and
    // scoring is what lowercases both sides. Line breaks do not: a sentence the
    // page wraps ("replaces the original / appointment") is one sentence, the
    // scorer collapses whitespace before comparing, and so does this.
    //
    // Money and quantities are checked too, and they are the ones that would
    // rot silently: truth holds $600.00 as 60_000 cents, which no amount of
    // editing the page can contradict on its own. Formatting the cents back to
    // what a page prints is what ties the number to this document — a truth
    // that says 60_000 for a page that now reads $650.00 is caught here rather
    // than by a model failing to find it.
    const flatten = (value: string): string => value.replace(/\s+/g, ' ');
    const withThousands = (n: number): string =>
      String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const printedMoney = (cents: number): string =>
      `$${withThousands(Math.floor(cents / 100))}.${String(cents % 100).padStart(2, '0')}`;

    for (const document of documents) {
      const page = flatten(document.labelText);
      for (const [field, expectation] of Object.entries(document.truth)) {
        // A boolean is a reading of the page rather than a string on it:
        // `signature_present` is true because a name is written on the line,
        // and there is no text to go looking for.
        if (expectation.kind === 'bool') continue;
        const printed =
          expectation.kind === 'money_cents'
            ? printedMoney(expectation.value)
            : expectation.kind === 'int'
              ? String(expectation.value)
              : flatten(String(expectation.value));
        expect(
          page,
          `${document.key}.${field}: “${printed}” is not on the page`,
        ).toContain(printed);
      }
    }
  });

  it('prices every money expectation through our own parser', () => {
    // A money expectation is cents, and cents are what `parseMoneyToCents`
    // produces from what the model copied. Integers, always — never floats.
    for (const document of documents) {
      for (const [field, expectation] of Object.entries(document.truth)) {
        if (expectation.kind !== 'money_cents') continue;
        expect(Number.isInteger(expectation.value), `${document.key}.${field}`).toBe(true);
        expect(expectation.value, `${document.key}.${field}`).toBeGreaterThan(0);
      }
    }
  });
});

describe('the customer cases’ own ground truth', () => {
  const cases = customerCases();

  it('adds up: gross − paid = deduction, on the settlement page that prints all three', () => {
    for (const fixtureCase of cases) {
      // Two of the three settlements are remittances and STF-203's is a
      // short-payment notice, so what this looks for is the page that prints
      // the amounts, not a document type.
      const settlement = fixtureCase.documents.find((d) => d.key === fixtureCase.settlementKey);
      expect(
        settlement,
        `${fixtureCase.caseId} names a settlement page it does not hold`,
      ).toBeDefined();

      // The three amounts are printed on that document, and our parser is what
      // turns them into cents — the same path the eval scores a model through.
      for (const printed of Object.values(fixtureCase.printed)) {
        expect(settlement?.labelText, `${fixtureCase.caseId}: ${printed}`).toContain(printed);
      }
      expect(parseMoneyToCents(fixtureCase.printed.gross)).toBe(fixtureCase.grossCents);
      expect(parseMoneyToCents(fixtureCase.printed.deduction)).toBe(fixtureCase.deductionCents);
      expect(parseMoneyToCents(fixtureCase.printed.paid)).toBe(fixtureCase.paidCents);

      expect(
        fixtureCase.grossCents - fixtureCase.paidCents,
        `${fixtureCase.caseId} does not reconcile`,
      ).toBe(fixtureCase.deductionCents);
    }
  });

  it('links every document to its case on the page, not only in the manifest', () => {
    // The manifest says which case a document belongs to. The page says it too
    // — every one of them carries "STF-201 | ES-260901" in its footer — and
    // that is the claim worth checking, because linkage read off a manifest is
    // linkage the pipeline will never have.
    for (const fixtureCase of cases) {
      for (const document of fixtureCase.documents) {
        expect(document.labelText, `${document.key} does not name its case`).toContain(
          fixtureCase.caseId,
        );
        expect(document.labelText, `${document.key} does not name its invoice`).toContain(
          fixtureCase.invoiceNumber,
        );
      }
    }
  });

  it('keeps every amount an integer number of cents', () => {
    for (const fixtureCase of cases) {
      for (const [name, cents] of Object.entries({
        gross: fixtureCase.grossCents,
        deduction: fixtureCase.deductionCents,
        paid: fixtureCase.paidCents,
      })) {
        expect(Number.isInteger(cents), `${fixtureCase.caseId}.${name}`).toBe(true);
        expect(cents, `${fixtureCase.caseId}.${name}`).toBeGreaterThan(0);
      }
      if (fixtureCase.recoverCents !== null) {
        expect(Number.isInteger(fixtureCase.recoverCents), fixtureCase.caseId).toBe(true);
        expect(fixtureCase.recoverCents, fixtureCase.caseId).toBeGreaterThan(0);
        expect(fixtureCase.recoverCents, fixtureCase.caseId).toBeLessThanOrEqual(
          fixtureCase.deductionCents,
        );
      }
    }
  });

  it('keeps an undetermined recovery undetermined', () => {
    // The pack is explicit: a null recovery means undetermined, not zero.
    // Writing 0 here would turn "we do not know what this is worth" into "this
    // is worth nothing", which is a different claim and a worse one.
    const stf203 = cases.find((c) => c.caseId === 'STF-203');
    expect(stf203?.decision).toBe('request_evidence');
    expect(stf203?.recoverCents).toBeNull();
    expect(stf203?.deductionCents).toBe(45_000);

    expect(cases.find((c) => c.caseId === 'STF-201')?.recoverCents).toBe(60_000);
    // Half of LOG-202's $800 is a charge the signed receipt says is fair.
    expect(cases.find((c) => c.caseId === 'LOG-202')?.recoverCents).toBe(50_000);
  });

  it('says what each case concludes, in the pack’s own words', () => {
    for (const fixtureCase of cases) {
      expect(fixtureCase.basis.length, fixtureCase.caseId).toBeGreaterThan(40);
      expect(fixtureCase.expectedOutcome, fixtureCase.caseId).toContain(fixtureCase.basis);
    }
  });
});

describe('the customer suite reaches the recorder and the eval gate', () => {
  it('includes every customer document in everyDocument()', async () => {
    // The bug LOG-001 hit: a suite written, exported and tested, and never
    // added to the one list the recorder and the eval iterate.
    const { everyDocument } = await import('../src/corpus');
    const keys = new Set(everyDocument().map((d) => d.key));
    for (const document of customerDocuments()) {
      expect(keys.has(document.key), `${document.key} is not in everyDocument()`).toBe(true);
    }
  });
});

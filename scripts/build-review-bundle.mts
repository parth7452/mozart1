/**
 * Builds a self-contained bundle for the case review prototype.
 *
 * Everything in it is real: the scan is the rendered fixture, the fields are
 * what the model actually returned, the boxes are Reducto's, the verification
 * flags come from checking each quote against the OCR text, and the findings
 * come from running reconciliation over the four documents of the case.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  buildExtractionResult,
  flattenExtraction,
  locateQuote,
  reconcileNotice,
  verifyQuotes,
  type Cassette,
} from '@recouple/extraction';
import { everyDocument, inlineJsonSafely, WALMART_CODE_24 } from '@recouple/fixtures';

const here = path.dirname(fileURLToPath(import.meta.url));
const cassetteDir = path.join(here, '..', 'packages', 'fixtures', 'cassettes');
const out = path.join(here, '..', 'packages', 'fixtures', 'review-bundle.json');

const cassette = (key: string): Cassette =>
  JSON.parse(readFileSync(path.join(cassetteDir, `${key}.json`), 'utf8')) as Cassette;

const documentByKey = (key: string) => {
  const found = everyDocument().find((d) => d.key === key);
  if (found === undefined) throw new Error(`no fixture ${key}`);
  return found;
};

// The scanned notice is the interesting one: it is the case where the boxes are
// real and where, without OCR, nothing would be verifiable at all.
const scanKey = 'walmart-apdp-notice-scan';
const scan = documentByKey(scanKey);
const scanCassette = cassette(scanKey);
const ocrPages = scanCassette.ocr?.pages.map((p) => p.text) ?? [];
const blocks = scanCassette.ocr?.blocks ?? [];

const fields = verifyQuotes(flattenExtraction(scanCassette.document), ocrPages).map((field) => {
  const block = locateQuote(field.sourceQuote, field.sourcePage, blocks);
  return {
    path: field.fieldPath,
    value: field.value,
    confidence: field.confidence,
    page: field.sourcePage,
    quote: field.sourceQuote,
    verified: field.quoteVerified,
    match: field.quoteMatch ?? null,
    bbox: block?.bbox ?? field.sourceBbox ?? null,
  };
});

// Reconciliation runs over the whole case: notice, PO, invoice, signed BOL.
const typed = (key: string, docType: string) =>
  buildExtractionResult({
    docType: docType as never,
    extractor: 'cassette',
    document: cassette(key).document,
    pageText: documentByKey(key).pageText,
    call: {
      purpose: 'extract',
      provider: 'anthropic',
      modelVersion: cassette(key).call.modelVersion,
      costMicros: 0,
      latencyMs: 0,
      outcome: 'ok',
    },
  }).document;

const reconciliation = reconcileNotice({
  notice: typed('walmart-apdp-notice', 'deduction_notice') as never,
  po: typed('walmart-po', 'po') as never,
  invoice: typed('harborline-invoice', 'invoice') as never,
  shipment: typed('carrier-bol', 'bol') as never,
});

const costMicros =
  scanCassette.call.costMicros + Math.round((scanCassette.ocr?.credits ?? 0) * 1_000);

writeFileSync(
  out,
  JSON.stringify(
    {
      case: {
        key: WALMART_CODE_24.key,
        title: WALMART_CODE_24.title,
        retailer: WALMART_CODE_24.retailer,
        state: 'classified',
        expectedOutcome: WALMART_CODE_24.expectedOutcome,
      },
      document: {
        key: scanKey,
        filename: scan.filename,
        mimeType: 'image/jpeg',
        imageBase64: Buffer.from(scan.bytes).toString('base64'),
        ocrProvider: scanCassette.ocr?.provider ?? null,
        pageText: ocrPages,
      },
      fields,
      reconciliation,
      cost: {
        extractMicros: scanCassette.call.costMicros,
        ocrCredits: scanCassette.ocr?.credits ?? 0,
        totalMicros: costMicros,
        extractModel: scanCassette.call.modelVersion,
      },
      documents: WALMART_CODE_24.documents.map((d) => ({
        key: d.key,
        filename: d.filename,
        docType: d.docType,
      })),
    },
    null,
    2,
  ),
);

console.log(
  `review-bundle.json: ${fields.length} fields, ` +
    `${fields.filter((f) => f.bbox !== null).length} with boxes, ` +
    `${fields.filter((f) => f.verified === true).length} verified, ` +
    `${reconciliation.findings.length} findings`,
);

// Inject the bundle into the review page template, so the published page is
// self-contained: the scan, the fields, the boxes and the findings all ship
// with it and it needs no network at all.
const templatePath = path.join(here, '..', 'apps', 'review-prototype', 'template.html');
const pagePath = path.join(here, '..', 'apps', 'review-prototype', 'case-review.html');
// Escaped even though the bundle now ships in an inert JSON block: the data is
// document-derived, and the cost of belt and braces here is nothing.
const bundle = inlineJsonSafely(readFileSync(out, 'utf8'));
writeFileSync(
  pagePath,
  readFileSync(templatePath, 'utf8').replace('__BUNDLE__', () => bundle),
);
console.log(
  `case-review.html: ${(Buffer.byteLength(readFileSync(pagePath)) / 1024 / 1024).toFixed(2)} MB`,
);

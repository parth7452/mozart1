/**
 * Records model responses for the fixture documents.
 *
 * This is the only script that spends money. It runs a real classification and a
 * real extraction for each fixture, writes the validated result to
 * packages/fixtures/cassettes/, and prints what each call cost. CI replays those
 * cassettes; nothing in the test suite calls a model.
 *
 *   pnpm record:cassettes            # every fixture
 *   pnpm record:cassettes walmart    # only fixtures whose key matches
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import 'dotenv/config';
import {
  ClaudeClassifier,
  ClaudeExtractor,
  ExtractionError,
  groundingReport,
  locateQuote,
  modelFor,
  ocrFromEnv,
  OcrError,
  type Cassette,
  type DocType,
  type DocumentPayload,
  type OcrBlock,
  type OcrResult,
} from '@recouple/extraction';
import { acceptEmailBody, acceptUpload } from '@recouple/ingest';
import { everyDocument } from '@recouple/fixtures';

const here = path.dirname(fileURLToPath(import.meta.url));
const cassetteDir = path.join(here, '..', 'packages', 'fixtures', 'cassettes');

const filter = process.argv[2];
const documents = everyDocument().filter(
  (d) => filter === undefined || d.key.includes(filter),
);

if (documents.length === 0) {
  console.error(`no fixture documents match ${JSON.stringify(filter)}`);
  process.exit(1);
}

const classifier = new ClaudeClassifier();
const extractor = new ClaudeExtractor();
const ocr = ocrFromEnv();
if (ocr === undefined) {
  console.warn('note: REDUCTO_API_KEY is not set — scans will be recorded without a text layer');
}

let totalMicros = 0;
let mismatches = 0;

for (const fixture of documents) {
  // Fixtures go through the same front door as the real thing — which for a
  // notice that arrived in a message is not the upload door. Sniffing magic
  // bytes on text the mail server already parsed would be checking the wrong
  // thing, so the email-body gate applies instead.
  const accepted =
    fixture.mimeType === 'text/plain'
      ? acceptEmailBody(new TextDecoder().decode(fixture.bytes)).accepted
      : acceptUpload(fixture.bytes, fixture.filename);
  let payload: DocumentPayload = {
    documentId: fixture.key,
    orgId: 'fixture-org',
    filename: fixture.filename,
    mimeType: accepted.mimeType,
    base64: Buffer.from(fixture.bytes).toString('base64'),
    byteSize: accepted.byteSize,
    pageText: fixture.pageText,
  };

  process.stdout.write(`\n=== ${fixture.key} (${fixture.filename})\n`);

  // A document with no text layer gets one, so its quotes can be checked.
  let ocrResult: OcrResult | undefined;
  const needsOcr = fixture.pageText.length === 0 || fixture.pageText.every((t) => t.trim() === '');
  if (needsOcr && ocr !== undefined) {
    try {
      ocrResult = await ocr.ocr(payload);
      totalMicros += ocrResult.call.costMicros;
      payload = {
        ...payload,
        pageText: ocrResult.pages.map((page) => page.text),
        pageTextSource: 'ocr',
      };
      console.log(
        `  ocr       ${ocrResult.pages.length} page(s), ${ocrResult.blocks.length} blocks ` +
          `(${ocrResult.call.latencyMs}ms, ${ocrResult.call.detail ?? ''})`,
      );
    } catch (error) {
      console.error(
        `  ocr       FAILED ${error instanceof OcrError ? error.message : String(error)}`,
      );
    }
  }

  try {
    const classification = await classifier.classify(payload);
    totalMicros += classification.call.costMicros;
    const agreed = classification.docType === fixture.docType;
    if (!agreed) mismatches += 1;
    console.log(
      `  classify  ${classification.docType} @ ${classification.confidence.toFixed(2)} ` +
        `${agreed ? '✓' : `✗ expected ${fixture.docType}`} ` +
        `(${classification.call.latencyMs}ms, ${classification.call.costMicros}µ$)`,
    );

    // Extract against the *expected* type: a cassette records what a correct
    // pipeline would read, so a classification slip does not poison the corpus.
    const extraction = await extractor.extract(payload, fixture.docType as DocType);
    totalMicros += extraction.call.costMicros;
    const blocks: readonly OcrBlock[] = ocrResult?.blocks ?? [];
    const boxed = blocks.length === 0
      ? 0
      : extraction.fields.filter(
          (f) => locateQuote(f.sourceQuote, f.sourcePage, blocks) !== undefined,
        ).length;
    const grounding = groundingReport(extraction.fields);
    console.log(
      `  extract   ${extraction.fields.length} fields, ` +
        `${grounding.verified} quotes verified, ${grounding.ungrounded} ungrounded` +
        `${blocks.length > 0 ? `, ${boxed} boxed` : ''} ` +
        `(${extraction.call.latencyMs}ms, ${extraction.call.costMicros}µ$, ` +
        `${extraction.call.inputTokens}in/${extraction.call.outputTokens}out)`,
    );

    const cassette: Cassette = {
      key: fixture.key,
      docType: fixture.docType as DocType,
      classifiedAs: classification.docType,
      classifierConfidence: classification.confidence,
      document: extraction.document,
      recordedWith: modelFor('extract'),
      recordedAt: new Date().toISOString(),
      call: {
        modelVersion: extraction.call.modelVersion,
        inputTokens: extraction.call.inputTokens ?? 0,
        outputTokens: extraction.call.outputTokens ?? 0,
        costMicros: extraction.call.costMicros,
        latencyMs: extraction.call.latencyMs,
      },
      ...(ocrResult !== undefined
        ? {
            ocr: {
              provider: ocrResult.provider,
              pages: ocrResult.pages,
              blocks: ocrResult.blocks,
              credits: ocrResult.call.costMicros / 1_000,
              latencyMs: ocrResult.call.latencyMs,
            },
          }
        : {}),
    };
    writeFileSync(
      path.join(cassetteDir, `${fixture.key}.json`),
      `${JSON.stringify(cassette, null, 2)}\n`,
    );
    console.log(`  recorded  packages/fixtures/cassettes/${fixture.key}.json`);
  } catch (error) {
    if (error instanceof ExtractionError) {
      totalMicros += error.call.costMicros;
      console.error(`  FAILED    ${error.message} [${error.call.outcome}]`);
    } else {
      console.error(`  FAILED    ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exitCode = 1;
  }
}

console.log(
  `\ntotal ${(totalMicros / 1_000_000).toFixed(4)} USD across ${documents.length} documents` +
    `${mismatches > 0 ? `, ${mismatches} classification mismatch(es)` : ''}`,
);

/**
 * Records model responses for the fixture documents.
 *
 * This is the only script that spends money. It runs a real classification and a
 * real extraction for each fixture, writes the validated result to
 * packages/fixtures/cassettes/, and prints what each call cost. CI replays those
 * cassettes; nothing in the test suite calls a model.
 *
 *   pnpm record:cassettes                     # every fixture
 *   pnpm record:cassettes walmart             # only fixtures whose key matches
 *   pnpm record:cassettes --suite customer    # only one suite
 *
 * The suite filter exists because a suite is the unit that gets recorded: a new
 * corpus lands whole, and re-recording the other 26 documents to get 15 is
 * money spent on nothing.
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

const args = process.argv.slice(2);
const suiteAt = args.findIndex((a) => a === '--suite' || a.startsWith('--suite='));
let suite: string | undefined;
if (suiteAt !== -1) {
  const inline = args[suiteAt] as string;
  suite = inline.startsWith('--suite=') ? inline.slice('--suite='.length) : args[suiteAt + 1];
  if (suite === undefined || suite === '') {
    console.error('--suite needs a suite name, for example `--suite customer`');
    process.exit(1);
  }
  args.splice(suiteAt, inline.startsWith('--suite=') ? 1 : 2);
}
const filter = args[0];

const everything = everyDocument();
const documents = everything.filter(
  (d) =>
    (filter === undefined || d.key.includes(filter)) && (suite === undefined || d.suite === suite),
);

if (documents.length === 0) {
  const asked = [
    ...(suite !== undefined ? [`suite ${JSON.stringify(suite)}`] : []),
    ...(filter !== undefined ? [`key containing ${JSON.stringify(filter)}`] : []),
  ].join(' and ');
  console.error(
    `no fixture documents match ${asked}. Suites: ${[...new Set(everything.map((d) => d.suite))].sort().join(', ')}`,
  );
  process.exit(1);
}

console.log(
  `recording ${documents.length} of ${everything.length} fixture documents` +
    `${suite !== undefined ? ` in suite ${suite}` : ''}${filter !== undefined ? ` matching ${filter}` : ''}`,
);

const classifier = new ClaudeClassifier();
const extractor = new ClaudeExtractor();

/** A page that arrives with no text of its own: a scan, a photograph. */
const needsOcr = (fixture: (typeof everything)[number]): boolean =>
  fixture.pageText.length === 0 || fixture.pageText.every((t) => t.trim() === '');

const ocr = ocrFromEnv();
const withoutTextLayer = documents.filter(needsOcr);
if (ocr === undefined) {
  if (withoutTextLayer.length === 0) {
    // Nothing here needs OCR, so the missing key costs this run nothing.
    console.warn(
      'note: REDUCTO_API_KEY is not set. Nothing in this selection needs OCR — every ' +
        'document here carries its own text layer.',
    );
  } else {
    // A cassette recorded with an empty text layer is worse than no cassette:
    // no quote can be verified against a blank page, so the eval would score
    // the document as if it had been read. These are refused, one by one,
    // below.
    console.error(
      `REDUCTO_API_KEY is not set, and ${withoutTextLayer.length} of these ${documents.length} ` +
        'documents have no text layer of their own:\n' +
        `  ${withoutTextLayer.map((d) => d.key).join(', ')}\n` +
        'They will be refused rather than recorded blank. Set REDUCTO_API_KEY to record them.',
    );
  }
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
  if (needsOcr(fixture)) {
    if (ocr === undefined) {
      console.error(
        '  ocr       REFUSED   this page has no text layer and no OcrProvider is ' +
          'configured. Set REDUCTO_API_KEY and re-run; nothing was recorded for it.',
      );
      process.exitCode = 1;
      continue;
    }
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
      // Same reason as a missing provider: reading on would spend money on a
      // blank page and record it as a document somebody read.
      console.error(
        `  ocr       FAILED ${error instanceof OcrError ? error.message : String(error)}`,
      );
      process.exitCode = 1;
      continue;
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

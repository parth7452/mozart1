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
 *   pnpm record:cassettes --classify-only     # re-ask the classifier, nothing else
 *   pnpm record:cassettes --extract-only      # re-ask the extractor, nothing else
 *   pnpm record:cassettes --doc-type deduction_notice   # only documents of one type
 *
 * The suite filter exists because a suite is the unit that gets recorded: a new
 * corpus lands whole, and re-recording the other 26 documents to get 15 is
 * money spent on nothing.
 *
 * `--classify-only` exists because the classifier's prompt is shared by every
 * document, so a change to it is a question about all of them — and a full
 * re-record answers a different question too. It re-runs OCR and extraction,
 * whose own variation then moves field scores the change never touched, in
 * suites where one field is more than the eval's tolerance. This re-asks the
 * classifier and rewrites `classifiedAs`, `classifierConfidence` and the stamp
 * saying what answered them; the extraction, its cost and the OCR pages stay
 * byte for byte as recorded. A scan is shown the OCR text its cassette already
 * holds — the text the classifier saw when it was recorded — so no OCR provider
 * is called. It refuses a document with no cassette: there is nothing to keep.
 *
 * `--extract-only` is the same idea from the other side, for a change to what
 * the extractor is asked — a field added to a document type, a description
 * sharpened. It re-reads each document against its expected type and replaces
 * the extraction, its cost and its model; the classification, its stamp and
 * the OCR pages and blocks stay as recorded. A scan is read with the OCR text
 * its cassette already holds, so no OCR provider is called and no Reducto key
 * is needed, and its quotes are checked against the same text layer they were
 * before. It refuses a document with no cassette, and a scan whose cassette
 * holds no OCR, for the same reasons `--classify-only` does. `--doc-type` is
 * its natural companion: a schema change is a change to one type, and the
 * other types' readings are not what it asked about.
 *
 * Every extraction recorded — in full or with `--extract-only` — carries an
 * `extractor` stamp saying what produced it, so `pnpm eval` can name the
 * readings this checkout's extractor did not give, as it does classifications.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import 'dotenv/config';
import {
  ClaudeClassifier,
  ClaudeExtractor,
  ExtractionError,
  classifierPromptSha256,
  classifyTemperatureFor,
  extractorPromptSha256,
  groundingReport,
  SCHEMA_VERSION,
  locateQuote,
  modelFor,
  ocrFromEnv,
  OcrError,
  withClassification,
  type Cassette,
  type ClassificationResult,
  type ClassifierStamp,
  type ExtractorStamp,
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
const classifyOnlyAt = args.indexOf('--classify-only');
const classifyOnly = classifyOnlyAt !== -1;
if (classifyOnly) args.splice(classifyOnlyAt, 1);
const extractOnlyAt = args.indexOf('--extract-only');
const extractOnly = extractOnlyAt !== -1;
if (extractOnly) args.splice(extractOnlyAt, 1);
if (classifyOnly && extractOnly) {
  console.error(
    '--classify-only and --extract-only each keep what the other re-asks; together they ' +
      'are a full recording. Run without either for that.',
  );
  process.exit(1);
}
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
const docTypeAt = args.findIndex((a) => a === '--doc-type' || a.startsWith('--doc-type='));
let docTypeFilter: string | undefined;
if (docTypeAt !== -1) {
  const inline = args[docTypeAt] as string;
  docTypeFilter = inline.startsWith('--doc-type=')
    ? inline.slice('--doc-type='.length)
    : args[docTypeAt + 1];
  if (docTypeFilter === undefined || docTypeFilter === '') {
    console.error('--doc-type needs a document type, for example `--doc-type deduction_notice`');
    process.exit(1);
  }
  args.splice(docTypeAt, inline.startsWith('--doc-type=') ? 1 : 2);
}
if (args.length > 1 || (args[0] !== undefined && args[0].startsWith('--'))) {
  // One key filter at most. A second word used to be dropped without a sound,
  // which on a paid run means paying for a selection nobody asked for.
  console.error(
    `unexpected arguments: ${args.join(' ')}. Give at most one key filter, plus --suite, ` +
      '--doc-type, --classify-only or --extract-only.',
  );
  process.exit(1);
}
const filter = args[0];

const everything = everyDocument();
if (docTypeFilter !== undefined && !everything.some((d) => d.docType === docTypeFilter)) {
  console.error(
    `no fixture document is of type ${JSON.stringify(docTypeFilter)}. Types: ` +
      `${[...new Set(everything.map((d) => d.docType))].sort().join(', ')}`,
  );
  process.exit(1);
}
const documents = everything.filter(
  (d) =>
    (filter === undefined || d.key.includes(filter)) &&
    (suite === undefined || d.suite === suite) &&
    (docTypeFilter === undefined || d.docType === docTypeFilter),
);

if (documents.length === 0) {
  const asked = [
    ...(suite !== undefined ? [`suite ${JSON.stringify(suite)}`] : []),
    ...(docTypeFilter !== undefined ? [`type ${JSON.stringify(docTypeFilter)}`] : []),
    ...(filter !== undefined ? [`key containing ${JSON.stringify(filter)}`] : []),
  ].join(' and ');
  console.error(
    `no fixture documents match ${asked}. Suites: ${[...new Set(everything.map((d) => d.suite))].sort().join(', ')}`,
  );
  process.exit(1);
}

console.log(
  `${classifyOnly ? 're-classifying' : extractOnly ? 're-extracting' : 'recording'} ` +
    `${documents.length} of ${everything.length} fixture documents` +
    `${suite !== undefined ? ` in suite ${suite}` : ''}` +
    `${docTypeFilter !== undefined ? ` of type ${docTypeFilter}` : ''}` +
    `${filter !== undefined ? ` matching ${filter}` : ''}`,
);

const classifier = new ClaudeClassifier();

/** What answered a classification, written onto the cassette beside it. */
const stampFor = (classification: ClassificationResult): ClassifierStamp => ({
  model: classification.call.modelVersion,
  promptSha256: classifierPromptSha256(),
  temperature: classifyTemperatureFor(classification.call.modelVersion),
  classifiedAt: new Date().toISOString(),
});

/** What produced an extraction, written onto the cassette beside it. */
const extractorStampFor = (docType: DocType, modelVersion: string): ExtractorStamp => ({
  model: modelVersion,
  promptSha256: extractorPromptSha256(docType),
  schemaVersion: SCHEMA_VERSION,
  extractedAt: new Date().toISOString(),
});

/**
 * The payload a fixture is read as. Fixtures go through the same front door as
 * the real thing — which for a notice that arrived in a message is not the
 * upload door. Sniffing magic bytes on text the mail server already parsed
 * would be checking the wrong thing, so the email-body gate applies instead.
 */
function payloadFor(fixture: (typeof everything)[number]): DocumentPayload {
  const accepted =
    fixture.mimeType === 'text/plain'
      ? acceptEmailBody(new TextDecoder().decode(fixture.bytes)).accepted
      : acceptUpload(fixture.bytes, fixture.filename);
  return {
    documentId: fixture.key,
    orgId: 'fixture-org',
    filename: fixture.filename,
    mimeType: accepted.mimeType,
    base64: Buffer.from(fixture.bytes).toString('base64'),
    byteSize: accepted.byteSize,
    pageText: fixture.pageText,
  };
}

/** A page that arrives with no text of its own: a scan, a photograph. */
const needsOcr = (fixture: (typeof everything)[number]): boolean =>
  fixture.pageText.length === 0 || fixture.pageText.every((t) => t.trim() === '');

if (classifyOnly) {
  let spent = 0;
  let disagreed = 0;
  let changed = 0;
  for (const fixture of documents) {
    const file = path.join(cassetteDir, `${fixture.key}.json`);
    process.stdout.write(`\n=== ${fixture.key} (${fixture.filename})\n`);
    if (!existsSync(file)) {
      console.error(
        '  classify  REFUSED   no cassette to re-classify. Record this document in full ' +
          '(without --classify-only); nothing was written for it.',
      );
      process.exitCode = 1;
      continue;
    }
    const recorded = JSON.parse(readFileSync(file, 'utf8')) as Cassette;
    if (needsOcr(fixture) && recorded.ocr === undefined) {
      // The classifier would see the image with no text beside it, which is
      // not what it saw when this was recorded, so the answer would not be
      // comparable with the one it replaces.
      console.error(
        '  classify  REFUSED   this page has no text layer and its cassette holds no OCR ' +
          'pages. Record it in full; nothing was written for it.',
      );
      process.exitCode = 1;
      continue;
    }
    const ocrPages = recorded.ocr?.pages.map((page) => page.text);
    const payload: DocumentPayload = {
      ...payloadFor(fixture),
      ...(ocrPages !== undefined ? { pageText: ocrPages, pageTextSource: 'ocr' as const } : {}),
    };
    try {
      const classification = await classifier.classify(payload);
      spent += classification.call.costMicros;
      const agreed = classification.docType === fixture.docType;
      if (!agreed) disagreed += 1;
      const moved =
        classification.docType !== recorded.classifiedAs ||
        classification.confidence !== recorded.classifierConfidence;
      if (moved) changed += 1;
      console.log(
        `  classify  ${classification.docType} @ ${classification.confidence.toFixed(2)} ` +
          `${agreed ? '✓' : `✗ expected ${fixture.docType}`} ` +
          `(was ${recorded.classifiedAs} @ ${recorded.classifierConfidence.toFixed(2)}; ` +
          `${classification.call.latencyMs}ms, ${classification.call.costMicros}µ$)`,
      );
      writeFileSync(
        file,
        `${JSON.stringify(withClassification(recorded, classification, stampFor(classification)), null, 2)}\n`,
      );
    } catch (error) {
      if (error instanceof ExtractionError) {
        spent += error.call.costMicros;
        console.error(`  FAILED    ${error.message} [${error.call.outcome}]`);
      } else {
        console.error(`  FAILED    ${error instanceof Error ? error.message : String(error)}`);
      }
      process.exitCode = 1;
    }
  }
  console.log(
    `\ntotal ${(spent / 1_000_000).toFixed(4)} USD across ${documents.length} documents, ` +
      `${changed} answer(s) moved, ${disagreed} classification mismatch(es). ` +
      'Extraction, OCR and their costs were not touched; run `pnpm eval` next.',
  );
  process.exit();
}

const extractor = new ClaudeExtractor();

if (extractOnly) {
  let spent = 0;
  for (const fixture of documents) {
    const file = path.join(cassetteDir, `${fixture.key}.json`);
    process.stdout.write(`\n=== ${fixture.key} (${fixture.filename})\n`);
    if (!existsSync(file)) {
      console.error(
        '  extract   REFUSED   no cassette to re-extract. Record this document in full ' +
          '(without --extract-only); nothing was written for it.',
      );
      process.exitCode = 1;
      continue;
    }
    const recorded = JSON.parse(readFileSync(file, 'utf8')) as Cassette;
    if (needsOcr(fixture) && recorded.ocr === undefined) {
      // Its quotes would be checked against a blank page, and the eval would
      // score it as if it had been read.
      console.error(
        '  extract   REFUSED   this page has no text layer and its cassette holds no OCR ' +
          'pages. Record it in full; nothing was written for it.',
      );
      process.exitCode = 1;
      continue;
    }
    const ocrPages = recorded.ocr?.pages.map((page) => page.text);
    const payload: DocumentPayload = {
      ...payloadFor(fixture),
      ...(ocrPages !== undefined ? { pageText: ocrPages, pageTextSource: 'ocr' as const } : {}),
    };
    try {
      // Against the expected type, as a full recording does.
      const extraction = await extractor.extract(payload, fixture.docType as DocType);
      spent += extraction.call.costMicros;
      const blocks: readonly OcrBlock[] = recorded.ocr?.blocks ?? [];
      const boxed =
        blocks.length === 0
          ? 0
          : extraction.fields.filter(
              (f) => locateQuote(f.sourceQuote, f.sourcePage, blocks) !== undefined,
            ).length;
      const grounding = groundingReport(extraction.fields);
      console.log(
        `  extract   ${extraction.fields.length} fields, ` +
          `${grounding.verified} quotes verified, ${grounding.ungrounded} ungrounded` +
          `${blocks.length > 0 ? `, ${boxed} boxed` : ''} ` +
          `(was ${recorded.call.costMicros}µ$; now ${extraction.call.latencyMs}ms, ` +
          `${extraction.call.costMicros}µ$, ` +
          `${extraction.call.inputTokens}in/${extraction.call.outputTokens}out)`,
      );
      // Spread first, so every key keeps its place and only these four move.
      const cassette: Cassette = {
        ...recorded,
        document: extraction.document,
        extractor: extractorStampFor(fixture.docType as DocType, extraction.call.modelVersion),
        recordedWith: modelFor('extract'),
        recordedAt: new Date().toISOString(),
        call: {
          modelVersion: extraction.call.modelVersion,
          inputTokens: extraction.call.inputTokens ?? 0,
          outputTokens: extraction.call.outputTokens ?? 0,
          costMicros: extraction.call.costMicros,
          latencyMs: extraction.call.latencyMs,
        },
      };
      writeFileSync(file, `${JSON.stringify(cassette, null, 2)}\n`);
    } catch (error) {
      if (error instanceof ExtractionError) {
        spent += error.call.costMicros;
        console.error(`  FAILED    ${error.message} [${error.call.outcome}]`);
      } else {
        console.error(`  FAILED    ${error instanceof Error ? error.message : String(error)}`);
      }
      process.exitCode = 1;
    }
  }
  console.log(
    `\ntotal ${(spent / 1_000_000).toFixed(4)} USD across ${documents.length} documents. ` +
      'Classification, OCR and their costs were not touched; run `pnpm eval` next.',
  );
  process.exit();
}

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
  let payload = payloadFor(fixture);

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
      classifier: stampFor(classification),
      document: extraction.document,
      extractor: extractorStampFor(fixture.docType as DocType, extraction.call.modelVersion),
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

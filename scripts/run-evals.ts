/**
 * The eval gate (plan §18).
 *
 * Replays recorded cassettes through the same flatten + quote-verify code
 * production uses, scores them against ground truth, and fails when a metric
 * regresses beyond tolerance. No model is called and nothing is spent.
 *
 *   pnpm eval                  # score and compare against the baseline
 *   pnpm eval --record-baseline  # write a new baseline (a reviewed decision)
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { classificationIsActionable } from '@recouple/core-domain';
import {
  CassetteClassifier,
  CassetteExtractor,
  locateQuote,
  modelFor,
  type Cassette,
  type DocType,
  type DocumentPayload,
} from '@recouple/extraction';
import { everyDocument } from '@recouple/fixtures';
import {
  DEFAULT_TOLERANCE,
  findRegressions,
  scoreDocument,
  summarise,
  toBaseline,
  type Baseline,
  type DocumentScore,
} from '@recouple/evals';

const here = path.dirname(fileURLToPath(import.meta.url));
const cassetteDir = path.join(here, '..', 'packages', 'fixtures', 'cassettes');
const baselinePath = path.join(here, '..', 'packages', 'evals', 'baseline.json');
const recordBaseline = process.argv.includes('--record-baseline');

const cassettes = new Map<string, Cassette>();
if (existsSync(cassetteDir)) {
  for (const file of readdirSync(cassetteDir).filter((f) => f.endsWith('.json'))) {
    const cassette = JSON.parse(readFileSync(path.join(cassetteDir, file), 'utf8')) as Cassette;
    cassettes.set(cassette.key, cassette);
  }
}

const documents = everyDocument().filter((d) => cassettes.has(d.key));

if (documents.length === 0) {
  console.error(
    'No cassettes recorded yet, so there is nothing to score.\n' +
      'Record them with `pnpm record:cassettes` (this calls the API and costs money),\n' +
      'then re-run `pnpm eval`.',
  );
  // Not a failure: an empty corpus is a state to fix, not a regression to block on.
  process.exit(0);
}

// Cassettes are keyed by fixture key, which is what the payload's documentId carries.
const extractor = new CassetteExtractor(cassettes, (d) => d.documentId);
const classifier = new CassetteClassifier(cassettes, (d) => d.documentId);

const scores: DocumentScore[] = [];
const suiteOf = new Map<string, string>();
let classifiedCorrectly = 0;
let recordedCostMicros = 0;
const classifiedBySuite = new Map<
  string,
  { correct: number; total: number; unsafe: number }
>();
const unsafeDetail: string[] = [];
let boxedFields = 0;
let totalFields = 0;

for (const fixture of documents) {
  suiteOf.set(fixture.key, fixture.suite);
  // A scan's text layer is the one OCR produced; replaying it means the score
  // covers the whole pipeline rather than extraction in isolation (ADR 0009).
  const cassette = cassettes.get(fixture.key);
  const ocrPages = cassette?.ocr?.pages.map((page) => page.text);
  const payload: DocumentPayload = {
    documentId: fixture.key,
    orgId: 'eval',
    filename: fixture.filename,
    mimeType: fixture.mimeType,
    base64: '',
    byteSize: fixture.bytes.length,
    pageText: ocrPages ?? fixture.pageText,
    ...(ocrPages !== undefined ? { pageTextSource: 'ocr' as const } : {}),
  };

  const classification = await classifier.classify(payload);
  const correct = classification.docType === fixture.docType;
  if (correct) classifiedCorrectly += 1;
  // A wrong answer the confidence gate would have let through is the expensive
  // kind; a wrong answer below the floor gets routed to a human.
  const unsafe = !correct && classificationIsActionable(classification.confidence);
  if (unsafe) {
    unsafeDetail.push(
      `${fixture.key}: classified ${classification.docType} (expected ${fixture.docType}) at ${classification.confidence.toFixed(2)} — above the review floor`,
    );
  } else if (!correct) {
    unsafeDetail.push(
      `${fixture.key}: classified ${classification.docType} (expected ${fixture.docType}) at ${classification.confidence.toFixed(2)} — below the review floor, routed to a human`,
    );
  }
  const tally = classifiedBySuite.get(fixture.suite) ?? { correct: 0, total: 0, unsafe: 0 };
  classifiedBySuite.set(fixture.suite, {
    correct: tally.correct + (correct ? 1 : 0),
    total: tally.total + 1,
    unsafe: tally.unsafe + (unsafe ? 1 : 0),
  });

  const extraction = await extractor.extract(payload, fixture.docType as DocType);
  const blocks = cassette?.ocr?.blocks ?? [];
  const fields =
    blocks.length === 0
      ? extraction.fields
      : extraction.fields.map((field) => {
          const block = locateQuote(field.sourceQuote, field.sourcePage, blocks);
          return block === undefined ? field : { ...field, sourceBbox: block.bbox };
        });
  boxedFields += fields.filter((f) => f.sourceBbox !== null).length;
  totalFields += fields.length;
  scores.push(scoreDocument({ key: fixture.key, truth: fixture.truth, fields }));
  recordedCostMicros += cassette?.call.costMicros ?? 0;
  recordedCostMicros += Math.round((cassette?.ocr?.credits ?? 0) * 1_000);
}

const suite = summarise(scores, {
  classificationAccuracy: classifiedCorrectly / documents.length,
  totalCostMicros: recordedCostMicros,
});

const pct = (n: number | null) => (n === null ? '   —' : `${(n * 100).toFixed(1)}%`);

const SUITE_LABELS: Record<string, string> = {
  authored: 'authored here — does the pipeline work',
  held_out: 'written elsewhere — does it generalise',
  scanned: 'rasterised + degraded — does it survive a scan',
  dense: 'dozens of rows — does it survive a real remittance',
};

const perSuite = new Map<string, ReturnType<typeof summarise>>();

for (const suiteName of ['authored', 'held_out', 'scanned', 'dense']) {
  const suiteScores = scores.filter((s) => suiteOf.get(s.key) === suiteName);
  if (suiteScores.length === 0) continue;
  const tally = classifiedBySuite.get(suiteName);
  const summary = summarise(suiteScores, {
    classificationAccuracy: tally === undefined ? null : tally.correct / tally.total,
  });
  perSuite.set(suiteName, summary);

  console.log(`\n${suiteName.toUpperCase()}  (${SUITE_LABELS[suiteName] ?? ''})`);
  console.log('document                       recall  precis  ground  wrong  missing');
  console.log('─'.repeat(72));
  for (const score of suiteScores) {
    console.log(
      `${score.key.padEnd(30)} ${pct(score.recall)}  ${pct(score.precision)}  ` +
        `${pct(score.groundedRate)}  ${String(score.wrong).padStart(5)}  ${String(score.missing).padStart(7)}`,
    );
  }
  console.log('─'.repeat(72));
  console.log(
    `${'subtotal'.padEnd(30)} ${pct(summary.recall)}  ${pct(summary.precision)}  ` +
      `${pct(summary.groundedRate)}   classification ${pct(summary.classificationAccuracy)}` +
      `${tally !== undefined && tally.unsafe > 0 ? `  (${tally.unsafe} above the review floor)` : ''}`,
  );
}

console.log(
  `\noverall ${pct(suite.recall)} recall · ${pct(suite.precision)} precision · ` +
    `${pct(suite.groundedRate)} grounded · classification ${pct(suite.classificationAccuracy)}`,
);
console.log(
  `recorded cost $${(suite.totalCostMicros / 1_000_000).toFixed(4)} across ${documents.length} documents ` +
    `($${(suite.totalCostMicros / 1_000_000 / documents.length).toFixed(4)} each, plus OCR credits where used)`,
);
console.log(
  `${boxedFields} of ${totalFields} fields carry a bounding box a reviewer can follow`,
);

if (unsafeDetail.length > 0) {
  console.log('\nclassification misses:');
  for (const line of unsafeDetail) console.log(`  ${line}`);
}

console.log();
for (const score of scores) {
  for (const field of score.fields.filter((f) => f.outcome !== 'correct')) {
    console.log(
      `  ${score.key} ${field.fieldPath}: expected ${field.expected}, got ${field.actual}` +
        `${field.quoteVerified === false ? ' [quote not on page]' : ''}`,
    );
  }
}

const suiteRecord = Object.fromEntries(perSuite);

if (recordBaseline) {
  const baseline = toBaseline(suite, modelFor('extract'), suiteRecord);
  writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`\nbaseline written to packages/evals/baseline.json`);
  process.exit(0);
}

if (!existsSync(baselinePath)) {
  console.log('\nNo baseline recorded yet. Record one with `pnpm eval --record-baseline`.');
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline;
const regressions = findRegressions(baseline, DEFAULT_TOLERANCE, suiteRecord);

if (baseline.extractModel !== modelFor('extract')) {
  console.log(
    `\nnote: baseline was recorded with ${baseline.extractModel}, this run used ${modelFor('extract')}`,
  );
}

if (regressions.length > 0) {
  console.error(`\nREGRESSION (tolerance ${DEFAULT_TOLERANCE}):`);
  for (const r of regressions) {
    console.error(
      `  ${r.metric}: ${(r.baseline * 100).toFixed(1)}% → ${(r.current * 100).toFixed(1)}% (−${(r.drop * 100).toFixed(1)} points)`,
    );
  }
  console.error('\nFix the code. Do not move the baseline to make this pass.');
  process.exit(1);
}

console.log('\nno regression against the recorded baseline');

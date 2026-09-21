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

const allDocuments = everyDocument();
const documents = allDocuments.filter((d) => cassettes.has(d.key));

/**
 * Suites whose fixtures exist and whose cassettes do not.
 *
 * Recording costs money and needs API keys, so a suite can land before its
 * numbers do. That is a state to report, not a regression to fail on — but it
 * has to be *reported*, because the alternative is a suite that looks wired and
 * is silently scoring nothing (which is exactly what happened to LOG-001).
 */
const recordedBySuite = new Map<string, { recorded: number; total: number }>();
for (const fixture of allDocuments) {
  const tally = recordedBySuite.get(fixture.suite) ?? { recorded: 0, total: 0 };
  recordedBySuite.set(fixture.suite, {
    recorded: tally.recorded + (cassettes.has(fixture.key) ? 1 : 0),
    total: tally.total + 1,
  });
}
const unrecordedSuites = [...recordedBySuite]
  .filter(([, tally]) => tally.recorded === 0)
  .map(([name, tally]) => [name, tally.total] as const);

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
  email_body: 'no page at all — a notice pasted into a message',
  logistics: 'one freight case across five documents — does the argument hold',
  customer: 'photographed staffing and freight cases — does it work off a phone camera',
};

/**
 * Display order. Every suite in the corpus is reported, in this order where it
 * is named and after it otherwise — a suite is never left out of this list by
 * being forgotten, only by having no cassettes.
 */
const SUITE_ORDER = [
  'authored',
  'held_out',
  'scanned',
  'dense',
  'email_body',
  'logistics',
  'customer',
];
const scoredSuites = [...new Set(scores.map((s) => suiteOf.get(s.key) ?? 'unknown'))].sort(
  (a, b) => {
    const rank = (name: string) =>
      SUITE_ORDER.indexOf(name) === -1 ? SUITE_ORDER.length : SUITE_ORDER.indexOf(name);
    return rank(a) - rank(b) || a.localeCompare(b);
  },
);

const perSuite = new Map<string, ReturnType<typeof summarise>>();

for (const suiteName of scoredSuites) {
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

const recordCommand = (suiteName: string) => `pnpm record:cassettes --suite ${suiteName}`;

if (unrecordedSuites.length > 0) {
  console.log('\nnot yet recorded — skipped, not failed:');
  for (const [name, total] of unrecordedSuites) {
    console.log(
      `  ${name.padEnd(12)} ${String(total).padStart(2)} documents, no cassettes. ` +
        `Record with \`${recordCommand(name)}\` ` +
        '(this calls the API and spends money), then `pnpm eval --record-baseline`.',
    );
  }
}

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
// Written into the baseline so the file itself says which suites have never
// been measured, rather than a reader inferring it from a missing row.
const pendingRecord = Object.fromEntries(
  unrecordedSuites.map(([name, total]) => [
    name,
    `not yet recorded: ${total} fixture documents, no cassettes. ` +
      `\`${recordCommand(name)}\` needs ANTHROPIC_API_KEY, ` +
      'and REDUCTO_API_KEY for any document with no text layer.',
  ]),
);

if (recordBaseline) {
  const baseline = toBaseline(suite, modelFor('extract'), suiteRecord, pendingRecord);
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

// A suite that scored but has no baseline row is reported, not gated — there is
// nothing to compare it against yet. Saying so out loud is the point: an
// ungated suite is easy to mistake for a passing one.
const ungated = scoredSuites.filter((name) => (baseline.suites ?? {})[name] === undefined);
if (ungated.length > 0) {
  console.log(
    `\nnote: ${ungated.join(', ')} scored here but ${ungated.length === 1 ? 'has' : 'have'} no baseline row, ` +
      'so nothing gates them. Look at the numbers, then `pnpm eval --record-baseline`.',
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

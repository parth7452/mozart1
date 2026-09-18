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
import {
  CassetteClassifier,
  CassetteExtractor,
  modelFor,
  type Cassette,
  type DocType,
  type DocumentPayload,
} from '@recouple/extraction';
import { allFixtureDocuments } from '@recouple/fixtures';
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

const documents = allFixtureDocuments().filter((d) => cassettes.has(d.key));

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
let classifiedCorrectly = 0;
let recordedCostMicros = 0;

for (const fixture of documents) {
  const payload: DocumentPayload = {
    documentId: fixture.key,
    orgId: 'eval',
    filename: fixture.filename,
    mimeType: fixture.mimeType,
    base64: '',
    byteSize: fixture.bytes.length,
    pageText: fixture.pageText,
  };

  const classification = await classifier.classify(payload);
  if (classification.docType === fixture.docType) classifiedCorrectly += 1;

  const extraction = await extractor.extract(payload, fixture.docType as DocType);
  scores.push(scoreDocument({ key: fixture.key, truth: fixture.truth, fields: extraction.fields }));
  recordedCostMicros += cassettes.get(fixture.key)?.call.costMicros ?? 0;
}

const suite = summarise(scores, {
  classificationAccuracy: classifiedCorrectly / documents.length,
  totalCostMicros: recordedCostMicros,
});

const pct = (n: number | null) => (n === null ? '   —' : `${(n * 100).toFixed(1)}%`);

console.log('\nfixture                        recall  precis  ground  wrong  missing');
console.log('─'.repeat(72));
for (const score of scores) {
  console.log(
    `${score.key.padEnd(30)} ${pct(score.recall)}  ${pct(score.precision)}  ` +
      `${pct(score.groundedRate)}  ${String(score.wrong).padStart(5)}  ${String(score.missing).padStart(7)}`,
  );
}
console.log('─'.repeat(72));
console.log(
  `${'suite'.padEnd(30)} ${pct(suite.recall)}  ${pct(suite.precision)}  ${pct(suite.groundedRate)}`,
);
console.log(
  `classification ${pct(suite.classificationAccuracy)} · recorded cost ` +
    `$${(suite.totalCostMicros / 1_000_000).toFixed(4)} across ${documents.length} documents`,
);

for (const score of scores) {
  for (const field of score.fields.filter((f) => f.outcome !== 'correct')) {
    console.log(
      `  ${score.key} ${field.fieldPath}: expected ${field.expected}, got ${field.actual}` +
        `${field.quoteVerified === false ? ' [quote not on page]' : ''}`,
    );
  }
}

if (recordBaseline) {
  const baseline = toBaseline(suite, modelFor('extract'));
  writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`\nbaseline written to packages/evals/baseline.json`);
  process.exit(0);
}

if (!existsSync(baselinePath)) {
  console.log('\nNo baseline recorded yet. Record one with `pnpm eval --record-baseline`.');
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline;
const regressions = findRegressions(baseline, suite);

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

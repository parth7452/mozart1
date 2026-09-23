/**
 * The eval gate (plan §18).
 *
 * Replays recorded cassettes through the same flatten + quote-verify code
 * production uses, scores them against ground truth, and fails when a metric
 * regresses beyond tolerance. No model is called and nothing is spent.
 *
 *   pnpm eval                  # score and compare against the baseline
 *   pnpm eval --record-baseline  # write a new baseline (a reviewed decision)
 *   pnpm eval --record-pending   # refresh only `pendingSuites`, no metric moves
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { classificationIsActionable } from '@recouple/core-domain';
import { opensCaseOnItsOwn } from '@recouple/pipeline';
import {
  CassetteClassifier,
  CassetteExtractor,
  classificationIsCurrent,
  classifierPromptSha256,
  locateQuote,
  modelFor,
  type Cassette,
  type DocType,
  type DocumentPayload,
} from '@recouple/extraction';
import { everyDocument } from '@recouple/fixtures';
import {
  DEFAULT_TOLERANCE,
  findCoverageShortfalls,
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
/**
 * Rewrites `pendingSuites` and nothing else.
 *
 * A suite can land without its cassettes, and `pendingSuites` is what stops a
 * suite with no numbers reading like a suite that passed. Keeping it current
 * used to mean `--record-baseline`, which rewrites every metric in the file —
 * so the honest bookkeeping and the one edit a baseline may never make were the
 * same command, and the bookkeeping is what got skipped. This does the
 * bookkeeping alone: every other key is read and written back exactly as it
 * was, and a diff that touches anything but `pendingSuites` is a bug in this.
 */
const recordPending = process.argv.includes('--record-pending');

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
 * The recorded baseline, read before anything is reported rather than after.
 *
 * What the baseline has already measured decides how an unrecorded suite is
 * described: a suite nobody has ever scored is skipped, and a suite the
 * baseline scored and this run cannot is a hole in the run. Telling them apart
 * needs the baseline in hand at the point the report is written.
 */
const baseline: Baseline | null = existsSync(baselinePath)
  ? (JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline)
  : null;
const baselinedSuites = new Set(Object.keys(baseline?.suites ?? {}));

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
// Only a suite the baseline has never seen may be called skipped. One the
// baseline has measured and this run has not is a coverage shortfall, gated
// below — never a line in the "skipped, not failed" list, which is the line a
// reader takes as permission to ignore it.
const skippedSuites = unrecordedSuites.filter(([name]) => !baselinedSuites.has(name));

if (documents.length === 0) {
  console.error(
    'No cassettes recorded yet, so there is nothing to score.\n' +
      'Record them with `pnpm record:cassettes` (this calls the API and costs money),\n' +
      'then re-run `pnpm eval`.',
  );
  if (baselinedSuites.size > 0) {
    console.error(
      `\nThe baseline has measured ${[...baselinedSuites].join(', ')}, so an empty run is a\n` +
        'coverage loss rather than a fresh start. Restore the cassettes and re-run.',
    );
    process.exit(1);
  }
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
  // kind. Below the floor, what happens depends on what it was read as: only a
  // notice or a remittance opens a case on its own, so only those are held for
  // a person (ADR 0044). Evidence opens nothing at any confidence, and the line
  // says so rather than claiming a review that does not happen. Printed text
  // only — `unsafe`, which is what is scored, is unchanged.
  const unsafe = !correct && classificationIsActionable(classification.confidence);
  if (unsafe) {
    unsafeDetail.push(
      `${fixture.key}: classified ${classification.docType} (expected ${fixture.docType}) at ${classification.confidence.toFixed(2)} — above the review floor`,
    );
  } else if (!correct) {
    unsafeDetail.push(
      `${fixture.key}: classified ${classification.docType} (expected ${fixture.docType}) at ${classification.confidence.toFixed(2)} — below the review floor, ` +
        (opensCaseOnItsOwn(classification.docType)
          ? 'held for a person rather than opening a case'
          : 'which gates nothing here: only a notice or a remittance is held, and this opens no case either way'),
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
  authored_pending: 'authored here, no cassette yet — shapes the numbers do not cover',
  held_out: 'written elsewhere — does it generalise',
  scanned: 'rasterised + degraded — does it survive a scan',
  dense: 'dozens of rows — does it survive a real remittance',
  email_body: 'no page at all — a notice pasted into a message',
  logistics: 'one freight case across five documents — does the argument hold',
  customer: 'simulated camera pages — does a staffing or freight case survive one',
};

/**
 * Display order. Every suite in the corpus is reported, in this order where it
 * is named and after it otherwise — a suite is never left out of this list by
 * being forgotten, only by having no cassettes.
 */
const SUITE_ORDER = [
  'authored',
  'authored_pending',
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

if (skippedSuites.length > 0) {
  console.log('\nnot yet recorded — skipped, not failed:');
  for (const [name, total] of skippedSuites) {
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

/**
 * Classifications this checkout's classifier did not give.
 *
 * Replay hands back what the classifier said when a cassette was recorded, so a
 * prompt change moves no number above: the old answers read as the new
 * prompt's score. Reported, not gated. Gating would fail every run until the
 * whole corpus is re-classified, which is a decision about CI for a person to
 * make, and the first step is that nobody has to infer it from dates.
 */
const classifyModel = modelFor('classify');
const unstamped = documents.filter((d) => cassettes.get(d.key)?.classifier === undefined);
const stale = documents.filter((d) => {
  const cassette = cassettes.get(d.key);
  return (
    cassette?.classifier !== undefined && !classificationIsCurrent(cassette, classifyModel)
  );
});
if (unstamped.length > 0 || stale.length > 0) {
  console.log(
    `\nnote: ${unstamped.length + stale.length} of ${documents.length} classifications replayed here ` +
      `were not given by this checkout's classifier\n` +
      `(${classifyModel}, prompt ${classifierPromptSha256().slice(0, 12)}): ` +
      `${unstamped.length} record nothing about what answered them, ` +
      `${stale.length} were answered by another model or prompt.\n` +
      "The classification numbers above are theirs, not this prompt's. Re-ask with\n" +
      '`pnpm record:cassettes --classify-only` (spends money: one classifier call a document,\n' +
      'no OCR, no extraction), then `pnpm eval`.',
  );
  for (const d of stale) console.log(`  ${d.key}`);
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
  skippedSuites.map(([name, total]) => [
    name,
    `not yet recorded: ${total} fixture documents, no cassettes. ` +
      `\`${recordCommand(name)}\` needs ANTHROPIC_API_KEY, ` +
      'and REDUCTO_API_KEY for any document with no text layer.',
  ]),
);

/**
 * Suites the baseline measured that this run measured less of.
 *
 * A suite whose cassettes went missing has no rate left to regress: it drops
 * out of the comparison and every remaining number reads green. So the count
 * is gated too, and a run that scored fewer documents than the baseline did is
 * a failed run — the numbers it printed are about a smaller corpus than the
 * ones it is being compared against.
 */
const shortfalls = baseline === null ? [] : findCoverageShortfalls(baseline, suiteRecord);
const describeShortfall = (s: (typeof shortfalls)[number]): string =>
  `  ${s.suite.padEnd(12)} baseline scored ` +
  `${s.baselineDocuments === null ? 'this suite (no count recorded)' : `${s.baselineDocuments} document(s)`}, ` +
  `this run scored ${s.currentDocuments}.`;

if (recordPending) {
  if (baseline === null) {
    console.error(
      '\nThere is no baseline to refresh. Record one with `pnpm eval --record-baseline` first.',
    );
    process.exit(1);
  }
  // Read again from disk and put the one key back, rather than re-serialising
  // the summarised run: what is not `pendingSuites` has to come out the other
  // side unchanged, and the way to be sure of that is not to touch it.
  const current = JSON.parse(readFileSync(baselinePath, 'utf8')) as Record<string, unknown>;
  current.pendingSuites = pendingRecord;
  writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`);
  const named = Object.keys(pendingRecord);
  console.log(
    `\npendingSuites refreshed in packages/evals/baseline.json: ` +
      `${named.length === 0 ? 'none' : named.join(', ')}`,
  );
  console.log('No metric was touched; the diff should name that key and nothing else.');
  process.exit(0);
}

if (recordBaseline) {
  if (shortfalls.length > 0) {
    // Writing now would erase the rows that prove the gap, which is the one
    // way a baseline may never move (CLAUDE.md).
    console.error(
      '\nREFUSING TO RECORD A BASELINE: a suite the current baseline measured is absent or short.',
    );
    for (const s of shortfalls) console.error(describeShortfall(s));
    console.error(
      '\nRecord the missing cassettes first. If a suite is genuinely gone, take its row\n' +
        'out of packages/evals/baseline.json deliberately, in its own reviewed commit.',
    );
    process.exit(1);
  }
  const recorded = toBaseline(suite, modelFor('extract'), suiteRecord, pendingRecord);
  writeFileSync(baselinePath, `${JSON.stringify(recorded, null, 2)}\n`);
  console.log(`\nbaseline written to packages/evals/baseline.json`);
  process.exit(0);
}

if (baseline === null) {
  console.log('\nNo baseline recorded yet. Record one with `pnpm eval --record-baseline`.');
  process.exit(0);
}

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
      `so nothing gates ${ungated.length === 1 ? 'it' : 'them'}. ` +
      'Look at the numbers, then `pnpm eval --record-baseline`.',
  );
}

if (shortfalls.length > 0) {
  console.error('\nCOVERAGE SHORTFALL: a suite the baseline has measured was not measured here.');
  for (const s of shortfalls) console.error(describeShortfall(s));
  console.error(
    '\nA suite with missing cassettes is not a suite that passed: the rates above are\n' +
      'an average over fewer documents than the baseline they are compared against.\n' +
      'Restore the cassettes (`pnpm record:cassettes --suite <name>`) and re-run.\n' +
      'Do not move the baseline to make this pass.',
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
}

if (shortfalls.length > 0 || regressions.length > 0) process.exit(1);

console.log('\nno regression against the recorded baseline');

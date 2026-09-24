/**
 * Baselines and the regression gate.
 *
 * A recorded baseline is what the suite scored when someone last looked at it.
 * CI fails when a metric drops beyond tolerance. Baselines are never adjusted to
 * make a run pass (CLAUDE.md) — a drop is either a bug to fix or a deliberate,
 * reviewed change.
 */

import type { SuiteScore } from './score';

export interface SuiteBaseline {
  readonly recall: number;
  readonly precision: number;
  readonly groundedRate: number | null;
  readonly classificationAccuracy: number | null;
  /**
   * Wrong classifications the confidence gate would have let through. A wrong
   * notice or remittance below the floor is held for a person (ADR 0044), which
   * is the system working; a confident wrong answer is the one that costs money.
   */
  readonly unsafeMisclassifications?: number;
  /**
   * How many documents this suite scored when the baseline was recorded.
   *
   * A rate says nothing about how much was measured: three cassettes out of
   * four still average 100%, and every metric above would compare clean while
   * a quarter of the suite went unscored. The count is what makes that
   * visible, so `findCoverageShortfalls` can refuse a run that measured less
   * than the baseline did. Optional because baselines recorded before this
   * field existed do not carry it; a suite with no count can still be caught
   * when it disappears entirely, just not when it merely shrinks.
   */
  readonly documents?: number;
}

export interface Baseline {
  readonly recordedAt: string;
  readonly extractModel: string;
  readonly recall: number;
  readonly precision: number;
  readonly groundedRate: number | null;
  readonly classificationAccuracy: number | null;
  readonly totalCostMicros: number;
  /**
   * Per suite, so a drop on the held-out corpus cannot be averaged away by the
   * fixtures we wrote ourselves — which is the drop that would actually matter.
   */
  readonly suites?: Readonly<Record<string, SuiteBaseline>>;
  /**
   * Suites that exist as fixtures and have never been recorded, with the reason.
   *
   * A suite with no cassettes has no numbers, and inventing a row for it would
   * be a baseline that was never measured — the one thing a baseline may not
   * be. Naming it here instead keeps the gap visible: the eval reports it as
   * skipped rather than silently scoring one document fewer, and a suite that
   * is in neither map is an orphan somebody forgot.
   */
  readonly pendingSuites?: Readonly<Record<string, string>>;
}

/** Absolute drop tolerated before a metric counts as a regression. */
export const DEFAULT_TOLERANCE = 0.02;

export interface Regression {
  readonly metric: string;
  readonly baseline: number;
  readonly current: number;
  readonly drop: number;
}

export function toBaseline(
  score: SuiteScore,
  extractModel: string,
  suites: Readonly<Record<string, SuiteScore>> = {},
  pendingSuites: Readonly<Record<string, string>> = {},
): Baseline {
  const perSuite: Record<string, SuiteBaseline> = {};
  for (const [name, suite] of Object.entries(suites)) {
    perSuite[name] = {
      recall: suite.recall,
      precision: suite.precision,
      groundedRate: suite.groundedRate,
      classificationAccuracy: suite.classificationAccuracy,
      documents: suite.documents.length,
    };
  }
  return {
    recordedAt: new Date().toISOString(),
    extractModel,
    recall: score.recall,
    precision: score.precision,
    groundedRate: score.groundedRate,
    classificationAccuracy: score.classificationAccuracy,
    totalCostMicros: score.totalCostMicros,
    ...(Object.keys(perSuite).length > 0 ? { suites: perSuite } : {}),
    ...(Object.keys(pendingSuites).length > 0 ? { pendingSuites } : {}),
  };
}

export function findRegressions(
  baseline: Baseline,
  tolerance = DEFAULT_TOLERANCE,
  currentSuites: Readonly<Record<string, SuiteScore>> = {},
): readonly Regression[] {
  // Rates only, and only for suites that scored this run. How *much* was
  // scored is a different question in a different unit, and a tolerance in
  // points has no opinion about it — `findCoverageShortfalls` answers that one.
  // The gate has to ask both: a suite that vanished has no rate to regress.
  //
  // Gated per suite only. The blended figure across suites of different
  // difficulty moves whenever the corpus mix changes — adding a harder suite
  // drops it without anything having got worse — so it is reported, not gated.
  const pairs: Array<[string, number | null, number | null]> = [];

  // A drop on documents we did not write must not hide behind fixtures we did.
  for (const [name, before] of Object.entries(baseline.suites ?? {})) {
    const after = currentSuites[name];
    if (after === undefined) continue;
    pairs.push(
      [`${name}.recall`, before.recall, after.recall],
      [`${name}.precision`, before.precision, after.precision],
      [`${name}.groundedRate`, before.groundedRate, after.groundedRate],
      [
        `${name}.classificationAccuracy`,
        before.classificationAccuracy,
        after.classificationAccuracy,
      ],
    );
  }

  const regressions: Regression[] = [];
  for (const [metric, before, after] of pairs) {
    if (before === null || after === null) continue;
    const drop = before - after;
    if (drop > tolerance) {
      regressions.push({ metric, baseline: before, current: after, drop });
    }
  }
  return regressions;
}

/**
 * A suite the baseline measured that this run measured less of — or not at all.
 */
export interface CoverageShortfall {
  readonly suite: string;
  /** What the baseline scored, or `null` when it was recorded without a count. */
  readonly baselineDocuments: number | null;
  readonly currentDocuments: number;
}

/**
 * Suites that went missing or got shorter since the baseline.
 *
 * `findRegressions` compares rates, and a rate cannot fall when there is
 * nothing to compare: a suite whose cassettes are absent simply drops out of
 * `currentSuites` and every remaining metric passes. That is the failure this
 * function exists for. A baselined suite must score at least as many documents
 * as it did when the baseline was recorded; fewer means the run did not measure
 * what the baseline says was measured, and its green is not a green anyone
 * should read.
 *
 * Absence is caught whether or not the baseline carries a count, because a
 * suite with a row and no cassettes is a hole either way.
 */
export function findCoverageShortfalls(
  baseline: Baseline,
  currentSuites: Readonly<Record<string, SuiteScore>> = {},
): readonly CoverageShortfall[] {
  const shortfalls: CoverageShortfall[] = [];
  for (const [name, before] of Object.entries(baseline.suites ?? {})) {
    const after = currentSuites[name];
    const currentDocuments = after === undefined ? 0 : after.documents.length;
    const baselineDocuments = before.documents ?? null;
    const short =
      baselineDocuments === null ? currentDocuments === 0 : currentDocuments < baselineDocuments;
    if (short) shortfalls.push({ suite: name, baselineDocuments, currentDocuments });
  }
  return shortfalls;
}

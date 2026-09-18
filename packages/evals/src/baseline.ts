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
   * answer below the floor is routed to a human, which is the system working;
   * a confident wrong answer is the one that costs money.
   */
  readonly unsafeMisclassifications?: number;
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
): Baseline {
  const perSuite: Record<string, SuiteBaseline> = {};
  for (const [name, suite] of Object.entries(suites)) {
    perSuite[name] = {
      recall: suite.recall,
      precision: suite.precision,
      groundedRate: suite.groundedRate,
      classificationAccuracy: suite.classificationAccuracy,
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
  };
}

export function findRegressions(
  baseline: Baseline,
  tolerance = DEFAULT_TOLERANCE,
  currentSuites: Readonly<Record<string, SuiteScore>> = {},
): readonly Regression[] {
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

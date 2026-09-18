/**
 * Baselines and the regression gate.
 *
 * A recorded baseline is what the suite scored when someone last looked at it.
 * CI fails when a metric drops beyond tolerance. Baselines are never adjusted to
 * make a run pass (CLAUDE.md) — a drop is either a bug to fix or a deliberate,
 * reviewed change.
 */

import type { SuiteScore } from './score';

export interface Baseline {
  readonly recordedAt: string;
  readonly extractModel: string;
  readonly recall: number;
  readonly precision: number;
  readonly groundedRate: number | null;
  readonly classificationAccuracy: number | null;
  readonly totalCostMicros: number;
}

/** Absolute drop tolerated before a metric counts as a regression. */
export const DEFAULT_TOLERANCE = 0.02;

export interface Regression {
  readonly metric: string;
  readonly baseline: number;
  readonly current: number;
  readonly drop: number;
}

export function toBaseline(score: SuiteScore, extractModel: string): Baseline {
  return {
    recordedAt: new Date().toISOString(),
    extractModel,
    recall: score.recall,
    precision: score.precision,
    groundedRate: score.groundedRate,
    classificationAccuracy: score.classificationAccuracy,
    totalCostMicros: score.totalCostMicros,
  };
}

export function findRegressions(
  baseline: Baseline,
  current: SuiteScore,
  tolerance = DEFAULT_TOLERANCE,
): readonly Regression[] {
  const pairs: Array<[string, number | null, number | null]> = [
    ['recall', baseline.recall, current.recall],
    ['precision', baseline.precision, current.precision],
    ['groundedRate', baseline.groundedRate, current.groundedRate],
    ['classificationAccuracy', baseline.classificationAccuracy, current.classificationAccuracy],
  ];

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

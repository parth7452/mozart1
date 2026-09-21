import { describe, expect, it } from 'vitest';
import { flattenExtraction, schemaFor, verifyQuotes, type DocType } from '@recouple/extraction';
import { allFixtureDocuments, expectedExtraction } from '@recouple/fixtures';
import { scoreDocument, summarise, type SuiteScore } from '../src/score';
import {
  DEFAULT_TOLERANCE,
  findCoverageShortfalls,
  findRegressions,
  toBaseline,
  type Baseline,
} from '../src/baseline';
import {
  DEFAULT_MIN_CLASSIFICATION_CONFIDENCE,
  classificationIsActionable,
} from '@recouple/core-domain';

/**
 * The fixture corpus has three parts that must agree: the document text, the
 * ground truth, and the expected extraction. These tests are what stops them
 * drifting — an eval scored against stale truth is worse than no eval.
 */
describe('the fixture corpus agrees with itself', () => {
  it('has an expected extraction that satisfies the schema for its type', () => {
    for (const document of allFixtureDocuments()) {
      const schema = schemaFor(document.docType as DocType);
      const result = schema.safeParse(expectedExtraction(document));
      expect(result.success, `${document.key}: ${JSON.stringify(result.error?.issues ?? [])}`).toBe(
        true,
      );
    }
  });

  it('quotes only text that is actually on the page it cites', () => {
    for (const document of allFixtureDocuments()) {
      const fields = verifyQuotes(
        flattenExtraction(expectedExtraction(document)),
        document.pageText,
      );
      const ungrounded = fields.filter((f) => f.quoteVerified !== true);
      expect(
        ungrounded.map((f) => `${f.fieldPath}: ${f.sourceQuote}`),
        `${document.key} has quotes that are not on the page`,
      ).toEqual([]);
    }
  });

  it('scores a perfect extraction as perfect — the scorer’s own sanity check', () => {
    for (const document of allFixtureDocuments()) {
      const fields = verifyQuotes(
        flattenExtraction(expectedExtraction(document)),
        document.pageText,
      );
      const score = scoreDocument({ key: document.key, truth: document.truth, fields });
      const failures = score.fields.filter((f) => f.outcome !== 'correct');
      expect(
        failures.map((f) => `${f.fieldPath}: expected ${f.expected}, got ${f.actual}`),
        document.key,
      ).toEqual([]);
      expect(score.recall).toBe(1);
      expect(score.precision).toBe(1);
      expect(score.groundedRate).toBe(1);
    }
  });
});

describe('scoring', () => {
  const truth = allFixtureDocuments()[0]?.truth ?? {};
  const document = allFixtureDocuments()[0];

  it('counts a missing field and a wrong field differently', () => {
    const fields = verifyQuotes(
      flattenExtraction(expectedExtraction(document!)),
      document!.pageText,
    );
    const withGap = fields.filter((f) => f.fieldPath !== 'claim_id');
    const gapScore = scoreDocument({ key: 'gap', truth, fields: withGap });
    expect(gapScore.missing).toBe(1);
    expect(gapScore.wrong).toBe(0);
    // A field it did not answer cannot make it imprecise, only less complete.
    expect(gapScore.precision).toBe(1);
    expect(gapScore.recall).toBeLessThan(1);

    const wrong = fields.map((f) =>
      f.fieldPath === 'claim_id' ? { ...f, value: 'APDP-00000' } : f,
    );
    const wrongScore = scoreDocument({ key: 'wrong', truth, fields: wrong });
    expect(wrongScore.wrong).toBe(1);
    expect(wrongScore.precision).toBeLessThan(1);
  });

  it('compares money by parsed cents, not by string', () => {
    const fields = verifyQuotes(
      flattenExtraction(expectedExtraction(document!)),
      document!.pageText,
    );
    const reformatted = fields.map((f) =>
      f.fieldPath === 'deduction_total' ? { ...f, value: '3120.00' } : f,
    );
    const score = scoreDocument({ key: 'money', truth, fields: reformatted });
    expect(score.fields.find((f) => f.fieldPath === 'deduction_total')?.outcome).toBe('correct');

    const offByCents = fields.map((f) =>
      f.fieldPath === 'deduction_total' ? { ...f, value: '$3,120.01' } : f,
    );
    expect(
      scoreDocument({ key: 'money', truth, fields: offByCents }).fields.find(
        (f) => f.fieldPath === 'deduction_total',
      )?.outcome,
    ).toBe('wrong');
  });
});

/**
 * A suite that scored `count` documents, all of them perfectly.
 *
 * The rates are deliberately flawless: these tests are about *how much* a run
 * measured, and a suite that scored fewer documents must fail on that alone,
 * with nothing for the rate gate to catch it by.
 */
const scoredSuite = (count: number): SuiteScore => ({
  ...summarise([], { classificationAccuracy: 1 }),
  recall: 1,
  precision: 1,
  groundedRate: 1,
  documents: Array.from({ length: count }, (_, i) =>
    scoreDocument({ key: `doc-${i}`, truth: {}, fields: [] }),
  ),
});

describe('the regression gate', () => {
  const baseline: Baseline = {
    recordedAt: '2026-09-18T00:00:00.000Z',
    extractModel: 'claude-sonnet-5',
    recall: 0.95,
    precision: 0.97,
    groundedRate: 0.99,
    classificationAccuracy: 1,
    totalCostMicros: 120_000,
    suites: {
      authored: { recall: 1, precision: 1, groundedRate: 1, classificationAccuracy: 1 },
      held_out: { recall: 0.98, precision: 0.98, groundedRate: 1, classificationAccuracy: 1 },
    },
  };

  const suite = (recall: number, precision = recall) => ({
    ...summarise([], { classificationAccuracy: 1 }),
    recall,
    precision,
    groundedRate: 1,
  });

  it('passes a run that holds the line', () => {
    expect(
      findRegressions(baseline, DEFAULT_TOLERANCE, {
        authored: suite(1),
        held_out: suite(0.98),
      }),
    ).toEqual([]);
  });

  it('tolerates noise but fails a real drop, naming the suite and metric', () => {
    expect(
      findRegressions(baseline, DEFAULT_TOLERANCE, {
        authored: suite(0.99),
        held_out: suite(0.97),
      }),
    ).toEqual([]);

    const regressions = findRegressions(baseline, DEFAULT_TOLERANCE, {
      authored: suite(1),
      held_out: suite(0.8),
    });
    expect(regressions.map((r) => r.metric)).toEqual([
      'held_out.recall',
      'held_out.precision',
    ]);
    expect(regressions[0]?.drop).toBeCloseTo(0.18, 5);
  });

  it('does not let a held-out drop hide behind the fixtures we wrote', () => {
    // Blended, this run looks like a 9-point drop across 20 documents, which a
    // single tolerance would swallow. Per suite, it is an 18-point collapse.
    const regressions = findRegressions(baseline, DEFAULT_TOLERANCE, {
      authored: suite(1),
      held_out: suite(0.8),
    });
    expect(regressions.length).toBeGreaterThan(0);
  });

  it('ignores a suite the baseline has never seen, rather than failing on it', () => {
    // Adding a harder corpus must not read as a regression on day one.
    expect(
      findRegressions(baseline, DEFAULT_TOLERANCE, {
        authored: suite(1),
        held_out: suite(0.98),
        scanned: suite(0.4),
      }),
    ).toEqual([]);
  });

  it('records what a run scored, per suite, with the model that scored it', () => {
    const recorded = toBaseline(
      summarise([], { classificationAccuracy: 1 }),
      'claude-sonnet-5',
      { authored: suite(1), scanned: suite(0.9) },
    );
    expect(recorded.extractModel).toBe('claude-sonnet-5');
    expect(recorded.suites?.scanned?.recall).toBe(0.9);
    expect(recorded.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('records how many documents each suite scored, not only how well', () => {
    // The count is what makes a shorter run detectable at all; a rate cannot
    // say whether it is an average over four documents or three.
    const recorded = toBaseline(summarise([], { classificationAccuracy: 1 }), 'claude-sonnet-5', {
      scanned: scoredSuite(4),
    });
    expect(recorded.suites?.scanned?.documents).toBe(4);
  });

  it('names a suite as pending only when there is one, and never invents a row for it', () => {
    // A suite with no cassettes has no numbers. `pendingSuites` says so in the
    // file itself; an empty map would be noise, so it is left out entirely.
    const nothingPending = toBaseline(
      summarise([], { classificationAccuracy: 1 }),
      'claude-sonnet-5',
      { authored: suite(1) },
    );
    expect(nothingPending.pendingSuites).toBeUndefined();
    expect(Object.keys(nothingPending)).not.toContain('pendingSuites');

    const pending = toBaseline(
      summarise([], { classificationAccuracy: 1 }),
      'claude-sonnet-5',
      { authored: suite(1) },
      { customer: 'not yet recorded: 15 fixture documents, no cassettes.' },
    );
    expect(pending.pendingSuites).toEqual({
      customer: 'not yet recorded: 15 fixture documents, no cassettes.',
    });
    // Pending is not scored: it gets a reason, never a metric.
    expect(pending.suites?.customer).toBeUndefined();
  });
});

describe('the coverage gate', () => {
  const baseline: Baseline = {
    recordedAt: '2026-09-18T00:00:00.000Z',
    extractModel: 'claude-sonnet-5',
    recall: 1,
    precision: 1,
    groundedRate: 0.99,
    classificationAccuracy: 1,
    totalCostMicros: 120_000,
    suites: {
      authored: {
        recall: 1,
        precision: 1,
        groundedRate: 1,
        classificationAccuracy: 1,
        documents: 8,
      },
      scanned: {
        recall: 1,
        precision: 1,
        groundedRate: 0.98,
        classificationAccuracy: 1,
        documents: 4,
      },
    },
  };

  it('passes a run that scored every document the baseline scored', () => {
    expect(
      findCoverageShortfalls(baseline, { authored: scoredSuite(8), scanned: scoredSuite(4) }),
    ).toEqual([]);
    // More than the baseline is a bigger corpus, not a shortfall.
    expect(
      findCoverageShortfalls(baseline, { authored: scoredSuite(9), scanned: scoredSuite(4) }),
    ).toEqual([]);
  });

  it('fails a suite the baseline has seen that is short this run', () => {
    const shortfalls = findCoverageShortfalls(baseline, {
      authored: scoredSuite(8),
      scanned: scoredSuite(3),
    });
    expect(shortfalls).toEqual([{ suite: 'scanned', baselineDocuments: 4, currentDocuments: 3 }]);

    // And the rate gate cannot see it: three perfect cassettes out of four
    // average exactly as well as four did, which is the hole this closes.
    expect(
      findRegressions(baseline, DEFAULT_TOLERANCE, {
        authored: scoredSuite(8),
        scanned: scoredSuite(3),
      }),
    ).toEqual([]);
  });

  it('fails a suite the baseline has seen that is absent this run', () => {
    expect(findCoverageShortfalls(baseline, { authored: scoredSuite(8) })).toEqual([
      { suite: 'scanned', baselineDocuments: 4, currentDocuments: 0 },
    ]);
  });

  it('still catches a vanished suite in a baseline recorded before counts existed', () => {
    const old: Baseline = {
      ...baseline,
      suites: {
        scanned: { recall: 1, precision: 1, groundedRate: 0.98, classificationAccuracy: 1 },
      },
    };
    expect(findCoverageShortfalls(old, {})).toEqual([
      { suite: 'scanned', baselineDocuments: null, currentDocuments: 0 },
    ]);
    // Without a count there is nothing to be short of, so a suite that merely
    // shrank cannot be caught until the baseline is recorded again.
    expect(findCoverageShortfalls(old, { scanned: scoredSuite(1) })).toEqual([]);
  });

  it('says nothing about a suite the baseline has never seen', () => {
    // An unrecorded suite is skipped, not failed — that is the other list.
    expect(findCoverageShortfalls(baseline, { authored: scoredSuite(8), scanned: scoredSuite(4) })).toEqual(
      [],
    );
    expect(
      findCoverageShortfalls(baseline, {
        authored: scoredSuite(8),
        scanned: scoredSuite(4),
        customer: scoredSuite(0),
      }),
    ).toEqual([]);
  });
});

describe('the confidence floor', () => {
  it('separates a wrong answer that gets reviewed from one that gets acted on', () => {
    // The scanned BOL came back as a POD at 0.75. Wrong, but below the floor,
    // so it routes to a human — which is the system working, not failing.
    expect(classificationIsActionable(0.75)).toBe(false);
    expect(classificationIsActionable(0.99)).toBe(true);
    expect(classificationIsActionable(DEFAULT_MIN_CLASSIFICATION_CONFIDENCE)).toBe(true);
  });

  it('honours a tenant that has tightened its own floor', () => {
    expect(classificationIsActionable(0.96, 0.99)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { flattenExtraction, schemaFor, verifyQuotes, type DocType } from '@recouple/extraction';
import { allFixtureDocuments, expectedExtraction } from '@recouple/fixtures';
import { scoreDocument, summarise } from '../src/score';
import { findRegressions, toBaseline, type Baseline } from '../src/baseline';

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

describe('the regression gate', () => {
  const baseline: Baseline = {
    recordedAt: '2026-09-18T00:00:00.000Z',
    extractModel: 'claude-sonnet-5',
    recall: 0.95,
    precision: 0.97,
    groundedRate: 0.99,
    classificationAccuracy: 1,
    totalCostMicros: 120_000,
  };

  it('passes a run that holds the line', () => {
    const current = summarise([], { classificationAccuracy: 1 });
    expect(
      findRegressions(baseline, { ...current, recall: 0.95, precision: 0.97, groundedRate: 0.99 }),
    ).toEqual([]);
  });

  it('tolerates noise but fails a real drop, naming the metric', () => {
    const current = summarise([], { classificationAccuracy: 1 });
    expect(
      findRegressions(baseline, { ...current, recall: 0.94, precision: 0.97, groundedRate: 0.99 }),
    ).toEqual([]);

    const regressions = findRegressions(baseline, {
      ...current,
      recall: 0.8,
      precision: 0.97,
      groundedRate: 0.99,
    });
    expect(regressions.map((r) => r.metric)).toEqual(['recall']);
    expect(regressions[0]?.drop).toBeCloseTo(0.15, 5);
  });

  it('records what a run scored, with the model that scored it', () => {
    const recorded = toBaseline(summarise([], { classificationAccuracy: 1 }), 'claude-sonnet-5');
    expect(recorded.extractModel).toBe('claude-sonnet-5');
    expect(recorded.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

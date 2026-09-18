/**
 * Field-level scoring against labelled ground truth (plan §18).
 *
 * The comparison is strict where being wrong costs money: identifiers must match
 * exactly, and amounts are compared as integer cents after our own parser reads
 * them — never as strings, so "$3,120.00" and "3120.00" both count as right and
 * "$3,120" and "$3.120,00" do not quietly pass.
 */

import { MoneyError, parseMoneyToCents } from '@recouple/core-domain';
import type { ExtractedField } from '@recouple/extraction';
import type { TruthExpectation } from '@recouple/fixtures';

export type FieldOutcome = 'correct' | 'wrong' | 'missing' | 'unparseable';

export interface FieldScore {
  readonly fieldPath: string;
  readonly outcome: FieldOutcome;
  readonly expected: string;
  readonly actual: string;
  readonly confidence: number | null;
  readonly quoteVerified: boolean | null;
}

export interface DocumentScore {
  readonly key: string;
  readonly fields: readonly FieldScore[];
  readonly correct: number;
  readonly wrong: number;
  readonly missing: number;
  /** Correct as a share of every field ground truth expects. */
  readonly recall: number;
  /** Correct as a share of the fields the model actually produced for truth paths. */
  readonly precision: number;
  /** Share of extracted fields whose quote was found on the page it cited. */
  readonly groundedRate: number | null;
  /** Fields the model produced beyond ground truth — not penalised, but counted. */
  readonly extraFields: number;
}

function normaliseText(value: unknown): string {
  return String(value).trim().toLowerCase().replace(/\s+/g, ' ');
}

function compare(
  expectation: TruthExpectation,
  actual: unknown,
): { ok: boolean; rendered: string } {
  switch (expectation.kind) {
    case 'money_cents': {
      if (typeof actual !== 'string') return { ok: false, rendered: String(actual) };
      try {
        const cents = parseMoneyToCents(actual);
        return { ok: cents === expectation.value, rendered: `${actual} (${cents}¢)` };
      } catch (error) {
        return {
          ok: false,
          rendered: `${actual} (${error instanceof MoneyError ? 'unparseable' : 'error'})`,
        };
      }
    }
    case 'int':
      return { ok: Number(actual) === expectation.value, rendered: String(actual) };
    case 'bool':
      return { ok: actual === expectation.value, rendered: String(actual) };
    case 'text':
    case 'date': {
      const expected = normaliseText(expectation.value);
      const got = normaliseText(actual);
      // A retailer name may legitimately come back as "Walmart Stores, Inc."
      // where truth says "Walmart"; containment either way counts.
      const ok = got === expected || got.includes(expected) || expected.includes(got);
      return { ok, rendered: String(actual) };
    }
  }
}

function renderExpected(expectation: TruthExpectation): string {
  return expectation.kind === 'money_cents'
    ? `${expectation.value}¢`
    : String(expectation.value);
}

export function scoreDocument(input: {
  key: string;
  truth: Readonly<Record<string, TruthExpectation>>;
  fields: readonly ExtractedField[];
}): DocumentScore {
  const byPath = new Map(input.fields.map((f) => [f.fieldPath, f] as const));
  const truthPaths = Object.keys(input.truth);
  const scores: FieldScore[] = [];

  for (const path of truthPaths) {
    const expectation = input.truth[path] as TruthExpectation;
    const field = byPath.get(path);
    if (field === undefined) {
      scores.push({
        fieldPath: path,
        outcome: 'missing',
        expected: renderExpected(expectation),
        actual: '—',
        confidence: null,
        quoteVerified: null,
      });
      continue;
    }
    const { ok, rendered } = compare(expectation, field.value);
    scores.push({
      fieldPath: path,
      outcome: ok ? 'correct' : 'wrong',
      expected: renderExpected(expectation),
      actual: rendered,
      confidence: field.confidence,
      quoteVerified: field.quoteVerified,
    });
  }

  const correct = scores.filter((s) => s.outcome === 'correct').length;
  const wrong = scores.filter((s) => s.outcome === 'wrong').length;
  const missing = scores.filter((s) => s.outcome === 'missing').length;
  const produced = correct + wrong;

  const checkable = input.fields.filter((f) => f.quoteVerified !== null);
  const grounded = checkable.filter((f) => f.quoteVerified === true).length;

  return {
    key: input.key,
    fields: scores,
    correct,
    wrong,
    missing,
    recall: truthPaths.length === 0 ? 1 : correct / truthPaths.length,
    precision: produced === 0 ? 0 : correct / produced,
    groundedRate: checkable.length === 0 ? null : grounded / checkable.length,
    extraFields: Math.max(0, input.fields.length - produced),
  };
}

export interface SuiteScore {
  readonly documents: readonly DocumentScore[];
  readonly recall: number;
  readonly precision: number;
  readonly groundedRate: number | null;
  readonly classificationAccuracy: number | null;
  readonly totalCostMicros: number;
}

export function summarise(
  documents: readonly DocumentScore[],
  extras: { classificationAccuracy?: number | null; totalCostMicros?: number } = {},
): SuiteScore {
  const correct = documents.reduce((n, d) => n + d.correct, 0);
  const wrong = documents.reduce((n, d) => n + d.wrong, 0);
  const missing = documents.reduce((n, d) => n + d.missing, 0);
  const rated = documents.filter((d) => d.groundedRate !== null);

  return {
    documents,
    recall: correct + wrong + missing === 0 ? 1 : correct / (correct + wrong + missing),
    precision: correct + wrong === 0 ? 0 : correct / (correct + wrong),
    groundedRate:
      rated.length === 0
        ? null
        : rated.reduce((sum, d) => sum + (d.groundedRate ?? 0), 0) / rated.length,
    classificationAccuracy: extras.classificationAccuracy ?? null,
    totalCostMicros: extras.totalCostMicros ?? 0,
  };
}

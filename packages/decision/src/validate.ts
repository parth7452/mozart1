import { createHash } from 'node:crypto';
import {
  DecisionContractError,
  MAX_CHOICE_CARDINALITY,
  MAX_FACT_CHARS,
  type DecisionState,
  type JsonValue,
  type QuestionSet,
} from './types';

/** Recursively key-sorted JSON, so a hash of state is stable across runs. */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, JsonValue>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
}

/**
 * The hash stored on every decision row. Re-deciding an unchanged state is a
 * no-op, which is what makes the decide step safely re-entrant.
 */
export function inputStateHash(state: DecisionState): string {
  return createHash('sha256')
    .update(canonicalJson({ orgId: state.orgId, deductionId: state.deductionId, facts: state.facts }))
    .digest('hex');
}

/** Fails loudly if a question set would not survive the provider's limits. */
export function assertQuestionSetValid(questions: QuestionSet): void {
  const names = Object.keys(questions);
  if (names.length === 0) throw new DecisionContractError('a question set cannot be empty');

  for (const [name, question] of Object.entries(questions)) {
    if (question.kind === 'choice') {
      if (question.options.length === 0) {
        throw new DecisionContractError(`choice "${name}" has no options`);
      }
      if (question.options.length > MAX_CHOICE_CARDINALITY) {
        throw new DecisionContractError(
          `choice "${name}" has ${question.options.length} options, over the ${MAX_CHOICE_CARDINALITY} ceiling: split it into family + sub-code`,
        );
      }
      if (new Set(question.options).size !== question.options.length) {
        throw new DecisionContractError(`choice "${name}" has duplicate options`);
      }
    }
    if (question.kind === 'score' && question.levels.length < 2) {
      throw new DecisionContractError(`score "${name}" needs at least two levels`);
    }
  }
}

/**
 * Guards invariant 4 at the boundary: state is extracted fields, so anything
 * document-sized or carrying quarantine markers is a bug in the caller, not
 * something to pass along to a provider.
 */
export function assertStateIsStructured(state: DecisionState): void {
  const walk = (value: JsonValue, path: string): void => {
    if (typeof value === 'string') {
      if (value.length > MAX_FACT_CHARS) {
        throw new DecisionContractError(
          `decision state field "${path}" is ${value.length} chars: pass extracted values, not document text`,
        );
      }
      if (value.includes('untrusted_document')) {
        throw new DecisionContractError(
          `decision state field "${path}" carries quarantined document text`,
        );
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, JsonValue>)) {
        walk(v, path ? `${path}.${k}` : k);
      }
    }
  };
  walk(state.facts as JsonValue, 'facts');
}

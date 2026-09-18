/**
 * The decision layer contract.
 *
 * App code never calls Jev or Claude directly (invariant 5's sibling rule): it
 * asks a DecisionProvider. Jev is early access, so treating it as one
 * implementation of a contract — with a Claude structured-output provider behind
 * the same interface — is what keeps a vendor change additive.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [k: string]: JsonValue };

/** Jev's documented ceiling on the number of options in a Choice. */
export const MAX_CHOICE_CARDINALITY = 255;

/** Facts are extracted values, not prose: nothing document-sized goes through. */
export const MAX_FACT_CHARS = 1_000;

export interface ChoiceQuestion<Option extends string = string> {
  readonly kind: 'choice';
  readonly prompt: string;
  readonly options: readonly Option[];
  /** A multiple Choice returns a set rather than one option. */
  readonly multiple?: boolean;
}

export interface ScoreQuestion {
  readonly kind: 'score';
  readonly prompt: string;
  /** Ordered levels, lowest first. */
  readonly levels: readonly string[];
}

export interface NoulQuestion {
  readonly kind: 'noul';
  readonly prompt: string;
}

export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;
export type QuestionSet = Readonly<Record<string, Question>>;

export type AnswerOf<Q extends Question> = Q extends ChoiceQuestion<infer O>
  ? Q['multiple'] extends true
    ? readonly O[]
    : O
  : Q extends ScoreQuestion
    ? string
    : boolean;

export interface Answer<Q extends Question = Question> {
  readonly value: AnswerOf<Q>;
  /** Calibrated probability for the returned value. */
  readonly probability: number;
  /** Raw per-option probabilities, persisted for calibration analysis. */
  readonly distribution: Readonly<Record<string, number>>;
}

/**
 * Structured state only. The provider sees extracted fields, playbook facts and
 * evidence status — never raw document text, which is what keeps a malicious
 * PDF from reaching a component that can act (invariant 4).
 */
export interface DecisionState {
  readonly orgId: string;
  readonly deductionId: string;
  readonly facts: Readonly<Record<string, JsonValue>>;
}

export interface DecisionResult<T extends QuestionSet> {
  readonly answers: { readonly [K in keyof T]: Answer<T[K]> };
  /** Lowest per-answer probability: the gate compares against this. */
  readonly confidence: number;
  readonly provider: ProviderName;
  readonly modelVersion: string;
  readonly schemaVersion: string;
  readonly inputStateHash: string;
  readonly latencyMs: number;
  readonly costMicros: number;
}

export type ProviderName = 'jev' | 'claude-structured';

export interface DecideOptions {
  readonly schemaVersion: string;
  readonly timeoutMs?: number;
}

export interface DecisionProvider {
  readonly name: ProviderName;
  readonly modelVersion: string;
  decide<T extends QuestionSet>(
    state: DecisionState,
    questions: T,
    opts: DecideOptions,
  ): Promise<DecisionResult<T>>;
}

/** Thrown when a provider's response does not match the contract. */
export class DecisionContractError extends Error {}

/** Thrown when a provider is unavailable or too slow; the caller falls back. */
export class DecisionUnavailableError extends Error {}

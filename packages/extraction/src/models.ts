/**
 * Model roles and what they cost (ADR 0007).
 *
 * Extraction and narrative run on Sonnet; first-page doc-type classification
 * runs on Haiku. Both are overridable by env var, and the model that actually
 * served a call is written to the `model_calls` row — so a model change shows up
 * in the data rather than having to be inferred from a deploy date.
 */

export type ModelRole = 'classify' | 'extract' | 'verify' | 'narrative';

const DEFAULTS: Record<ModelRole, string> = {
  classify: 'claude-haiku-4-5',
  extract: 'claude-sonnet-5',
  verify: 'claude-sonnet-5',
  narrative: 'claude-sonnet-5',
};

/**
 * The classifier's sampling temperature: 0.
 *
 * A doc type decides whether a document opens a case, how many, and whether a
 * person is asked first (ADR 0028, ADR 0044), so it should not be a coin toss.
 * With no temperature set, the same page read `remittance_advice` three times in
 * five and `deduction_notice` twice, and every classification number the eval
 * reported was one sample. Zero makes the answer as repeatable as the model
 * allows. It does not make it right.
 */
export const CLASSIFY_TEMPERATURE = 0;

/**
 * Models that reject a sampling parameter outright. Sending `temperature` to
 * one is a 400, and `RECOUPLE_CLASSIFY_MODEL` can point the classifier at any
 * of them. Matched by prefix, so a dated snapshot counts as its family.
 */
const NO_SAMPLING_PREFIXES = [
  'claude-fable-',
  'claude-mythos-',
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-opus-4-7',
  'claude-opus-4-8',
] as const;

/**
 * The temperature to send the classifier on `model`, or `null` when that model
 * takes none: then nothing is sent, and the stamp on a recorded classification
 * says it was not pinned rather than pretending it was.
 */
export function classifyTemperatureFor(model: string): number | null {
  return NO_SAMPLING_PREFIXES.some((prefix) => model.startsWith(prefix))
    ? null
    : CLASSIFY_TEMPERATURE;
}

const ENV_KEYS: Record<ModelRole, string> = {
  classify: 'RECOUPLE_CLASSIFY_MODEL',
  extract: 'RECOUPLE_EXTRACT_MODEL',
  verify: 'RECOUPLE_VERIFY_MODEL',
  narrative: 'RECOUPLE_NARRATIVE_MODEL',
};

export function modelFor(role: ModelRole, env: NodeJS.ProcessEnv = process.env): string {
  const override = env[ENV_KEYS[role]];
  return override !== undefined && override !== '' ? override : DEFAULTS[role];
}

/**
 * Price per token in micro-USD. A published rate of $N per million tokens is
 * exactly N micro-USD per token, so this table needs no unit conversion and the
 * cost arithmetic stays in integers.
 */
interface Rate {
  readonly inputMicros: number;
  readonly outputMicros: number;
}

const RATES: Record<string, Rate> = {
  'claude-opus-5': { inputMicros: 5, outputMicros: 25 },
  'claude-sonnet-5': { inputMicros: 2, outputMicros: 10 },
  'claude-haiku-4-5': { inputMicros: 1, outputMicros: 5 },
};

/** Cached input reads at roughly a tenth of the input rate. */
const CACHE_READ_MULTIPLIER = 0.1;

/** A write to the five-minute cache costs a quarter more than plain input. */
const CACHE_WRITE_MULTIPLIER = 1.25;

export interface TokenUsage {
  /** The whole prompt: full-price input, cache reads and cache writes. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** The part of `inputTokens` read from the cache. */
  readonly cachedTokens?: number;
  /** The part of `inputTokens` written to the cache (ADR 0053's paged reads). */
  readonly cacheWriteTokens?: number;
}

/**
 * Cost of one call in micro-USD, rounded up. An unknown model returns 0 and is
 * reported as such rather than guessed at — a wrong number in the cost model is
 * worse than a visible gap.
 */
export function costMicros(model: string, usage: TokenUsage): number {
  const rate = RATES[model];
  if (rate === undefined) return 0;
  const cached = usage.cachedTokens ?? 0;
  const written = usage.cacheWriteTokens ?? 0;
  const uncachedInput = Math.max(0, usage.inputTokens - cached - written);
  return Math.ceil(
    uncachedInput * rate.inputMicros +
      cached * rate.inputMicros * CACHE_READ_MULTIPLIER +
      written * rate.inputMicros * CACHE_WRITE_MULTIPLIER +
      usage.outputTokens * rate.outputMicros,
  );
}

export function isPricedModel(model: string): boolean {
  return Object.prototype.hasOwnProperty.call(RATES, model);
}

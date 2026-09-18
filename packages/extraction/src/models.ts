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

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens?: number;
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
  const uncachedInput = Math.max(0, usage.inputTokens - cached);
  return Math.ceil(
    uncachedInput * rate.inputMicros +
      cached * rate.inputMicros * CACHE_READ_MULTIPLIER +
      usage.outputTokens * rate.outputMicros,
  );
}

export function isPricedModel(model: string): boolean {
  return Object.prototype.hasOwnProperty.call(RATES, model);
}

import { MERGEABLE_STATES, type CaseState } from '@recouple/core-domain';
import { MAX_CASES_REMOVED_AT_ONCE } from '@recouple/pipeline';
import { isUuid } from './request';

/**
 * The case ids a remove request names (ADR 0072): UUIDs only, folded to lower
 * case, each once, at most `MAX_CASES_REMOVED_AT_ONCE`. Anything else makes
 * the whole selection a refusal rather than a quietly shorter one.
 */
export function removalIdsFrom(
  raw: unknown,
): { readonly ids: readonly string[] } | { readonly refused: 'none' | 'not_an_id' | 'too_many' } {
  const values = (Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw]).filter(
    (value): value is string => typeof value === 'string' && value !== '',
  );
  if (values.length === 0) return { refused: 'none' };
  if (!values.every((value) => isUuid(value))) return { refused: 'not_an_id' };
  const ids = [...new Set(values.map((value) => value.toLowerCase()))];
  if (ids.length > MAX_CASES_REMOVED_AT_ONCE) return { refused: 'too_many' };
  return { ids };
}

/** Why a selected case cannot be removed, in words, or `undefined` when it can. */
export function whyNotRemovable(state: CaseState): string | undefined {
  if ((MERGEABLE_STATES as readonly string[]).includes(state)) return undefined;
  if (state === 'removed') return 'already deleted';
  if (state === 'merged') return 'merged into another case';
  if (state === 'submitted') return 'already filed with the payer';
  return 'closed';
}

export const REMOVE_REASON_MAX_LENGTH = 500;

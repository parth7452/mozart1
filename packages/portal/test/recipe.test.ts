import { describe, expect, it } from 'vitest';
import { NEVER_CLICK_FLOOR, RecipeRefusedError, effectiveNeverClick, matchesNeverClick, parseRecipe } from '../src/recipe';
import { recipeJson } from './recipe-fixture';

describe('parseRecipe', () => {
  it('accepts a well-formed recipe', () => {
    expect(parseRecipe(recipeJson()).portalKey).toBe('fixture');
  });
  it('refuses an unknown step kind', () => {
    expect(() => parseRecipe(recipeJson(undefined, { steps: [{ kind: 'submit_dispute', name: 'x' }] }))).toThrow(RecipeRefusedError);
  });
  it('refuses sign_in or answer_mfa with an argument', () => {
    expect(() => parseRecipe(recipeJson(undefined, { steps: [{ kind: 'sign_in', selector: '#pw' }] }))).toThrow(RecipeRefusedError);
    expect(() => parseRecipe(recipeJson(undefined, { steps: [{ kind: 'answer_mfa', code: '123456' }] }))).toThrow(RecipeRefusedError);
  });
  it('refuses a recipe without an allowlist, or with an empty or wildcard one', () => {
    const { hostAllowlist: _, ...rest } = recipeJson();
    expect(() => parseRecipe(rest)).toThrow(RecipeRefusedError);
    expect(() => parseRecipe(recipeJson(undefined, { hostAllowlist: [] }))).toThrow(RecipeRefusedError);
    expect(() => parseRecipe(recipeJson(undefined, { hostAllowlist: ['*.example.com'] }))).toThrow(RecipeRefusedError);
  });
  it('refuses a sign-in origin off the allowlist, and duplicate step names', () => {
    expect(() => parseRecipe(recipeJson(undefined, { hostAllowlist: ['other:1'] }))).toThrow(RecipeRefusedError);
    expect(() => parseRecipe(recipeJson(undefined, { steps: [{ kind: 'capture_page', name: 'a' }, { kind: 'capture_page', name: 'a' }] }))).toThrow(RecipeRefusedError);
    expect(() => parseRecipe(recipeJson(undefined, { steps: [{ kind: 'dismiss', name: 'd', selector: '#m', label: 'I agree', containerText: 'Terms' }] }))).toThrow(RecipeRefusedError);
  });
  it('refuses a search without its recorded method and action', () => {
    expect(() => parseRecipe(recipeJson(undefined, { steps: [{ kind: 'search', name: 's', formSelector: 'form', fields: {} }] }))).toThrow(RecipeRefusedError);
  });
});

describe('never-click', () => {
  it('only adds to the floor', () => {
    const r = parseRecipe(recipeJson(undefined, { neverClick: ['Escalate'] }));
    const list = effectiveNeverClick(r);
    for (const w of NEVER_CLICK_FLOOR) expect(list).toContain(w);
    expect(list).toContain('escalate');
  });
  it('matches on word boundaries, case-insensitively', () => {
    const list = effectiveNeverClick(parseRecipe(recipeJson()));
    expect(matchesNeverClick('Submit dispute', list)).toBe(true);
    expect(matchesNeverClick('OPT  IN now', list)).toBe(true);
    expect(matchesNeverClick('Deductions', list)).toBe(false);
    expect(matchesNeverClick('Export statements', list)).toBe(false);
  });
});

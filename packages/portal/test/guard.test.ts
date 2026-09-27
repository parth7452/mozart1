import { describe, expect, it } from 'vitest';
import { decideRequest, type RequestContext } from '../src/guard';
import { parseRecipe } from '../src/recipe';
import { recipeJson } from './recipe-fixture';

const O = 'http://127.0.0.1:4000';
const recipe = parseRecipe(recipeJson(O));
const signIn = { kind: 'sign_in' as const, name: 'sign_in' };
const req = (method: string, path: string, activeStep: RequestContext['activeStep'], body: string | null = null, origin = O): RequestContext =>
  ({ method, url: `${origin}${path}`, body, activeStep });

describe('decideRequest', () => {
  it('allows GET and HEAD on the allowlist', () => {
    expect(decideRequest(recipe, req('GET', '/deductions.html', null))).toEqual({ allow: true });
    expect(decideRequest(recipe, req('HEAD', '/x', null))).toEqual({ allow: true });
  });
  it('refuses a non-http scheme', () => {
    expect(decideRequest(recipe, { method: 'GET', url: 'file:///etc/passwd', body: null, activeStep: null })).toEqual({ allow: false, reason: 'scheme_not_allowed' });
  });
  it('refuses an off-allowlist host with any method, even during sign_in', () => {
    expect(decideRequest(recipe, req('GET', '/', null, null, 'http://127.0.0.1:4001'))).toEqual({ allow: false, reason: 'host_not_allowed' });
    expect(decideRequest(recipe, req('POST', '/login', signIn, 'u=a', 'http://127.0.0.1:4001'))).toEqual({ allow: false, reason: 'host_not_allowed' });
  });
  it('allows POST to the bound sign-in and MFA paths only during those steps', () => {
    expect(decideRequest(recipe, req('POST', '/login', signIn))).toEqual({ allow: true });
    expect(decideRequest(recipe, req('POST', '/mfa', { kind: 'answer_mfa', name: 'answer_mfa' }))).toEqual({ allow: true });
    expect(decideRequest(recipe, req('POST', '/login', { kind: 'follow', name: 'f' }))).toEqual({ allow: false, reason: 'non_get_not_allowed' });
    expect(decideRequest(recipe, req('POST', '/login', null))).toEqual({ allow: false, reason: 'non_get_not_allowed' });
  });
  it('refuses prefix and traversal tricks on the sign-in path', () => {
    expect(decideRequest(recipe, req('POST', '/loginx', signIn)).allow).toBe(false);
    expect(decideRequest(recipe, req('POST', '/login/../change-password', signIn)).allow).toBe(false);
    expect(decideRequest(recipe, req('POST', '/login/', signIn)).allow).toBe(false);
  });
  it('allows a search POST only to its recorded action', () => {
    const s = { kind: 'search' as const, name: 's', recordedAction: `${O}/search` };
    expect(decideRequest(recipe, req('POST', '/search', s))).toEqual({ allow: true });
    expect(decideRequest(recipe, req('POST', '/reauth', s)).allow).toBe(false);
  });
  it('applies the post-as-read body discriminator', () => {
    const list = { kind: 'follow' as const, name: 'list' };
    expect(decideRequest(recipe, req('POST', '/graphql', list, JSON.stringify({ operationName: 'ListDeductions' })))).toEqual({ allow: true });
    expect(decideRequest(recipe, req('POST', '/graphql', list, JSON.stringify({ operationName: 'SubmitDispute' })))).toEqual({ allow: false, reason: 'body_discriminator_mismatch' });
    expect(decideRequest(recipe, req('POST', '/graphql', list, 'operationName=ListDeductions'))).toEqual({ allow: true });
    expect(decideRequest(recipe, req('POST', '/graphql', { kind: 'follow', name: 'other' }, JSON.stringify({ operationName: 'ListDeductions' }))).allow).toBe(false);
  });
  it('always refuses PUT, DELETE and PATCH', () => {
    for (const m of ['PUT', 'DELETE', 'PATCH']) {
      expect(decideRequest(recipe, req(m, '/login', signIn))).toEqual({ allow: false, reason: 'non_get_not_allowed' });
      expect(decideRequest(recipe, req(m, '/graphql', { kind: 'follow', name: 'list' }, JSON.stringify({ operationName: 'ListDeductions' }))).allow).toBe(false);
    }
  });
});

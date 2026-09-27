import type { RecipeVersion } from '../src/recipe';

export function recipeJson(origin = 'http://127.0.0.1:4000', over: Record<string, unknown> = {}): Record<string, unknown> {
  const host = new URL(origin).host;
  return {
    portalKey: 'fixture', version: 1, effectiveFrom: '2026-09-27',
    hostAllowlist: [host],
    signIn: { origin, formPaths: ['/login'], mfaPaths: ['/mfa'], acsPaths: [] },
    neverClick: [],
    postAsRead: [{ step: 'list', path: '/graphql', bodyDiscriminator: { field: 'operationName', equals: 'ListDeductions' } }],
    caps: { maxPages: 10, maxDownloads: 5, maxRunMs: 30_000 },
    provenance: { draftedBy: { kind: 'person', id: 'tester' }, source: 'fixture walk-through', portalAdr: 'none' },
    steps: [{ kind: 'open', name: 'start', url: `${origin}/login.html` }, { kind: 'sign_in' }],
    ...over,
  };
}

export type { RecipeVersion };

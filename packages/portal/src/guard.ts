// The write guard (ADR 0057 §1): method + target, decided for every request
// the runner's browser makes. Pure; Playwright never reaches this file.
import type { RecipeVersion, StepKind } from './recipe';

export type RequestContext = { method: string; url: string; body: string | null; activeStep: { kind: StepKind; name: string; recordedAction?: string } | null };
export type GuardDecision = { allow: true } | { allow: false; reason: 'host_not_allowed' | 'non_get_not_allowed' | 'body_discriminator_mismatch' | 'scheme_not_allowed' };

function bodyField(body: string | null, field: string): string | undefined {
  if (body === null) return undefined;
  try {
    const v: unknown = JSON.parse(body);
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const f = (v as Record<string, unknown>)[field];
      return typeof f === 'string' ? f : undefined;
    }
    return undefined;
  } catch {
    const params = new URLSearchParams(body);
    return params.getAll(field).length === 1 ? (params.get(field) ?? undefined) : undefined;
  }
}

export function decideRequest(recipe: RecipeVersion, req: RequestContext): GuardDecision {
  let url: URL;
  try { url = new URL(req.url); } catch { return { allow: false, reason: 'scheme_not_allowed' }; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { allow: false, reason: 'scheme_not_allowed' };
  if (!recipe.hostAllowlist.includes(url.host)) return { allow: false, reason: 'host_not_allowed' };
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD') return { allow: true };
  if (method !== 'POST') return { allow: false, reason: 'non_get_not_allowed' };
  const step = req.activeStep;
  if (step === null) return { allow: false, reason: 'non_get_not_allowed' };

  if (step.kind === 'sign_in' || step.kind === 'answer_mfa') {
    const signIn = new URL(recipe.signIn.origin);
    const paths = [...recipe.signIn.formPaths, ...recipe.signIn.mfaPaths, ...recipe.signIn.acsPaths];
    if (url.origin === signIn.origin && paths.includes(url.pathname)) return { allow: true };
  }
  if (step.kind === 'search' && step.recordedAction !== undefined) {
    let recorded: URL | null = null;
    try { recorded = new URL(step.recordedAction); } catch { recorded = null; }
    if (recorded !== null && recorded.origin === url.origin && recorded.pathname === url.pathname && recorded.search === url.search) {
      return { allow: true };
    }
  }
  const entries = recipe.postAsRead.filter((p) => p.step === step.name && p.path === url.pathname);
  if (entries.length > 0) {
    const ok = entries.some((p) => p.bodyDiscriminator === undefined || bodyField(req.body, p.bodyDiscriminator.field) === p.bodyDiscriminator.equals);
    return ok ? { allow: true } : { allow: false, reason: 'body_discriminator_mismatch' };
  }
  return { allow: false, reason: 'non_get_not_allowed' };
}

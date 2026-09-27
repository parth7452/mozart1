// A portal recipe (ADR 0057 §3): versioned, effective-dated data with
// provenance, whose step kinds can only express reads. No credential lives
// here; sign_in and answer_mfa take no argument, the binding does.
import { z } from 'zod';

/** ADR 0057 §1, verbatim. A recipe may add to it and never remove from it. */
export const NEVER_CLICK_FLOOR = ['dispute','appeal','submit','upload','attach','approve','accept','agree','delete','remove','save','create','request','send','pay','confirm','continue','yes','ok','finish','complete','withdraw','cancel','enroll','opt in','subscribe','register','update','edit','reset','resend','authorize'] as const;

/** ADR 0057 §3, closed. */
export const STEP_KINDS = ['open','sign_in','answer_mfa','dismiss','follow','search','wait_for','expect','capture_page','download','for_each','next_page','sign_out'] as const;
export type StepKind = (typeof STEP_KINDS)[number];

const name = z.string().min(1);

export type RecipeStep =
  | { kind: 'open'; name: string; url: string }
  | { kind: 'sign_in' }
  | { kind: 'answer_mfa' }
  | { kind: 'sign_out' }
  | { kind: 'dismiss'; name: string; selector: string; label: string; containerText: string }
  | { kind: 'follow'; name: string; label: string }
  | { kind: 'search'; name: string; formSelector: string; fields: Record<string, string>; recordedMethod: string; recordedAction: string }
  | { kind: 'wait_for'; name: string; selector: string }
  | { kind: 'expect'; name: string; selector?: string | undefined; text?: string | undefined }
  | { kind: 'capture_page'; name: string }
  | { kind: 'download'; name: string; label: string }
  | { kind: 'for_each'; name: string; rowSelector: string; maxRows: number; steps: RecipeStep[] }
  | { kind: 'next_page'; name: string; label: string; maxPages: number };

export const RecipeStepSchema: z.ZodType<RecipeStep> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('open'), name, url: z.string().url() }).strict(),
    z.object({ kind: z.literal('sign_in') }).strict(),
    z.object({ kind: z.literal('answer_mfa') }).strict(),
    z.object({ kind: z.literal('sign_out') }).strict(),
    z.object({ kind: z.literal('dismiss'), name, selector: z.string().min(1), label: z.string().min(1), containerText: z.string().min(1) }).strict(),
    z.object({ kind: z.literal('follow'), name, label: z.string().min(1) }).strict(),
    z.object({ kind: z.literal('search'), name, formSelector: z.string().min(1), fields: z.record(z.string(), z.string()), recordedMethod: z.string().min(1), recordedAction: z.string().url() }).strict(),
    z.object({ kind: z.literal('wait_for'), name, selector: z.string().min(1) }).strict(),
    z.object({ kind: z.literal('expect'), name, selector: z.string().min(1).optional(), text: z.string().min(1).optional() }).strict()
      .refine((s) => s.selector !== undefined || s.text !== undefined, 'expect needs a selector or a text'),
    z.object({ kind: z.literal('capture_page'), name }).strict(),
    z.object({ kind: z.literal('download'), name, label: z.string().min(1) }).strict(),
    z.object({ kind: z.literal('for_each'), name, rowSelector: z.string().min(1), maxRows: z.number().int().positive(), steps: z.array(RecipeStepSchema).min(1) }).strict(),
    z.object({ kind: z.literal('next_page'), name, label: z.string().min(1), maxPages: z.number().int().positive() }).strict(),
  ]),
) as z.ZodType<RecipeStep>;

/** A step's name; the three argument-free steps are named by their kind. */
export function stepName(step: RecipeStep): string {
  return 'name' in step ? step.name : step.kind;
}

export const PostAsReadSchema = z.object({ step: z.string(), path: z.string().startsWith('/'), bodyDiscriminator: z.object({ field: z.string(), equals: z.string() }).strict().optional() }).strict();

function allSteps(steps: readonly RecipeStep[]): RecipeStep[] {
  return steps.flatMap((s) => (s.kind === 'for_each' ? [s, ...allSteps(s.steps)] : [s]));
}

function hostOf(url: string): string | null {
  try { return new URL(url).host; } catch { return null; }
}

export const RecipeVersionSchema = z.object({
  portalKey: z.string().min(1), version: z.number().int().positive(), effectiveFrom: z.iso.date(),
  hostAllowlist: z.array(z.string().regex(/^[a-z0-9.-]+(:\d+)?$/i, 'exact host[:port], no wildcards')).min(1),
  signIn: z.object({ origin: z.string().url(), formPaths: z.array(z.string().startsWith('/')).min(1), mfaPaths: z.array(z.string().startsWith('/')), acsPaths: z.array(z.string().startsWith('/')) }).strict(),
  neverClick: z.array(z.string().min(1)),
  postAsRead: z.array(PostAsReadSchema),
  caps: z.object({ maxPages: z.number().int().positive(), maxDownloads: z.number().int().nonnegative(), maxRunMs: z.number().int().positive() }).strict(),
  provenance: z.object({ draftedBy: z.object({ kind: z.enum(['person','agent_session']), id: z.string() }).strict(), source: z.string(), portalAdr: z.string() }).strict(),
  steps: z.array(RecipeStepSchema).min(1),
}).strict().superRefine((r, ctx) => {
  const origin = hostOf(r.signIn.origin);
  if (origin === null || !r.hostAllowlist.includes(origin)) {
    ctx.addIssue({ code: 'custom', path: ['signIn', 'origin'], message: 'sign-in origin host is not on the allowlist' });
  }
  const seen = new Set<string>();
  for (const s of allSteps(r.steps)) {
    const n = stepName(s);
    if (seen.has(n)) ctx.addIssue({ code: 'custom', path: ['steps'], message: `step name ${n} is not unique` });
    seen.add(n);
    if (s.kind === 'dismiss' && matchesNeverClick(s.label, effectiveNeverClick(r))) {
      ctx.addIssue({ code: 'custom', path: ['steps'], message: `dismiss step ${n} clicks a never-click control` });
    }
  }
});

export type RecipeVersion = z.infer<typeof RecipeVersionSchema>;

export class RecipeRefusedError extends Error {
  override readonly name = 'RecipeRefusedError';
  constructor(readonly issues: readonly { path: readonly PropertyKey[]; message: string }[]) {
    super(`recipe refused: ${issues.map((i) => `${i.path.map(String).join('.')}: ${i.message}`).join('; ')}`);
  }
}

export function parseRecipe(json: unknown): RecipeVersion {
  const parsed = RecipeVersionSchema.safeParse(json);
  if (!parsed.success) throw new RecipeRefusedError(parsed.error.issues);
  return parsed.data;
}

/** The floor plus the recipe's additions, lower-cased. The floor cannot shrink. */
export function effectiveNeverClick(r: RecipeVersion): readonly string[] {
  return [...new Set([...NEVER_CLICK_FLOOR, ...r.neverClick.map((w) => w.trim().toLowerCase())])];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Word-boundary, case-insensitive: "Submit dispute" → true, "Deductions" → false. */
export function matchesNeverClick(label: string, list: readonly string[]): boolean {
  const text = label.toLowerCase().replace(/\s+/g, ' ');
  return list.some((w) => {
    const words = w.toLowerCase().trim().split(/\s+/).map(escapeRe).join('\\s+');
    return new RegExp(`(^|[^a-z0-9])${words}($|[^a-z0-9])`).test(text);
  });
}

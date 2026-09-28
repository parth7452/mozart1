/**
 * Which portals' terms let a recipe run (ADR 0057 §2): data, keyed by the
 * per-portal ADR that records the founder's reading of them.
 *
 * A recipe names the ADR it runs under (`provenance.portalAdr`). The portal
 * job runs it (a dry run, a read that captures, or an agent session) only when
 * that ADR's terms record says "allowed" or "allowed with conditions", or
 * records the payer's written consent. The job cannot read an ADR while it
 * runs, so the answer an ADR records is copied here, in a change the founder
 * approves, and takes effect when that change is deployed
 * (`docs/plans/ariba-portal/README.md`, step 1).
 *
 * **This list may say less than an ADR, and never more.**
 * `packages/core-domain/test/portal-terms.test.ts` reads each entry's ADR and
 * refuses an entry whose terms record does not give that answer for that
 * portal:
 *
 *  - ADR 0058 (UNFI) records "allowed", and is paused (2026-09-27): there is no
 *    sandbox and no dedicated login until the pilot call. It is added here
 *    when UNFI resumes, on the founder's go.
 *  - ADR 0062 (SAP Business Network) records "allowed with conditions"
 *    (2026-09-28): terms are accepted by a person, never by a run, and a
 *    sign-in that presents them stops for one (`terms_prompt`).
 *
 * Removing an entry is how a portal is stopped for every tenant at once: the
 * next run of any recipe naming its ADR is refused before anything is read.
 * No code names a portal to decide this; the portal key below is data
 * checked against the ADR, like the answer.
 */

/**
 * The answers ADR 0057 §2 lets a recipe run under. Its other two answers
 * ("needs written consent", "not allowed"), and a record still pending, let
 * nothing run, so none of them is an entry here.
 */
export const PORTAL_TERMS_ALLOWING_ANSWERS = [
  'allowed',
  'allowed_with_conditions',
  'payer_written_consent',
] as const;
export type PortalTermsAllowingAnswer = (typeof PORTAL_TERMS_ALLOWING_ANSWERS)[number];

/** One portal's terms, as its ADR records them allowing a run. */
export interface PortalTermsAllowance {
  /**
   * The per-portal ADR, four digits, as its file name begins and as a recipe's
   * `provenance.portalAdr` names it (`0062`).
   */
  readonly adr: string;
  /** The one portal its terms record covers. A recipe for another portal naming this ADR is refused. */
  readonly portalKey: string;
  readonly answer: PortalTermsAllowingAnswer;
  /** The day the founder recorded the answer in the ADR, YYYY-MM-DD. */
  readonly recordedOn: string;
}

/** An ADR number as a recipe names one: four digits, nothing else. */
export const PORTAL_TERMS_ADR_PATTERN = /^\d{4}$/;

/** `PORTAL_KEY_PATTERN` in `@recouple/portal`, which this package does not depend on. */
const PORTAL_KEY = /^[a-z][a-z0-9_]{0,62}$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** An allowance that is not one: a malformed ADR number, portal key, answer or day, or an ADR listed twice. */
export class PortalTermsAllowanceError extends Error {
  override readonly name = 'PortalTermsAllowanceError';
  constructor(readonly field: string, rule: string) {
    super(`a portal terms allowance's ${field} must be ${rule}`);
  }
}

/**
 * The allowances as the gate reads them, keyed by ADR, each one checked. The
 * one way to build what `portalTermsVerdict` is given, so a test's list is
 * held to the rules the deployed one is.
 */
export function portalTermsAllowances(
  list: readonly PortalTermsAllowance[],
): ReadonlyMap<string, PortalTermsAllowance> {
  const byAdr = new Map<string, PortalTermsAllowance>();
  for (const allowance of list) {
    if (!PORTAL_TERMS_ADR_PATTERN.test(allowance.adr)) {
      throw new PortalTermsAllowanceError('adr', 'four digits');
    }
    if (!PORTAL_KEY.test(allowance.portalKey)) {
      throw new PortalTermsAllowanceError('portalKey', 'a portal key');
    }
    if (!(PORTAL_TERMS_ALLOWING_ANSWERS as readonly string[]).includes(allowance.answer)) {
      throw new PortalTermsAllowanceError('answer', `one of ${PORTAL_TERMS_ALLOWING_ANSWERS.join(', ')}`);
    }
    if (!isIsoDay(allowance.recordedOn)) {
      throw new PortalTermsAllowanceError('recordedOn', 'a day, YYYY-MM-DD');
    }
    if (byAdr.has(allowance.adr)) {
      throw new PortalTermsAllowanceError('adr', 'listed once');
    }
    byAdr.set(allowance.adr, Object.freeze({ ...allowance }));
  }
  return byAdr;
}

/**
 * What is deployed: the ADRs whose terms record lets a recipe run, for the
 * reasons at the top of this file.
 */
export const PORTAL_TERMS_ALLOWED: ReadonlyMap<string, PortalTermsAllowance> =
  portalTermsAllowances([
    { adr: '0062', portalKey: 'sap_business_network', answer: 'allowed_with_conditions', recordedOn: '2026-09-28' },
  ]);

/**
 * Why a recipe may not run under its terms: it names no ADR as four digits,
 * its ADR records no allowing answer here, or its ADR is another portal's.
 */
export type PortalTermsRefusal = 'no_adr_named' | 'not_recorded' | 'other_portal';

export type PortalTermsVerdict =
  | { readonly allowed: true; readonly allowance: PortalTermsAllowance }
  | { readonly allowed: false; readonly reason: PortalTermsRefusal };

/**
 * Whether the ADR a recipe names records its portal's terms as letting it run
 * (ADR 0057 §2). Exact: `ADR 0062`, `62` or `0062-sap` name nothing, so a
 * recipe that does not say `0062` is refused rather than matched by a guess.
 */
export function portalTermsVerdict(
  recipe: { readonly portalKey: string; readonly portalAdr: string },
  allowances: ReadonlyMap<string, PortalTermsAllowance> = PORTAL_TERMS_ALLOWED,
): PortalTermsVerdict {
  const adr: unknown = recipe.portalAdr;
  if (typeof adr !== 'string' || !PORTAL_TERMS_ADR_PATTERN.test(adr)) {
    return { allowed: false, reason: 'no_adr_named' };
  }
  const allowance = allowances.get(adr);
  if (allowance === undefined) return { allowed: false, reason: 'not_recorded' };
  if (allowance.portalKey !== recipe.portalKey) return { allowed: false, reason: 'other_portal' };
  return { allowed: true, allowance };
}

function isIsoDay(value: string): boolean {
  if (!ISO_DAY.test(value)) return false;
  const day = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === value;
}

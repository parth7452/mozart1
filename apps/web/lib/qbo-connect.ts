import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { TokenCipher } from '@recouple/crypto';
import { env } from './env';
import {
  QBO_TOKEN_KMS_KEY_ID,
  qboAppConfigFromEnv,
  qboTokenCipherFromEnv,
  type EnvVars,
  type QboAppConfig,
} from './ledger-sync';

/**
 * What the QuickBooks consent flow needs from this deployment, and the state
 * that ties Intuit's redirect back to the person who pressed Connect
 * (ADR 0039 §1, §2).
 */

/** Where Intuit sends the owner back. Registered at Intuit character for character. */
export const QBO_CALLBACK_PATH = '/settings/quickbooks/callback';

/** The settings page every step of the flow returns to. */
export const QBO_SETTINGS_PATH = '/settings/quickbooks';

/**
 * The state cookie. `__Host-` means the browser refuses it unless it is
 * `Secure`, `Path=/` and has no `Domain` — host-only, so it cannot be set for
 * or read by any other subdomain.
 */
export const QBO_STATE_COOKIE = '__Host-recouple_qbo_oauth';

/** How long a consent may take, start to callback: ten minutes. */
export const QBO_STATE_MAX_AGE_SECONDS = 600;

/**
 * Whether this deployment can run the consent flow, and with what.
 *
 * `scannerFromEnv`'s shape (ADR 0018): one answer, typed, and a deployment
 * that cannot do this says why rather than throwing at a customer. Two halves
 * must both be present — the Intuit app (`QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`,
 * `QBO_ENVIRONMENT`) and the KMS key the tokens are sealed with — because a
 * consent whose tokens could not be stored is a consent spent for nothing. The
 * start route and the callback both ask, so a callback on a deployment that is
 * not configured exchanges nothing either.
 *
 * AWS credentials are not checked here, for `qboTokenCipherFromEnv`'s reason:
 * they are the SDK's provider chain's business. A missing one fails at the seal,
 * before the database is touched (ADR 0039 §4).
 */
export type QboConnectConfig =
  | {
      readonly kind: 'ready';
      readonly app: QboAppConfig;
      readonly cipher: TokenCipher;
      /** `${siteUrl}/settings/quickbooks/callback`: derived, so nobody can mistype it. */
      readonly redirectUri: string;
    }
  | {
      readonly kind: 'not_configured';
      /** The variables to set, by name. Names, never values. */
      readonly missing: readonly string[];
    };

export function qboConnectFromEnv(environment: EnvVars = process.env): QboConnectConfig {
  const missing = ['QBO_CLIENT_ID', 'QBO_CLIENT_SECRET', 'QBO_ENVIRONMENT', QBO_TOKEN_KMS_KEY_ID].filter(
    (name) => (environment[name] ?? '').trim() === '',
  );
  if (missing.length > 0) return { kind: 'not_configured', missing };

  let app: QboAppConfig | { readonly missing: string };
  try {
    app = qboAppConfigFromEnv(environment);
  } catch (error) {
    // `QBO_ENVIRONMENT` set to something that is neither environment. Loud in
    // the log, named on the page, and nothing sent to Intuit: ADR 0026 refused
    // to default it, and a consent against the wrong environment's app is a
    // consent that cannot work.
    console.error(
      `[recouple] QuickBooks connect: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { kind: 'not_configured', missing: ['QBO_ENVIRONMENT (sandbox or production)'] };
  }
  if ('missing' in app) return { kind: 'not_configured', missing: ['QBO_CLIENT_ID', 'QBO_CLIENT_SECRET'] };

  const cipher = qboTokenCipherFromEnv(environment);
  if (cipher === undefined) return { kind: 'not_configured', missing: [QBO_TOKEN_KMS_KEY_ID] };

  return { kind: 'ready', app, cipher, redirectUri: `${env.siteUrl}${QBO_CALLBACK_PATH}` };
}

/**
 * Which QuickBooks environment this deployment reads — `QBO_ENVIRONMENT` and
 * nothing else, so a page that only labels its numbers never touches the
 * client secret or the KMS key. Anything but the two known values is
 * `undefined`: the label is left off rather than guessed.
 */
export function qboEnvironmentFromEnv(
  environment: EnvVars = process.env,
): 'sandbox' | 'production' | undefined {
  const value = (environment.QBO_ENVIRONMENT ?? '').trim();
  return value === 'sandbox' || value === 'production' ? value : undefined;
}

/** Connecting and disconnecting a ledger is an owner's act (ADR 0039 §8). The database says so too. */
export function mayConnectLedger(role: string): boolean {
  return role === 'owner';
}

/** Who pressed Connect, and when — everything the cookie claims besides the nonce. */
export interface OAuthStateClaim {
  readonly orgId: string;
  readonly userId: string;
}

/**
 * A fresh single-use nonce, and the cookie value that carries it with the org,
 * the member and the time.
 *
 * 32 random bytes, base64url: no dots, so the cookie's four fields split
 * unambiguously. Not signed, deliberately — the callback re-derives the org and
 * the member from the live session and trusts only the nonce, so a signature
 * would protect claims nobody takes on trust (ADR 0039 §2).
 */
export function issueOAuthState(input: {
  readonly orgId: string;
  readonly userId: string;
  readonly now: Date;
}): { readonly state: string; readonly cookieValue: string } {
  const state = randomBytes(32).toString('base64url');
  return {
    state,
    cookieValue: [state, input.orgId, input.userId, String(input.now.getTime())].join('.'),
  };
}

/** Why a state was refused — for the log, never for the page. */
export type OAuthStateRefusal = 'no_cookie' | 'no_state' | 'malformed' | 'mismatch' | 'expired';

/**
 * The cookie's claim, if the `state` Intuit sent back is its nonce and it is
 * less than ten minutes old; otherwise which of those it was not.
 *
 * Constant-time over equal lengths: the nonce is a secret for its ten minutes,
 * and a comparison that returns at the first differing byte is a comparison
 * that can be timed. Every refusal means the same thing to the callback — do
 * not exchange this code — and the reason exists only so an operator can tell
 * a spent cookie from a forged one after the fact.
 */
export function checkOAuthState(
  cookieValue: string | undefined,
  stateParam: string | null,
  now: Date,
): { readonly ok: true; readonly claim: OAuthStateClaim } | { readonly ok: false; readonly reason: OAuthStateRefusal } {
  if (cookieValue === undefined || cookieValue === '') return { ok: false, reason: 'no_cookie' };
  if (stateParam === null || stateParam === '') return { ok: false, reason: 'no_state' };
  const parts = cookieValue.split('.');
  if (parts.length !== 4) return { ok: false, reason: 'malformed' };
  const [nonce, orgId, userId, issuedAt] = parts as [string, string, string, string];

  const expected = Buffer.from(nonce, 'utf8');
  const given = Buffer.from(stateParam, 'utf8');
  if (expected.length === 0) return { ok: false, reason: 'malformed' };
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: 'mismatch' };
  }

  const issued = Number(issuedAt);
  if (!Number.isFinite(issued)) return { ok: false, reason: 'malformed' };
  const age = now.getTime() - issued;
  if (age < 0 || age > QBO_STATE_MAX_AGE_SECONDS * 1000) return { ok: false, reason: 'expired' };

  return { ok: true, claim: { orgId, userId } };
}

/** `checkOAuthState`'s claim, or nothing. */
export function readOAuthState(
  cookieValue: string | undefined,
  stateParam: string | null,
  now: Date,
): OAuthStateClaim | undefined {
  const checked = checkOAuthState(cookieValue, stateParam, now);
  return checked.ok ? checked.claim : undefined;
}

/**
 * A browser-set request header, fit for a log line: lower-case letters, digits
 * and `;=?-` only, at most 40 characters. The `Sec-Fetch-*` and `Sec-Purpose`
 * headers are an enumeration when a browser sends them, and anything at all
 * when a forged request does, so nothing else about them is kept.
 */
export function headerForLog(value: string | null): string {
  if (value === null) return '-';
  const kept = value.toLowerCase().replace(/[^a-z0-9;=?-]/g, '').slice(0, 40);
  return kept === '' ? '?' : kept;
}

/**
 * The cookie's attributes: the ones `__Host-` requires (`Secure`, `Path=/`, no
 * `Domain`), `HttpOnly` so no page script can read the nonce, and `SameSite=Lax`
 * because Intuit's redirect back is a cross-site top-level navigation — a
 * `Strict` cookie would not be sent on it, and the callback would refuse every
 * consent.
 */
export function oauthStateCookie(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: maxAgeSeconds,
  };
}

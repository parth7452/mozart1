/**
 * Intuit's OAuth 2.0 endpoints, as functions (ADR 0039).
 *
 * Four calls, and every one of them handles a credential:
 *
 * - `intuitAuthorizeUrl` builds where a customer's owner is sent to consent;
 * - `exchangeIntuitToken` trades an authorization code, or a refresh token, for
 *   a token set;
 * - `verifyRealmAccess` proves a new access token can read the company Intuit
 *   named, before anything is written;
 * - `revokeIntuitToken` ends our access when a customer disconnects.
 *
 * The endpoints are the ones Intuit's discovery documents publish, and they are
 * the same for sandbox and production.
 *
 * **No code and no token is ever put in an error message.** A failure says
 * which call failed, the HTTP status and, where Intuit sent one, its OAuth
 * `error` code — a short closed-set word like `invalid_grant`. The body of a
 * *successful* token response is never quoted at all, because that body is the
 * credential.
 */

import { randomUUID } from 'node:crypto';
import { QboAuthError, QboRateLimited, QboRequestFailed } from './errors';
import { defaultFetch, request, retryAfterMs, type FetchLike } from './http';
import { assertQboId } from './ids';
import { isJsonObject, type JsonObject } from './reader';
import type { QboTokens } from './tokens';

export const INTUIT_AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
/** One endpoint for both sandbox and production — Intuit does not split it. */
export const INTUIT_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
export const INTUIT_REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';

/**
 * The one scope we ask for: the books. Not `openid`, `profile` or `email` —
 * who the person is comes from our own sign-in, and asking Intuit for more than
 * the ledger is asking a customer to consent to more than we use.
 */
export const QBO_ACCOUNTING_SCOPE = 'com.intuit.quickbooks.accounting';

/** Our Intuit app. Never read from `process.env` in here. */
export interface IntuitApp {
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface IntuitCallOptions {
  /** Defaults to the global `fetch`; tests inject a fake and never touch a network. */
  readonly fetchImpl?: FetchLike;
  /** Injectable clock, so the expiries are testable. */
  readonly now?: () => Date;
  readonly timeoutMs?: number;
}

/**
 * Ten seconds per call, body included. Intuit's OAuth endpoints answer in well
 * under one; the bound is for the day they do not. A refresh and a revoke run
 * while the company's lock is held, and the callback makes two of these calls
 * inside one request's time budget (ADR 0039 §5).
 */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Where to send the owner to consent: exactly five parameters and nothing else.
 *
 * `state` is the caller's single-use nonce; it comes back on the redirect and is
 * what stops a forged one (ADR 0039 §2). `redirectUri` must match one registered
 * at Intuit character for character, and Intuit refuses anything else on its
 * own page — which is the fail-closed answer for a deployment whose origin is
 * not the registered one.
 */
export function intuitAuthorizeUrl(input: {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
}): string {
  for (const [name, value] of Object.entries(input)) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new QboRequestFailed(`an Intuit authorization URL needs a ${name}`, 0, undefined);
    }
  }
  const url = new URL(INTUIT_AUTHORIZE_URL);
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', QBO_ACCOUNTING_SCOPE);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('state', input.state);
  return url.toString();
}

/** What a token set is asked for with: a consent's code, or the last refresh token. */
export type IntuitGrant =
  | {
      readonly grantType: 'authorization_code';
      readonly code: string;
      /** The same URI the consent was started with; Intuit checks they match. */
      readonly redirectUri: string;
    }
  | { readonly grantType: 'refresh_token'; readonly refreshToken: string };

/**
 * A token set from Intuit's token endpoint.
 *
 * `subject` names what this is for in an error — `realm 123` for a refresh, the
 * word `authorization code` for a consent — and is never the credential itself.
 *
 * Both expiries are computed from the injected clock at the moment the answer
 * arrived, not carried over from anything. A refresh token that came back
 * missing, empty or not a string is refused rather than stored: a token set we
 * cannot refresh from again is a connection that strands in an hour.
 */
export async function exchangeIntuitToken(
  app: IntuitApp,
  grant: IntuitGrant,
  subject: string,
  options: IntuitCallOptions = {},
): Promise<QboTokens> {
  const fetchImpl = options.fetchImpl ?? defaultFetch();
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const form =
    grant.grantType === 'refresh_token'
      ? { grant_type: 'refresh_token', refresh_token: grant.refreshToken }
      : { grant_type: 'authorization_code', code: grant.code, redirect_uri: grant.redirectUri };
  const call = grant.grantType === 'refresh_token' ? 'the token refresh' : 'the code exchange';

  const { response, text } = await request(
    fetchImpl,
    INTUIT_TOKEN_URL,
    {
      method: 'POST',
      headers: {
        authorization: basicAuth(app),
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        'Request-Id': randomUUID(),
      },
      body: new URLSearchParams(form).toString(),
    },
    timeoutMs,
  );

  if (!response.ok) {
    const code = oauthErrorOf(text);
    const said = `(${response.status}): ${code}`;
    // Only a refusal of the grant or of our app is a reason to reconnect:
    // `invalid_grant` (400) or `invalid_client` (401). Rate limiting or an
    // Intuit outage mid-refresh is not, and reported as one it would tell an
    // owner to reconnect a connection that works (the settings page reads the
    // run log's class name).
    //
    // And of those two, only `invalid_grant` on a refresh says the customer's
    // grant is gone (ADR 0046 §1). `invalid_client` is our own app's
    // credentials, and a code exchange's refusal is a consent that did not
    // complete — neither is a stored sign-in that died.
    if (response.status === 400 || response.status === 401) {
      const dead =
        grant.grantType === 'refresh_token' && response.status === 400 && code === 'invalid_grant';
      throw new QboAuthError(
        `Intuit refused ${call} for ${subject} ${said}`,
        dead ? 'grant_refused' : undefined,
      );
    }
    if (response.status === 429) {
      throw new QboRateLimited(
        `Intuit rate-limited ${call} for ${subject} ${said}`,
        retryAfterMs(response),
      );
    }
    throw new QboRequestFailed(
      `Intuit could not answer ${call} for ${subject} ${said}`,
      response.status,
      undefined,
    );
  }

  // A 2xx from here on, so the body is a token response: it is never quoted.
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new QboAuthError(`Intuit's token response for ${subject} was not JSON`);
  }
  if (!isJsonObject(payload)) {
    throw new QboAuthError(`Intuit's token response for ${subject} was not an object`);
  }

  const issuedAt = now().getTime();
  return {
    accessToken: tokenField(payload, 'access_token', subject),
    refreshToken: tokenField(payload, 'refresh_token', subject),
    accessExpiresAt: new Date(
      issuedAt + lifetimeField(payload, 'expires_in', subject) * 1000,
    ).toISOString(),
    refreshExpiresAt: new Date(
      issuedAt + lifetimeField(payload, 'x_refresh_token_expires_in', subject) * 1000,
    ).toISOString(),
  };
}

/**
 * Proves an access token can read the company Intuit named, before anything is
 * written (ADR 0039 §3).
 *
 * `realmId` arrives as a query parameter on the redirect back to us, which is a
 * thing anybody can edit. Without this a member could file a company they do
 * not administer and — with one enabled connection per company across the
 * deployment — lock its real owner out of it. The id is checked to be digits
 * before it goes into a URL path.
 */
export async function verifyRealmAccess(
  input: { readonly baseUrl: string; readonly realmId: string; readonly accessToken: string },
  options: IntuitCallOptions = {},
): Promise<void> {
  const realmId = assertQboId(input.realmId);
  const fetchImpl = options.fetchImpl ?? defaultFetch();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${input.baseUrl.replace(/\/+$/, '')}/v3/company/${realmId}/companyinfo/${realmId}`;

  const { response, text } = await request(
    fetchImpl,
    url,
    {
      method: 'GET',
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        accept: 'application/json',
        'Request-Id': randomUUID(),
      },
    },
    timeoutMs,
  );
  // A successful answer is the company's own details, read and dropped: the
  // status is the whole of what this call is asked.

  if (response.ok) return;
  if (response.status === 401 || response.status === 403) {
    throw new QboAuthError(
      `the new access token cannot read QuickBooks company ${realmId} (${response.status})`,
    );
  }
  if (response.status === 429) {
    throw new QboRateLimited(`QuickBooks rate-limited the check of company ${realmId}`, undefined);
  }
  throw new QboRequestFailed(
    `QuickBooks answered ${response.status} checking company ${realmId}`,
    response.status,
    faultOf(text),
  );
}

/**
 * Ends our access: Intuit's revocation endpoint, given the refresh token.
 *
 * A non-2xx is an error, never a quiet success — a Disconnect that believed a
 * refused revoke would tell the customer their books were closed to us when
 * they were not (ADR 0039 §9). The caller records which it was.
 */
export async function revokeIntuitToken(
  app: IntuitApp,
  token: string,
  options: IntuitCallOptions = {},
): Promise<void> {
  if (typeof token !== 'string' || token.trim() === '') {
    throw new QboRequestFailed('there is no token to revoke', 0, undefined);
  }
  const fetchImpl = options.fetchImpl ?? defaultFetch();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const { response, text } = await request(
    fetchImpl,
    INTUIT_REVOKE_URL,
    {
      method: 'POST',
      headers: {
        authorization: basicAuth(app),
        accept: 'application/json',
        'content-type': 'application/json',
        'Request-Id': randomUUID(),
      },
      body: JSON.stringify({ token }),
    },
    timeoutMs,
  );
  if (!response.ok) {
    throw new QboRequestFailed(
      `Intuit refused the revoke (${response.status}): ${oauthErrorOf(text)}`,
      response.status,
      undefined,
    );
  }
}

/** HTTP Basic over our app's id and secret, which every OAuth call carries. */
function basicAuth(app: IntuitApp): string {
  return `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`, 'utf8').toString('base64')}`;
}

/**
 * Intuit's OAuth `error` code from a refusal, and nothing else from the body.
 *
 * An OAuth error body is `{"error": "invalid_grant", ...}`, and the code is a
 * short word from a closed set. Anything that is not that shape is reported as
 * unreadable rather than quoted: the rule this file keeps is that a body is
 * never echoed into a message, so it cannot start being echoed on the day a
 * vendor sends something unexpected.
 */
function oauthErrorOf(text: string): string {
  try {
    const payload: unknown = JSON.parse(text);
    if (isJsonObject(payload)) {
      const code = payload['error'];
      if (typeof code === 'string' && /^[a-z_]{1,64}$/.test(code)) return code;
    }
  } catch {
    // Not JSON: said below, not quoted.
  }
  return 'no OAuth error code in the response';
}

/** Intuit's `Fault` object, if an API error body carried one. */
function faultOf(text: string): unknown {
  try {
    const payload: unknown = JSON.parse(text);
    if (isJsonObject(payload) && payload['Fault'] !== undefined) return payload['Fault'];
  } catch {
    // Not JSON.
  }
  return undefined;
}

function tokenField(payload: JsonObject, key: string, subject: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || value === '') {
    // The kind of thing that was there, never the thing: the field is a token.
    throw new QboAuthError(
      `Intuit's token response for ${subject} has no usable ${key} (${kindOf(value)})`,
    );
  }
  return value;
}

function lifetimeField(payload: JsonObject, key: string, subject: string): number {
  const value = payload[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new QboAuthError(
      `Intuit's token response for ${subject} has no usable ${key} (${kindOf(value)})`,
    );
  }
  return value;
}

function kindOf(value: unknown): string {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (value === '') return 'empty';
  return `a ${typeof value}`;
}

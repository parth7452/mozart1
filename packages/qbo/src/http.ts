/**
 * The one way this package talks to Intuit over HTTP: a timeout, and a
 * transport failure turned into a typed error rather than an empty answer.
 *
 * Moved out of `QboClient` when the OAuth calls arrived (ADR 0039), because the
 * authorization-code exchange, the revoke and the realm check go to the same
 * hosts with the same needs, and a second copy of the timeout would be the one
 * that drifted. Nothing here decides what a response means; the callers do.
 */

import { QboRequestFailed } from './errors';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The default, for a caller that injected nothing. Tests always inject. */
export function defaultFetch(): FetchLike {
  return (input, init) => fetch(input, init);
}

/**
 * One request and its whole body, abandoned after `timeoutMs`.
 *
 * The timer runs until the body has been read, not until the headers arrive:
 * a server that answers promptly and then stalls mid-body would otherwise hold
 * the caller for as long as the runtime's own body timeout allows — minutes —
 * and a token refresh is made while holding the company's lock (ADR 0039 §5).
 *
 * The URL in an error is redacted to its path: a query string here carries a
 * ledger filter, and on the OAuth endpoints nothing secret travels in one — the
 * code and the tokens are always in a body — but redacting everywhere is the
 * rule that does not need remembering.
 */
export async function request(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ readonly response: Response; readonly text: string }> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchImpl(url, { ...init, signal: abort.signal });
    } catch (error) {
      if (isAbort(error)) throw timedOut(url, timeoutMs, 0);
      throw new QboRequestFailed(
        `the request to QuickBooks failed before any response (${redactUrl(url)}): ` +
          `${error instanceof Error ? error.message : String(error)}`,
        0,
        undefined,
      );
    }
    try {
      return { response, text: await response.text() };
    } catch (error) {
      if (isAbort(error)) throw timedOut(url, timeoutMs, response.status);
      throw new QboRequestFailed(
        `could not read QuickBooks' response body (${redactUrl(url)}): ` +
          `${error instanceof Error ? error.message : String(error)}`,
        response.status,
        undefined,
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function timedOut(url: string, timeoutMs: number, status: number): QboRequestFailed {
  return new QboRequestFailed(
    `QuickBooks did not answer within ${timeoutMs}ms (${redactUrl(url)})`,
    status,
    undefined,
  );
}

/** `Retry-After` in milliseconds: seconds, or an HTTP date, or nothing. */
export function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (header === null || header.trim() === '') return undefined;

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);

  const at = Date.parse(header);
  if (!Number.isNaN(at)) return Math.max(0, at - Date.now());

  // Unreadable. `undefined` says "we do not know", which beats inventing a
  // backoff the caller would then trust.
  return undefined;
}

/**
 * A body short enough for an error message.
 *
 * Only ever for a body that cannot hold a credential: an API error, a ledger
 * fault. A **successful** token response holds tokens, and nothing that reads
 * one passes it here (`oauth.ts`).
 */
export function summarise(text: string): string {
  const trimmed = text.trim();
  if (trimmed === '') return '(empty body)';
  return trimmed.length > 300 ? `${trimmed.slice(0, 297)}...` : trimmed;
}

/** A URL for an error message, without the query — it carries the ledger filter. */
export function redactUrl(url: string): string {
  const cut = url.indexOf('?');
  return cut === -1 ? url : url.slice(0, cut);
}

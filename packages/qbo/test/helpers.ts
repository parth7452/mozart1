/**
 * A fake QuickBooks, and nothing else.
 *
 * No test in this package opens a socket. `fetch` is injected into the adapter
 * and these helpers are what it gets: hand-written fixtures from Intuit's
 * documented shapes, plus a recorder so a test can assert what we *sent* —
 * which is how `Request-Id` and the order of save-then-use are checked at all.
 */

import { readFileSync } from 'node:fs';
import type { FetchLike, QboConnectionConfig } from '../src/client';
import { QBO_SANDBOX_BASE_URL } from '../src/client';
import type { QboTokens } from '../src/tokens';
import { InMemoryQboTokenStore } from '../src/testing';

export const REALM_ID = '4620816365213608204';

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string | undefined;
  /** The `query` search param, for an API call. */
  readonly statement: string | undefined;
}

export interface Recorder {
  readonly fetchImpl: FetchLike;
  readonly calls: RecordedRequest[];
}

export function recordingFetch(
  handler: (request: RecordedRequest) => Response | Promise<Response>,
): Recorder {
  const calls: RecordedRequest[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const request: RecordedRequest = {
      url: input,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : undefined,
      statement: new URL(input).searchParams.get('query') ?? undefined,
    };
    calls.push(request);
    return handler(request);
  };
  return { fetchImpl, calls };
}

/** Which entity a query statement asks for, for a fake that serves several. */
export function entityOf(statement: string | undefined): string | undefined {
  return /\bfrom\s+(\w+)\b/.exec(statement ?? '')?.[1];
}

export function startPositionOf(statement: string | undefined): number | undefined {
  const match = /\bSTARTPOSITION\s+(\d+)\b/.exec(statement ?? '');
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

export const NOW = new Date('2026-09-21T16:00:00.000Z');

/** An access token with an hour left on it: no refresh is due. */
export function freshTokens(): QboTokens {
  return {
    accessToken: 'access-token-1',
    refreshToken: 'refresh-token-1',
    accessExpiresAt: new Date(NOW.getTime() + 55 * 60_000).toISOString(),
    refreshExpiresAt: new Date(NOW.getTime() + 90 * 24 * 3600_000).toISOString(),
  };
}

/** Inside the five-minute skew, so the next call must refresh first. */
export function nearlyExpiredTokens(): QboTokens {
  return {
    ...freshTokens(),
    accessExpiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
  };
}

export function configFor(
  fetchImpl: FetchLike,
  tokens: QboTokens = freshTokens(),
  overrides: Partial<QboConnectionConfig> = {},
): QboConnectionConfig {
  return {
    realmId: REALM_ID,
    baseUrl: QBO_SANDBOX_BASE_URL,
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    tokenStore: new InMemoryQboTokenStore({ [REALM_ID]: tokens }),
    fetchImpl,
    now: () => NOW,
    ...overrides,
  };
}

export const AUGUST: { readonly from: string; readonly to: string } = {
  from: '2026-08-01',
  to: '2026-09-30',
};

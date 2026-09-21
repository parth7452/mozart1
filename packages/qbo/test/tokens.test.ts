import { describe, expect, it } from 'vitest';
import { INTUIT_TOKEN_URL } from '../src/client';
import { QboAuthError } from '../src/errors';
import { QboAccountingSource } from '../src/source';
import { InMemoryQboTokenStore } from '../src/testing';
import type { QboTokenStore, QboTokens } from '../src/tokens';
import {
  AUGUST,
  configFor,
  freshTokens,
  fixture,
  jsonResponse,
  nearlyExpiredTokens,
  NOW,
  recordingFetch,
  REALM_ID,
} from './helpers';

/**
 * Wraps a store so a test can see *when* a save happened relative to the
 * requests, not only what it left behind. The ordering is the whole point:
 * Intuit kills the old refresh token the instant it issues a new one, so a
 * crash between "used the new access token" and "saved the new refresh token"
 * strands a customer's connection.
 */
function tracked(seed: QboTokens, log: string[]): { store: QboTokenStore; inner: InMemoryQboTokenStore } {
  const inner = new InMemoryQboTokenStore({ [REALM_ID]: seed });
  const store: QboTokenStore = {
    async load(realmId) {
      log.push('load');
      return inner.load(realmId);
    },
    async save(realmId, tokens) {
      // A real store is a network or KMS round trip, so this one takes a turn
      // of the event loop to finish. Without it the assertion below is
      // vacuous: an in-memory save completes synchronously, and a `save()`
      // the adapter never awaited would still look like it had landed.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await inner.save(realmId, tokens);
      log.push(`save:${tokens.refreshToken}`);
    },
  };
  return { store, inner };
}

describe('proactive token rotation', () => {
  it('uses the stored access token as-is when it is not near expiry', async () => {
    const log: string[] = [];
    const { store, inner } = tracked(freshTokens(), log);
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse({ QueryResponse: {} }));

    await new QboAccountingSource(configFor(fetchImpl, undefined, { tokenStore: store })).listInvoices(
      AUGUST,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer access-token-1');
    expect(inner.saves).toEqual([]);
    expect(log).toEqual(['load']);
  });

  it('refreshes within five minutes of expiry, and saves the rotation BEFORE using it', async () => {
    const log: string[] = [];
    const { store, inner } = tracked(nearlyExpiredTokens(), log);

    const { fetchImpl, calls } = recordingFetch((request) => {
      if (request.url === INTUIT_TOKEN_URL) {
        log.push('fetch:token');
        return jsonResponse(fixture('token-refresh.json'));
      }
      log.push('fetch:query');
      // At the moment the API call goes out, the rotated refresh token must
      // already be on disk. Asserting it here — inside the request — is what
      // makes this about ordering rather than about the end state.
      expect(inner.saves).toHaveLength(1);
      return jsonResponse({ QueryResponse: {} });
    });

    await new QboAccountingSource(configFor(fetchImpl, undefined, { tokenStore: store })).listInvoices(
      AUGUST,
    );

    expect(log).toEqual([
      'load',
      'fetch:token',
      'save:AB11605090630rotatedZmv1G4oX9Rtf2AoQ0hxXMvWmBcaLdjOWHdQFP',
      'fetch:query',
    ]);

    // The refresh is an HTTP Basic POST of a form body, and it carries its own
    // Request-Id like everything else outbound.
    const refresh = calls[0];
    expect(refresh?.method).toBe('POST');
    expect(refresh?.headers.get('authorization')).toBe(
      `Basic ${Buffer.from('test-client-id:test-client-secret').toString('base64')}`,
    );
    expect(refresh?.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(refresh?.body).toBe('grant_type=refresh_token&refresh_token=refresh-token-1');
    expect(refresh?.headers.get('Request-Id')).not.toBe(calls[1]?.headers.get('Request-Id'));

    // The new access token is what the ledger call uses.
    expect(calls[1]?.headers.get('authorization')).toBe(
      'Bearer eyJlbmMiOiJBMTI4Q0JDLUhTMjU2IiwiYWxnIjoiZGlyIn0..rotated-access-token',
    );

    // Both expiries are recomputed from the clock, not carried over.
    expect(inner.saves[0]?.tokens.accessExpiresAt).toBe(
      new Date(NOW.getTime() + 3600 * 1000).toISOString(),
    );
    expect(inner.saves[0]?.tokens.refreshExpiresAt).toBe(
      new Date(NOW.getTime() + 8_726_400 * 1000).toISOString(),
    );
  });

  it('treats an unreadable access expiry as expired rather than as valid', async () => {
    const store = new InMemoryQboTokenStore({
      [REALM_ID]: { ...freshTokens(), accessExpiresAt: 'not a date' },
    });
    const { fetchImpl, calls } = recordingFetch((request) =>
      request.url === INTUIT_TOKEN_URL
        ? jsonResponse(fixture('token-refresh.json'))
        : jsonResponse({ QueryResponse: {} }),
    );

    await new QboAccountingSource(configFor(fetchImpl, undefined, { tokenStore: store })).listInvoices(
      AUGUST,
    );

    // Refreshing early costs a round trip. Using a token that has in fact
    // expired costs the sync.
    expect(calls[0]?.url).toBe(INTUIT_TOKEN_URL);
    expect(store.saves).toHaveLength(1);
  });

  it('says the customer has to reconnect when the refresh token itself has expired', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(fixture('token-refresh.json')));
    const store = new InMemoryQboTokenStore({
      [REALM_ID]: {
        ...nearlyExpiredTokens(),
        refreshExpiresAt: new Date(NOW.getTime() - 1000).toISOString(),
      },
    });

    const source = new QboAccountingSource(configFor(fetchImpl, undefined, { tokenStore: store }));
    await expect(source.listInvoices(AUGUST)).rejects.toThrow(QboAuthError);
    await expect(source.listInvoices(AUGUST)).rejects.toThrow(/has to reconnect/);
    // Nothing is sent: there is no point asking Intuit to honour a dead token.
    expect(calls).toHaveLength(0);
  });

  it('raises an auth error, not an empty ledger, when no tokens are stored', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse({ QueryResponse: {} }));
    const source = new QboAccountingSource(
      configFor(fetchImpl, undefined, { tokenStore: new InMemoryQboTokenStore() }),
    );

    await expect(source.listInvoices(AUGUST)).rejects.toThrow(QboAuthError);
    expect(calls).toHaveLength(0);
  });

  it('raises an auth error when Intuit refuses the refresh, and keeps the old tokens', async () => {
    const store = new InMemoryQboTokenStore({ [REALM_ID]: nearlyExpiredTokens() });
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse({ error: 'invalid_grant' }, 400),
    );

    const source = new QboAccountingSource(configFor(fetchImpl, undefined, { tokenStore: store }));
    await expect(source.listInvoices(AUGUST)).rejects.toThrow(QboAuthError);
    expect(store.saves).toEqual([]);
  });

  it('raises an auth error when the refresh answer has no usable tokens in it', async () => {
    const store = new InMemoryQboTokenStore({ [REALM_ID]: nearlyExpiredTokens() });
    const { fetchImpl } = recordingFetch(() =>
      // A 200 with the rotated refresh token missing. Accepting this would save
      // a token set we cannot refresh from again.
      jsonResponse({ access_token: 'new', expires_in: 3600, x_refresh_token_expires_in: 8_726_400 }),
    );

    const source = new QboAccountingSource(configFor(fetchImpl, undefined, { tokenStore: store }));
    await expect(source.listInvoices(AUGUST)).rejects.toThrow(/no usable refresh_token/);
    expect(store.saves).toEqual([]);
  });
});

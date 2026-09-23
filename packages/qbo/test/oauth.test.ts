import { describe, expect, it } from 'vitest';
import { QboAuthError, QboInvalidId, QboRateLimited, QboRequestFailed } from '../src/errors';
import {
  exchangeIntuitToken,
  INTUIT_AUTHORIZE_URL,
  INTUIT_REVOKE_URL,
  INTUIT_TOKEN_URL,
  intuitAuthorizeUrl,
  QBO_ACCOUNTING_SCOPE,
  revokeIntuitToken,
  verifyRealmAccess,
} from '../src/oauth';
import { fixture, jsonResponse, NOW, recordingFetch } from './helpers';

/**
 * Intuit's OAuth calls, with no network (ADR 0039).
 *
 * Every one of these carries a credential — an authorization code, a token,
 * our client secret — so beside "does it send the right request" each test asks
 * the other question: does anything it says on the way out, in an error above
 * all, contain the credential? A message is logged, and a log is not where a
 * customer's books are kept.
 */

const APP = { clientId: 'test-client-id', clientSecret: 'test-client-secret' };
const BASIC = `Basic ${Buffer.from('test-client-id:test-client-secret').toString('base64')}`;
const CODE = 'AB11727000000s3cretAuthorizationCodeDoNotLog';
const REDIRECT = 'https://app.mozart.financial/settings/quickbooks/callback';

describe('where the owner is sent to consent', () => {
  it('carries exactly the five parameters, and the accounting scope alone', () => {
    const url = new URL(
      intuitAuthorizeUrl({ clientId: 'test-client-id', redirectUri: REDIRECT, state: 'nonce-1' }),
    );

    expect(`${url.origin}${url.pathname}`).toBe(INTUIT_AUTHORIZE_URL);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'test-client-id',
      response_type: 'code',
      scope: QBO_ACCOUNTING_SCOPE,
      redirect_uri: REDIRECT,
      state: 'nonce-1',
    });
    // Not openid, profile or email: we ask for the books and nothing about
    // the person.
    expect(url.searchParams.get('scope')).toBe('com.intuit.quickbooks.accounting');
  });

  it('refuses to build one with a part missing', () => {
    for (const blank of ['', '   ']) {
      expect(() =>
        intuitAuthorizeUrl({ clientId: blank, redirectUri: REDIRECT, state: 'n' }),
      ).toThrow(QboRequestFailed);
      expect(() =>
        intuitAuthorizeUrl({ clientId: 'id', redirectUri: REDIRECT, state: blank }),
      ).toThrow(/state/);
    }
  });
});

describe('trading an authorization code for tokens', () => {
  const grant = { grantType: 'authorization_code' as const, code: CODE, redirectUri: REDIRECT };

  it('posts the code as a form with our Basic credentials, and computes both expiries', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(fixture('token-refresh.json')));

    const tokens = await exchangeIntuitToken(APP, grant, 'authorization code', {
      fetchImpl,
      now: () => NOW,
    });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe(INTUIT_TOKEN_URL);
    expect(call?.method).toBe('POST');
    expect(call?.headers.get('authorization')).toBe(BASIC);
    expect(call?.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(call?.body))).toEqual({
      grant_type: 'authorization_code',
      code: CODE,
      redirect_uri: REDIRECT,
    });

    expect(tokens.refreshToken).toBe('AB11605090630rotatedZmv1G4oX9Rtf2AoQ0hxXMvWmBcaLdjOWHdQFP');
    expect(tokens.accessExpiresAt).toBe(new Date(NOW.getTime() + 3600 * 1000).toISOString());
    expect(tokens.refreshExpiresAt).toBe(
      new Date(NOW.getTime() + 8_726_400 * 1000).toISOString(),
    );
  });

  it('sends a fresh Request-Id each time', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(fixture('token-refresh.json')));
    await exchangeIntuitToken(APP, grant, 'authorization code', { fetchImpl });
    await exchangeIntuitToken(APP, grant, 'authorization code', { fetchImpl });
    const ids = calls.map((call) => call.headers.get('Request-Id'));
    expect(ids[0]).toBeTruthy();
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('names Intuit’s error code on a refusal, and never the code it refused', async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse({ error: 'invalid_grant', error_description: 'Token invalid' }, 400),
    );

    const error = await exchangeIntuitToken(APP, grant, 'authorization code', { fetchImpl })
      .then(() => undefined)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(QboAuthError);
    expect((error as Error).message).toContain('invalid_grant');
    expect((error as Error).message).toContain('400');
    expect((error as Error).message).not.toContain(CODE);
  });

  it('does not quote a refusal whose body is not an OAuth error', async () => {
    const echoed = `<html>your code ${CODE} was bad</html>`;
    const { fetchImpl } = recordingFetch(() => new Response(echoed, { status: 502 }));

    const error = await exchangeIntuitToken(APP, grant, 'authorization code', { fetchImpl })
      .then(() => undefined)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(QboAuthError);
    expect((error as Error).message).not.toContain(CODE);
    expect((error as Error).message).not.toContain('<html>');
  });

  it('never quotes a successful body it could not use — that body is the credential', async () => {
    const leaked = 'eyJhbGciOiJkaXIifQ..the-access-token-itself';
    for (const body of [
      // Not JSON at all.
      `access_token=${leaked}`,
      // JSON, but with the refresh token missing: saving this would strand the
      // connection in an hour.
      JSON.stringify({ access_token: leaked, expires_in: 3600, x_refresh_token_expires_in: 8_726_400 }),
      // A refresh token of the wrong type.
      JSON.stringify({ access_token: leaked, refresh_token: 42, expires_in: 3600, x_refresh_token_expires_in: 1 }),
    ]) {
      const { fetchImpl } = recordingFetch(
        () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
      );
      const error = await exchangeIntuitToken(APP, grant, 'authorization code', { fetchImpl })
        .then(() => undefined)
        .catch((thrown: unknown) => thrown);

      expect(error, body).toBeInstanceOf(QboAuthError);
      expect((error as Error).message, body).not.toContain(leaked);
    }
  });

  it('refreshes with the same call, named for the company rather than the token', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse({ error: 'invalid_grant' }, 400));

    const error = await exchangeIntuitToken(
      APP,
      { grantType: 'refresh_token', refreshToken: 'refresh-token-DO-NOT-LOG' },
      'realm 4620816365213417000',
      { fetchImpl },
    )
      .then(() => undefined)
      .catch((thrown: unknown) => thrown);

    expect(new URLSearchParams(calls[0]?.body).get('grant_type')).toBe('refresh_token');
    expect((error as Error).message).toContain('realm 4620816365213417000');
    expect((error as Error).message).not.toContain('refresh-token-DO-NOT-LOG');
  });
});

describe('proving the new token can read the company Intuit named', () => {
  const BASE = 'https://sandbox-quickbooks.api.intuit.com';

  it('reads the company’s own details with the new access token', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse({ CompanyInfo: { Id: '9341' } }));

    await verifyRealmAccess({ baseUrl: BASE, realmId: '9341', accessToken: 'new-access' }, { fetchImpl });

    expect(calls[0]?.url).toBe(`${BASE}/v3/company/9341/companyinfo/9341`);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer new-access');
  });

  it('refuses a company id that is not digits before anything is sent', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse({}));
    for (const realmId of ['../../admin', '9341?x=1', '', '12a']) {
      await expect(
        verifyRealmAccess({ baseUrl: BASE, realmId, accessToken: 't' }, { fetchImpl }),
      ).rejects.toBeInstanceOf(QboInvalidId);
    }
    expect(calls).toHaveLength(0);
  });

  it('says the token cannot read the company on a 401 or a 403', async () => {
    for (const status of [401, 403]) {
      const { fetchImpl } = recordingFetch(() => jsonResponse({ Fault: {} }, status));
      await expect(
        verifyRealmAccess({ baseUrl: BASE, realmId: '9341', accessToken: 't' }, { fetchImpl }),
      ).rejects.toBeInstanceOf(QboAuthError);
    }
  });

  it('tells a rate limit and a server fault apart from a refusal', async () => {
    const limited = recordingFetch(() => jsonResponse({}, 429));
    await expect(
      verifyRealmAccess({ baseUrl: BASE, realmId: '9341', accessToken: 't' }, limited),
    ).rejects.toBeInstanceOf(QboRateLimited);

    const broken = recordingFetch(() => jsonResponse({ Fault: { type: 'SERVICE' } }, 500));
    const error = await verifyRealmAccess(
      { baseUrl: BASE, realmId: '9341', accessToken: 't' },
      broken,
    )
      .then(() => undefined)
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(QboRequestFailed);
    expect((error as QboRequestFailed).status).toBe(500);
  });
});

describe('ending our access', () => {
  it('posts the token as JSON with our Basic credentials', async () => {
    const { fetchImpl, calls } = recordingFetch(() => new Response('', { status: 200 }));

    await revokeIntuitToken(APP, 'refresh-token-to-revoke', { fetchImpl });

    expect(calls[0]?.url).toBe(INTUIT_REVOKE_URL);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers.get('authorization')).toBe(BASIC);
    expect(calls[0]?.headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ token: 'refresh-token-to-revoke' });
  });

  it('is a failure, not a quiet success, when Intuit refuses — and does not repeat the token', async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse({ error: 'invalid_request' }, 400));

    const error = await revokeIntuitToken(APP, 'refresh-token-DO-NOT-LOG', { fetchImpl })
      .then(() => undefined)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(QboRequestFailed);
    expect((error as QboRequestFailed).status).toBe(400);
    expect((error as Error).message).toContain('invalid_request');
    expect((error as Error).message).not.toContain('refresh-token-DO-NOT-LOG');
  });

  it('refuses to send an empty token', async () => {
    const { fetchImpl, calls } = recordingFetch(() => new Response('', { status: 200 }));
    await expect(revokeIntuitToken(APP, '', { fetchImpl })).rejects.toBeInstanceOf(
      QboRequestFailed,
    );
    expect(calls).toHaveLength(0);
  });
});

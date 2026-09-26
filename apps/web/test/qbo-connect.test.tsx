import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LedgerConnectionDisabledError, LedgerSyncRefusedError } from '@recouple/pipeline';
import type { LedgerConnectionOverview } from '@recouple/store-postgres';
import {
  checkOAuthState,
  headerForLog,
  issueOAuthState,
  mayConnectLedger,
  oauthStateCookie,
  qboConnectFromEnv,
  QBO_STATE_MAX_AGE_SECONDS,
  readOAuthState,
} from '../lib/qbo-connect';
import {
  LedgerConnectionPage,
  lastSyncSentence,
  needsReconnect,
  type QboDeployment,
} from '../components/ledger-connection';
import type { Viewer } from '../components/case-list';

// The names the ledger job writes, taken from the classes themselves, so a
// rename of either fails here rather than silently changing what is shown.
const REFUSED = new LedgerSyncRefusedError('org-1', 'user-1').name;
const DISABLED = new LedgerConnectionDisabledError('conn-1').name;

/**
 * The consent flow's pieces that are not routes (ADR 0039 §1, §2, §12): what a
 * deployment needs before it may send anybody to Intuit, the state that ties
 * the redirect back to the person who pressed Connect, and the page.
 */

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';
const today = new Date('2026-09-23T12:00:00Z');

const READY = {
  NEXT_PUBLIC_SITE_URL: 'https://app.example.test/',
  QBO_CLIENT_ID: 'client-id',
  QBO_CLIENT_SECRET: 'client-secret-DO-NOT-ECHO',
  QBO_ENVIRONMENT: 'sandbox',
  QBO_TOKEN_KMS_KEY_ID: 'alias/recouple-qbo-tokens',
  AWS_REGION: 'us-east-1',
};

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
  vi.restoreAllMocks();
});

describe('whether a deployment may start a consent', () => {
  beforeEach(() => {
    // `redirectUri` is derived from the site URL, which reads process.env.
    process.env.NEXT_PUBLIC_SITE_URL = READY.NEXT_PUBLIC_SITE_URL;
  });

  it('is ready with the Intuit app and the key the tokens are sealed with, and derives the redirect', () => {
    const configured = qboConnectFromEnv(READY);
    expect(configured.kind).toBe('ready');
    if (configured.kind !== 'ready') return;
    expect(configured.app.environment).toBe('sandbox');
    // Derived, trailing slash and all, so nobody can mistype what Intuit matches exactly.
    expect(configured.redirectUri).toBe('https://app.example.test/settings/quickbooks/callback');
  });

  it('names each missing variable, and never a value', () => {
    for (const name of ['QBO_CLIENT_ID', 'QBO_CLIENT_SECRET', 'QBO_ENVIRONMENT', 'QBO_TOKEN_KMS_KEY_ID']) {
      const configured = qboConnectFromEnv({ ...READY, [name]: '  ' });
      expect(configured).toEqual({ kind: 'not_configured', missing: [name] });
      expect(JSON.stringify(configured)).not.toContain(READY.QBO_CLIENT_SECRET);
    }
    expect(qboConnectFromEnv({})).toEqual({
      kind: 'not_configured',
      missing: ['QBO_CLIENT_ID', 'QBO_CLIENT_SECRET', 'QBO_ENVIRONMENT', 'QBO_TOKEN_KMS_KEY_ID'],
    });
  });

  it('refuses an environment that is neither, loudly, and without guessing one', () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    const configured = qboConnectFromEnv({ ...READY, QBO_ENVIRONMENT: 'prod' });
    expect(configured).toEqual({
      kind: 'not_configured',
      missing: ['QBO_ENVIRONMENT (sandbox or production)'],
    });
    expect(errors).toHaveLength(1);
    expect(errors.join('\n')).not.toContain(READY.QBO_CLIENT_SECRET);
  });

  it('is an owner’s act, and nobody else’s', () => {
    expect(mayConnectLedger('owner')).toBe(true);
    for (const role of ['approver', 'analyst', 'viewer', 'Owner', '']) {
      expect(mayConnectLedger(role)).toBe(false);
    }
  });
});

describe('the state that ties Intuit’s redirect back to one consent', () => {
  const now = new Date('2026-09-23T12:00:00.000Z');

  it('round-trips the org and the member it was issued to', () => {
    const { state, cookieValue } = issueOAuthState({ orgId: ORG_ID, userId: USER_ID, now });
    expect(readOAuthState(cookieValue, state, now)).toEqual({ orgId: ORG_ID, userId: USER_ID });
  });

  it('is 32 random bytes, base64url, with no dot to confuse the cookie’s fields', () => {
    const first = issueOAuthState({ orgId: ORG_ID, userId: USER_ID, now });
    const second = issueOAuthState({ orgId: ORG_ID, userId: USER_ID, now });
    expect(first.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.state).not.toBe(second.state);
    expect(first.cookieValue.split('.')).toEqual([first.state, ORG_ID, USER_ID, String(now.getTime())]);
  });

  it('lasts ten minutes to the millisecond, and is refused from the future', () => {
    const { state, cookieValue } = issueOAuthState({ orgId: ORG_ID, userId: USER_ID, now });
    const at = (ms: number) => new Date(now.getTime() + ms);
    expect(readOAuthState(cookieValue, state, at(QBO_STATE_MAX_AGE_SECONDS * 1000))).toBeDefined();
    expect(readOAuthState(cookieValue, state, at(QBO_STATE_MAX_AGE_SECONDS * 1000 + 1))).toBeUndefined();
    expect(readOAuthState(cookieValue, state, at(-1))).toBeUndefined();
  });

  it('answers nothing for every way it can be wrong, all the same way', () => {
    const { state, cookieValue } = issueOAuthState({ orgId: ORG_ID, userId: USER_ID, now });
    const [, org, user, issued] = cookieValue.split('.');
    const wrong: [string | undefined, string | null][] = [
      [undefined, state],
      [cookieValue, null],
      [cookieValue, ''],
      [cookieValue, `${state}x`], // a different length
      [cookieValue, `${state.slice(0, -1)}${state.endsWith('A') ? 'B' : 'A'}`], // same length, one byte
      [`${state}.${org}.${user}`, state], // three fields
      [`${state}.${org}.${user}.${issued}.extra`, state], // five
      [`.${org}.${user}.${issued}`, ''], // an empty nonce
      [`${state}.${org}.${user}.soon`, state], // not a time
    ];
    for (const [cookie, param] of wrong) {
      expect(readOAuthState(cookie, param, now)).toBeUndefined();
    }
  });

  it('names which check refused it, for the log', () => {
    const { state, cookieValue } = issueOAuthState({ orgId: ORG_ID, userId: USER_ID, now });
    const later = new Date(now.getTime() + QBO_STATE_MAX_AGE_SECONDS * 1000 + 1);
    expect(checkOAuthState(undefined, state, now)).toEqual({ ok: false, reason: 'no_cookie' });
    expect(checkOAuthState(cookieValue, null, now)).toEqual({ ok: false, reason: 'no_state' });
    expect(checkOAuthState('a.b.c', state, now)).toEqual({ ok: false, reason: 'malformed' });
    expect(checkOAuthState(cookieValue, `${state}x`, now)).toEqual({ ok: false, reason: 'mismatch' });
    expect(checkOAuthState(cookieValue, state, later)).toEqual({ ok: false, reason: 'expired' });
    expect(checkOAuthState(cookieValue, state, now)).toEqual({
      ok: true,
      claim: { orgId: ORG_ID, userId: USER_ID },
    });
  });

  it('keeps only an enumeration’s characters from a request header', () => {
    expect(headerForLog('cross-site')).toBe('cross-site');
    expect(headerForLog('prefetch;prerender')).toBe('prefetch;prerender');
    expect(headerForLog(null)).toBe('-');
    expect(headerForLog('<script>alert(1)</script>')).toBe('scriptalert1script');
    expect(headerForLog('x'.repeat(80))).toHaveLength(40);
    expect(headerForLog('\n\t ')).toBe('?');
  });

  it('is carried in a cookie a page script cannot read and Intuit’s redirect still sends', () => {
    expect(oauthStateCookie(QBO_STATE_MAX_AGE_SECONDS)).toEqual({
      httpOnly: true,
      secure: true,
      // Strict would not be sent on the cross-site navigation back from Intuit.
      sameSite: 'lax',
      path: '/',
      maxAge: 600,
    });
  });
});

const owner: Viewer = { email: 'owner@harborline.test', orgName: 'Harborline Foods', role: 'owner' };
const analyst: Viewer = { ...owner, email: 'ap@harborline.test', role: 'analyst' };
const sandbox: QboDeployment = { environment: 'sandbox' };

function connection(overrides: Partial<LedgerConnectionOverview> = {}): LedgerConnectionOverview {
  return {
    connectionId: '44444444-4444-4444-4444-444444444444',
    orgId: ORG_ID,
    provider: 'qbo',
    providerAccountId: '9341457960434078',
    enabled: true,
    createdBy: USER_ID,
    createdByEmail: 'owner@harborline.test',
    createdAt: '2026-09-20T09:00:00.000Z',
    updatedAt: '2026-09-20T09:00:00.000Z',
    latestCredential: {
      storedAt: '2026-09-23T07:00:05.000Z',
      accessExpiresAt: '2026-09-23T08:00:05.000Z',
      refreshExpiresAt: '2027-01-01T07:00:05.000Z',
    },
    lastRun: {
      outcome: 'completed',
      startedAt: '2026-09-23T07:00:00.000Z',
      finishedAt: '2026-09-23T07:00:09.000Z',
      invoicesExamined: 12,
      openedCount: 3,
      skippedCount: 0,
      declinedCount: 1,
      anomalyCount: 1,
    },
    ...overrides,
  };
}

function page(props: Partial<Parameters<typeof LedgerConnectionPage>[0]> = {}): string {
  return renderToStaticMarkup(
    <LedgerConnectionPage
      viewer={owner}
      connections={[]}
      mayConnect
      deployment={sandbox}
      today={today}
      {...props}
    />,
  );
}

describe('Settings → QuickBooks', () => {
  it('offers an owner the button when nothing is connected, as a POST', () => {
    const html = page();
    expect(html).toContain('Not connected');
    expect(html).toContain('reads sandbox companies');
    expect(html).toMatch(/<form action="\/settings\/quickbooks\/connect" method="post">/);
    expect(html).toContain('Connect QuickBooks');
  });

  it('shows everybody else what is connected, and no button', () => {
    const html = page({ viewer: analyst, mayConnect: false, connections: [connection()] });
    expect(html).toContain('9341457960434078');
    expect(html).not.toContain('/settings/quickbooks/connect');
    expect(html).not.toContain('/settings/quickbooks/disconnect');
    expect(html).toContain('Only an owner of this workspace can connect or disconnect QuickBooks.');
  });

  it('names what to set on a deployment that cannot connect, and sends nobody to Intuit', () => {
    const html = page({ deployment: { missing: ['QBO_TOKEN_KMS_KEY_ID'] } });
    expect(html).toContain('QuickBooks is not set up on this deployment');
    expect(html).toContain('QBO_TOKEN_KMS_KEY_ID');
    expect(html).not.toContain('/settings/quickbooks/connect');
  });

  it('says what a connection reads, as whom, until when, and how its last sync went', () => {
    const html = page({ connections: [connection()] });
    expect(html).toContain('<h2>Connected</h2>');
    expect(html).toContain('owner@harborline.test');
    expect(html).toContain('2027-01-01');
    expect(html).toContain('2026-09-23 07:00 UTC: 12 invoices read, 3 cases opened, 1 declined, 1 anomalies');
    expect(html).toContain('name="connectionId" value="44444444-4444-4444-4444-444444444444"');
    expect(html).toMatch(/<form action="\/settings\/quickbooks\/disconnect" method="post">/);
    // Nothing to reconnect, so no button that suggests there is.
    expect(html).not.toContain('Reconnect');
  });

  it('says a connection the sync released was turned off because Intuit refused it (ADR 0046)', () => {
    const released = connection({
      enabled: false,
      updatedAt: '2026-10-02T07:00:05.000Z',
      releasedBySync: { at: '2026-10-02T07:00:05.000Z', reason: 'grant_refused' },
    });
    const html = page({ connections: [released] });
    expect(html).toContain('<h2>Not connected</h2>');
    expect(html).toContain(
      'QuickBooks refused the stored sign-in for company 9341457960434078 on 2026-10-02, so it was ' +
        'turned off automatically and nothing reads it now. Connect QuickBooks to sign in again.',
    );
    expect(html).toContain('2026-10-02, after QuickBooks refused its sign-in');
    expect(html).toContain('Connect QuickBooks');

    // A connection a person turned off says nothing about a release.
    const byHand = page({ connections: [connection({ enabled: false })] });
    expect(byHand).not.toContain('turned off automatically');
    expect(byHand).not.toContain('refused its sign-in');
  });

  it('offers Reconnect when the sign-in cannot be used, and says why', () => {
    const html = page({
      connections: [connection({ lastRun: { ...connection().lastRun!, outcome: 'failed', errorClass: 'QboAuthError' } })],
    });
    expect(html).toContain('Connected — needs reconnecting');
    expect(html).toContain('QuickBooks refused its sign-in on the last sync');
    expect(html).toContain('Reconnect');
  });

  it('lists the connections that were turned off, by company and by who', () => {
    const html = page({
      connections: [
        connection({ enabled: false, connectionId: 'old', updatedAt: '2026-09-21T10:00:00.000Z' }),
        connection(),
      ],
    });
    expect(html).toContain('Earlier connections');
    expect(html).toContain('2026-09-21');
  });

  it('renders the notice a step of the flow left, and nothing it does not know', () => {
    expect(page({ notice: 'qbo_connected' })).toContain('a first sync is on its way');
    expect(page({ notice: '<script>alert(1)</script>' })).not.toContain('alert(1)');
  });
});

describe('whether a connection needs reconnecting', () => {
  it('does not, when the only thing expired is the access token — the next sync refreshes it', () => {
    const expiredAccess = connection({
      latestCredential: { ...connection().latestCredential!, accessExpiresAt: '2026-09-01T00:00:00.000Z' },
    });
    expect(needsReconnect(expiredAccess, today)).toBeUndefined();
  });

  it('does, with no stored sign-in, an expired refresh, or a refusal the run log recorded', () => {
    const { latestCredential: _dropped, ...noCredential } = connection();
    expect(needsReconnect(noCredential, today)).toMatch(/No QuickBooks sign-in is stored/);
    expect(
      needsReconnect(
        connection({ latestCredential: { ...connection().latestCredential!, refreshExpiresAt: '2026-09-23T12:00:00.000Z' } }),
        today,
      ),
    ).toMatch(/expired on 2026-09-23/);
    const run = connection().lastRun!;
    expect(
      needsReconnect(connection({ lastRun: { ...run, outcome: 'failed', errorClass: 'CredentialUnreadableError' } }), today),
    ).toMatch(/could not be opened/);
    expect(
      needsReconnect(connection({ lastRun: { ...run, outcome: 'refused', errorClass: REFUSED } }), today),
    ).toMatch(/can no longer write/);
    // A disconnect is not the member's doing, and not a reason to sign in again.
    expect(
      needsReconnect(
        connection({ lastRun: { ...run, outcome: 'refused', errorClass: DISABLED } }),
        today,
      ),
    ).toBeUndefined();
    // A failure that is not about the sign-in is not a reason to sign in again.
    expect(
      needsReconnect(connection({ lastRun: { ...run, outcome: 'failed', errorClass: 'QboRequestFailed' } }), today),
    ).toBeUndefined();
  });

  it('does not, straight after a reconnect, over a failure from before it', () => {
    // The run refused the old sign-in at 07:00; the owner reconnected at 09:00.
    const reconnected = connection({
      lastRun: {
        ...connection().lastRun!,
        outcome: 'failed',
        errorClass: 'QboAuthError',
        startedAt: '2026-09-23T07:00:00.000Z',
        finishedAt: '2026-09-23T07:00:04.000Z',
      },
      latestCredential: { ...connection().latestCredential!, storedAt: '2026-09-23T09:00:00.000Z' },
    });
    expect(needsReconnect(reconnected, today)).toBeUndefined();
    expect(page({ connections: [reconnected] })).not.toContain('needs reconnecting');

    // A run that rotated the sign-in and then was refused still counts: it
    // finished after the rotation it stored.
    const refusedAfterRotating = connection({
      lastRun: {
        ...connection().lastRun!,
        outcome: 'failed',
        errorClass: 'QboAuthError',
        startedAt: '2026-09-23T07:00:00.000Z',
        finishedAt: '2026-09-23T07:00:09.000Z',
      },
      latestCredential: { ...connection().latestCredential!, storedAt: '2026-09-23T07:00:05.000Z' },
    });
    expect(needsReconnect(refusedAfterRotating, today)).toMatch(/refused its sign-in/);
  });
});

describe('the last sync, in a sentence', () => {
  it('uses the run log’s own words: an outcome, the counts and a class name', () => {
    const run = connection().lastRun!;
    const { lastRun: _dropped, ...never } = connection();
    expect(lastSyncSentence(never)).toBe('not yet — the first one is on its way');
    expect(lastSyncSentence(connection({ lastRun: { ...run, outcome: 'not_configured' } }))).toBe(
      '2026-09-23 07:00 UTC: not read — this deployment could not reach QuickBooks',
    );
    expect(lastSyncSentence(connection({ lastRun: { ...run, outcome: 'refused', errorClass: REFUSED } }))).toBe(
      `2026-09-23 07:00 UTC: not read — refused (${REFUSED})`,
    );
    expect(
      lastSyncSentence(connection({ lastRun: { ...run, outcome: 'refused', errorClass: DISABLED } })),
    ).toBe('2026-09-23 07:00 UTC: not read — it was disconnected when this run started');
    expect(lastSyncSentence(connection({ lastRun: { ...run, outcome: 'failed' } }))).toBe('2026-09-23 07:00 UTC: failed');
  });
});

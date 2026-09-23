import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { exchangeIntuitToken, QboAuthError, verifyRealmAccess } from '@recouple/qbo';
import {
  AccountConnectedElsewhereError,
  connectQboCompany,
  OwnerRequiredError,
  PostgresLedgerSyncStore,
} from '@recouple/store-postgres';
import { requireSession } from '../../../../lib/session';
import { tenantStore } from '../../../../lib/store';
import { env } from '../../../../lib/env';
import { inngestClient, inngestKeysFromEnv } from '../../../../lib/inngest';
import { ledgerSyncRequestedEvent } from '../../../../lib/inngest-ledger';
import { type NoticeKey } from '../../../../lib/notices';
import {
  checkOAuthState,
  headerForLog,
  mayConnectLedger,
  oauthStateCookie,
  qboConnectFromEnv,
  QBO_SETTINGS_PATH,
  QBO_STATE_COOKIE,
  type OAuthStateRefusal,
} from '../../../../lib/qbo-connect';

/** Exchange, verify, seal and three transactions: seconds, not minutes (ADR 0039). */
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

/**
 * Where Intuit sends the owner back after consent (ADR 0039 §2–§4, §10).
 *
 * **The one GET in this app that writes**, and it cannot use `isCrossSite`: it
 * is reached by a cross-site top-level redirect from Intuit, so the browser
 * says `Sec-Fetch-Site: cross-site` on every legitimate call. Its CSRF defence
 * is the state cookie — a single-use nonce this app minted when the owner
 * pressed Connect, compared in constant time, ten minutes at most — and that is
 * checked before anything else is. Everything the cookie names beyond the nonce
 * is re-derived from the live session.
 *
 * In order, each before anything it could cost:
 *
 *  1. the state (no match, no exchange — and the cookie is cleared on every
 *     path this code reaches);
 *  2. Intuit's own `error`, never repeated back — `error_description` is not
 *     rendered and not logged;
 *  3. the session's user is the cookie's; the cookie's org is one of the
 *     session's memberships, where the member is still an owner; and the
 *     database says the member may write;
 *  4. this deployment can seal what it is about to receive;
 *  5. the code is exchanged, here and never in a job — it is a credential, and
 *     an event payload is durable in a third party (ADR 0021);
 *  6. the new token must read the company Intuit named before anything is
 *     written, so nobody files a company they do not administer;
 *  7. `connectQboCompany`: seal, the company's lock, then the claim, the
 *     credential and the audit row in one transaction;
 *  8. one `ledger/sync.requested`, so the first results arrive in minutes.
 *
 * What is logged is a class name and ids. Never the code, a token or anything
 * Intuit said.
 *
 * **A second arrival of the same redirect** — production saw one on the first
 * sandbox click-through, a second later, after the first had connected and
 * spent the cookie — is refused like any other request without a state; it
 * exchanges nothing. What it *says* is the difference: when there is no cookie
 * at all and this member's own connection to the company in the URL stored a
 * sign-in within the last two minutes, the page says the company is connected
 * rather than that the sign-in failed — and so does an arrival that still
 * carried the cookie but found its code already spent by the first. That is a
 * read through RLS of something the page shows anyway, so a forged link can
 * learn nothing from it and can change nothing. Every refusal and every connect
 * is logged with the request's fetch metadata and the notice given, so the next
 * one says where it came from.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const url = new URL(request.url);
  const cookieValue = request.cookies.get(QBO_STATE_COOKIE)?.value;

  const session = await requireSession();
  const settings = new URL(QBO_SETTINGS_PATH, request.url);
  const say = (notice: NoticeKey): NextResponse => {
    settings.searchParams.set('qbo', notice);
    const response = NextResponse.redirect(settings, { status: 303 });
    // Single use, however this ends.
    response.cookies.set(QBO_STATE_COOKIE, '', oauthStateCookie(0));
    return response;
  };

  // 1. The state, first: nothing below runs for a redirect this app did not start.
  const checked = checkOAuthState(cookieValue, url.searchParams.get('state'), new Date());
  if (!checked.ok || checked.claim.userId !== session.userId) {
    const reason: OAuthStateRefusal | 'other_member' = checked.ok ? 'other_member' : checked.reason;
    const notice: NoticeKey =
      reason === 'no_cookie' &&
      (await justConnected(
        { orgId: session.org.orgId, userId: session.userId },
        url.searchParams.get('realmId'),
      ))
        ? 'qbo_already_connected'
        : 'qbo_state_invalid';
    console.warn(
      `[recouple] QuickBooks connect: state refused (${reason}) for member ${session.userId}, ` +
        `said ${notice}; ${fetchMetadata(request)}`,
    );
    return say(notice);
  }
  const claim = checked.claim;

  // 2. The owner said no at Intuit, or Intuit could not ask them.
  if (url.searchParams.get('error') !== null) return say('qbo_denied');

  // 3. Whose consent this is: the cookie's org, among the session's own
  // memberships — not whichever org the org cookie happens to select now.
  const membership = session.orgs.find((org) => org.orgId === claim.orgId);
  if (membership === undefined || !mayConnectLedger(membership.role)) return say('qbo_role');
  const identity = { orgId: claim.orgId, userId: session.userId };

  // 4. A deployment that could not store the tokens exchanges nothing.
  const configured = qboConnectFromEnv();
  if (configured.kind !== 'ready') return say('qbo_not_configured');

  const code = url.searchParams.get('code');
  const realmId = url.searchParams.get('realmId');
  if (code === null || code === '' || realmId === null || !/^\d{1,20}$/.test(realmId)) {
    return say('qbo_exchange_failed');
  }

  const store = tenantStore(identity);
  try {
    if (!(await store.memberMayWrite(identity))) return say('qbo_role');

    // 5. The exchange.
    let tokens;
    try {
      tokens = await exchangeIntuitToken(
        configured.app,
        { grantType: 'authorization_code', code, redirectUri: configured.redirectUri },
        'authorization code',
      );
    } catch (cause) {
      log('the code exchange failed', identity, realmId, cause);
      // A second arrival that still carried the cookie spends the code the
      // first one already spent, and Intuit refuses it. If the first is
      // connecting this company for this member, say so rather than that
      // nothing was connected: it may still be finishing, so ask for a few
      // seconds.
      if (cause instanceof QboAuthError && (await connectsWithin(identity, realmId, 5))) {
        console.warn(
          `[recouple] QuickBooks connect: code already spent by an earlier arrival for org ` +
            `${identity.orgId}, member ${identity.userId}, ${realmId}; said qbo_already_connected; ` +
            fetchMetadata(request),
        );
        return say('qbo_already_connected');
      }
      return say('qbo_exchange_failed');
    }

    // 6. The company is one this token can read.
    try {
      await verifyRealmAccess({
        baseUrl: configured.app.baseUrl,
        realmId,
        accessToken: tokens.accessToken,
      });
    } catch (cause) {
      log('the company could not be read with the new token', identity, realmId, cause);
      return say('qbo_realm_unverified');
    }

    // 7. Seal, lock, one transaction.
    let connected;
    try {
      connected = await connectQboCompany({ connectionString: env.databaseUrl }, identity, {
        realmId,
        tokens,
        cipher: configured.cipher,
        via: 'web_consent',
        environment: configured.app.environment,
      });
    } catch (cause) {
      if (cause instanceof AccountConnectedElsewhereError) return say('qbo_connected_elsewhere');
      if (cause instanceof OwnerRequiredError) return say('qbo_role');
      log('connecting failed', identity, realmId, cause);
      return say('qbo_connect_failed');
    }

    console.log(
      `[recouple] QuickBooks connect: ${connected.outcome} company ${realmId} as connection ` +
        `${connected.connection.connectionId} for org ${identity.orgId}, member ${identity.userId}; ` +
        fetchMetadata(request),
    );

    // 8. The first sync, on the existing event.
    return say(await queueFirstSync(connected.connection.connectionId, identity));
  } finally {
    await store.close();
  }
}

/** How recently a sign-in must have been stored to explain a repeated arrival. */
const REPEAT_WINDOW_MS = 120_000;

/**
 * Whether this member's own connection to `realmId`, in `identity.orgId`, is
 * enabled with a sign-in stored in the last two minutes — the answer to a
 * redirect that arrives again after the first one connected. Read through RLS
 * as the signed-in member; any doubt (no such company, somebody else's
 * connection, an older sign-in, the read failing) is `false`, and the caller
 * says what it would have said anyway. It writes nothing.
 *
 * A sync's own token rotation also stores a sign-in, as this member (the sync
 * acts as the connection's creator), so within those two minutes the answer can
 * be yes without a consent having just finished. The notice it leads to is
 * true either way: the company is connected, and this request changed nothing.
 */
async function justConnected(
  identity: { readonly orgId: string; readonly userId: string },
  realmId: string | null,
): Promise<boolean> {
  if (realmId === null || !/^\d{1,20}$/.test(realmId)) return false;
  const store = tenantStore(identity);
  try {
    const connections = await new PostgresLedgerSyncStore(
      { connectionString: env.databaseUrl },
      identity,
      store,
    ).ledgerConnectionOverview();
    const stored = connections.find(
      (connection) =>
        connection.enabled &&
        connection.providerAccountId === realmId &&
        connection.createdBy === identity.userId,
    )?.latestCredential?.storedAt;
    if (stored === undefined) return false;
    const age = Date.now() - Date.parse(stored);
    return age >= 0 && age <= REPEAT_WINDOW_MS;
  } catch (cause) {
    log('reading the connection for a repeated redirect failed', identity, realmId, cause);
    return false;
  } finally {
    await store.close();
  }
}

/** `justConnected`, asked once a second for up to `seconds` seconds. */
async function connectsWithin(
  identity: { readonly orgId: string; readonly userId: string },
  realmId: string,
  seconds: number,
): Promise<boolean> {
  for (let attempt = 0; attempt <= seconds; attempt += 1) {
    if (await justConnected(identity, realmId)) return true;
    if (attempt < seconds) await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
}

/**
 * What kind of request this was — the browser's fetch metadata, reduced to its
 * enumeration characters, and whether it carried a code and a state — so a log
 * line says whether an arrival was a navigation, a prefetch or something else.
 * Never a value from the URL.
 */
function fetchMetadata(request: NextRequest): string {
  const url = new URL(request.url);
  const header = (name: string) => headerForLog(request.headers.get(name));
  return (
    `sec-fetch-site=${header('sec-fetch-site')} sec-fetch-mode=${header('sec-fetch-mode')} ` +
    `sec-fetch-dest=${header('sec-fetch-dest')} sec-fetch-user=${header('sec-fetch-user')} ` +
    `sec-purpose=${header('sec-purpose')} code=${url.searchParams.has('code') ? 'yes' : 'no'} ` +
    `state=${url.searchParams.has('state') ? 'yes' : 'no'}`
  );
}

/**
 * One `ledger/sync.requested` for the new connection, acting as the member who
 * made it — which is its `created_by` (ADR 0031 §3).
 *
 * Its own notice for each way it can end. With no Inngest keys there is no
 * scheduler at all — the daily fan-out is itself an Inngest function — so that
 * is said rather than a 07:00 run promised that will not happen.
 */
async function queueFirstSync(
  connectionId: string,
  identity: { readonly orgId: string; readonly userId: string },
): Promise<NoticeKey> {
  try {
    const keys = inngestKeysFromEnv();
    if (keys === undefined) return 'qbo_connected_no_scheduler';
    await inngestClient(keys).send(
      ledgerSyncRequestedEvent({
        connectionId,
        orgId: identity.orgId,
        userId: identity.userId,
        syncKey: randomUUID(),
      }),
    );
    return 'qbo_connected';
  } catch (cause) {
    log('the first sync could not be queued', identity, connectionId, cause);
    return 'qbo_connected_not_queued';
  }
}

/**
 * A line for an operator: what failed, whose, which company — and the error's
 * class name only. The messages on this path are written never to carry a code
 * or a token, and a class name cannot carry either.
 */
function log(
  what: string,
  identity: { readonly orgId: string; readonly userId: string },
  subject: string,
  cause: unknown,
): void {
  const name = cause instanceof Error ? cause.name : typeof cause;
  console.error(
    `[recouple] QuickBooks connect: ${what} (${name}) for org ${identity.orgId}, ` +
      `member ${identity.userId}, ${subject}`,
  );
}

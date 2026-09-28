import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  QboAuthError,
  QboChartTooLarge,
  QboMalformedResponse,
  QboRateLimited,
  QboRequestFailed,
  SETUP_ACCOUNTS,
  proposePostingSetup,
  type QboAccount,
} from '@recouple/qbo';
import { TokenCipherError } from '@recouple/crypto';
import {
  CredentialExpiryUnreadableError,
  CredentialUnreadableError,
  LedgerAccountBusyError,
  LockPoolTimeoutError,
  QboRealmMismatchError,
  type PostingConnectionView,
} from '@recouple/store-postgres';
import { CHART_MAX_PAGES, CHART_READ_BOUNDS, CHART_READ_TIMEOUT_MS, postingSettingsFor } from '../lib/posting-setup';
import type { QboPoster } from '../lib/qbo-posting';

/**
 * Settings → QuickBooks' own read of each company's chart (ADR 0063 §1, §4):
 * what the card proposes from, and what the page shows when it cannot. The
 * read is the page's and optional, so nothing it meets may take the page —
 * and its Connect and Disconnect — down with it; and what it logs is a class
 * name and ids, because what an error says may quote QuickBooks' own answer.
 */

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const IDENTITY = { orgId: ORG_ID, userId: USER_ID };

function connection(connectionId: string, realmId: string): PostingConnectionView {
  return { connectionId, realmId, postingEnabled: false, map: undefined };
}
const FIRST = connection('44444444-4444-4444-8444-444444444444', '4620816365');
const SECOND = connection('55555555-5555-4555-8555-555555555555', '9130357843');

function account(id: string, name: string, accountType: string, active = true): QboAccount {
  return { id, name, fullyQualifiedName: name, accountType, accountSubType: undefined, active };
}
const CHART = [
  account('7001', 'Trade Receivables', 'Accounts Receivable'),
  account('7003', 'Prepaid Freight', 'Other Current Asset'),
  account('7004', 'Promotional Allowances', 'Expense'),
];

/** What a failure may carry and a log line may not: a body, an account's name, a key, a token. */
const SECRET = `BODY-SECRET ${SETUP_ACCOUNTS.writeoff.name} arn:aws:kms:us-east-1:key access-token-xyz`;

/** What one connection's read does: answer a chart, reject with `throws`, or never get a client. */
type Read = readonly QboAccount[] | { readonly throws: unknown } | 'no_client' | 'throws_building';

/** What each read of the chart was asked with, by connection. */
const asked: Array<[string, unknown]> = [];

/**
 * A poster that answers each connection's read with `reads[connectionId]`.
 * Only the chart's read is ever asked for; anything else is a mistake here.
 */
function posterFor(reads: Record<string, Read>): QboPoster {
  const refuse = (): never => {
    throw new Error('the page reads the chart and nothing else');
  };
  return {
    clientFor: refuse,
    accountTypesFor: refuse,
    accountCreatorFor: refuse,
    accountsFor(_identity, { connectionId }, options) {
      asked.push([connectionId, options]);
      const read = reads[connectionId];
      if (read === undefined) throw new Error(`no read arranged for ${connectionId}`);
      if (read === 'no_client') return undefined;
      if (read === 'throws_building') throw new TokenCipherError(`could not build: ${SECRET}`);
      return async () => {
        if ('throws' in read) throw read.throws;
        return read;
      };
    },
  };
}

const logged: Array<{ level: string; line: string }> = [];

beforeEach(() => {
  logged.length = 0;
  asked.length = 0;
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push({ level, line: args.map(String).join(' ') });
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a chart that reads', () => {
  it("is proposePostingSetup's own proposal over it, and logs nothing", async () => {
    const [setup] = await postingSettingsFor(posterFor({ [FIRST.connectionId]: CHART }), IDENTITY, [FIRST]);
    expect(setup).toEqual({ ...FIRST, chart: { kind: 'read', proposal: proposePostingSetup(CHART) } });
    expect(logged).toEqual([]);
  });

  it("asks each company's QuickBooks with the page's own ten-second bound, not a press's minute", async () => {
    await postingSettingsFor(posterFor({ [FIRST.connectionId]: CHART, [SECOND.connectionId]: CHART }), IDENTITY, [
      FIRST,
      SECOND,
    ]);
    expect(CHART_READ_TIMEOUT_MS).toBe(10_000);
    // Two pages of a chart at most, so the read can be counted.
    expect(CHART_READ_BOUNDS).toEqual({ timeoutMs: CHART_READ_TIMEOUT_MS, maxPages: CHART_MAX_PAGES });
    expect(CHART_MAX_PAGES).toBe(2);
    expect(asked).toEqual([
      [FIRST.connectionId, CHART_READ_BOUNDS],
      [SECOND.connectionId, CHART_READ_BOUNDS],
    ]);
  });

  it('says not_configured when this deployment cannot build a client for the company, and logs nothing', async () => {
    const [setup] = await postingSettingsFor(posterFor({ [FIRST.connectionId]: 'no_client' }), IDENTITY, [FIRST]);
    expect(setup?.chart).toEqual({ kind: 'not_configured' });
    expect(logged).toEqual([]);
  });
});

describe('a chart that cannot be read costs its card, never the page', () => {
  /** Everything the read may meet: QuickBooks, our way to it, KMS, a mistake of ours. */
  const FAILURES: Array<[string, Error]> = [
    ['QboAuthError', new QboAuthError(`Intuit refused the refresh: ${SECRET}`)],
    ['QboRateLimited', new QboRateLimited(`QuickBooks answered 429: ${SECRET}`, 60_000)],
    ['QboRequestFailed', new QboRequestFailed(`QuickBooks did not answer within 60000ms: ${SECRET}`, 0, undefined)],
    ['QboMalformedResponse', new QboMalformedResponse(`expected text: ${SECRET}`, 'Account[3].Name')],
    ['LedgerAccountBusyError', new LedgerAccountBusyError('qbo', FIRST.realmId)],
    ['LockPoolTimeoutError', new LockPoolTimeoutError('qbo', FIRST.realmId)],
    // A chart longer than the page reads: shown as unreadable, never as the part of it read.
    ['QboChartTooLarge', new QboChartTooLarge(CHART_MAX_PAGES, 1000)],
    [
      'CredentialUnreadableError',
      new CredentialUnreadableError(FIRST.connectionId, 'cred-1', 'kms-v1', SECRET, 'decrypt'),
    ],
    ['TokenCipherError', new TokenCipherError(`sealing the rotated token failed: ${SECRET}`)],
    ['CredentialExpiryUnreadableError', new CredentialExpiryUnreadableError(FIRST.connectionId, 'expires_at', SECRET)],
    ['QboRealmMismatchError', new QboRealmMismatchError(FIRST.connectionId, FIRST.realmId, SECRET)],
    ['AccessDeniedException', Object.assign(new Error(`User: ${SECRET} is not authorized`), { name: 'AccessDeniedException' })],
    ['TypeError', new TypeError(`cannot read properties of undefined (reading '${SECRET}')`)],
  ];

  it.each(FAILURES)('shows %s as unreadable, in one error line naming the class and the ids', async (cls, error) => {
    const [setup] = await postingSettingsFor(posterFor({ [FIRST.connectionId]: { throws: error } }), IDENTITY, [FIRST]);
    expect(setup?.chart).toEqual({ kind: 'unreadable' });
    expect(logged).toEqual([
      {
        level: 'error',
        line:
          `[recouple] posting settings: chart of accounts unreadable (${cls}), ` +
          `connection ${FIRST.connectionId} org ${ORG_ID}`,
      },
    ]);
  });

  it('adds the status and fault code QuickBooks answered with, and nothing it said', async () => {
    const error = new QboRequestFailed(`QuickBooks answered 403 for realm ${FIRST.realmId}: {"Fault":${SECRET}}`, 403, {
      Error: [{ Message: SECRET, Detail: SECRET, code: '3100' }],
      type: 'AuthorizationFault',
    });
    await postingSettingsFor(posterFor({ [FIRST.connectionId]: { throws: error } }), IDENTITY, [FIRST]);
    expect(logged.map(({ line }) => line)).toEqual([
      '[recouple] posting settings: chart of accounts unreadable (QboRequestFailed, HTTP 403, fault 3100), ' +
        `connection ${FIRST.connectionId} org ${ORG_ID}`,
    ]);
  });

  it('shows a client that cannot even be built as unreadable, too', async () => {
    const [setup] = await postingSettingsFor(posterFor({ [FIRST.connectionId]: 'throws_building' }), IDENTITY, [FIRST]);
    expect(setup?.chart).toEqual({ kind: 'unreadable' });
    expect(logged.map(({ line }) => line)).toEqual([
      `[recouple] posting settings: chart of accounts unreadable (TokenCipherError), connection ${FIRST.connectionId} org ${ORG_ID}`,
    ]);
  });

  it('names no class it cannot trust to be one, and survives a throw that is not an Error', async () => {
    const forged = Object.assign(new Error(SECRET), { name: `${SETUP_ACCOUNTS.writeoff.name} <b>` });
    for (const thrown of [forged, SECRET] as const) {
      logged.length = 0;
      const [setup] = await postingSettingsFor(posterFor({ [FIRST.connectionId]: { throws: thrown } }), IDENTITY, [FIRST]);
      // A string is thrown as the read's own rejection, not by the poster.
      expect(setup?.chart).toEqual({ kind: 'unreadable' });
      expect(logged.map(({ line }) => line)).toEqual([
        `[recouple] posting settings: chart of accounts unreadable (unnamed), connection ${FIRST.connectionId} org ${ORG_ID}`,
      ]);
    }
  });

  it('never lets what an error says reach a log line', async () => {
    for (const [, error] of FAILURES) {
      await postingSettingsFor(posterFor({ [FIRST.connectionId]: { throws: error } }), IDENTITY, [FIRST]);
    }
    const everything = logged.map(({ line }) => line).join('\n');
    for (const forbidden of ['BODY-SECRET', SETUP_ACCOUNTS.writeoff.name, 'arn:', 'access-token', 'Fault']) {
      expect(everything, forbidden).not.toContain(forbidden);
    }
  });
});

describe('several companies', () => {
  it('reads each on its own: one that fails costs only its own card', async () => {
    const settings = await postingSettingsFor(
      posterFor({
        [FIRST.connectionId]: {
          throws: new QboRequestFailed(`QuickBooks did not answer within 60000ms: ${SECRET}`, 0, undefined),
        },
        [SECOND.connectionId]: CHART,
      }),
      IDENTITY,
      [FIRST, SECOND],
    );
    expect(settings.map(({ connectionId, chart }) => [connectionId, chart.kind])).toEqual([
      [FIRST.connectionId, 'unreadable'],
      [SECOND.connectionId, 'read'],
    ]);
    expect(logged).toHaveLength(1);
    expect(logged[0]?.line).toContain(`connection ${FIRST.connectionId}`);
  });

  it('reads them side by side, so a slow company holds the page for its own read and not for the sum', async () => {
    const started: string[] = [];
    const waiting = new Map<string, () => void>();
    const slow: QboPoster = {
      ...posterFor({}),
      accountsFor: (_identity, { connectionId }) => async () => {
        started.push(connectionId);
        await new Promise<void>((resolve) => waiting.set(connectionId, resolve));
        return CHART;
      },
    };
    const page = postingSettingsFor(slow, IDENTITY, [FIRST, SECOND]);
    // Both reads are under way before either has answered.
    await vi.waitFor(() => expect(started).toEqual([FIRST.connectionId, SECOND.connectionId]));
    waiting.get(SECOND.connectionId)?.();
    waiting.get(FIRST.connectionId)?.();
    const settings = await page;
    expect(settings.map(({ connectionId, chart }) => [connectionId, chart.kind])).toEqual([
      [FIRST.connectionId, 'read'],
      [SECOND.connectionId, 'read'],
    ]);
  });
});

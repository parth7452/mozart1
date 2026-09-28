import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { REASON_FAMILIES } from '@recouple/core-domain';
import {
  QboAccountReadBackError,
  QboAuthError,
  QboChartTooLarge,
  QboMalformedResponse,
  QboRateLimited,
  QboRequestFailed,
  SETUP_ACCOUNTS,
  SETUP_ROWS,
  postingSetupRequestId,
  type AccountReadBackField,
  type LedgerAccountMap,
  type QboAccount,
  type SetupAccountSpec,
  type SetupRow,
} from '@recouple/qbo';
import {
  AccountMapTypeError,
  CredentialUnreadableError,
  LEDGER_ACCOUNT_LOCK_TIMEOUT_MS,
  LOCK_POOL_CONNECT_TIMEOUT_MS,
  LedgerAccountBusyError,
  LockPoolTimeoutError,
  OwnerRequiredError,
  SETUP_CLAIM_CONNECT_TIMEOUT_MS,
} from '@recouple/store-postgres';
import { NOTICES, resolveNotice } from '../lib/notices';

/**
 * ADR 0063 §2: one owner's press that creates what is missing, saves the map
 * and turns posting on — in that order, and nothing after a step that
 * refuses. The session, the posting store and QuickBooks are stand-ins that
 * record every call in one list, so a test can say what ran and in what
 * order; `setUpPosting` itself is the real one. The store's claim is modelled
 * as the advisory lock it is, within one process: a connection is held by at
 * most one press at a time. Its audit log is modelled as the rows it holds, so
 * a create one press asked for and never heard back about is what the next
 * press is told is unanswered, until a creation or a find answers it; each
 * request is named for its attempt, the answers its row already has; and
 * every account created or found is what a later press is told setup recorded.
 */

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const CONNECTION_ID = '44444444-4444-4444-8444-444444444444';
const REALM = '4620816365';

/** A chart as QuickBooks lists it; ids are four digits no other text here holds. */
function account(id: string, name: string, accountType: string, active = true): QboAccount {
  return { id, name, fullyQualifiedName: name, accountType, accountSubType: undefined, active };
}
const AR = account('7001', 'Trade Receivables (Harbor Line)', 'Accounts Receivable');
const BANK = account('7002', 'Operating Checking', 'Bank');
const PREPAID = account('7003', 'Prepaid Freight', 'Other Current Asset');
const PROMO = account('7004', 'Promotional Allowances', 'Expense');
const MISC = account('7005', 'Miscellaneous Losses', 'Other Expense');
const OURS_DR = account('7010', SETUP_ACCOUNTS.deductions_receivable.name, 'Other Current Asset');
const OURS_WO = account('7011', SETUP_ACCOUNTS.writeoff.name, 'Expense');
/** What an accountant renamed ours to, and what they moved it under. */
const RENAMED_TO = '1250 Holdback Clearing';
const PARENT = 'Harbor Line Clearing';
/** Every name this file puts in a chart: none may reach a log, a redirect or an audit row. */
const NAMES = [AR, BANK, PREPAID, PROMO, MISC, OURS_DR, OURS_WO].map((a) => a.name).concat(RENAMED_TO, PARENT);

const harness = vi.hoisted(() => ({
  role: 'owner' as string,
  posting: true,
  mayWrite: true,
  dbOwner: true,
  client: true,
  calls: [] as unknown[][],
  chart: [] as QboAccount[],
  nextId: 8000,
  map: undefined as (LedgerAccountMap & { mapId: string }) | undefined,
  postingEnabled: false,
  /** The connections a press holds the claim on right now. */
  claimed: new Set<string>(),
  /** Set when no connection to hold a claim on is free: every press is `no_connection`. */
  noClaimConnection: false,
  listError: undefined as Error | undefined,
  /** Makes one create fail: what it throws, after whatever it leaves in the chart. */
  createFails: undefined as ((spec: SetupAccountSpec, id: string) => Error | undefined) | undefined,
  /** Holds every create open until it settles, so a second press can arrive meanwhile. */
  createGate: undefined as Promise<void> | undefined,
  typesError: undefined as Error | undefined,
  saveError: undefined as Error | undefined,
  requestAuditError: undefined as Error | undefined,
  createdAuditError: undefined as Error | undefined,
  /** The setup rows the audit log holds, in the order they were written: the store's own answers are read off it. */
  audit: [] as Array<{
    action: 'requested' | 'created' | 'found';
    row: SetupRow;
    requestId: string;
    accountId?: string;
  }>,
  /** What each QuickBooks reader and creator was built with: a press bounds every request it makes. */
  built: [] as Array<[string, unknown]>,
}));

const store = {
  async memberMayWrite() {
    harness.calls.push(['memberMayWrite']);
    return harness.mayWrite;
  },
  async memberIsOwner() {
    harness.calls.push(['memberIsOwner']);
    return harness.dbOwner;
  },
  async withSetupClaim<T>(connectionId: string, work: () => Promise<T>) {
    harness.calls.push(['withSetupClaim', connectionId]);
    if (harness.noClaimConnection) return { held: false as const, reason: 'no_connection' as const };
    if (harness.claimed.has(connectionId)) return { held: false as const, reason: 'held' as const };
    harness.claimed.add(connectionId);
    try {
      return { held: true as const, result: await work() };
    } finally {
      harness.claimed.delete(connectionId);
    }
  },
  async postingConnections() {
    harness.calls.push(['postingConnections']);
    return [
      { connectionId: CONNECTION_ID, realmId: REALM, postingEnabled: harness.postingEnabled, map: harness.map },
    ];
  },
  /** The real store's rule: a row whose latest request has no creation, and no find, after it — and that request's id. */
  async unansweredAccountCreates(connectionId: string) {
    harness.calls.push(['unansweredAccountCreates', connectionId]);
    return SETUP_ROWS.flatMap((row) => {
      const asked = harness.audit.findLastIndex((entry) => entry.action === 'requested' && entry.row === row);
      const answered = harness.audit.slice(asked + 1).some((entry) => entry.action !== 'requested' && entry.row === row);
      return asked < 0 || answered ? [] : [{ row, requestId: harness.audit[asked]!.requestId }];
    });
  },
  /** The real store's rule: every account created or found for each row, oldest first. */
  async recordedSetupAccounts(connectionId: string) {
    harness.calls.push(['recordedSetupAccounts', connectionId]);
    const of = (row: SetupRow) =>
      harness.audit.flatMap((entry) =>
        entry.action !== 'requested' && entry.row === row && entry.accountId !== undefined ? [entry.accountId] : [],
      );
    return { deductions_receivable: of('deductions_receivable'), writeoff: of('writeoff') };
  },
  /** The real store's rule: this attempt is the number of answers the row already has. */
  async recordAccountCreateRequested(connectionId: string, row: SetupRow) {
    harness.calls.push(['recordAccountCreateRequested', connectionId, row]);
    if (harness.requestAuditError !== undefined) throw harness.requestAuditError;
    const answers = harness.audit.filter((entry) => entry.action !== 'requested' && entry.row === row).length;
    const requestId = postingSetupRequestId(connectionId, row, answers);
    harness.audit.push({ action: 'requested', row, requestId });
    return requestId;
  },
  async recordAccountCreated(
    connectionId: string,
    input: { row: SetupRow; qboAccountId: string; readBackMismatch?: readonly AccountReadBackField[] },
  ) {
    harness.calls.push(['recordAccountCreated', connectionId, input]);
    if (harness.createdAuditError !== undefined) throw harness.createdAuditError;
    harness.audit.push({ action: 'created', row: input.row, requestId: latestRequest(input.row), accountId: input.qboAccountId });
  },
  async recordAccountFound(connectionId: string, input: { row: SetupRow; qboAccountId: string }) {
    harness.calls.push(['recordAccountFound', connectionId, input]);
    if (harness.createdAuditError !== undefined) throw harness.createdAuditError;
    harness.audit.push({ action: 'found', row: input.row, requestId: latestRequest(input.row), accountId: input.qboAccountId });
  },
  async saveAccountMap(
    connectionId: string,
    map: LedgerAccountMap,
    readTypes: (ids: readonly string[]) => Promise<ReadonlyMap<string, string>>,
  ) {
    harness.calls.push(['saveAccountMap', connectionId, map]);
    // The real store reads every type live before it writes; so does this.
    await readTypes([map.arAccountId, map.deductionsReceivableAccountId]);
    if (harness.saveError !== undefined) {
      const error = harness.saveError;
      harness.saveError = undefined;
      throw error;
    }
    harness.map = { ...map, mapId: 'map-1' };
    return { mapId: 'map-1' };
  },
  async setPostingEnabled(connectionId: string, enabled: boolean) {
    harness.calls.push(['setPostingEnabled', connectionId, enabled]);
    harness.postingEnabled = enabled;
  },
};

/** The request an answer for `row` answers, as the real store copies it: the row's latest. */
function latestRequest(row: SetupRow): string {
  const asked = harness.audit.findLast((entry) => entry.action === 'requested' && entry.row === row);
  if (asked === undefined) throw new Error(`no ${row} account was asked for`);
  return asked.requestId;
}

/**
 * QuickBooks as the poster reaches it. A create adds the account to the chart,
 * so a second press re-reads a chart that has it, the way the company would.
 */
const poster = {
  clientFor: () => undefined,
  accountTypesFor: (_identity: unknown, _connection: unknown, options?: unknown) => {
    harness.built.push(['accountTypesFor', options]);
    return harness.client
      ? async (ids: readonly string[]) => {
          harness.calls.push(['accountTypes', [...ids]]);
          if (harness.typesError !== undefined) throw harness.typesError;
          return new Map(harness.chart.filter((a) => a.active && ids.includes(a.id)).map((a) => [a.id, a.accountType]));
        }
      : undefined;
  },
  accountsFor: (_identity: unknown, _connection: unknown, options?: unknown) => {
    harness.built.push(['accountsFor', options]);
    return harness.client
      ? async () => {
          harness.calls.push(['listAccounts']);
          if (harness.listError !== undefined) throw harness.listError;
          return [...harness.chart];
        }
      : undefined;
  },
  accountCreatorFor: (_identity: unknown, _connection: unknown, options?: unknown) => {
    harness.built.push(['accountCreatorFor', options]);
    return harness.client
      ? async (spec: SetupAccountSpec, requestId: string) => {
          harness.calls.push(['createAccount', spec, requestId]);
          if (harness.createGate !== undefined) await harness.createGate;
          const id = String(harness.nextId++);
          const failure = harness.createFails?.(spec, id);
          if (failure !== undefined) throw failure;
          const created = account(id, spec.name, spec.accountType);
          harness.chart.push(created);
          return created;
        }
      : undefined;
  },
};

vi.mock('../lib/session', () => ({
  requireSession: async () => ({
    userId: USER_ID,
    email: 'owner@example.test',
    org: { orgId: ORG_ID, slug: 'acme', name: 'Acme', role: harness.role },
    orgs: [],
  }),
}));

vi.mock('../lib/qbo-posting', () => ({
  qboPostingFromEnv: () => (harness.posting ? poster : undefined),
}));

vi.mock('../lib/posting', () => ({
  postingStoreFor: () => store,
}));

const { POST, maxDuration } = await import('../app/settings/quickbooks/setup/route');
const {
  CHART_MAX_PAGES,
  CREATE_ACCOUNT,
  PRESS_BOUNDS,
  PRESS_REQUEST_TIMEOUT_MS,
  SAME_AS_WRITEOFF,
  splitField,
  setupChoicesFrom,
} = await import('../lib/posting-setup');

/** The form the card sends, as the page draws it; `overrides` replace or drop fields. */
function press(overrides: Record<string, string | null> = {}, site = 'same-origin'): Promise<Response> {
  const fields: Record<string, string | null> = {
    connectionId: CONNECTION_ID,
    ar: AR.id,
    deductionsReceivable: CREATE_ACCOUNT,
    writeoff: CREATE_ACCOUNT,
    ...Object.fromEntries([...REASON_FAMILIES, 'unclassified' as const].map((f) => [splitField(f), SAME_AS_WRITEOFF])),
    ...overrides,
  };
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) if (value !== null) body.set(key, value);
  return POST(
    new NextRequest('https://app.example.test/settings/quickbooks/setup', {
      method: 'POST',
      body,
      headers: { 'sec-fetch-site': site },
    }),
  );
}

const locations: string[] = [];
async function notice(response: Promise<Response>): Promise<string | null> {
  const answered = await response;
  expect(answered.status).toBe(303);
  const location = answered.headers.get('location') ?? '';
  locations.push(location);
  return new URL(location).searchParams.get('qbo');
}

const names = (): string[] => harness.calls.map(([name]) => name as string);

/**
 * What a read-back refusal leaves behind: an account QuickBooks made, under
 * our name, and did not make as asked — here, inactive.
 */
function readBackFails(name: string) {
  return (spec: SetupAccountSpec, id: string): Error | undefined => {
    if (spec.name !== name) return undefined;
    harness.chart.push(account(id, spec.name, spec.accountType, false));
    return new QboAccountReadBackError(id, ['Active']);
  };
}
/** Makes the create of one row fail with `error`, and every other create succeed. */
function createOf(row: SetupRow, error: () => Error) {
  return (spec: SetupAccountSpec): Error | undefined =>
    spec.name === SETUP_ACCOUNTS[row].name ? error() : undefined;
}
const created = (): unknown[][] => harness.calls.filter(([name]) => name === 'createAccount');
const requested = (): unknown[] =>
  harness.calls.filter(([name]) => name === 'recordAccountCreateRequested').map(([, , row]) => row);
const audited = (): unknown[] =>
  harness.calls.filter(([name]) => name === 'recordAccountCreated').map(([, , input]) => input);
const found = (): unknown[] =>
  harness.calls.filter(([name]) => name === 'recordAccountFound').map(([, , input]) => input);
const mapSaved = (): LedgerAccountMap =>
  harness.calls.find(([name]) => name === 'saveAccountMap')?.[2] as LedgerAccountMap;

const logged: string[] = [];

/**
 * Every class `setUpPosting` reads as "QuickBooks could not be asked", each
 * saying something no log line may repeat: a body, an account name, a key.
 */
const UNAVAILABLE: Array<[string, () => Error]> = [
  ['QboAuthError', () => new QboAuthError(`Intuit refused the refresh: BODY-SECRET ${OURS_WO.name}`)],
  ['QboRateLimited', () => new QboRateLimited('QuickBooks answered 429: BODY-SECRET', 60_000)],
  [
    'QboRequestFailed',
    () =>
      new QboRequestFailed(`QuickBooks answered 503 for realm ${REALM}: {"Fault":"BODY-SECRET"}`, 503, {
        Error: [{ Message: 'BODY-SECRET', Detail: `BODY-SECRET ${OURS_DR.name}`, code: '3100' }],
      }),
  ],
  ['QboMalformedResponse', () => new QboMalformedResponse(`expected text at BODY-SECRET ${PROMO.name}`, 'Account[0].Name')],
  ['LedgerAccountBusyError', () => new LedgerAccountBusyError('qbo', REALM)],
  ['LockPoolTimeoutError', () => new LockPoolTimeoutError('qbo', REALM)],
  [
    'CredentialUnreadableError',
    () => new CredentialUnreadableError(CONNECTION_ID, 'cred-1', 'kms-v1', 'arn:aws:kms:BODY-SECRET', 'decrypt'),
  ],
];

beforeEach(() => {
  harness.role = 'owner';
  harness.posting = true;
  harness.mayWrite = true;
  harness.dbOwner = true;
  harness.client = true;
  harness.calls = [];
  harness.chart = [AR, BANK, PREPAID, PROMO, MISC];
  harness.nextId = 8000;
  harness.map = undefined;
  harness.postingEnabled = false;
  harness.claimed.clear();
  harness.noClaimConnection = false;
  harness.listError = undefined;
  harness.createFails = undefined;
  harness.createGate = undefined;
  harness.typesError = undefined;
  harness.saveError = undefined;
  harness.requestAuditError = undefined;
  harness.createdAuditError = undefined;
  harness.audit = [];
  harness.built = [];
  locations.length = 0;
  logged.length = 0;
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('who may press', () => {
  it('refuses a cross-site POST with a 403 and touches nothing', async () => {
    const response = await press({}, 'cross-site');
    expect(response.status).toBe(403);
    expect(harness.calls).toEqual([]);
  });

  it('refuses everything when this deployment does not post', async () => {
    harness.posting = false;
    expect(await notice(press())).toBe('posting_off');
    expect(harness.calls).toEqual([]);
  });

  it.each(['approver', 'analyst', 'read_only'])('refuses the %s role before the store or QuickBooks', async (role) => {
    harness.role = role;
    expect(await notice(press())).toBe('posting_role');
    expect(harness.calls).toEqual([]);
  });

  it('refuses a member who may no longer write', async () => {
    harness.mayWrite = false;
    expect(await notice(press())).toBe('posting_role');
    expect(names()).toEqual(['memberMayWrite']);
  });

  it('asks the database whether this is an owner, and claims nothing and asks QuickBooks nothing when it says no', async () => {
    harness.dbOwner = false;
    expect(await notice(press())).toBe('posting_role');
    expect(names()).toEqual(['memberMayWrite', 'memberIsOwner']);
  });

  it('says posting cannot be set up when no QuickBooks client can be built', async () => {
    harness.client = false;
    expect(await notice(press())).toBe('posting_setup_not_configured');
    expect(names()).toEqual(['memberMayWrite', 'memberIsOwner', 'withSetupClaim', 'postingConnections']);
  });
});

describe('the form', () => {
  it('refuses a connection id that is not one, and a form the page did not draw', async () => {
    expect(await notice(press({ connectionId: 'not-a-uuid' }))).toBe('posting_unknown_connection');
    expect(await notice(press({ ar: null }))).toBe('posting_setup_invalid');
    expect(await notice(press({ ar: CREATE_ACCOUNT }))).toBe('posting_setup_invalid');
    expect(await notice(press({ deductionsReceivable: 'Deductions Receivable' }))).toBe('posting_setup_invalid');
    expect(await notice(press({ [splitField('freight')]: '7004; drop table' }))).toBe('posting_setup_invalid');
    expect(harness.calls).toEqual([]);
  });

  it('reads a split row left at its default, or not sent, as the one write-off row', () => {
    const form = new FormData();
    form.set('ar', AR.id);
    form.set('deductionsReceivable', PREPAID.id);
    form.set('writeoff', PROMO.id);
    form.set(splitField('freight'), MISC.id);
    form.set(splitField('quality'), SAME_AS_WRITEOFF);
    form.set(splitField('unclassified'), CREATE_ACCOUNT);
    const choices = setupChoicesFrom(form);
    expect(choices?.writeoffByFamily.freight).toEqual({ kind: 'existing', accountId: MISC.id });
    expect(choices?.writeoffByFamily.quality).toEqual({ kind: 'existing', accountId: PROMO.id });
    expect(choices?.writeoffByFamily.shortage).toEqual({ kind: 'existing', accountId: PROMO.id });
    expect(choices?.unclassifiedWriteoff).toEqual({ kind: 'create' });
  });

  it("refuses a connection that is not one of this workspace's current ones", async () => {
    expect(await notice(press({ connectionId: '99999999-9999-4999-8999-999999999999' }))).toBe(
      'posting_unknown_connection',
    );
    expect(names()).not.toContain('listAccounts');
  });

  it("refuses a company that already has a map: changing one is the map form's", async () => {
    harness.map = {
      mapId: 'map-0',
      arAccountId: AR.id,
      deductionsReceivableAccountId: PREPAID.id,
      writeoffByFamily: Object.fromEntries(REASON_FAMILIES.map((f) => [f, PROMO.id])) as never,
      unclassifiedWriteoff: PROMO.id,
    };
    expect(await notice(press())).toBe('posting_setup_mapped');
    expect(names()).not.toContain('listAccounts');
  });
});

describe('the press', () => {
  it('creates exactly what is missing, each on the record before it is sent and after, then the map, then the switch', async () => {
    expect(await notice(press())).toBe('posting_set_up_created_two');
    expect(names()).toEqual([
      'memberMayWrite',
      'memberIsOwner',
      'withSetupClaim',
      'postingConnections',
      'listAccounts',
      'unansweredAccountCreates',
      'recordedSetupAccounts',
      'recordAccountCreateRequested',
      'createAccount',
      'recordAccountCreated',
      'recordAccountCreateRequested',
      'createAccount',
      'recordAccountCreated',
      'saveAccountMap',
      'accountTypes',
      'setPostingEnabled',
    ]);
    // Only our two fixed accounts, each under the request id its request row
    // was recorded with: its connection's, its row's and its first attempt's,
    // so pressing again after no answer came is the same request to Intuit.
    expect(created()).toEqual([
      ['createAccount', SETUP_ACCOUNTS.deductions_receivable, postingSetupRequestId(CONNECTION_ID, 'deductions_receivable', 0)],
      ['createAccount', SETUP_ACCOUNTS.writeoff, postingSetupRequestId(CONNECTION_ID, 'writeoff', 0)],
    ]);
    expect(requested()).toEqual(['deductions_receivable', 'writeoff']);
    expect(audited()).toEqual([
      { row: 'deductions_receivable', qboAccountId: '8000' },
      { row: 'writeoff', qboAccountId: '8001' },
    ]);
    expect(mapSaved()).toEqual({
      arAccountId: AR.id,
      deductionsReceivableAccountId: '8000',
      writeoffByFamily: Object.fromEntries(REASON_FAMILIES.map((f) => [f, '8001'])),
      unclassifiedWriteoff: '8001',
    });
    expect(harness.calls.at(-1)).toEqual(['setPostingEnabled', CONNECTION_ID, true]);
    // Every request the press makes waits the press's own bound — not the
    // client's minute, and not the page's ten seconds — and a chart is read in
    // two pages at most, so it ends inside the route's `maxDuration` (ADR 0063 §2).
    expect(PRESS_BOUNDS).toEqual({ timeoutMs: PRESS_REQUEST_TIMEOUT_MS, maxPages: CHART_MAX_PAGES });
    expect(harness.built).toEqual([
      ['accountsFor', PRESS_BOUNDS],
      ['accountCreatorFor', PRESS_BOUNDS],
      ['accountTypesFor', PRESS_BOUNDS],
    ]);
    expect(found()).toEqual([]);
    // Each account is logged by its id as it is made, before its audit row.
    expect(logged.filter((line) => line.includes('posting setup: created'))).toEqual([
      `[recouple] posting setup: created the deductions_receivable account 8000 in realm ${REALM} ` +
        `under request ${postingSetupRequestId(CONNECTION_ID, 'deductions_receivable', 0)}, ` +
        `connection ${CONNECTION_ID} org ${ORG_ID}`,
      `[recouple] posting setup: created the writeoff account 8001 in realm ${REALM} ` +
        `under request ${postingSetupRequestId(CONNECTION_ID, 'writeoff', 0)}, ` +
        `connection ${CONNECTION_ID} org ${ORG_ID}`,
    ]);
  });

  it('reuses an account of ours that is already there and creates only the other', async () => {
    harness.chart.push({ ...OURS_DR, name: 'deductions receivable', fullyQualifiedName: 'deductions receivable' });
    expect(await notice(press())).toBe('posting_set_up_created_one');
    expect(created()).toEqual([
      ['createAccount', SETUP_ACCOUNTS.writeoff, postingSetupRequestId(CONNECTION_ID, 'writeoff', 0)],
    ]);
    expect(requested()).toEqual(['writeoff']);
    expect(mapSaved().deductionsReceivableAccountId).toBe(OURS_DR.id);
  });

  it('creates nothing, and asks for nothing, when the owner chose accounts the company has, split by reason', async () => {
    expect(
      await notice(
        press({
          deductionsReceivable: PREPAID.id,
          writeoff: PROMO.id,
          [splitField('freight')]: MISC.id,
        }),
      ),
    ).toBe('posting_set_up');
    expect(created()).toEqual([]);
    expect(requested()).toEqual([]);
    expect(audited()).toEqual([]);
    const map = mapSaved();
    expect(map.writeoffByFamily.freight).toBe(MISC.id);
    expect(map.writeoffByFamily.shortage).toBe(PROMO.id);
    expect(map.unclassifiedWriteoff).toBe(PROMO.id);
  });

  it('creates the write-off account only for the rows that chose it', async () => {
    expect(
      await notice(
        press({ deductionsReceivable: PREPAID.id, writeoff: PROMO.id, [splitField('unclassified')]: CREATE_ACCOUNT }),
      ),
    ).toBe('posting_set_up_created_one');
    const map = mapSaved();
    expect(map.unclassifiedWriteoff).toBe('8000');
    expect(map.writeoffByFamily.shortage).toBe(PROMO.id);
  });

  it('is safe to press again: the second press finds what the first created and creates nothing', async () => {
    harness.saveError = new Error('the database went away');
    await expect(press()).rejects.toThrow('the database went away');
    expect(created()).toHaveLength(2);
    expect(names()).not.toContain('setPostingEnabled');

    harness.calls = [];
    expect(await notice(press())).toBe('posting_set_up');
    expect(created()).toEqual([]);
    expect(requested()).toEqual([]);
    expect(audited()).toEqual([]);
    const map = mapSaved();
    expect(map.deductionsReceivableAccountId).toBe('8000');
    expect(map.unclassifiedWriteoff).toBe('8001');
    expect(harness.calls.at(-1)).toEqual(['setPostingEnabled', CONNECTION_ID, true]);
  });
});

describe('how long a press may take', () => {
  it("has asked QuickBooks everything it will ask well inside the route's maxDuration", () => {
    // A wait for a connection to hold the claim on; seven requests at most — a
    // chart of two pages, two creates and their read-backs, the type check;
    // and one token refresh: a lock connection, the company's lock, then
    // Intuit's token call (10 s, `@recouple/qbo`'s own OAuth bound).
    const requests = CHART_MAX_PAGES + 2 * 2 + 1;
    expect(requests).toBe(7);
    const refresh = LOCK_POOL_CONNECT_TIMEOUT_MS + LEDGER_ACCOUNT_LOCK_TIMEOUT_MS + 10_000;
    const worst = SETUP_CLAIM_CONNECT_TIMEOUT_MS + requests * PRESS_REQUEST_TIMEOUT_MS + refresh;
    expect(worst).toBe(240_000);
    // A minute and more is left for our database's short transactions.
    expect(maxDuration * 1000 - worst).toBeGreaterThanOrEqual(60_000);
  });
});

describe('two presses at once', () => {
  it('answers a press that arrives while another holds the claim, having done nothing, and lets the first finish alone', async () => {
    let release: () => void = () => undefined;
    harness.createGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = press();
    await vi.waitFor(() => expect(names()).toContain('createAccount'));

    const before = harness.calls.length;
    expect(await notice(press())).toBe('posting_setup_busy');
    expect(names().slice(before)).toEqual(['memberMayWrite', 'memberIsOwner', 'withSetupClaim']);

    release();
    expect(await notice(first)).toBe('posting_set_up_created_two');
    expect(created()).toHaveLength(2);
    expect(requested()).toHaveLength(2);
    expect(audited()).toHaveLength(2);
    expect(names().filter((name) => name === 'saveAccountMap')).toHaveLength(1);
    expect(names().filter((name) => name === 'setPostingEnabled')).toHaveLength(1);

    // A press once the first has ended finds the map it saved.
    expect(await notice(press())).toBe('posting_setup_mapped');
    expect(created()).toHaveLength(2);
  });

  it('answers a press that gets no connection to hold its claim on as busy, having done nothing', async () => {
    harness.noClaimConnection = true;
    expect(await notice(press())).toBe('posting_setup_busy');
    expect(names()).toEqual(['memberMayWrite', 'memberIsOwner', 'withSetupClaim']);
    expect(logged.at(-1)).toBe(
      `[recouple] posting setup refused (PostingSetupBusyError: no_connection), connection ${CONNECTION_ID} org ${ORG_ID}`,
    );
  });
});

describe('what stops a press, and where', () => {
  it('refuses a company with no active Accounts Receivable account, and creates nothing', async () => {
    harness.chart = [{ ...AR, active: false }, BANK, PREPAID, PROMO];
    expect(await notice(press())).toBe('posting_setup_no_receivable');
    expect(names()).toEqual([
      'memberMayWrite',
      'memberIsOwner',
      'withSetupClaim',
      'postingConnections',
      'listAccounts',
      'unansweredAccountCreates',
      'recordedSetupAccounts',
    ]);
  });

  it.each([
    ['an inactive account', { ...OURS_DR, active: false }, 'posting_setup_receivable_inactive'],
    ['an account of the wrong type', { ...OURS_DR, accountType: 'Bank' }, 'posting_setup_receivable_wrong_type'],
  ])('stops when our name is held by %s, and asks for neither account', async (_what, holder, key) => {
    harness.chart.push(holder);
    expect(await notice(press())).toBe(key);
    expect(requested()).toEqual([]);
    expect(created()).toEqual([]);
    expect(audited()).toEqual([]);
    expect(names()).not.toContain('saveAccountMap');
  });

  it('names the write-off row when its name is the one taken', async () => {
    harness.chart.push({ ...OURS_WO, active: false });
    expect(await notice(press())).toBe('posting_setup_writeoff_inactive');
    harness.chart = [AR, PREPAID, { ...OURS_WO, accountType: 'Income' }];
    expect(await notice(press())).toBe('posting_setup_writeoff_wrong_type');
    expect(created()).toEqual([]);
  });

  it('refuses an account chosen that the re-read does not show as active and of its type', async () => {
    expect(await notice(press({ ar: BANK.id }))).toBe('posting_setup_choice');
    expect(await notice(press({ deductionsReceivable: PROMO.id }))).toBe('posting_setup_choice');
    expect(await notice(press({ [splitField('returns')]: '7999' }))).toBe('posting_setup_choice');
    harness.chart = [AR, { ...PREPAID, active: false }, PROMO];
    expect(await notice(press({ deductionsReceivable: PREPAID.id }))).toBe('posting_setup_choice');
    expect(created()).toEqual([]);
    expect(names()).not.toContain('saveAccountMap');
  });

  it('audits an account that did not read back as sent, names it in the log, and stops before the map', async () => {
    harness.createFails = readBackFails(SETUP_ACCOUNTS.writeoff.name);
    expect(await notice(press())).toBe('posting_setup_writeoff_read_back');
    // QuickBooks made it: it is in the company's books, so it is on the
    // record like the first, with what did not match and nothing it read.
    expect(audited()).toEqual([
      { row: 'deductions_receivable', qboAccountId: '8000' },
      { row: 'writeoff', qboAccountId: '8001', readBackMismatch: ['Active'] },
    ]);
    expect(names()).not.toContain('saveAccountMap');
    expect(names()).not.toContain('setPostingEnabled');
    expect(logged).toContain(
      `[recouple] posting setup: created the writeoff account 8001 in realm ${REALM} ` +
        `under request ${postingSetupRequestId(CONNECTION_ID, 'writeoff', 0)}, ` +
        `and it read back unlike it was sent (Active), connection ${CONNECTION_ID} org ${ORG_ID}`,
    );
    expect(logged.at(-1)).toBe(
      '[recouple] posting setup refused (PostingSetupReadBackError: writeoff account 8001, mismatch Active), ' +
        `connection ${CONNECTION_ID} org ${ORG_ID}`,
    );

    // The next press finds ours and stops at what QuickBooks left: an account
    // by our name that we did not make as asked, which we never touch.
    harness.calls = [];
    harness.createFails = undefined;
    expect(await notice(press())).toBe('posting_setup_writeoff_inactive');
    expect(created()).toEqual([]);
  });

  it('keeps the id of an account whose audit row could not be written, in the log line written first', async () => {
    harness.createdAuditError = new Error('the database went away');
    await expect(press()).rejects.toThrow('the database went away');
    expect(created()).toHaveLength(1);
    expect(logged.some((line) => line.includes('created the deductions_receivable account 8000 in realm'))).toBe(
      true,
    );
    expect(names()).not.toContain('saveAccountMap');

    // An owner no longer an owner by then is refused by name; the id is in the log all the same.
    harness.calls = [];
    harness.chart = [AR, BANK, PREPAID, PROMO, MISC];
    harness.createdAuditError = new OwnerRequiredError(ORG_ID, USER_ID);
    logged.length = 0;
    expect(await notice(press())).toBe('posting_role');
    expect(logged.some((line) => line.includes('created the deductions_receivable account 8001 in realm'))).toBe(
      true,
    );
    expect(names()).not.toContain('saveAccountMap');
  });

  it('puts each request on the record before it is sent, and sends nothing when that is refused', async () => {
    harness.requestAuditError = new OwnerRequiredError(ORG_ID, USER_ID);
    expect(await notice(press())).toBe('posting_role');
    expect(created()).toEqual([]);
    expect(names().at(-1)).toBe('recordAccountCreateRequested');
  });

  it.each(UNAVAILABLE)(
    'says QuickBooks could not be reached when reading the chart meets %s, and nothing after runs',
    async (cls, make) => {
      harness.listError = make();
      expect(await notice(press())).toBe('posting_setup_unreachable');
      expect(names().at(-1)).toBe('listAccounts');
      expect(logged.at(-1)).toContain(`(PostingSetupUnreachableError: at read_chart, ${cls}`);
    },
  );

  it.each(UNAVAILABLE)(
    'says QuickBooks could not be reached when a create meets %s, with the request already on the record',
    async (cls, make) => {
      harness.createFails = createOf('writeoff', make);
      expect(await notice(press())).toBe('posting_setup_unreachable');
      // The first account was made and audited; the second was asked for,
      // and its answer — which may have been an account — never came.
      expect(requested()).toEqual(['deductions_receivable', 'writeoff']);
      expect(audited()).toEqual([{ row: 'deductions_receivable', qboAccountId: '8000' }]);
      expect(names().at(-1)).toBe('createAccount');
      expect(logged.at(-1)).toContain(`(PostingSetupUnreachableError: at create of writeoff, ${cls}`);
    },
  );

  it('logs the status and fault code of a QuickBooks that answered, and nothing it said', async () => {
    harness.listError = UNAVAILABLE.find(([cls]) => cls === 'QboRequestFailed')?.[1]();
    expect(await notice(press())).toBe('posting_setup_unreachable');
    expect(logged.at(-1)).toBe(
      '[recouple] posting setup refused (PostingSetupUnreachableError: at read_chart, QboRequestFailed, ' +
        `HTTP 503, fault 3100), connection ${CONNECTION_ID} org ${ORG_ID}`,
    );
  });

  it.each([
    ['deductions_receivable', 'posting_setup_receivable_create_refused', []],
    ['writeoff', 'posting_setup_writeoff_create_refused', [{ row: 'deductions_receivable', qboAccountId: '8000' }]],
  ] as const)(
    'says a 4xx at the %s create may have left the account made, and to read the card before pressing again',
    async (row, key, before) => {
      harness.createFails = createOf(
        row,
        () =>
          new QboRequestFailed(`QuickBooks answered 400 for realm ${REALM}: BODY-SECRET`, 400, {
            Error: [{ Message: 'Duplicate Name Exists Error', Detail: 'BODY-SECRET', code: '6240' }],
            type: 'ValidationFault',
          }),
      );
      expect(await notice(press())).toBe(key);
      // The refusal may be the create's or the read-back's, and it does not say
      // which: so the owner is not told the account was refused, nor that a
      // second press will be.
      const said = resolveNotice(key)?.text ?? '';
      expect(said).toContain('The account may have been made all the same.');
      expect(said).toContain('If the card below no longer says we’ll create it, it was');
      expect(said).not.toMatch(/refused the same way|refused to create/);
      expect(audited()).toEqual(before);
      expect(names()).not.toContain('saveAccountMap');
      expect(logged.at(-1)).toBe(
        `[recouple] posting setup refused (PostingSetupCreateRefusedError: ${row}, HTTP 400, fault 6240), ` +
          `connection ${CONNECTION_ID} org ${ORG_ID}`,
      );
    },
  );

  it('stops at a map QuickBooks now reads as the wrong type, after the creates and before the switch', async () => {
    harness.saveError = new AccountMapTypeError(['writeoff_by_family.freight']);
    expect(await notice(press())).toBe('posting_setup_map_types');
    expect(names()).toContain('saveAccountMap');
    expect(names()).not.toContain('setPostingEnabled');
    expect(logged.at(-1)).toContain('(AccountMapTypeError: writeoff_by_family.freight)');
  });

  it('says QuickBooks could not be reached when the type check before the map cannot ask it', async () => {
    harness.typesError = new QboRequestFailed(`QuickBooks answered 502: BODY-SECRET ${PROMO.name}`, 502, undefined);
    expect(await notice(press())).toBe('posting_setup_unreachable');
    expect(names().at(-1)).toBe('accountTypes');
    expect(names()).not.toContain('setPostingEnabled');
    expect(logged.at(-1)).toBe(
      '[recouple] posting setup refused (PostingSetupUnreachableError: at save_map, QboRequestFailed, HTTP 502), ' +
        `connection ${CONNECTION_ID} org ${ORG_ID}`,
    );
  });

  it('stops at a chart longer than a press reads, before anything is planned or asked for', async () => {
    harness.listError = new QboChartTooLarge(CHART_MAX_PAGES, 1000);
    expect(await notice(press())).toBe('posting_setup_chart_too_large');
    expect(names().at(-1)).toBe('listAccounts');
    expect(logged.at(-1)).toBe(
      `[recouple] posting setup refused (PostingSetupChartTooLargeError: over 2 pages of 1000), ` +
        `connection ${CONNECTION_ID} org ${ORG_ID}`,
    );
  });

  it('turns an error that is not a refusal into a failure, not a notice', async () => {
    harness.listError = new TypeError('a bug');
    await expect(press()).rejects.toThrow('a bug');
  });
});

/** What an accountant does to one of ours between two presses: a new name, or a parent. */
function edit(id: string, change: Partial<QboAccount>): void {
  harness.chart = harness.chart.map((acct) => (acct.id === id ? { ...acct, ...change } : acct));
}

describe('an account setup made for a row, renamed or moved since', () => {
  /** The first press: Deductions Receivable made as 8000, the write-off never answered. */
  async function firstPress(): Promise<void> {
    harness.createFails = createOf('writeoff', timedOut);
    expect(await notice(press())).toBe('posting_setup_unreachable');
    expect(audited()).toEqual([{ row: 'deductions_receivable', qboAccountId: '8000' }]);
    harness.calls = [];
    harness.createFails = undefined;
  }

  it.each([
    ['renamed', { name: RENAMED_TO, fullyQualifiedName: RENAMED_TO }],
    ['moved under another account', { fullyQualifiedName: `${PARENT}:${SETUP_ACCOUNTS.deductions_receivable.name}` }],
    ['renamed and made inactive', { name: RENAMED_TO, fullyQualifiedName: RENAMED_TO, active: false }],
  ] as const)(
    'is never made a second time once it is %s: the press stops before it asks QuickBooks for anything',
    async (_what, change) => {
      await firstPress();
      edit('8000', change);
      expect(await notice(press())).toBe('posting_setup_receivable_renamed');
      // No request, no create, no second `account_created` for 8000 — and not
      // the write-off either, whose create this press would otherwise resend.
      expect(requested()).toEqual([]);
      expect(created()).toEqual([]);
      expect(audited()).toEqual([]);
      expect(found()).toEqual([]);
      expect(names()).not.toContain('saveAccountMap');
      expect(names()).not.toContain('setPostingEnabled');
      expect(logged.at(-1)).toBe(
        '[recouple] posting setup refused (PostingSetupRenamedError: deductions_receivable account 8000), ' +
          `connection ${CONNECTION_ID} org ${ORG_ID}`,
      );
    },
  );

  it('is used when the owner chooses it under its new name, and the unanswered write-off is sent again as it was', async () => {
    await firstPress();
    edit('8000', { name: RENAMED_TO, fullyQualifiedName: RENAMED_TO });
    expect(await notice(press({ deductionsReceivable: '8000' }))).toBe('posting_set_up_created_one');
    // The write-off's first request had no answer: this is the same request.
    expect(created()).toEqual([
      ['createAccount', SETUP_ACCOUNTS.writeoff, postingSetupRequestId(CONNECTION_ID, 'writeoff', 0)],
    ]);
    // 8001 went to the first press's write-off, whose answer never came.
    expect(audited()).toEqual([{ row: 'writeoff', qboAccountId: '8002' }]);
    expect(mapSaved().deductionsReceivableAccountId).toBe('8000');
  });

  it('is found by name again once it has its name back, and nothing is made', async () => {
    await firstPress();
    edit('8000', { name: RENAMED_TO, fullyQualifiedName: RENAMED_TO });
    expect(await notice(press())).toBe('posting_setup_receivable_renamed');
    edit('8000', { name: SETUP_ACCOUNTS.deductions_receivable.name, fullyQualifiedName: SETUP_ACCOUNTS.deductions_receivable.name });
    harness.calls = [];
    expect(await notice(press())).toBe('posting_set_up_created_one');
    expect(requested()).toEqual(['writeoff']);
    expect(mapSaved().deductionsReceivableAccountId).toBe('8000');
  });

  it('is asked for again only when it is gone from the chart, and then as a new request Intuit cannot answer with the old one', async () => {
    await firstPress();
    harness.chart = harness.chart.filter((acct) => acct.id !== '8000');
    expect(await notice(press())).toBe('posting_set_up_created_two');
    expect(created()).toEqual([
      ['createAccount', SETUP_ACCOUNTS.deductions_receivable, postingSetupRequestId(CONNECTION_ID, 'deductions_receivable', 1)],
      ['createAccount', SETUP_ACCOUNTS.writeoff, postingSetupRequestId(CONNECTION_ID, 'writeoff', 0)],
    ]);
    expect(postingSetupRequestId(CONNECTION_ID, 'deductions_receivable', 1)).not.toBe(
      postingSetupRequestId(CONNECTION_ID, 'deductions_receivable', 0),
    );
  });

  it('counts a found account as an answer too: a later create of its row is a new request', async () => {
    // Asked, and lost; the next press finds it and records it as found.
    harness.createFails = madeThenLost('deductions_receivable', timedOut);
    await notice(press());
    harness.calls = [];
    harness.createFails = undefined;
    harness.saveError = new Error('the database went away');
    await expect(press({ deductionsReceivable: '8000' })).rejects.toThrow('the database went away');
    expect(found()).toEqual([{ row: 'deductions_receivable', qboAccountId: '8000' }]);

    // Moved since: refused, not asked for under the request it was found for.
    edit('8000', { fullyQualifiedName: `${PARENT}:${SETUP_ACCOUNTS.deductions_receivable.name}` });
    harness.calls = [];
    expect(await notice(press())).toBe('posting_setup_receivable_renamed');
    expect(created()).toEqual([]);
  });
});

/**
 * A create QuickBooks carried out and whose answer never reached the press:
 * the account is in the chart the next press reads — active unless `active`
 * says otherwise — and this press hears only `error`.
 */
function madeThenLost(row: SetupRow, error: () => Error, active = true) {
  return (spec: SetupAccountSpec, id: string): Error | undefined => {
    if (spec.name !== SETUP_ACCOUNTS[row].name) return undefined;
    harness.chart.push(account(id, spec.name, spec.accountType, active));
    return error();
  };
}
const timedOut = (): Error =>
  new QboRequestFailed('QuickBooks did not answer within 60000ms (BODY-SECRET)', 0, undefined);

describe('a create whose answer never came', () => {
  it('is put on the record as found by the next press, before it plans, and used', async () => {
    harness.createFails = madeThenLost('deductions_receivable', timedOut);
    expect(await notice(press())).toBe('posting_setup_unreachable');
    // Asked, and never told what was made: the request is all the log has.
    expect(requested()).toEqual(['deductions_receivable']);
    expect(audited()).toEqual([]);
    expect(found()).toEqual([]);

    // The next press, as the card now draws it: the account found under our name.
    harness.calls = [];
    harness.createFails = undefined;
    expect(await notice(press({ deductionsReceivable: '8000' }))).toBe('posting_set_up_created_one');
    expect(names().slice(0, 7)).toEqual([
      'memberMayWrite',
      'memberIsOwner',
      'withSetupClaim',
      'postingConnections',
      'listAccounts',
      'unansweredAccountCreates',
      'recordAccountFound',
    ]);
    // Found, and never recorded as created: nobody saw it made.
    expect(found()).toEqual([{ row: 'deductions_receivable', qboAccountId: '8000' }]);
    expect(audited()).toEqual([{ row: 'writeoff', qboAccountId: '8001' }]);
    expect(requested()).toEqual(['writeoff']);
    expect(mapSaved().deductionsReceivableAccountId).toBe('8000');
    expect(logged).toContain(
      `[recouple] posting setup: found the deductions_receivable account 8000 in realm ${REALM} ` +
        `as request ${postingSetupRequestId(CONNECTION_ID, 'deductions_receivable', 0)} asked for it, ` +
        `after that request had no answer, connection ${CONNECTION_ID} org ${ORG_ID}`,
    );
    expect(await store.unansweredAccountCreates(CONNECTION_ID)).toEqual([]);
  });

  it('is settled whatever the next press chose for that row', async () => {
    harness.createFails = madeThenLost('deductions_receivable', timedOut);
    await notice(press());
    harness.calls = [];
    harness.createFails = undefined;
    expect(await notice(press({ deductionsReceivable: PREPAID.id, writeoff: PROMO.id }))).toBe('posting_set_up');
    expect(found()).toEqual([{ row: 'deductions_receivable', qboAccountId: '8000' }]);
    expect(audited()).toEqual([]);
    expect(mapSaved().deductionsReceivableAccountId).toBe(PREPAID.id);
  });

  it('includes a 4xx that came after the account was made: the next press finds it and records it', async () => {
    harness.createFails = madeThenLost(
      'writeoff',
      () =>
        new QboRequestFailed(`QuickBooks answered 400 for realm ${REALM}: BODY-SECRET`, 400, {
          Error: [{ Message: 'Object Not Found', code: '610' }],
        }),
    );
    expect(await notice(press())).toBe('posting_setup_writeoff_create_refused');
    expect(audited()).toEqual([{ row: 'deductions_receivable', qboAccountId: '8000' }]);

    harness.calls = [];
    harness.createFails = undefined;
    expect(await notice(press({ deductionsReceivable: '8000', writeoff: '8001' }))).toBe('posting_set_up');
    expect(created()).toEqual([]);
    expect(found()).toEqual([{ row: 'writeoff', qboAccountId: '8001' }]);
    expect(audited()).toEqual([]);
  });

  it.each([
    // The finding that made this rule: ours sends `Expense`, so an Other
    // Expense account is not what the lost request made — though a map may
    // post write-offs to it, and this one does.
    ['an Other Expense account under the write-off name', [account('7012', SETUP_ACCOUNTS.writeoff.name, 'Other Expense')]],
    ['an account whose name is ours in another case', [account('7012', 'customer deductions', 'Expense')]],
    [
      'two accounts either of which it could be',
      [account('7012', SETUP_ACCOUNTS.writeoff.name, 'Expense'), account('7013', SETUP_ACCOUNTS.writeoff.name, 'Expense')],
    ],
  ])(
    'records nothing for %s, leaves the request unanswered, and lets the plan use what it may',
    async (_what, holders) => {
      harness.createFails = createOf('writeoff', timedOut);
      expect(await notice(press())).toBe('posting_setup_unreachable');
      expect(audited()).toEqual([{ row: 'deductions_receivable', qboAccountId: '8000' }]);

      // Between the presses, something else takes the name.
      harness.calls = [];
      harness.createFails = undefined;
      harness.chart.push(...holders);
      expect(await notice(press())).toBe('posting_set_up');
      expect(audited()).toEqual([]);
      expect(found()).toEqual([]);
      expect(created()).toEqual([]);
      expect(logged.some((line) => line.includes('posting setup: found the'))).toBe(false);
      // The plan reuses what its own rule reuses: the lowest id under the
      // name, in any case, of a type a write-off may post to.
      const map = mapSaved();
      expect(map.writeoffByFamily).toEqual(Object.fromEntries(REASON_FAMILIES.map((f) => [f, '7012'])));
      expect(map.unclassifiedWriteoff).toBe('7012');
      expect(map.deductionsReceivableAccountId).toBe('8000');
      // And the audit log still says only that the write-off was asked for.
      expect(await store.unansweredAccountCreates(CONNECTION_ID)).toEqual([
        { row: 'writeoff', requestId: postingSetupRequestId(CONNECTION_ID, 'writeoff', 0) },
      ]);
    },
  );

  it('records nothing for a sub-account under our name, and asks again for ours under the same request id', async () => {
    harness.createFails = createOf('writeoff', timedOut);
    await notice(press());
    harness.calls = [];
    harness.createFails = undefined;
    harness.chart.push({
      ...account('7012', SETUP_ACCOUNTS.writeoff.name, 'Expense'),
      fullyQualifiedName: `Operating Costs:${SETUP_ACCOUNTS.writeoff.name}`,
    });
    expect(await notice(press())).toBe('posting_set_up_created_one');
    expect(found()).toEqual([]);
    expect(created()).toEqual([
      ['createAccount', SETUP_ACCOUNTS.writeoff, postingSetupRequestId(CONNECTION_ID, 'writeoff', 0)],
    ]);
    expect(audited()).toEqual([{ row: 'writeoff', qboAccountId: '8002' }]);
    expect(await store.unansweredAccountCreates(CONNECTION_ID)).toEqual([]);
  });

  it('stays unanswered while nothing holds our name, and the next press asks again under the same request id', async () => {
    harness.createFails = createOf(
      'deductions_receivable',
      () => new QboRequestFailed('QuickBooks answered 503: BODY-SECRET', 503, undefined),
    );
    expect(await notice(press())).toBe('posting_setup_unreachable');
    const first = created()[0]?.[2];

    harness.calls = [];
    harness.createFails = undefined;
    expect(await notice(press())).toBe('posting_set_up_created_two');
    expect(audited()).toEqual([
      { row: 'deductions_receivable', qboAccountId: '8001' },
      { row: 'writeoff', qboAccountId: '8002' },
    ]);
    expect(created()[0]?.[2]).toBe(first);
    expect(first).toBe(postingSetupRequestId(CONNECTION_ID, 'deductions_receivable', 0));
  });

  it('records nothing for an account under our name it would not use, and the plan refuses on it', async () => {
    harness.createFails = madeThenLost('deductions_receivable', timedOut, false);
    await notice(press());
    harness.calls = [];
    harness.createFails = undefined;
    expect(await notice(press())).toBe('posting_setup_receivable_inactive');
    expect(audited()).toEqual([]);
    expect(found()).toEqual([]);
    expect(created()).toEqual([]);
  });

  it('creates nothing when what it found cannot be put on the record, and the id is in the log all the same', async () => {
    harness.createFails = madeThenLost('deductions_receivable', timedOut);
    await notice(press());
    harness.calls = [];
    harness.createFails = undefined;
    harness.createdAuditError = new OwnerRequiredError(ORG_ID, USER_ID);
    expect(await notice(press({ deductionsReceivable: '8000' }))).toBe('posting_role');
    expect(names().at(-1)).toBe('recordAccountFound');
    expect(created()).toEqual([]);
    expect(logged.some((line) => line.includes('found the deductions_receivable account 8000 in realm'))).toBe(true);
  });
});

describe('what leaves the route', () => {
  it('names ids, class names, statuses and closed-set words — never an account name or what QuickBooks said', async () => {
    const fault = {
      Error: [{ Message: 'Duplicate Name Exists Error', Detail: `BODY-SECRET ${OURS_WO.name}`, code: '6240' }],
    };
    const scenarios: Array<() => void | Promise<void>> = [
      () => undefined,
      () => {
        harness.chart = [AR, BANK, PREPAID, PROMO, MISC, { ...OURS_DR, active: false }];
      },
      () => {
        harness.chart = [AR, PREPAID, PROMO];
        harness.createFails = readBackFails(SETUP_ACCOUNTS.writeoff.name);
      },
      () => {
        harness.listError = new QboRequestFailed(
          `QuickBooks answered 503: {"Fault":{"type":"ValidationFault"}} BODY-SECRET ${PROMO.name} access-token-xyz`,
          503,
          fault,
        );
      },
      () => {
        harness.chart = [BANK, PREPAID];
      },
      () => {
        harness.chart = [AR, BANK, PREPAID, PROMO];
      },
      () => {
        harness.chart = [AR, PREPAID, PROMO];
        harness.createFails = createOf(
          'writeoff',
          () => new QboRequestFailed(`QuickBooks answered 400: BODY-SECRET ${OURS_WO.name}`, 400, fault),
        );
      },
      () => {
        harness.claimed.add(CONNECTION_ID);
      },
      () => {
        harness.chart = [AR, PREPAID, PROMO];
        harness.typesError = new QboRequestFailed(`BODY-SECRET access-token-xyz ${AR.name}`, 502, fault);
      },
      () => {
        // Presses for other companies hold every connection a claim is held on.
        harness.noClaimConnection = true;
      },
      () => {
        harness.listError = new QboChartTooLarge(CHART_MAX_PAGES, 1000);
      },
      async () => {
        // One of ours, made by an earlier press and renamed since by an accountant.
        await store.recordAccountCreateRequested(CONNECTION_ID, 'deductions_receivable');
        await store.recordAccountCreated(CONNECTION_ID, { row: 'deductions_receivable', qboAccountId: '7020' });
        harness.chart.push(account('7020', RENAMED_TO, 'Other Current Asset'));
      },
      async () => {
        // An earlier press asked for ours and never heard back; it is there now.
        await store.recordAccountCreateRequested(CONNECTION_ID, 'deductions_receivable');
        harness.chart.push(OURS_DR);
      },
    ];
    const forms: Array<Record<string, string | null>> = [{}, {}, {}, {}, {}, { ar: BANK.id }, {}, {}, {}, {}, {}, {}, {}];
    expect(forms).toHaveLength(scenarios.length);
    for (const [index, arrange] of scenarios.entries()) {
      harness.map = undefined;
      harness.claimed.clear();
      harness.noClaimConnection = false;
      harness.createFails = undefined;
      harness.listError = undefined;
      harness.typesError = undefined;
      harness.chart = [AR, BANK, PREPAID, PROMO, MISC];
      await arrange();
      await notice(press(forms[index]));
    }

    // Every redirect carries one notice key, ours, and nothing else.
    expect(locations).toHaveLength(scenarios.length);
    for (const location of locations) {
      const url = new URL(location);
      expect(url.pathname).toBe('/settings/quickbooks');
      expect([...url.searchParams.keys()]).toEqual(['qbo']);
      expect(Object.hasOwn(NOTICES, url.searchParams.get('qbo') ?? '')).toBe(true);
      expect(resolveNotice(url.searchParams.get('qbo'))).toBeDefined();
    }
    // Every audit row a row, an id, and at most the fields a read-back
    // compared; one found rather than seen made is a row of its own.
    expect(audited().length).toBeGreaterThanOrEqual(3);
    for (const input of audited() as Array<Record<string, unknown>>) {
      expect(['qboAccountId', 'readBackMismatch', 'row']).toEqual(expect.arrayContaining(Object.keys(input)));
      expect(SETUP_ROWS).toContain(input['row']);
      expect(input['qboAccountId']).toMatch(/^\d+$/);
      for (const field of (input['readBackMismatch'] as string[] | undefined) ?? []) {
        expect(['Id', 'Name', 'AccountType', 'Active']).toContain(field);
      }
    }
    expect(found()).toEqual([{ row: 'deductions_receivable', qboAccountId: OURS_DR.id }]);
    for (const row of requested()) expect(SETUP_ROWS).toContain(row);
    // And every log line a sentence of ids, class names and closed-set words.
    expect(logged.length).toBeGreaterThanOrEqual(scenarios.length);
    const everything = [
      ...logged,
      ...locations,
      JSON.stringify(audited()),
      JSON.stringify(found()),
      JSON.stringify(requested()),
    ].join('\n');
    // A fault's code is ADR 0060 §6's to log ("fault 6240"); its body is not.
    for (const forbidden of [...NAMES, 'BODY-SECRET', 'access-token', '"Fault"', 'ValidationFault', 'Duplicate Name', 'arn:']) {
      expect(everything.toLowerCase(), forbidden).not.toContain(forbidden.toLowerCase());
    }
    expect(everything).toContain('fault 6240');
    for (const line of logged) {
      expect(line).toMatch(/^\[recouple\] posting (set up: |setup refused \(|setup: (created|found) the )/);
      expect(line).toContain(`connection ${CONNECTION_ID} org ${ORG_ID}`);
    }
    expect(logged.some((line) => line.includes(`found the deductions_receivable account ${OURS_DR.id}`))).toBe(true);
    expect(locations.map((location) => new URL(location).searchParams.get('qbo'))).toEqual(
      expect.arrayContaining(['posting_setup_busy', 'posting_setup_chart_too_large', 'posting_setup_receivable_renamed']),
    );
  });
});

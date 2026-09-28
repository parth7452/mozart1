import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { renderToStaticMarkup } from 'react-dom/server';
import { REASON_FAMILIES } from '@recouple/core-domain';
import {
  SETUP_ACCOUNTS,
  postingSetupRequestId,
  proposePostingSetup,
  type LedgerAccountMap,
  type QboAccount,
  type SetupAccountSpec,
  type SetupRow,
} from '@recouple/qbo';
import {
  AccountMapTypeError,
  LEDGER_ACCOUNT_LOCK_TIMEOUT_MS,
  LOCK_POOL_CONNECT_TIMEOUT_MS,
  MAP_ACCOUNT_TYPES,
} from '@recouple/store-postgres';
import type { PostingConnectionSetup } from '../lib/posting-setup';

/**
 * What Settings → QuickBooks draws is what its routes read (ADR 0063 §1, §4).
 * Each form is rendered by the real view, submitted as a browser submits it —
 * every input, every dropdown on the value it starts on unless a test chooses
 * another it offers — and posted to the real route. A field renamed on one
 * side and not the other fails here, where it would otherwise fail every
 * owner's press with CI green. The session, the store and QuickBooks are
 * stand-ins; the store checks each account's type the way the real one does,
 * against the chart written here.
 */

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const CONNECTION_ID = '44444444-4444-4444-8444-444444444444';
const REALM = '4620816365';

function account(id: string, name: string, accountType: string): QboAccount {
  return { id, name, fullyQualifiedName: name, accountType, accountSubType: undefined, active: true };
}
const AR = account('7001', 'Trade Receivables', 'Accounts Receivable');
const PREPAID = account('7003', 'Prepaid Freight', 'Other Current Asset');
const PROMO = account('7004', 'Promotional Allowances', 'Expense');
const MISC = account('7005', 'Miscellaneous Losses', 'Other Expense');
const OURS_DR = account('7010', SETUP_ACCOUNTS.deductions_receivable.name, 'Other Current Asset');
const OURS_WO = account('7011', SETUP_ACCOUNTS.writeoff.name, 'Expense');

const harness = vi.hoisted(() => ({
  chart: [] as QboAccount[],
  map: undefined as (LedgerAccountMap & { mapId: string }) | undefined,
  /** Every map the store saved, in order. */
  saved: [] as LedgerAccountMap[],
  /** What each type reader was built with. */
  typeReaders: [] as unknown[],
  nextId: 8000,
}));

type TypeReader = (ids: readonly string[]) => Promise<ReadonlyMap<string, string>>;

const store = {
  async memberMayWrite() {
    return true;
  },
  async memberIsOwner() {
    return true;
  },
  async withSetupClaim<T>(_connectionId: string, work: () => Promise<T>) {
    return { held: true as const, result: await work() };
  },
  async postingConnections() {
    return [{ connectionId: CONNECTION_ID, realmId: REALM, postingEnabled: false, map: harness.map }];
  },
  async unansweredAccountCreates() {
    return [];
  },
  async recordedSetupAccounts() {
    return { deductions_receivable: [], writeoff: [] };
  },
  async recordAccountCreateRequested(connectionId: string, row: SetupRow) {
    return postingSetupRequestId(connectionId, row, 0);
  },
  async recordAccountCreated() {},
  async recordAccountFound() {},
  /** The real store's rule: every account's type, read live, is one the map accepts in its place. */
  async saveAccountMap(_connectionId: string, map: LedgerAccountMap, readTypes: TypeReader) {
    const places: Array<[string, string, readonly string[]]> = [
      ['ar_account_id', map.arAccountId, MAP_ACCOUNT_TYPES.ar],
      ['deductions_receivable_account_id', map.deductionsReceivableAccountId, MAP_ACCOUNT_TYPES.deductionsReceivable],
      ...REASON_FAMILIES.map((family): [string, string, readonly string[]] => [
        `writeoff_by_family.${family}`,
        map.writeoffByFamily[family],
        MAP_ACCOUNT_TYPES.writeoff,
      ]),
      ['unclassified_writeoff', map.unclassifiedWriteoff, MAP_ACCOUNT_TYPES.writeoff],
    ];
    const types = await readTypes([...new Set(places.map(([, id]) => id))]);
    const wrong = places.filter(([, id, allowed]) => !allowed.includes(types.get(id) ?? '')).map(([field]) => field);
    if (wrong.length > 0) throw new AccountMapTypeError(wrong);
    harness.saved.push(map);
    harness.map = { ...map, mapId: `map-${harness.saved.length}` };
    return { mapId: harness.map.mapId };
  },
  async setPostingEnabled() {},
};

/** QuickBooks as the poster reaches it: the chart above, and a create that adds to it. */
const poster = {
  clientFor: () => undefined,
  accountTypesFor: (_identity: unknown, _connection: unknown, options?: unknown): TypeReader => {
    harness.typeReaders.push(options);
    return async (ids) =>
      new Map(harness.chart.filter((a) => a.active && ids.includes(a.id)).map((a) => [a.id, a.accountType]));
  },
  accountsFor: () => async () => [...harness.chart],
  accountCreatorFor: () => async (spec: SetupAccountSpec) => {
    const created = account(String(harness.nextId++), spec.name, spec.accountType);
    harness.chart.push(created);
    return created;
  },
};

vi.mock('../lib/session', () => ({
  requireSession: async () => ({
    userId: USER_ID,
    email: 'owner@example.test',
    org: { orgId: ORG_ID, slug: 'acme', name: 'Acme', role: 'owner' },
    orgs: [],
  }),
}));

vi.mock('../lib/qbo-posting', () => ({
  qboPostingFromEnv: () => poster,
}));

vi.mock('../lib/posting', () => ({
  postingStoreFor: () => store,
}));

const { POST: saveMap, maxDuration: mapMaxDuration } = await import('../app/settings/quickbooks/account-map/route');
const { POST: setUp } = await import('../app/settings/quickbooks/setup/route');
const { PostingSettings } = await import('../components/posting-settings');
const { PRESS_BOUNDS, PRESS_REQUEST_TIMEOUT_MS, splitField } = await import('../lib/posting-setup');

const MAP_ACTION = '/settings/quickbooks/account-map';
const SETUP_ACTION = '/settings/quickbooks/setup';

/** The card as an owner sees it, over the chart as it stands. */
function page(): string {
  const connection: PostingConnectionSetup = {
    connectionId: CONNECTION_ID,
    realmId: REALM,
    postingEnabled: harness.map !== undefined,
    map: harness.map,
    chart: { kind: 'read', proposal: proposePostingSetup(harness.chart) },
  };
  return renderToStaticMarkup(<PostingSettings connections={[connection]} />);
}

const attribute = (attributes: string, name: string): string | undefined =>
  new RegExp(` ${name}="([^"]*)"`).exec(attributes)?.[1];

/** The markup inside the one form that posts to `action`. */
function formMarkup(html: string, action: string): string {
  const forms = [...html.matchAll(/<form([^>]*)>(.*?)<\/form>/gs)].filter(
    ([, attributes = '']) => attribute(attributes, 'action') === action,
  );
  expect(forms, action).toHaveLength(1);
  return forms[0]?.[2] ?? '';
}

/** Each dropdown in a form: its name, the values it offers, and the one it starts on. */
function dropdowns(markup: string): Array<{ name: string; values: string[]; start: string }> {
  return [...markup.matchAll(/<select([^>]*)>(.*?)<\/select>/gs)].map(([, attributes = '', inner = '']) => {
    const options = [...inner.matchAll(/<option([^>]*)>/g)].map(([, option = '']) => option);
    // A browser starts on the option marked selected, else the first.
    const start = options.find((option) => / selected=""/.test(option)) ?? options[0] ?? '';
    const name = attribute(attributes, 'name') ?? '';
    // A required dropdown on its disabled "Choose an account" would stop the browser sending.
    expect(/ disabled=""/.test(start), `${name} starts on no account`).toBe(false);
    return {
      name,
      values: options.map((option) => attribute(option, 'value') ?? ''),
      start: attribute(start, 'value') ?? '',
    };
  });
}

/**
 * What a browser sends for the form posting to `action`, as drawn: every input
 * with a name, and every dropdown on the value it starts on — or on one of its
 * own options, `chosen` by name, as an owner picks it.
 */
function submit(html: string, action: string, chosen: Readonly<Record<string, string>> = {}): NextRequest {
  const markup = formMarkup(html, action);
  const body = new FormData();
  for (const [, attributes = ''] of markup.matchAll(/<input([^>]*)>/g)) {
    const name = attribute(attributes, 'name');
    if (name !== undefined) body.append(name, attribute(attributes, 'value') ?? '');
  }
  const fields = dropdowns(markup);
  for (const [name, value] of Object.entries(chosen)) {
    expect(fields.find((field) => field.name === name)?.values ?? [], name).toContain(value);
  }
  for (const { name, start } of fields) body.append(name, chosen[name] ?? start);
  return new NextRequest(`https://app.example.test${action}`, {
    method: 'POST',
    body,
    headers: { 'sec-fetch-site': 'same-origin' },
  });
}

async function noticeOf(response: Promise<Response>): Promise<string | null> {
  const answered = await response;
  expect(answered.status).toBe(303);
  return new URL(answered.headers.get('location') ?? '').searchParams.get('qbo');
}

const everyFamily = (id: string): LedgerAccountMap['writeoffByFamily'] =>
  Object.fromEntries(REASON_FAMILIES.map((family) => [family, id])) as LedgerAccountMap['writeoffByFamily'];

beforeEach(() => {
  harness.chart = [AR, PREPAID, PROMO, MISC, OURS_DR, OURS_WO];
  harness.map = undefined;
  harness.saved = [];
  harness.typeReaders = [];
  harness.nextId = 8000;
  // What the routes log is `posting-setup-route.test.tsx`'s to read.
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a saved map, changed by its dropdowns', () => {
  const drawn: LedgerAccountMap = {
    arAccountId: AR.id,
    deductionsReceivableAccountId: PREPAID.id,
    writeoffByFamily: { ...everyFamily(OURS_WO.id), freight: MISC.id },
    unclassifiedWriteoff: PROMO.id,
  };

  it('saves exactly the ids the form was drawn with when nothing is changed', async () => {
    harness.map = { ...drawn, mapId: 'map-0' };
    const html = page();
    // Every place in a map is a dropdown, and nothing else is sent but the connection.
    expect(dropdowns(formMarkup(html, MAP_ACTION)).map(({ name }) => name)).toEqual([
      'arAccountId',
      'deductionsReceivableAccountId',
      ...REASON_FAMILIES.map((family) => `writeoff_${family}`),
      'unclassifiedWriteoff',
    ]);

    expect(await noticeOf(saveMap(submit(html, MAP_ACTION)))).toBe('posting_map_saved');
    expect(harness.saved).toEqual([drawn]);
    // Its type check waits a press's bound, inside the route's `maxDuration`.
    expect(harness.typeReaders).toEqual([PRESS_BOUNDS]);
  });

  it("has checked every type well inside the route's maxDuration", () => {
    // One type check at a press's bound, and one token refresh: a lock
    // connection, the company's lock, then Intuit's token call (10 s,
    // `@recouple/qbo`'s own OAuth bound).
    const worst = PRESS_REQUEST_TIMEOUT_MS + LOCK_POOL_CONNECT_TIMEOUT_MS + LEDGER_ACCOUNT_LOCK_TIMEOUT_MS + 10_000;
    expect(worst).toBe(80_000);
    expect(mapMaxDuration * 1000 - worst).toBeGreaterThanOrEqual(30_000);
  });

  it('saves what an owner chose in one dropdown, and the rest as drawn', async () => {
    harness.map = { ...drawn, mapId: 'map-0' };
    const request = submit(page(), MAP_ACTION, { writeoff_quality: MISC.id, deductionsReceivableAccountId: OURS_DR.id });
    expect(await noticeOf(saveMap(request))).toBe('posting_map_saved');
    expect(harness.saved).toEqual([
      {
        ...drawn,
        deductionsReceivableAccountId: OURS_DR.id,
        writeoffByFamily: { ...drawn.writeoffByFamily, quality: MISC.id },
      },
    ]);
  });
});

describe('the setup card, pressed as drawn', () => {
  it("creates the two accounts it said it would, and saves the map it proposed", async () => {
    harness.chart = [AR, PREPAID, PROMO, MISC];
    expect(await noticeOf(setUp(submit(page(), SETUP_ACTION)))).toBe('posting_set_up_created_two');
    expect(harness.saved).toEqual([
      {
        arAccountId: AR.id,
        deductionsReceivableAccountId: '8000',
        writeoffByFamily: everyFamily('8001'),
        unclassifiedWriteoff: '8001',
      },
    ]);
  });

  it('uses the accounts it found, and a split an owner chose by reason', async () => {
    const request = submit(page(), SETUP_ACTION, {
      [splitField('freight')]: MISC.id,
      [splitField('unclassified')]: PROMO.id,
    });
    expect(await noticeOf(setUp(request))).toBe('posting_set_up');
    expect(harness.saved).toEqual([
      {
        arAccountId: AR.id,
        deductionsReceivableAccountId: OURS_DR.id,
        writeoffByFamily: { ...everyFamily(OURS_WO.id), freight: MISC.id },
        unclassifiedWriteoff: PROMO.id,
      },
    ]);
  });
});

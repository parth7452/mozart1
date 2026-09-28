import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REASON_FAMILIES } from '@recouple/core-domain';
import type { QboAccount } from '@recouple/qbo';
import type { PostingConnectionView } from '@recouple/store-postgres';

/**
 * Settings → QuickBooks, the page itself (ADR 0063 §1): who causes a live read
 * of a company's chart of accounts, and what everyone else is told.
 *
 * The read is made with the viewer's own sign-in to QuickBooks — a token
 * refresh included, whose new token the database will not store for a member
 * it does not let write, which can cost the company its connection (ADR 0039).
 * So only an owner, on a deployment that posts, causes one: once per enabled
 * connection, with the page's own bound. Every other member, and every member
 * of a deployment that does not post, gets the page with no read of the
 * posting settings and no call to QuickBooks — and is told, in the page's own
 * words, whether this deployment ever writes to a company.
 */

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const FIRST = '44444444-4444-4444-8444-444444444444';
const SECOND = '55555555-5555-4555-8555-555555555555';

function account(id: string, name: string, accountType: string): QboAccount {
  return { id, name, fullyQualifiedName: name, accountType, accountSubType: undefined, active: true };
}
const CHART = [
  account('7001', 'Trade Receivables', 'Accounts Receivable'),
  account('7003', 'Prepaid Freight', 'Other Current Asset'),
  account('7004', 'Promotional Allowances', 'Expense'),
];

const harness = vi.hoisted(() => ({
  role: 'owner' as string,
  /** Whether `qboPostingFromEnv` builds a poster: `QBO_POSTING=1`. */
  posts: true,
  connections: [] as PostingConnectionView[],
  /** Reads of the posting settings, by the member each was made as. */
  settingsReads: [] as unknown[],
  /** Each chart reader asked for: the member, the connection and the options. */
  readersAsked: [] as Array<{ identity: unknown; connectionId: string; options: unknown }>,
  /** Each read of a chart actually made. */
  chartReads: [] as string[],
  chartFails: false,
  closed: 0,
  /** What the ledger overview answers: the company this workspace reads. */
  overview: [] as unknown[],
}));

vi.mock('../lib/session', () => ({
  requireSession: async () => ({
    userId: USER_ID,
    email: 'member@example.test',
    org: { orgId: ORG_ID, slug: 'acme', name: 'Acme Foods', role: harness.role },
    orgs: [{ orgId: ORG_ID, slug: 'acme', name: 'Acme Foods', role: harness.role }],
  }),
  storeFor: () => ({
    async close() {
      harness.closed += 1;
    },
  }),
}));

vi.mock('../lib/env', () => ({ env: { databaseUrl: 'postgres://not-used.example/test' } }));

vi.mock('../lib/qbo-posting', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/qbo-posting')>();
  const refuse = (): never => {
    throw new Error('the page reads the chart and nothing else');
  };
  return {
    ...actual,
    qboPostingFromEnv: () =>
      harness.posts
        ? {
            clientFor: refuse,
            accountTypesFor: refuse,
            accountCreatorFor: refuse,
            accountsFor: (identity: unknown, connection: { connectionId: string }, options: unknown) => {
              harness.readersAsked.push({ identity, connectionId: connection.connectionId, options });
              return async () => {
                harness.chartReads.push(connection.connectionId);
                if (harness.chartFails) throw new Error('QuickBooks did not answer');
                return CHART;
              };
            },
          }
        : undefined,
  };
});

vi.mock('../lib/posting', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/posting')>();
  return {
    ...actual,
    postingStoreFor: (session: { org: { orgId: string }; userId: string }) => ({
      async postingConnections() {
        harness.settingsReads.push({ orgId: session.org.orgId, userId: session.userId });
        return harness.connections;
      },
    }),
  };
});

vi.mock('@recouple/store-postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@recouple/store-postgres')>();
  return {
    ...actual,
    PostgresLedgerSyncStore: class {
      async ledgerConnectionOverview() {
        return harness.overview;
      }
    },
  };
});

const { default: QuickBooksSettingsPage, maxDuration } = await import('../app/settings/quickbooks/page');
const { CHART_MAX_PAGES, CHART_READ_BOUNDS, CHART_READ_TIMEOUT_MS } = await import('../lib/posting-setup');
const { LEDGER_ACCOUNT_LOCK_TIMEOUT_MS, LOCK_POOL_CONNECT_TIMEOUT_MS } = await import('@recouple/store-postgres');

async function page(): Promise<string> {
  const { renderToStaticMarkup } = await import('react-dom/server');
  return renderToStaticMarkup(await QuickBooksSettingsPage({ searchParams: Promise.resolve({}) }));
}

const WRITTEN_TO = 'written to only if an owner turns posting on';
const NEVER_WRITTEN = 'read once a day, never written to.';
const POSTING_CARD = 'aria-label="Posting to QuickBooks"';

beforeEach(() => {
  harness.role = 'owner';
  harness.posts = true;
  harness.connections = [
    { connectionId: FIRST, realmId: '4620816365', postingEnabled: false, map: undefined },
    { connectionId: SECOND, realmId: '9130357843', postingEnabled: false, map: undefined },
  ];
  harness.settingsReads = [];
  harness.readersAsked = [];
  harness.chartReads = [];
  harness.chartFails = false;
  harness.closed = 0;
  harness.overview = [
    {
      connectionId: FIRST,
      orgId: ORG_ID,
      provider: 'qbo',
      providerAccountId: '4620816365',
      enabled: true,
      createdBy: USER_ID,
      createdByEmail: 'member@example.test',
      createdAt: '2026-09-27T09:00:00.000Z',
      updatedAt: '2026-09-27T09:00:00.000Z',
    },
  ];
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('an owner, on a deployment that posts', () => {
  it("reads each enabled connection's chart once, as themselves and with the page's bound, and proposes from it", async () => {
    const html = await page();
    expect(harness.settingsReads).toEqual([{ orgId: ORG_ID, userId: USER_ID }]);
    expect(harness.readersAsked).toEqual([
      { identity: { orgId: ORG_ID, userId: USER_ID }, connectionId: FIRST, options: CHART_READ_BOUNDS },
      { identity: { orgId: ORG_ID, userId: USER_ID }, connectionId: SECOND, options: CHART_READ_BOUNDS },
    ]);
    expect(CHART_READ_BOUNDS).toEqual({ timeoutMs: CHART_READ_TIMEOUT_MS, maxPages: CHART_MAX_PAGES });
    expect(harness.chartReads).toEqual([FIRST, SECOND]);
    expect(html).toContain(POSTING_CARD);
    expect(html.match(/<form[^>]* action="\/settings\/quickbooks\/setup"/g)).toHaveLength(2);
    expect(html).toContain(`name="connectionId" value="${FIRST}"`);
    expect(html).toContain(`name="connectionId" value="${SECOND}"`);
    expect(html).toContain(WRITTEN_TO);
    expect(harness.closed).toBe(1);
  });

  it('reads the chart of a company whose map is saved as well, for the dropdowns that change it', async () => {
    // ADR 0063 §1: on every owner's view, with a map or without — so this
    // page's GET may refresh, and store, a company's token whenever an owner
    // opens it on a deployment that posts.
    const map = {
      mapId: 'map-1',
      arAccountId: '7001',
      deductionsReceivableAccountId: '7003',
      writeoffByFamily: Object.fromEntries(REASON_FAMILIES.map((family) => [family, '7004'])) as never,
      unclassifiedWriteoff: '7004',
    };
    harness.connections = [
      { connectionId: FIRST, realmId: '4620816365', postingEnabled: true, map },
      { connectionId: SECOND, realmId: '9130357843', postingEnabled: false, map: undefined },
    ];
    await page();
    expect(harness.chartReads).toEqual([FIRST, SECOND]);
  });

  it('reads nothing from QuickBooks when no connection is enabled', async () => {
    harness.connections = [];
    const html = await page();
    expect(harness.settingsReads).toHaveLength(1);
    expect(harness.readersAsked).toEqual([]);
    expect(html).toContain('Connect a QuickBooks company first.');
  });

  it("lets the chart read end on its own bounds well inside the page's maxDuration", () => {
    // Two pages of a chart at the read's bound, and one token refresh: a lock
    // connection, the company's lock, then Intuit's token call (10 s,
    // `@recouple/qbo`'s own OAuth bound). Several connections are read side by
    // side, not in turn.
    const worst =
      CHART_MAX_PAGES * CHART_READ_TIMEOUT_MS + LOCK_POOL_CONNECT_TIMEOUT_MS + LEDGER_ACCOUNT_LOCK_TIMEOUT_MS + 10_000;
    expect(worst).toBe(75_000);
    // The session, the connections and the ledger overview have the rest.
    expect(maxDuration * 1000 - worst).toBeGreaterThanOrEqual(15_000);
  });

  it('still draws the page, Disconnect included, when a chart cannot be read', async () => {
    harness.chartFails = true;
    const html = await page();
    expect(harness.chartReads).toEqual([FIRST, SECOND]);
    expect(html).toContain('QuickBooks could not be read just now');
    expect(html).not.toContain('action="/settings/quickbooks/setup"');
    expect(html).toContain('action="/settings/quickbooks/disconnect"');
    expect(harness.closed).toBe(1);
  });
});

describe('anyone else, on a deployment that posts', () => {
  it.each(['approver', 'analyst', 'read_only', 'accountant_guest'])(
    'causes no read of the chart or of the posting settings for the %s role, and is told the company may be written to',
    async (role) => {
      harness.role = role;
      const html = await page();
      expect(harness.settingsReads).toEqual([]);
      expect(harness.readersAsked).toEqual([]);
      expect(harness.chartReads).toEqual([]);
      expect(html).not.toContain(POSTING_CARD);
      expect(html).not.toContain('action="/settings/quickbooks/setup"');
      expect(html).toContain(WRITTEN_TO);
      expect(html).not.toContain(NEVER_WRITTEN);
      expect(harness.closed).toBe(1);
    },
  );
});

describe('a deployment that does not post', () => {
  it.each(['owner', 'analyst', 'read_only'])(
    'reads nothing for the %s role, shows no posting card, and says the company is never written to',
    async (role) => {
      harness.role = role;
      harness.posts = false;
      const html = await page();
      expect(harness.settingsReads).toEqual([]);
      expect(harness.readersAsked).toEqual([]);
      expect(html).not.toContain(POSTING_CARD);
      expect(html).toContain(NEVER_WRITTEN);
      expect(html).not.toContain(WRITTEN_TO);
    },
  );
});

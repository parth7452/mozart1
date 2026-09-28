import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What `qboPostingFromEnv` hands `QboClient` (ADR 0063 §1, §2): a settings
 * request — the page's read of a chart, a press's read, create and type
 * check, a map's type check — bounds each request at the time it names, and a
 * caller that names none, the posting job's client above all, waits
 * QuickBooks' own default. The client here is a stand-in that records what it
 * was built with; the timeout itself is `@recouple/qbo`'s, tested there. The
 * token store is a stand-in too: it is built, never used.
 */

const built = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock('@recouple/qbo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@recouple/qbo')>();
  return {
    ...actual,
    QboClient: class {
      constructor(config: Record<string, unknown>) {
        built.push(config);
      }
      async listAccounts() {
        return [];
      }
    },
  };
});

vi.mock('../lib/ledger-sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/ledger-sync')>();
  return { ...actual, qboTokenStoreFromEnv: () => ({ standIn: true }) };
});

const { qboPostingFromEnv } = await import('../lib/qbo-posting');

const ID = '11111111-2222-4333-8444-555555555555';
const IDENTITY = { orgId: ID, userId: ID };
const CONNECTION = { connectionId: ID, realmId: '4620816365' };
const POSTING = {
  QBO_POSTING: '1',
  QBO_CLIENT_ID: 'id',
  QBO_CLIENT_SECRET: 'secret',
  QBO_ENVIRONMENT: 'sandbox',
  QBO_TOKEN_KMS_KEY_ID: 'key',
};

beforeEach(() => {
  built.length = 0;
});

describe('how long a request to QuickBooks may wait', () => {
  it('bounds each request, and the pages of a read, as the settings page names them for its read of a chart', async () => {
    const read = qboPostingFromEnv(POSTING)?.accountsFor(IDENTITY, CONNECTION, { timeoutMs: 10_000, maxPages: 2 });
    expect(read).toBeDefined();
    await expect(read?.()).resolves.toEqual([]);
    expect(built).toHaveLength(1);
    expect(built[0]).toMatchObject({ realmId: CONNECTION.realmId, timeoutMs: 10_000, maxPages: 2 });
  });

  it("bounds a press's read, create and type check, and a map's type check, as each names", () => {
    const poster = qboPostingFromEnv(POSTING);
    const bounds = { timeoutMs: 25_000, maxPages: 2 };
    expect(poster?.accountsFor(IDENTITY, CONNECTION, bounds)).toBeDefined();
    expect(poster?.accountCreatorFor(IDENTITY, CONNECTION, bounds)).toBeDefined();
    expect(poster?.accountTypesFor(IDENTITY, CONNECTION, bounds)).toBeDefined();
    expect(built).toHaveLength(3);
    for (const config of built) expect(config).toMatchObject({ realmId: CONNECTION.realmId, ...bounds });
  });

  it("leaves a client whose caller names no bound, the posting job's included, at QuickBooks' own default", () => {
    const poster = qboPostingFromEnv(POSTING);
    expect(poster?.accountsFor(IDENTITY, CONNECTION)).toBeDefined();
    expect(poster?.accountsFor(IDENTITY, CONNECTION, {})).toBeDefined();
    expect(poster?.accountCreatorFor(IDENTITY, CONNECTION)).toBeDefined();
    expect(poster?.accountTypesFor(IDENTITY, CONNECTION)).toBeDefined();
    expect(poster?.clientFor(IDENTITY, CONNECTION)).toBeDefined();
    expect(built).toHaveLength(5);
    for (const config of built) {
      expect(Object.hasOwn(config, 'timeoutMs')).toBe(false);
      expect(Object.hasOwn(config, 'maxPages')).toBe(false);
    }
  });
});

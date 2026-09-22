import { describe, expect, it } from 'vitest';
import { InMemoryAccountingSource } from '@recouple/adapters/testing';
import { cents, type LedgerInvoice, type LedgerPayment } from '@recouple/core-domain';
import { InMemoryDiscoveryStore } from '../src/testing/memory-discovery';
import type { LedgerSource } from '../src/discovery';
import {
  LEDGER_SYNC_WINDOW_DAYS,
  LedgerConnectionNotFoundError,
  LedgerSyncJobError,
  ledgerSyncWindow,
  syncLedgerJob,
  type LedgerConnectionRecord,
  type LedgerSourceFactory,
  type LedgerSyncRunRecord,
  type LedgerSyncRunStore,
} from '../src/ledger-job';

/**
 * The scheduled ledger sync, without a scheduler (ADR 0031).
 *
 * Four things would matter if this were wrong, and they are the four asked
 * here. Does anything get read before the database has said this member may
 * still write? Does every outcome leave a row — because a sync that ran and
 * left no row is invisible to a coverage number? Does a failure get recorded
 * *and* rethrown, rather than one or the other? And is the overlapping window
 * actually free, or is that just something ADR 0031 asserts?
 */

const ORG = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';
const CONNECTION = '33333333-3333-3333-3333-333333333333';

function connectionRecord(
  overrides: Partial<LedgerConnectionRecord> = {},
): LedgerConnectionRecord {
  return {
    connectionId: CONNECTION,
    orgId: ORG,
    provider: 'qbo',
    providerAccountId: 'realm-9',
    enabled: true,
    createdBy: USER,
    ...overrides,
  };
}

function invoice(overrides: Partial<LedgerInvoice> = {}): LedgerInvoice {
  return {
    sourceKind: 'qbo',
    externalId: 'inv-1',
    invoiceNumber: 'INV-1001',
    customerExternalId: 'cust-9',
    customerName: 'Sysco Baltimore, LLC',
    issuedOn: '2026-09-01',
    totalCents: cents(1_000_000),
    balanceCents: cents(80_000),
    currency: 'USD',
    ...overrides,
  };
}

function payment(overrides: Partial<LedgerPayment> = {}): LedgerPayment {
  return {
    sourceKind: 'qbo',
    externalId: 'pay-1',
    customerExternalId: 'cust-9',
    receivedOn: '2026-09-10',
    totalCents: cents(920_000),
    reference: 'ACH-55512',
    memo: 'shortage',
    appliedTo: [{ invoiceExternalId: 'inv-1', amountCents: cents(920_000) }],
    ...overrides,
  };
}

/** A run store that records what it was asked to write, and answers questions. */
class RunStore implements LedgerSyncRunStore {
  readonly written: LedgerSyncRunRecord[] = [];
  readonly asked: { orgId: string; userId: string }[] = [];

  constructor(
    private readonly held: LedgerConnectionRecord | undefined,
    private readonly mayWrite = true,
  ) {}

  async memberMayWrite(actor: { orgId: string; userId: string }): Promise<boolean> {
    this.asked.push(actor);
    return this.mayWrite;
  }

  async connection(connectionId: string): Promise<LedgerConnectionRecord | undefined> {
    return this.held?.connectionId === connectionId ? this.held : undefined;
  }

  async recordLedgerSyncRun(input: LedgerSyncRunRecord): Promise<string> {
    this.written.push(input);
    return `run-${this.written.length}`;
  }
}

/** A source factory that records whether it was ever asked to build anything. */
function ready(source: LedgerSource): LedgerSourceFactory & { asked: number } {
  const factory = {
    asked: 0,
    resolve() {
      factory.asked += 1;
      return { kind: 'ready' as const, source };
    },
  };
  return factory;
}

function notConfigured(reason: string): LedgerSourceFactory {
  return { resolve: () => ({ kind: 'not_configured', reason }) };
}

function ledger(): InMemoryAccountingSource {
  return new InMemoryAccountingSource({
    invoices: [invoice()],
    payments: [payment()],
    credits: [],
  });
}

const AT = new Date('2026-09-22T07:00:00.000Z');

describe('the window a scheduled sync walks', () => {
  it('trails 35 days to today, inclusive, in UTC', () => {
    expect(ledgerSyncWindow(new Date('2026-09-22T23:59:59.000Z'))).toEqual({
      from: '2026-08-19',
      to: '2026-09-22',
    });
    expect(LEDGER_SYNC_WINDOW_DAYS).toBe(35);
  });

  it('is a whole number of days, at least one', () => {
    expect(ledgerSyncWindow(AT, 1)).toEqual({ from: '2026-09-22', to: '2026-09-22' });
    expect(() => ledgerSyncWindow(AT, 0)).toThrow(LedgerSyncJobError);
    expect(() => ledgerSyncWindow(AT, 1.5)).toThrow(LedgerSyncJobError);
  });

  it('does not move with the hour of the day the cron fires', () => {
    const early = ledgerSyncWindow(new Date('2026-09-22T00:00:01.000Z'));
    const late = ledgerSyncWindow(new Date('2026-09-22T23:00:01.000Z'));
    expect(early).toEqual(late);
  });
});

describe('syncing one connection on a schedule', () => {
  it('records a completed run with the counts the sync produced', async () => {
    const runs = new RunStore(connectionRecord());
    const sources = ready(ledger());
    const result = await syncLedgerJob(
      { runs, discovery: new InMemoryDiscoveryStore(), sources, now: () => AT },
      { connectionId: CONNECTION, orgId: ORG, actor: { userId: USER } },
    );

    expect(result.outcome).toBe('completed');
    expect(result.runId).toBe('run-1');
    expect(result.window).toEqual({ from: '2026-08-19', to: '2026-09-22' });
    expect(result.invoicesExamined).toBe(1);
    expect(result.openedCount).toBe(1);

    expect(runs.written).toHaveLength(1);
    const row = runs.written[0];
    expect(row?.outcome).toBe('completed');
    expect(row?.openedCount).toBe(1);
    expect(row?.skippedCount).toBe(0);
    expect(row?.declinedCount).toBe(0);
    expect(row?.anomalyCount).toBe(0);
    expect(row?.requestedBy).toBe(USER);
    expect(row?.windowFrom).toBe('2026-08-19');
    // A completed run carries no error class — the database refuses one, and
    // nothing here should be offering it one.
    expect(row?.errorClass).toBeUndefined();
  });

  it('refuses, and records the refusal, when the member may no longer write', async () => {
    const runs = new RunStore(connectionRecord(), false);
    const sources = ready(ledger());
    const discovery = new InMemoryDiscoveryStore();

    const result = await syncLedgerJob(
      { runs, discovery, sources, now: () => AT },
      { connectionId: CONNECTION, orgId: ORG, actor: { userId: USER } },
    );

    expect(result.outcome).toBe('refused');
    expect(runs.written[0]?.outcome).toBe('refused');
    expect(runs.written[0]?.errorClass).toBe('LedgerSyncRefusedError');
    expect(runs.written[0]?.openedCount).toBe(0);

    // Nothing was read and nothing was written: the point of asking before
    // spending. A source that was never built is a vendor that was never
    // called.
    expect(sources.asked).toBe(0);
    expect(discovery.cases).toEqual([]);
    expect(runs.asked).toEqual([{ orgId: ORG, userId: USER }]);
  });

  it('refuses a connection disabled since the fan-out listed it', async () => {
    const runs = new RunStore(connectionRecord({ enabled: false }));
    const sources = ready(ledger());

    const result = await syncLedgerJob(
      { runs, discovery: new InMemoryDiscoveryStore(), sources, now: () => AT },
      { connectionId: CONNECTION, orgId: ORG, actor: { userId: USER } },
    );

    expect(result.outcome).toBe('refused');
    expect(runs.written[0]?.errorClass).toBe('LedgerConnectionDisabledError');
    expect(sources.asked).toBe(0);
    // And it is not even asked about the member: a disabled connection is not
    // a question about anybody's rights.
    expect(runs.asked).toEqual([]);
  });

  it('records not_configured rather than throwing, and keeps the reason out of the row', async () => {
    const runs = new RunStore(connectionRecord());
    const discovery = new InMemoryDiscoveryStore();

    const result = await syncLedgerJob(
      {
        runs,
        discovery,
        sources: notConfigured('QBO_CLIENT_ID, QBO_CLIENT_SECRET are not set'),
        now: () => AT,
      },
      { connectionId: CONNECTION, orgId: ORG, actor: { userId: USER } },
    );

    expect(result.outcome).toBe('not_configured');
    // The reason comes back for a log line; the row gets a class name, because
    // a message off this path is not something to keep (invariant 4).
    expect(result.reason).toContain('QBO_CLIENT_ID');
    expect(runs.written[0]?.errorClass).toBe('LedgerSourceNotConfiguredError');
    expect(JSON.stringify(runs.written[0])).not.toContain('QBO_CLIENT_ID');
    expect(discovery.cases).toEqual([]);
  });

  it('records a failed run and then rethrows', async () => {
    const runs = new RunStore(connectionRecord());
    const exploding: LedgerSource = {
      async listInvoices() {
        throw new TypeError('the vendor sent something unreadable');
      },
      async listPayments() {
        return [];
      },
      async listCredits() {
        return [];
      },
    };

    await expect(
      syncLedgerJob(
        {
          runs,
          discovery: new InMemoryDiscoveryStore(),
          sources: { resolve: () => ({ kind: 'ready', source: exploding }) },
          now: () => AT,
        },
        { connectionId: CONNECTION, orgId: ORG, actor: { userId: USER } },
      ),
    ).rejects.toThrow(TypeError);

    // Both halves. A run that broke and left no row is a window a coverage
    // number would read as empty; a run that broke and did not throw is a
    // failure nobody sees.
    expect(runs.written).toHaveLength(1);
    expect(runs.written[0]?.outcome).toBe('failed');
    expect(runs.written[0]?.errorClass).toBe('TypeError');
  });

  it('throws on a connection this tenant cannot see, and records nothing', async () => {
    const runs = new RunStore(undefined);
    await expect(
      syncLedgerJob(
        {
          runs,
          discovery: new InMemoryDiscoveryStore(),
          sources: ready(ledger()),
          now: () => AT,
        },
        { connectionId: CONNECTION, orgId: ORG, actor: { userId: USER } },
      ),
    ).rejects.toThrow(LedgerConnectionNotFoundError);
    // There is nothing to attribute a row to: `connection_id` is a foreign key.
    expect(runs.written).toEqual([]);
  });

  it('refuses a payload whose org is not the connection’s', async () => {
    const runs = new RunStore(connectionRecord({ orgId: 'another-org' }));
    await expect(
      syncLedgerJob(
        {
          runs,
          discovery: new InMemoryDiscoveryStore(),
          sources: ready(ledger()),
          now: () => AT,
        },
        { connectionId: CONNECTION, orgId: ORG, actor: { userId: USER } },
      ),
    ).rejects.toThrow(LedgerSyncJobError);
    expect(runs.written).toEqual([]);
  });

  it('needs an org, a connection and an actor', async () => {
    const deps = {
      runs: new RunStore(connectionRecord()),
      discovery: new InMemoryDiscoveryStore(),
      sources: ready(ledger()),
      now: () => AT,
    };
    await expect(
      syncLedgerJob(deps, { connectionId: '', orgId: ORG, actor: { userId: USER } }),
    ).rejects.toThrow(LedgerSyncJobError);
    await expect(
      syncLedgerJob(deps, { connectionId: CONNECTION, orgId: '  ', actor: { userId: USER } }),
    ).rejects.toThrow(LedgerSyncJobError);
    await expect(
      syncLedgerJob(deps, { connectionId: CONNECTION, orgId: ORG, actor: { userId: '' } }),
    ).rejects.toThrow(LedgerSyncJobError);
  });

  it('costs nothing the second day: the overlap skips rather than opens', async () => {
    // ADR 0031 §6's claim, asked rather than asserted. Two runs over the same
    // ledger, which is what a trailing window does every day: the first opens
    // the case, the second finds the invoice's own identifier already on it and
    // skips.
    const runs = new RunStore(connectionRecord());
    const discovery = new InMemoryDiscoveryStore();
    const deps = {
      runs,
      discovery,
      sources: { resolve: () => ({ kind: 'ready' as const, source: ledger() }) },
      now: () => AT,
    };
    const input = { connectionId: CONNECTION, orgId: ORG, actor: { userId: USER } };

    const first = await syncLedgerJob(deps, input);
    const second = await syncLedgerJob(deps, input);

    expect(first.openedCount).toBe(1);
    expect(second.openedCount).toBe(0);
    expect(second.skippedCount).toBe(1);
    expect(discovery.cases).toHaveLength(1);
    // And the second run is still a run: the row says the window was walked,
    // which is the whole reason the log exists.
    expect(runs.written.map((row) => row.outcome)).toEqual(['completed', 'completed']);
  });
});

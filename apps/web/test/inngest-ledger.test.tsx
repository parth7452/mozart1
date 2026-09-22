import { describe, expect, it, vi } from 'vitest';
import { NonRetriableError } from 'inngest';
import { InMemoryAccountingSource } from '@recouple/adapters/testing';
import { cents, type LedgerInvoice, type LedgerPayment } from '@recouple/core-domain';
import { InMemoryDiscoveryStore } from '@recouple/pipeline/testing';
import {
  LedgerConnectionNotFoundError,
  LedgerSyncJobError,
  type LedgerConnectionRecord,
  type LedgerSourceFactory,
  type LedgerSyncRunRecord,
  type LedgerSyncRunStore,
} from '@recouple/pipeline';
import { INNGEST_PLAN_CONCURRENCY_LIMIT } from '../lib/inngest';
import {
  LEDGER_SYNCS_IN_FLIGHT,
  LEDGER_SYNCS_IN_FLIGHT_PER_ORG,
  LEDGER_SYNC_CONFIG,
  LEDGER_SYNC_FAN_OUT_CONFIG,
  LEDGER_SYNC_REQUESTED,
  LEDGER_SYNC_SCHEDULE,
  asLedgerSyncFailure,
  ledgerFanOutSteps,
  ledgerSyncSteps,
  parseLedgerSyncRequested,
  runLedgerSyncRequested,
  type LedgerSyncContext,
  type LedgerSyncRequestedData,
  type SyncableConnection,
} from '../lib/inngest-ledger';
import { accountingSourceFromEnv, qboTokenStoreFromEnv } from '../lib/ledger-sync';

/**
 * The scheduled half of the Inngest binding (ADR 0031).
 *
 * The questions that would matter if this were wrong. Does the fan-out send one
 * request per *enabled* connection, with ids and no ledger content? Does each
 * sync run as the connection's own member — through RLS, as `app_rw`, never as
 * the service role (invariant 6)? Does a member who may no longer write get a
 * recorded refusal rather than a read? And does an unconfigured deployment —
 * which is every deployment today — record that per connection instead of
 * throwing the fleet over?
 */

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '44444444-4444-4444-4444-444444444444';
const USER_A = '22222222-2222-2222-2222-222222222222';
const USER_B = '55555555-5555-5555-5555-555555555555';
const CONN_A = '33333333-3333-3333-3333-333333333333';
const CONN_B = '66666666-6666-6666-6666-666666666666';

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

function payment(): LedgerPayment {
  return {
    sourceKind: 'qbo',
    externalId: 'pay-1',
    customerExternalId: 'cust-9',
    receivedOn: '2026-09-10',
    totalCents: cents(920_000),
    reference: 'ACH-55512',
    memo: 'shortage',
    appliedTo: [{ invoiceExternalId: 'inv-1', amountCents: cents(920_000) }],
  };
}

function connectionRecord(
  overrides: Partial<LedgerConnectionRecord> = {},
): LedgerConnectionRecord {
  return {
    connectionId: CONN_A,
    orgId: ORG_A,
    provider: 'qbo',
    providerAccountId: 'realm-9',
    enabled: true,
    createdBy: USER_A,
    ...overrides,
  };
}

class RunStore implements LedgerSyncRunStore {
  readonly written: LedgerSyncRunRecord[] = [];

  constructor(
    private readonly held: LedgerConnectionRecord | undefined,
    private readonly mayWrite = true,
  ) {}

  async memberMayWrite(): Promise<boolean> {
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

const READY: LedgerSourceFactory = {
  resolve: () => ({
    kind: 'ready',
    source: new InMemoryAccountingSource({
      invoices: [invoice()],
      payments: [payment()],
      credits: [],
    }),
  }),
};

/**
 * A context that records the identity it was asked to build deps for, the
 * events it was asked to send, and whether it was closed — so what a payload
 * turns into is visible.
 */
function contextOver(options: {
  readonly connections?: readonly SyncableConnection[];
  readonly runs?: RunStore;
  readonly sources?: LedgerSourceFactory;
  readonly now?: Date;
}): {
  context: LedgerSyncContext;
  identities: { orgId: string; userId: string }[];
  sent: { name: string; data: LedgerSyncRequestedData }[];
  closed: () => number;
  runs: RunStore;
} {
  const identities: { orgId: string; userId: string }[] = [];
  const sent: { name: string; data: LedgerSyncRequestedData }[] = [];
  const runs = options.runs ?? new RunStore(connectionRecord());
  const at = options.now ?? new Date('2026-09-22T07:00:00.000Z');
  let closes = 0;

  return {
    identities,
    sent,
    runs,
    closed: () => closes,
    context: {
      connectionsToSync: async () => options.connections ?? [],
      send: async (events) => {
        sent.push(...events.map((event) => ({ name: event.name, data: event.data })));
      },
      depsFor: (identity) => {
        identities.push({ ...identity });
        return {
          deps: {
            runs,
            discovery: new InMemoryDiscoveryStore(),
            sources: options.sources ?? READY,
            now: () => at,
          },
          close: async () => {
            closes += 1;
          },
        };
      },
    },
  };
}

/** A `step` that runs everything it is handed, and records the step ids. */
function recordingStep(ids: string[]): {
  run<T>(id: string, work: () => Promise<T>): Promise<T>;
} {
  return {
    run: async (id, work) => {
      ids.push(id);
      return work();
    },
  };
}

describe('the ledger sync fan-out', () => {
  it('sends one request per enabled connection, as ids', async () => {
    const connections: SyncableConnection[] = [
      { connectionId: CONN_A, orgId: ORG_A, createdBy: USER_A },
      { connectionId: CONN_B, orgId: ORG_B, createdBy: USER_B },
    ];
    const { context, sent } = contextOver({ connections });
    const steps: string[] = [];

    const result = await ledgerFanOutSteps(context)({ step: recordingStep(steps) });

    expect(result.connections).toBe(2);
    expect(steps).toEqual(['list-connections', 'send-sync-requests']);
    expect(sent).toHaveLength(2);
    expect(sent.map((event) => event.name)).toEqual([
      LEDGER_SYNC_REQUESTED,
      LEDGER_SYNC_REQUESTED,
    ]);

    // Each connection's own org and its own member, never one org's claims on
    // another's connection.
    expect(sent[0]?.data.connectionId).toBe(CONN_A);
    expect(sent[0]?.data.orgId).toBe(ORG_A);
    expect(sent[0]?.data.userId).toBe(USER_A);
    expect(sent[1]?.data.userId).toBe(USER_B);

    // A fresh key per connection, so the runtime's window catches only a
    // literal redelivery — not a deliberate re-run of that tenant's sync.
    expect(sent[0]?.data.syncKey).not.toBe(sent[1]?.data.syncKey);
    for (const event of sent) {
      expect(parseLedgerSyncRequested(event.data)).toEqual(event.data);
      // Four fields, and not one of them a customer's ledger (invariant 4).
      expect(Object.keys(event.data).sort()).toEqual([
        'connectionId',
        'orgId',
        'syncKey',
        'userId',
      ]);
    }
  });

  it('sends nothing at all when no org has a ledger', async () => {
    const { context, sent } = contextOver({ connections: [] });
    const steps: string[] = [];

    const result = await ledgerFanOutSteps(context)({ step: recordingStep(steps) });

    expect(result.connections).toBe(0);
    expect(sent).toEqual([]);
    // No empty batch to the runtime either: the sending step is skipped.
    expect(steps).toEqual(['list-connections']);
  });

  it('mints the keys in the memoised step, so a retry re-sends the same ones', async () => {
    // The reason the fan-out is two steps. If the keys were minted in the
    // sending step, a retry of that step would be a *different* request per
    // connection and the idempotency window would not collapse it — one
    // duplicate sync per connection per retry.
    const connections: SyncableConnection[] = [
      { connectionId: CONN_A, orgId: ORG_A, createdBy: USER_A },
    ];
    const { context, sent } = contextOver({ connections });

    let listed: unknown;
    await ledgerFanOutSteps(context)({
      step: {
        run: async (id, work) => {
          const value = await work();
          if (id === 'list-connections') listed = value;
          return value;
        },
      },
    });

    // Replay: the runtime hands back the memoised list rather than running the
    // first step again, and the send goes out with those same keys.
    const firstKey = sent[0]?.data.syncKey;
    sent.length = 0;
    await ledgerFanOutSteps(context)({
      step: {
        run: async (id, work) => (id === 'list-connections' ? (listed as never) : work()),
      },
    });
    expect(sent[0]?.data.syncKey).toBe(firstKey);
  });
});

describe('the ledger sync payload', () => {
  it('rejects anything that is not four ids, without a retry', () => {
    const good: LedgerSyncRequestedData = {
      connectionId: CONN_A,
      orgId: ORG_A,
      userId: USER_A,
      syncKey: CONN_B,
    };
    expect(parseLedgerSyncRequested(good)).toEqual(good);

    for (const bad of [
      undefined,
      null,
      'a string',
      {},
      { ...good, connectionId: 'not-a-uuid' },
      { ...good, orgId: '' },
      { ...good, userId: 42 },
      { ...good, syncKey: undefined },
      { ...good, orgId: `${ORG_A} or 1=1` },
    ]) {
      expect(() => parseLedgerSyncRequested(bad)).toThrow(NonRetriableError);
    }
  });
});

describe('one scheduled sync', () => {
  const payload = (
    overrides: Partial<LedgerSyncRequestedData> = {},
  ): LedgerSyncRequestedData => ({
    connectionId: CONN_A,
    orgId: ORG_A,
    userId: USER_A,
    syncKey: '77777777-7777-7777-7777-777777777777',
    ...overrides,
  });

  it('builds its stores from the identity in the event, and closes them', async () => {
    const { context, identities, closed, runs } = contextOver({});

    const result = await runLedgerSyncRequested(payload(), context);

    // The tenant and the member come from the payload and nowhere else. That is
    // what makes a cron's reads the same reads a request would make.
    expect(identities).toEqual([{ orgId: ORG_A, userId: USER_A }]);
    expect(closed()).toBe(1);
    expect(result.outcome).toBe('completed');
    expect(result.openedCount).toBe(1);
    expect(runs.written[0]?.requestedBy).toBe(USER_A);
    expect(runs.written[0]?.windowFrom).toBe('2026-08-19');
    expect(runs.written[0]?.windowTo).toBe('2026-09-22');
  });

  it('refuses and records it when the member may no longer write', async () => {
    const runs = new RunStore(connectionRecord(), false);
    const { context, closed } = contextOver({ runs });

    const result = await runLedgerSyncRequested(payload(), context);

    expect(result.outcome).toBe('refused');
    expect(runs.written).toHaveLength(1);
    expect(runs.written[0]?.outcome).toBe('refused');
    expect(runs.written[0]?.errorClass).toBe('LedgerSyncRefusedError');
    expect(runs.written[0]?.invoicesExamined).toBe(0);
    expect(closed()).toBe(1);
  });

  it('records not_configured for a connection nothing can be built for', async () => {
    const runs = new RunStore(connectionRecord());
    const { context } = contextOver({
      runs,
      sources: { resolve: () => ({ kind: 'not_configured', reason: 'QBO_CLIENT_ID is not set' }) },
    });

    const result = await runLedgerSyncRequested(payload(), context);

    expect(result.outcome).toBe('not_configured');
    expect(runs.written[0]?.outcome).toBe('not_configured');
    expect(runs.written[0]?.errorClass).toBe('LedgerSourceNotConfiguredError');
  });

  it('runs through the step the runtime hands it, and says where it got to', async () => {
    const { context } = contextOver({});
    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    const steps: string[] = [];

    try {
      const result = await ledgerSyncSteps(context)({
        event: { data: payload() },
        step: recordingStep(steps),
      });

      expect(steps).toEqual(['sync-ledger']);
      expect(result.outcome).toBe('completed');

      // A run line with no step line under it is a stall at exactly that seam,
      // which is the failure this logging exists for.
      expect(lines).toHaveLength(4);
      expect(lines[0]).toContain('run entered');
      expect(lines[1]).toContain('step sync-ledger entered');
      expect(lines[2]).toContain('step sync-ledger completed');
      expect(lines[2]).toContain('window 2026-08-19..2026-09-22');
      expect(lines[2]).toContain('opened 1');
      expect(lines[3]).toContain('run returned');
      for (const line of lines) {
        expect(line).toContain(`connection ${CONN_A}`);
        expect(line).toContain(`org ${ORG_A}`);
      }
      // Not one word of anybody's ledger.
      const all = lines.join('\n');
      expect(all).not.toContain('Sysco');
      expect(all).not.toContain('INV-1001');
    } finally {
      log.mockRestore();
    }
  });

  it('names a malformed payload in the log before it throws', async () => {
    const { context } = contextOver({});
    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    try {
      await expect(
        ledgerSyncSteps(context)({
          event: { data: { orgId: 'nonsense' } },
          step: recordingStep([]),
        }),
      ).rejects.toThrow(NonRetriableError);
      expect(lines[0]).toContain('connection unknown org unknown');
    } finally {
      log.mockRestore();
    }
  });
});

describe('what a failure may say', () => {
  it('rebuilds the message from the class name and the ids, and retries only what could differ', () => {
    const ids = { connectionId: CONN_A, orgId: ORG_A };

    const settled = asLedgerSyncFailure(new LedgerSyncJobError('org mismatch'), ids);
    expect(settled).toBeInstanceOf(NonRetriableError);
    expect(String((settled as Error).message)).toContain('LedgerSyncJobError');
    expect(String((settled as Error).message)).toContain(CONN_A);
    // Never the original message: an error raised while reading somebody's
    // books can quote them, and a message travels to a third party's run
    // history (invariant 4).
    expect(String((settled as Error).message)).not.toContain('org mismatch');

    expect(asLedgerSyncFailure(new LedgerConnectionNotFoundError(CONN_A), ids)).toBeInstanceOf(
      NonRetriableError,
    );

    // A vendor that timed out could answer differently in thirty seconds.
    const transient = asLedgerSyncFailure(new Error('socket hang up'), ids);
    expect(transient).toBeInstanceOf(Error);
    expect(transient).not.toBeInstanceOf(NonRetriableError);
    expect(String((transient as Error).message)).not.toContain('socket hang up');
  });
});

describe('how the runtime is asked to run these', () => {
  it('keys idempotency on the request, not the org', () => {
    expect(LEDGER_SYNC_CONFIG.idempotency).toBe('event.data.syncKey');
    // The bug this is not: keying on the org would make the window swallow
    // every deliberate re-run of that tenant's sync for twenty-four hours.
    expect(LEDGER_SYNC_CONFIG.idempotency).not.toContain('orgId');
  });

  it('asks for no more concurrency than the plan allows', () => {
    // A function asking for more than the plan allows makes the whole app fail
    // to sync — not a slower schedule, no deployed function at all.
    expect(LEDGER_SYNCS_IN_FLIGHT).toBeLessThanOrEqual(INNGEST_PLAN_CONCURRENCY_LIMIT);
    expect(LEDGER_SYNCS_IN_FLIGHT_PER_ORG).toBeLessThanOrEqual(LEDGER_SYNCS_IN_FLIGHT);
    // One per org: two concurrent syncs of one ledger race on identity and
    // both open a case for the same invoice.
    expect(LEDGER_SYNCS_IN_FLIGHT_PER_ORG).toBe(1);
    expect(LEDGER_SYNC_CONFIG.concurrency[0]).toEqual({
      key: 'event.data.orgId',
      limit: LEDGER_SYNCS_IN_FLIGHT_PER_ORG,
    });
    // Keyless, so it is a fleet ceiling rather than one limit per org.
    expect(LEDGER_SYNC_CONFIG.concurrency[1]).toEqual({ limit: LEDGER_SYNCS_IN_FLIGHT });
  });

  it('fires the fan-out on a named schedule, one at a time', () => {
    expect(LEDGER_SYNC_SCHEDULE).toBe('0 7 * * *');
    expect(LEDGER_SYNC_FAN_OUT_CONFIG.triggers).toEqual([{ cron: LEDGER_SYNC_SCHEDULE }]);
    // Two firings overlapping would send every connection's event twice under
    // different keys, which the idempotency window cannot collapse.
    expect(LEDGER_SYNC_FAN_OUT_CONFIG.concurrency).toEqual([{ limit: 1 }]);
    expect(LEDGER_SYNC_FAN_OUT_CONFIG.id).not.toBe(LEDGER_SYNC_CONFIG.id);
  });
});

describe('what this deployment can read a ledger with', () => {
  it('is nothing, because there is no production token store yet', () => {
    // ADR 0031 §7, and this is the assertion that keeps it honest: the moment a
    // KMS-backed store lands, this test is what says the seam was reached.
    expect(qboTokenStoreFromEnv({})).toBeUndefined();

    const resolved = accountingSourceFromEnv({
      QBO_CLIENT_ID: 'client',
      QBO_CLIENT_SECRET: 'secret',
      QBO_ENVIRONMENT: 'sandbox',
    }).resolve(connectionRecord());
    expect(resolved.kind).toBe('not_configured');
    if (resolved.kind === 'not_configured') {
      expect(resolved.reason).toContain('token store');
    }
  });

  it('names the variables an unconfigured environment is missing', () => {
    const resolved = accountingSourceFromEnv({}).resolve(connectionRecord());
    expect(resolved.kind).toBe('not_configured');
    if (resolved.kind === 'not_configured') {
      expect(resolved.reason).toContain('QBO_CLIENT_ID');
      expect(resolved.reason).toContain('QBO_CLIENT_SECRET');
      expect(resolved.reason).toContain('QBO_ENVIRONMENT');
    }
  });

  it('builds a source when everything including a token store is there', async () => {
    // The configured path, with the in-memory token store injected by the test
    // rather than reachable from the app: `@recouple/qbo/testing` is a separate
    // entry point for exactly that reason (CLAUDE.md).
    const { InMemoryQboTokenStore } = await import('@recouple/qbo/testing');
    const resolved = accountingSourceFromEnv(
      {
        QBO_CLIENT_ID: 'client',
        QBO_CLIENT_SECRET: 'secret',
        QBO_ENVIRONMENT: 'production',
      },
      new InMemoryQboTokenStore(),
    ).resolve(connectionRecord());

    expect(resolved.kind).toBe('ready');
  });

  it('refuses a half-configured environment rather than defaulting it', () => {
    // Production is not a fallback for a missing config, and a sandbox read
    // reported as a customer's books is not a failure anybody would notice
    // (ADR 0026).
    expect(() =>
      accountingSourceFromEnv({
        QBO_CLIENT_ID: 'client',
        QBO_CLIENT_SECRET: 'secret',
        QBO_ENVIRONMENT: 'staging',
      }).resolve(connectionRecord()),
    ).toThrow(/sandbox/);
  });

  it('has no source for a provider this build does not know', () => {
    const resolved = accountingSourceFromEnv({}).resolve(
      connectionRecord({ provider: 'netsuite' }),
    );
    expect(resolved.kind).toBe('not_configured');
    if (resolved.kind === 'not_configured') {
      expect(resolved.reason).toContain('netsuite');
    }
  });
});

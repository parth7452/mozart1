import { describe, expect, it } from 'vitest';
import type { PostmarkInboundListing } from '@recouple/ingest';
import {
  INBOUND_STALE_AFTER_HOURS,
  INBOUND_SWEEP_DAYS,
  sweepInboundFailures,
  sweepWindows,
  type InboundSweepDeps,
} from '../src/inbound-sweep';
import type { InboundAddressResolution } from '../src/inbound-ports';

/**
 * The operator's sweep (ADR 0047 §12): Postmark's failed messages become
 * `not_received` rows on the workspace whose live address they were sent to,
 * written as the member that address acts as — and nothing else happens.
 */

const DOMAIN = 'in.mozart.example';
const ORG = '11111111-1111-1111-1111-111111111111';
const OWNER = '22222222-2222-2222-2222-222222222222';
const LIVE = '0123456789abcdef0123456789abcdef';
const RETIRED = 'fedcba9876543210fedcba9876543210';
const STALE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const addresses: Record<string, InboundAddressResolution> = {
  [LIVE]: { addressId: '33333333-3333-3333-3333-333333333333', orgId: ORG, actingMember: OWNER, retired: false },
  [RETIRED]: { addressId: '44444444-4444-4444-4444-444444444444', orgId: ORG, actingMember: OWNER, retired: true },
  [STALE]: {
    addressId: '55555555-5555-5555-5555-555555555555',
    orgId: ORG,
    actingMember: '66666666-6666-6666-6666-666666666666',
    retired: false,
  },
};

// 12:00 in New York on 24 September.
const NOW = new Date('2026-09-24T16:00:00Z');

function harness(failedByDay: Record<string, readonly PostmarkInboundListing[]>) {
  const recorded: { address: InboundAddressResolution; messageId: string; at: Date }[] = [];
  const windows: { from: Date; to: Date }[] = [];
  const lookups: string[] = [];
  const counted: { status: string; before: Date }[] = [];
  const deps: InboundSweepDeps = {
    postmark: {
      async listFailed(window) {
        windows.push(window);
        return failedByDay[window.from.toISOString().slice(0, 10)] ?? [];
      },
      async countOlderThan(status, before) {
        counted.push({ status, before });
        return status === 'queued' ? 1 : 0;
      },
    },
    inboundDomain: DOMAIN,
    lookup: async (token) => {
      lookups.push(token);
      return addresses[token];
    },
    memberMayWrite: async (actor) => actor.userId === OWNER,
    recordNotReceived: async (address, messageId, at) => {
      recorded.push({ address, messageId, at });
      return `recorded-${messageId}`;
    },
    now: () => NOW,
  };
  return { deps, recorded, windows, lookups, counted };
}

const to = (local: string, id: string): PostmarkInboundListing => ({
  messageId: id,
  originalRecipient: `${local}@${DOMAIN}`,
});

describe('which days the sweep reads', () => {
  it('reads today so far and each whole day before it, one Eastern day per window', () => {
    const windows = sweepWindows(NOW);
    expect(windows).toHaveLength(INBOUND_SWEEP_DAYS);
    expect(windows[0]).toEqual({
      from: new Date('2026-09-24T04:00:00Z'),
      to: NOW,
      day: '2026-09-24',
    });
    expect(windows[1]).toEqual({
      from: new Date('2026-09-23T04:00:00Z'),
      to: new Date('2026-09-24T03:59:59Z'),
      day: '2026-09-23',
    });
    expect(windows.at(-1)?.day).toBe('2026-09-19');
  });
});

describe('the sweep', () => {
  it('records a failed message to a live address, as its member, on the day Postmark listed it', async () => {
    const { deps, recorded } = harness({ '2026-09-23': [to(LIVE, 'pm-1')] });
    const report = await sweepInboundFailures(deps);

    expect(recorded).toEqual([
      { address: addresses[LIVE], messageId: 'pm-1', at: new Date('2026-09-23T04:00:00Z') },
    ]);
    expect(report.lines).toEqual([
      {
        kind: 'recorded',
        providerMessageId: 'pm-1',
        inboundMessageId: 'recorded-pm-1',
        addressId: addresses[LIVE]?.addressId,
        orgId: ORG,
        day: '2026-09-23',
      },
    ]);
  });

  it('says why a failed message has no live address, and records nothing for it', async () => {
    const { deps, recorded } = harness({
      '2026-09-24': [
        to(RETIRED, 'pm-retired'),
        to('ffffffffffffffffffffffffffffffff', 'pm-unknown'),
        to('support', 'pm-not-token'),
        { messageId: 'pm-elsewhere', originalRecipient: `${LIVE}@elsewhere.example` },
      ],
    });
    const report = await sweepInboundFailures(deps);

    expect(recorded).toEqual([]);
    expect(report.lines).toEqual([
      { kind: 'no_live_address', providerMessageId: 'pm-retired', reason: 'retired' },
      { kind: 'no_live_address', providerMessageId: 'pm-unknown', reason: 'unknown_token' },
      { kind: 'no_live_address', providerMessageId: 'pm-not-token', reason: 'not_a_token' },
      { kind: 'no_live_address', providerMessageId: 'pm-elsewhere', reason: 'not_our_domain' },
    ]);
  });

  it('records nothing for an address whose member may no longer write, and says so', async () => {
    const { deps, recorded } = harness({ '2026-09-22': [to(STALE, 'pm-stale')] });
    const report = await sweepInboundFailures(deps);
    expect(recorded).toEqual([]);
    expect(report.lines).toEqual([
      {
        kind: 'member_may_not_write',
        providerMessageId: 'pm-stale',
        addressId: addresses[STALE]?.addressId,
        orgId: ORG,
      },
    ]);
  });

  it('asks the database about one token once, and counts a message once', async () => {
    const { deps, lookups, recorded } = harness({
      '2026-09-24': [to(LIVE, 'pm-1'), to(LIVE, 'pm-2')],
      '2026-09-23': [to(LIVE, 'pm-1')],
    });
    await sweepInboundFailures(deps);
    expect(lookups).toEqual([LIVE]);
    expect(recorded.map((row) => row.messageId)).toEqual(['pm-1', 'pm-2']);
  });

  it('counts what has waited on Postmark for more than two hours', async () => {
    const { deps, counted } = harness({});
    const report = await sweepInboundFailures(deps);
    const before = new Date(NOW.getTime() - INBOUND_STALE_AFTER_HOURS * 3_600_000);
    expect(counted).toEqual([
      { status: 'queued', before },
      { status: 'scheduled', before },
    ]);
    expect(report).toMatchObject({ staleQueued: 1, staleScheduled: 0 });
    expect(report.windows.map((w) => w.failed)).toEqual(Array(INBOUND_SWEEP_DAYS).fill(0));
  });

  it('lets a failure to record stop the sweep, loudly: a rerun is free', async () => {
    const { deps } = harness({ '2026-09-24': [to(LIVE, 'pm-1')] });
    const failing = {
      ...deps,
      recordNotReceived: async () => {
        throw new Error('connection terminated');
      },
    };
    await expect(sweepInboundFailures(failing)).rejects.toThrow('connection terminated');
  });
});

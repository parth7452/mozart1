import { afterEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { LedgerAccountBusyError, LockPoolTimeoutError, withLedgerAccountLock } from '../src/ledger-lock';
import { PostgresPostingStore } from '../src/posting';
import {
  LOCK_POOL_CONNECT_TIMEOUT_MS,
  SETUP_CLAIM_CONNECT_TIMEOUT_MS,
  closeAllPools,
  isPoolConnectTimeout,
  sessionLockPool,
  setupClaimPool,
} from '../src/store';

/**
 * What a full pool is answered with (ADR 0063 §2), with no database: pg-pool's
 * own error for a `connect()` that waited its whole `connectionTimeoutMillis`
 * stands in for the pool, because a real one takes the whole wait to say it.
 * A setup press that gets no connection to hold its claim on is told another
 * press is running; a token refresh that gets no lock connection is refused
 * by name, so a press can say QuickBooks could not be asked rather than fail
 * with pg's words. A connection that could not be opened at all is neither,
 * and is thrown as it came. Nothing here reaches a network.
 */

const CONFIG = { connectionString: 'postgres://nobody@127.0.0.1:1/never' };
const TENANT = { orgId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222' };
const CONNECTION_ID = '44444444-4444-4444-8444-444444444444';
const COMPANY = { provider: 'qbo', providerAccountId: '4620816365' };

/** pg-pool's words, exactly, when a pool stayed full for its whole wait. */
const fullFor = (): Error => new Error('timeout exceeded when trying to connect');
const refused = (): Error => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' });

/** Makes every pool's `connect()` fail with `error`, and records which pool was asked. */
function connectFails(error: () => Error): Pool[] {
  const asked: Pool[] = [];
  vi.spyOn(Pool.prototype, 'connect').mockImplementation(function (this: Pool) {
    asked.push(this);
    return Promise.reject(error());
  } as never);
  return asked;
}

/** A pool's own settings, as pg-pool keeps them. */
function settingsOf(pool: Pool): { readonly max?: number; readonly connectionTimeoutMillis?: number } {
  return (pool as unknown as { options: { max?: number; connectionTimeoutMillis?: number } }).options;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await closeAllPools();
});

describe('a pool that stayed full', () => {
  it('is told apart from a connection that could not be opened', () => {
    expect(isPoolConnectTimeout(fullFor())).toBe(true);
    expect(isPoolConnectTimeout(new Error('Connection terminated due to connection timeout'))).toBe(false);
    expect(isPoolConnectTimeout(refused())).toBe(false);
    expect(isPoolConnectTimeout('timeout exceeded when trying to connect')).toBe(false);
  });

  it('answers a setup press no_connection from its own pool, its work never run', async () => {
    const asked = connectFails(fullFor);
    let ran = false;
    await expect(
      new PostgresPostingStore(CONFIG, TENANT).withSetupClaim(CONNECTION_ID, async () => {
        ran = true;
        return 'pressed';
      }),
    ).resolves.toEqual({ held: false, reason: 'no_connection' });
    expect(ran).toBe(false);
    // The claim's pool, not the lock pool a press's own token refresh takes a
    // connection from: two connections, and a wait of its own.
    expect(asked).toEqual([setupClaimPool(CONFIG)]);
    expect(asked[0]).not.toBe(sessionLockPool(CONFIG));
    expect(settingsOf(setupClaimPool(CONFIG))).toMatchObject({
      max: 2,
      connectionTimeoutMillis: SETUP_CLAIM_CONNECT_TIMEOUT_MS,
    });
    expect(SETUP_CLAIM_CONNECT_TIMEOUT_MS).toBe(10_000);
  });

  it("refuses the company's lock by name when no lock connection was free, and never runs the work", async () => {
    const asked = connectFails(fullFor);
    let ran = false;
    const error = await withLedgerAccountLock(CONFIG, TENANT, COMPANY, async () => {
      ran = true;
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LockPoolTimeoutError);
    expect(error).not.toBeInstanceOf(LedgerAccountBusyError);
    expect((error as Error).name).toBe('LockPoolTimeoutError');
    // Ids and numbers: nothing pg said.
    expect((error as Error).message).not.toContain('timeout exceeded');
    expect((error as LockPoolTimeoutError).providerAccountId).toBe(COMPANY.providerAccountId);
    expect(ran).toBe(false);
    expect(asked).toEqual([sessionLockPool(CONFIG)]);
    expect(settingsOf(sessionLockPool(CONFIG)).connectionTimeoutMillis).toBe(LOCK_POOL_CONNECT_TIMEOUT_MS);
  });

  it('throws a connection that could not be opened as it came, to either', async () => {
    connectFails(refused);
    await expect(withLedgerAccountLock(CONFIG, TENANT, COMPANY, async () => undefined)).rejects.toMatchObject({
      code: 'ECONNREFUSED',
    });
    await expect(
      new PostgresPostingStore(CONFIG, TENANT).withSetupClaim(CONNECTION_ID, async () => 'pressed'),
    ).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });
});

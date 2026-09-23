import { sessionLockPool, type PostgresStoreConfig, type TenantContext } from './store';

/**
 * The advisory-lock seed for a ledger account's key (ADR 0039 §5).
 *
 * Seed 0 is taken by `withDocumentRead`'s document ids and by the two
 * hash-chain triggers' keys (migration 0004), seed 1 by `withInvoiceClaim`'s
 * `org:invoice` keys (ADR 0028). A different seed is a different hash of the
 * same text, so a company's key cannot collide with either — two unrelated
 * things waiting on one number would be a stall nobody could explain.
 */
export const LEDGER_ACCOUNT_LOCK_SEED = 2;

/**
 * How long a caller waits for the company's lock before giving up.
 *
 * Longer than any holder should take — a refresh or a revoke is one Intuit call
 * bounded at ten seconds, a connect is one transaction — and short enough that
 * a callback waiting behind a stuck holder still ends inside its own request
 * budget with a notice rather than being killed by the platform after the
 * authorization code was spent (ADR 0039 §5).
 */
export const LEDGER_ACCOUNT_LOCK_TIMEOUT_MS = 15_000;

/**
 * Somebody else held this company's lock for longer than
 * `LEDGER_ACCOUNT_LOCK_TIMEOUT_MS`. Nothing was changed: the caller's work never
 * ran. Ids only.
 */
export class LedgerAccountBusyError extends Error {
  constructor(
    readonly provider: string,
    readonly providerAccountId: string,
  ) {
    super(
      `${provider} company ${providerAccountId} is being changed by another request; ` +
        'nothing was changed here — try again in a minute',
    );
    this.name = 'LedgerAccountBusyError';
  }
}

/** Which books: a provider and the provider's key for the company (QBO's realm). */
export interface LedgerAccountKey {
  readonly provider: string;
  readonly providerAccountId: string;
}

/**
 * Runs `work` while this process holds the company's lock, across every process
 * that asks for it (ADR 0039 §5).
 *
 * Everything that changes a company's tokens takes it: a token refresh
 * (`PostgresQboTokenStore.withRefreshLock`), a connect, reconnect or move
 * (`connectQboCompany`), a disconnect (`disconnectLedger`) — and so the
 * operator commands that call those. Intuit replaces a refresh token on every
 * refresh, so two of those interleaving on one company can leave the stored
 * token one Intuit has already killed.
 *
 * - **Keyed by the company, not the connection**, because a connect has no
 *   connection yet, and one company has at most one enabled connection across
 *   the deployment (migration 0030) — so the two are the same lock whenever a
 *   connection exists, and only the company's exists before.
 * - **The waiting form.** What runs inside is short — a refresh round trip, a
 *   transaction, a revoke — and a caller that gave up would fail a connect or a
 *   sync for no reason.
 * - **Transaction-scoped**, for `withDocumentRead`'s reason: `DATABASE_URL` is
 *   the transaction pooler, and a session lock can be taken on one server
 *   connection and released on another. Commit, rollback or a dead backend all
 *   release this one.
 * - **On the lock pool.** This connection holds the lock and nothing else; the
 *   work runs on the working pool and commits there *before* the lock is
 *   released, so the next holder reads what this one wrote.
 *
 * The role and the claims are set as `withTenant` sets them, transaction-
 * locally, so this connection cannot carry them anywhere either. Never
 * nested: `work` must not ask for the same company's lock again, because the
 * second request would wait on a lock its own caller holds.
 *
 * @throws {LedgerAccountBusyError} the lock was not granted within
 *   `LEDGER_ACCOUNT_LOCK_TIMEOUT_MS`; `work` did not run.
 */
export async function withLedgerAccountLock<T>(
  config: PostgresStoreConfig,
  tenant: TenantContext,
  account: LedgerAccountKey,
  work: () => Promise<T>,
  /** How long to wait for the lock. Tests shorten it; nothing else should. */
  options: { readonly waitMs?: number } = {},
): Promise<T> {
  if (account.provider.trim() === '' || account.providerAccountId.trim() === '') {
    throw new Error('a ledger account lock needs a provider and an account id');
  }
  const client = await sessionLockPool(config).connect();
  // Set when anything below fails. A connection is then destroyed rather than
  // pooled, because its transaction may still be open or aborted, and the
  // next borrower of this pool — a document read, an invoice claim — would
  // inherit it and fail on its first statement.
  let failed: Error | undefined;
  try {
    await client.query('begin');
    await client.query(`set local role ${config.role ?? 'app_rw'}`);
    await client.query('select set_config($1, $2, true)', [
      'request.jwt.claims',
      JSON.stringify({ org_id: tenant.orgId, sub: tenant.userId }),
    ]);
    const waitMs = options.waitMs ?? LEDGER_ACCOUNT_LOCK_TIMEOUT_MS;
    if (!Number.isInteger(waitMs) || waitMs <= 0) {
      throw new Error(`a ledger account lock wait must be a positive whole number of ms, not ${waitMs}`);
    }
    await client.query(`set local lock_timeout = ${waitMs}`);
    try {
      await client.query('select pg_advisory_xact_lock(hashtextextended($1, $2))', [
        `${account.provider}:${account.providerAccountId}`,
        LEDGER_ACCOUNT_LOCK_SEED,
      ]);
    } catch (error) {
      // 55P03 lock_not_available: the wait above ran out.
      if ((error as { code?: unknown }).code === '55P03') {
        throw new LedgerAccountBusyError(account.provider, account.providerAccountId);
      }
      throw error;
    }
    const result = await work();
    // Nothing is written on this connection; the commit is what releases the
    // lock, once the work's own transactions have committed.
    await client.query('commit');
    return result;
  } catch (error) {
    failed = error instanceof Error ? error : new Error(String(error));
    // Released now rather than whenever the pooler notices the connection go.
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release(failed);
  }
}

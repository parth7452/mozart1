/**
 * Where a tenant's QuickBooks tokens live — as a port, not a table.
 *
 * Intuit's access tokens last an hour. Its refresh tokens last about 100 days
 * and are **replaced on every refresh**: the old one dies the moment the new one
 * is issued. A process that refreshes, uses the new access token and never
 * persisted the new refresh token has stranded the connection, and the repair is
 * going back to the customer for consent. That is why `save` exists and why the
 * adapter awaits it *before* the next API call (ADR 0026).
 *
 * This is a port because credentials do not go in an application table
 * (CLAUDE.md). A KMS-backed implementation is a later task; the only one that
 * ships here is in-memory and lives under `@recouple/qbo/testing`, out of reach
 * of any production path.
 */

export interface QboTokenStore {
  load(realmId: string): Promise<{ accessToken: string; refreshToken: string; accessExpiresAt: string; refreshExpiresAt: string } | undefined>;
  save(realmId: string, tokens: { accessToken: string; refreshToken: string; accessExpiresAt: string; refreshExpiresAt: string }): Promise<void>;
}

/**
 * The token set the store holds, named.
 *
 * Derived from the port rather than written out again, so the two cannot drift:
 * change the interface and this follows.
 */
export type QboTokens = NonNullable<Awaited<ReturnType<QboTokenStore['load']>>>;

/**
 * How close to expiry the access token has to be before we refresh rather than
 * use it. Proactive: waiting for a 401 means a customer-visible failure on a
 * read that would have worked a minute earlier.
 */
export const ACCESS_TOKEN_REFRESH_SKEW_MS = 5 * 60_000;

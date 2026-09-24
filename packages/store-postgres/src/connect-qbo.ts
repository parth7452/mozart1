/**
 * Connecting and disconnecting a customer's QuickBooks company (ADR 0039).
 *
 * The one path for both doors: the Settings → QuickBooks button and
 * `pnpm link:qbo` / `pnpm unlink:qbo` call these functions and nothing else, so
 * the rules below have one copy.
 *
 * **Connect** is seal → lock → one transaction:
 *
 *  1. the token set is sealed under `{orgId, realmId}` before the database is
 *     touched, so a KMS failure cannot leave a claimed connection with no
 *     tokens behind it;
 *  2. the company's lock is taken (`withLedgerAccountLock`), the same lock every
 *     token refresh takes, so a connect and a sync's refresh cannot interleave;
 *  3. in one transaction: the claim (§6), the sealed credential row and the
 *     audit row. Anything that fails rolls all three back, so a reconnect that
 *     fails leaves the connection that was working exactly as it was.
 *
 * **Disconnect** is lock → disable (committed, audited) → revoke at Intuit →
 * audit the revoke. The database is the truth of whether we sync, so it is
 * turned off first; a revoke that fails is reported and recorded and does not
 * undo that.
 *
 * **Release** is the sync's own disconnect, for a sign-in Intuit has refused
 * for good (ADR 0046): lock → one transaction that turns the connection off
 * only while the refused credential is still the latest, with its audit rows.
 * Nothing is revoked, because there is nothing live to revoke.
 *
 * Everything runs as `app_rw` with the tenant's claims set transaction-locally,
 * and the database refuses anyone who is not an owner (migration 0030). The
 * service role appears nowhere. Nothing here puts a token in a log, an error or
 * an audit payload: those carry ids, a closed-set outcome and a class name.
 */

import type { PoolClient } from 'pg';
import type { TokenCipher } from '@recouple/crypto';
import { assertQboId, type DeadGrant, type QboTokens } from '@recouple/qbo';
import {
  AccountConnectedElsewhereError,
  ONE_ENABLED_PER_ACCOUNT_INDEX,
  OwnerRequiredError,
  rowToConnection,
  type AccountingConnectionRow,
  type ConnectionDbRow,
} from './connections';
import {
  insertSealedCredential,
  PostgresQboTokenStore,
  sealTokenSet,
} from './credentials';
import { withLedgerAccountLock } from './ledger-lock';
import { sessionPool, type PostgresStoreConfig, type TenantContext } from './store';

/** Which door a connection came through, for the audit row. */
export type LedgerConnectVia = 'web_consent' | 'operator_command';

/**
 * What a claim did (ADR 0039 §6).
 *
 * - `connected`: this member had no row for the company, and nobody else here
 *   held it enabled — a new row.
 * - `reconnected`: this member already had a row, and it was re-enabled and
 *   given the new tokens. Its run history and credential chain carry on.
 * - `moved`: another member's row here held the company enabled, and it was
 *   disabled. The connection now acts as this member (ADR 0031 §3).
 */
export type LedgerClaimOutcome = 'connected' | 'reconnected' | 'moved';

export interface LedgerClaimPlan {
  readonly outcome: LedgerClaimOutcome;
  /** This member's own row, to re-enable, when there is one. */
  readonly reuse?: AccountingConnectionRow;
  /** Other members' enabled rows here, to disable. */
  readonly disable: readonly AccountingConnectionRow[];
}

/**
 * The claim rule, as a function of this org's rows for the company.
 *
 * Pure, so the dry run of `pnpm link:qbo` and the claim itself cannot disagree
 * about what a connect would do. At most one of `rows` is enabled (migration
 * 0030's index) and at most one belongs to `userId` (its per-member unique).
 */
export function planLedgerClaim(
  rows: readonly AccountingConnectionRow[],
  userId: string,
): LedgerClaimPlan {
  const reuse = rows.find((row) => row.createdBy === userId);
  const disable = rows.filter((row) => row.enabled && row.createdBy !== userId);
  const outcome: LedgerClaimOutcome =
    disable.length > 0 ? 'moved' : reuse !== undefined ? 'reconnected' : 'connected';
  return { outcome, ...(reuse !== undefined ? { reuse } : {}), disable };
}

export interface ConnectedLedger {
  readonly connection: AccountingConnectionRow;
  readonly outcome: LedgerClaimOutcome;
  /** The connections this claim disabled — another member's, in this org. */
  readonly replacedConnectionIds: readonly string[];
  /** The credential row this connect stored. Its id, never its contents. */
  readonly credentialId: string;
}

/**
 * Connects a QuickBooks company to this tenant as this member, with this token
 * set: seal, lock, then claim + credential + audit in one transaction.
 *
 * `tokens` are what Intuit issued for this company *now* — from a consent in
 * the request (the callback has already proved they read `realmId`) or from an
 * operator's `.env`. They are sealed first and never leave this function in
 * the clear.
 *
 * Refusals, each before anything is committed:
 *
 * - `OwnerRequiredError` — the caller is not an owner here (the policies would
 *   refuse too, but by name is what a route can act on);
 * - `AccountConnectedElsewhereError` — another workspace holds the company
 *   enabled. Only after confirming no row here does, so it cannot misreport a
 *   conflict inside this org;
 * - a KMS or cipher failure — before the lock, so nothing was claimed.
 */
export async function connectQboCompany(
  config: PostgresStoreConfig,
  tenant: TenantContext,
  input: {
    readonly realmId: string;
    readonly tokens: QboTokens;
    readonly cipher: TokenCipher;
    readonly via: LedgerConnectVia;
    /** Which Intuit environment issued the tokens, recorded on the audit row. */
    readonly environment?: 'sandbox' | 'production';
  },
): Promise<ConnectedLedger> {
  const realmId = assertQboId(input.realmId);

  // 1. Seal before the database is touched (ADR 0039 §4).
  const credential = await sealTokenSet(
    input.cipher,
    { orgId: tenant.orgId, realmId },
    input.tokens,
    `QuickBooks company ${realmId}`,
  );

  // 2. The company's lock, then 3. one transaction.
  return withLedgerAccountLock(config, tenant, { provider: 'qbo', providerAccountId: realmId }, () =>
    inTenant(config, tenant, async (client) => {
      await assertOwner(client, tenant);

      const { rows: existing } = await client.query<ConnectionDbRow>(
        `select id, org_id, provider, provider_account_id, enabled, created_by
           from accounting_connections
          where provider = 'qbo' and provider_account_id = $1
          order by enabled desc, updated_at desc, id`,
        [realmId],
      );
      const plan = planLedgerClaim(existing.map(rowToConnection), tenant.userId);

      if (plan.disable.length > 0) {
        await client.query(
          `update accounting_connections set enabled = false where id = any($1::uuid[])`,
          [plan.disable.map((row) => row.connectionId)],
        );
      }

      const claimed = await claimRow(client, tenant, realmId, plan);

      const credentialId = await insertSealedCredential(client, {
        orgId: tenant.orgId,
        connectionId: claimed.connectionId,
        createdBy: tenant.userId,
        credential,
      });

      await audit(client, tenant, `accounting_connection.${plan.outcome}`, claimed.connectionId, {
        provider: 'qbo',
        provider_account_id: realmId,
        via: input.via,
        credential_id: credentialId,
        ...(input.environment !== undefined ? { environment: input.environment } : {}),
        ...(plan.disable.length > 0
          ? { replaced_connection_ids: plan.disable.map((row) => row.connectionId) }
          : {}),
      });

      return {
        connection: claimed,
        outcome: plan.outcome,
        replacedConnectionIds: plan.disable.map((row) => row.connectionId),
        credentialId,
      };
    }),
  );
}

/**
 * Re-enables this member's row, or inserts one — the step another workspace's
 * claim can refuse.
 *
 * Under a savepoint, so a unique violation can be looked at before it is
 * reported: it is mapped to `AccountConnectedElsewhereError` only when no row
 * in this org holds the company enabled, which is what makes the mapping
 * something the code checked rather than assumed. Any other failure is the
 * original error. Either way the caller's transaction rolls back whole.
 */
async function claimRow(
  client: PoolClient,
  tenant: TenantContext,
  realmId: string,
  plan: LedgerClaimPlan,
): Promise<AccountingConnectionRow> {
  await client.query('savepoint ledger_claim');
  try {
    const { rows } =
      plan.reuse !== undefined
        ? await client.query<ConnectionDbRow>(
            `update accounting_connections set enabled = true
              where id = $1
              returning id, org_id, provider, provider_account_id, enabled, created_by`,
            [plan.reuse.connectionId],
          )
        : await client.query<ConnectionDbRow>(
            `insert into accounting_connections (org_id, provider, provider_account_id, created_by)
             values ($1, 'qbo', $2, $3)
             returning id, org_id, provider, provider_account_id, enabled, created_by`,
            [tenant.orgId, realmId, tenant.userId],
          );
    const row = rows[0];
    if (row === undefined) {
      // RLS hid the row this plan was built from, between two statements of
      // one transaction under the company's lock. Not a state to guess about.
      throw new Error(`claiming QuickBooks company ${realmId} wrote no row`);
    }
    await client.query('release savepoint ledger_claim');
    return rowToConnection(row);
  } catch (error) {
    await client.query('rollback to savepoint ledger_claim');
    if (isUniqueViolationOn(error, ONE_ENABLED_PER_ACCOUNT_INDEX)) {
      const { rows } = await client.query<{ n: number }>(
        `select count(*)::int as n from accounting_connections
          where provider = 'qbo' and provider_account_id = $1 and enabled`,
        [realmId],
      );
      if ((rows[0]?.n ?? 0) === 0) throw new AccountConnectedElsewhereError('qbo', realmId);
    }
    throw error;
  }
}

/** How a revoke at Intuit ended (ADR 0039 §9). */
export type LedgerRevokeResult = 'confirmed' | 'failed' | 'not_attempted';

export interface DisconnectedLedger {
  readonly connection: AccountingConnectionRow;
  /** `false` when it was already disabled: nothing changed and nothing was revoked. */
  readonly disabled: boolean;
  readonly revoke: LedgerRevokeResult;
  /** The class name of a failed revoke, never its message. */
  readonly revokeErrorClass?: string;
  /**
   * Set when the revoke's own audit row could not be written — the class name
   * only. The disable is committed and audited by then, and the revoke has
   * happened or not at Intuit, so this is reported to the caller to log loudly
   * rather than thrown: a throw would tell the owner nothing changed when the
   * connection is off.
   */
  readonly revokeAuditErrorClass?: string;
}

/**
 * Turns a connection off, then ends our access at Intuit, and records both.
 *
 * `undefined` when this tenant cannot see the connection at all — RLS, not a
 * filter, and one answer for a stale id and another tenant's.
 *
 * `revoke` is how this deployment reaches Intuit: the cipher that opens the
 * latest token set and the call that revokes a refresh token. Absent — a
 * deployment with no Intuit app or no KMS key — the connection is still turned
 * off and the revoke is recorded as `not_attempted`, which is the truth.
 *
 * Revoking happens here and only here: never on a reconnect, a move or a
 * refused claim, because whether Intuit's revoke ends one grant or the app's
 * access to the company as a whole is not verified, and the whole-company
 * answer would kill the connection that was just made (ADR 0039 §9).
 */
export async function disconnectLedger(
  config: PostgresStoreConfig,
  tenant: TenantContext,
  input: {
    readonly connectionId: string;
    readonly via: LedgerConnectVia;
    readonly revoke?: {
      readonly cipher: TokenCipher;
      readonly revokeToken: (refreshToken: string) => Promise<void>;
    };
  },
): Promise<DisconnectedLedger | undefined> {
  const found = await inTenant(config, tenant, async (client) => {
    const { rows } = await client.query<ConnectionDbRow>(
      `select id, org_id, provider, provider_account_id, enabled, created_by
         from accounting_connections where id = $1`,
      [input.connectionId],
    );
    return rows[0] === undefined ? undefined : rowToConnection(rows[0]);
  });
  if (found === undefined) return undefined;

  return withLedgerAccountLock(
    config,
    tenant,
    { provider: found.provider, providerAccountId: found.providerAccountId },
    async () => {
      // Off first, and committed: from here on nothing syncs this company for
      // this tenant, whatever Intuit says next.
      const turnedOff = await inTenant(config, tenant, async (client) => {
        await assertOwner(client, tenant);
        const { rows } = await client.query<ConnectionDbRow>(
          `update accounting_connections set enabled = false
            where id = $1 and enabled
            returning id, org_id, provider, provider_account_id, enabled, created_by`,
          [found.connectionId],
        );
        const row = rows[0];
        if (row === undefined) return undefined;
        await audit(client, tenant, 'accounting_connection.disconnected', row.id, {
          provider: row.provider,
          provider_account_id: row.provider_account_id,
          via: input.via,
        });
        return rowToConnection(row);
      });

      if (turnedOff === undefined) {
        // Already off. Nothing changed, so nothing is revoked and nothing is
        // recorded: a second press is not a second disconnect.
        return { connection: found, disabled: false, revoke: 'not_attempted' as const };
      }

      let revoke: LedgerRevokeResult = 'not_attempted';
      let revokeErrorClass: string | undefined;
      if (input.revoke !== undefined) {
        try {
          const tokens = await new PostgresQboTokenStore(
            config,
            tenant,
            { connectionId: turnedOff.connectionId, realmId: turnedOff.providerAccountId },
            input.revoke.cipher,
          ).load(turnedOff.providerAccountId);
          if (tokens !== undefined) {
            await input.revoke.revokeToken(tokens.refreshToken);
            revoke = 'confirmed';
          }
        } catch (error) {
          // Reported and recorded, never swallowed: the class name goes on the
          // audit row and back to the caller, which tells the owner to remove
          // the app inside QuickBooks too. The message stays out of both — an
          // error from this path can be about a credential.
          revoke = 'failed';
          revokeErrorClass = error instanceof Error ? error.name : typeof error;
        }
      }

      // The disable is committed and Intuit has answered, so a failure here
      // cannot change either; it is returned for the caller to log, not thrown
      // (see `revokeAuditErrorClass`).
      let revokeAuditErrorClass: string | undefined;
      try {
        await inTenant(config, tenant, async (client) => {
          await audit(client, tenant, 'accounting_connection.revoke', turnedOff.connectionId, {
            provider: turnedOff.provider,
            provider_account_id: turnedOff.providerAccountId,
            via: input.via,
            result: revoke,
            ...(revokeErrorClass !== undefined ? { error_class: revokeErrorClass } : {}),
          });
        });
      } catch (error) {
        // node-postgres names every database error `error`, so the SQLSTATE
        // goes with it: `42501` (the member lost write in the meantime) and a
        // dropped connection send an operator to different places.
        const code = (error as { code?: unknown }).code;
        revokeAuditErrorClass =
          (error instanceof Error ? error.name : typeof error) +
          (typeof code === 'string' ? ` ${code}` : '');
      }

      return {
        connection: turnedOff,
        disabled: true,
        revoke,
        ...(revokeErrorClass !== undefined ? { revokeErrorClass } : {}),
        ...(revokeAuditErrorClass !== undefined ? { revokeAuditErrorClass } : {}),
      };
    },
  );
}

/** What a release answered (ADR 0046 §2). */
export type LedgerReleaseOutcome =
  /** Turned off, and audited as the sync's disconnect. */
  | 'released'
  /** A sign-in was stored after the refused one — a reconnect — so it was left on. */
  | 'newer_sign_in'
  /** It was off already; nothing was written. */
  | 'already_off';

/**
 * Turns off a connection whose stored sign-in Intuit refused for good, so the
 * company is no longer held from every other workspace (ADR 0046).
 *
 * Under the company's lock and in one transaction, as the member the run acts
 * as:
 *
 * - the latest credential must still be `credentialId`, the one the refused
 *   refresh presented. A newer row means somebody signed in since — a
 *   reconnect stores one under this same lock — and turning the connection off
 *   would undo a connect that works, so nothing is written;
 * - the connection is turned off only if it is still on;
 * - `accounting_connection.disconnected` and `accounting_connection.revoke`
 *   (`not_attempted`) are written with `via: 'ledger_sync'`, so this
 *   disconnect has its revoke row like every other, saying truthfully that
 *   none was sent.
 *
 * The database is still the referee of who may do it: the UPDATE is an
 * owner's (migration 0030), and `OwnerRequiredError` is raised before it for a
 * member who is no longer one. `undefined` when this tenant cannot see the
 * connection at all.
 */
export async function releaseDeadLedger(
  config: PostgresStoreConfig,
  tenant: TenantContext,
  input: {
    readonly connectionId: string;
    /** The stored token set the refused refresh presented (`loadedCredential`). */
    readonly credentialId: string;
    readonly reason: DeadGrant;
  },
): Promise<LedgerReleaseOutcome | undefined> {
  const found = await inTenant(config, tenant, async (client) => {
    const { rows } = await client.query<ConnectionDbRow>(
      `select id, org_id, provider, provider_account_id, enabled, created_by
         from accounting_connections where id = $1`,
      [input.connectionId],
    );
    return rows[0] === undefined ? undefined : rowToConnection(rows[0]);
  });
  if (found === undefined) return undefined;

  return withLedgerAccountLock(
    config,
    tenant,
    { provider: found.provider, providerAccountId: found.providerAccountId },
    () =>
      inTenant(config, tenant, async (client): Promise<LedgerReleaseOutcome> => {
        await assertOwner(client, tenant);

        const { rows: latest } = await client.query<{ id: string }>(
          `select id from accounting_credentials
            where connection_id = $1
            order by seq desc
            limit 1`,
          [found.connectionId],
        );
        if (latest[0]?.id !== input.credentialId) return 'newer_sign_in';

        const { rows } = await client.query<ConnectionDbRow>(
          `update accounting_connections set enabled = false
            where id = $1 and enabled
            returning id, org_id, provider, provider_account_id, enabled, created_by`,
          [found.connectionId],
        );
        const row = rows[0];
        if (row === undefined) return 'already_off';

        await audit(client, tenant, 'accounting_connection.disconnected', row.id, {
          provider: row.provider,
          provider_account_id: row.provider_account_id,
          via: 'ledger_sync',
          reason: input.reason,
          credential_id: input.credentialId,
        });
        await audit(client, tenant, 'accounting_connection.revoke', row.id, {
          provider: row.provider,
          provider_account_id: row.provider_account_id,
          via: 'ledger_sync',
          result: 'not_attempted' satisfies LedgerRevokeResult,
        });
        return 'released';
      }),
  );
}

/** Refuses a caller who is not an owner, by name, before the first write. */
async function assertOwner(client: PoolClient, tenant: TenantContext): Promise<void> {
  const { rows } = await client.query<{ owner: boolean }>('select app.member_is_owner() as owner');
  if (rows[0]?.owner !== true) throw new OwnerRequiredError(tenant.orgId, tenant.userId);
}

/**
 * One `audit_log` row, as the acting member (migration 0030 refuses any other).
 * Ids and closed-set words only; the chain hash is the trigger's (0004).
 */
async function audit(
  client: PoolClient,
  tenant: TenantContext,
  action: string,
  connectionId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `insert into audit_log (org_id, actor_id, action, subject_table, subject_id, payload)
     values ($1, $2, $3, 'accounting_connections', $4, $5::jsonb)`,
    [tenant.orgId, tenant.userId, action, connectionId, JSON.stringify(payload)],
  );
}

/**
 * As `PostgresStore.withTenant`: role and claims transaction-local. Repeated
 * here rather than reached into, as `connections.ts` and `credentials.ts`
 * repeat it.
 */
async function inTenant<T>(
  config: PostgresStoreConfig,
  tenant: TenantContext,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await sessionPool(config).connect();
  try {
    await client.query('begin');
    await client.query(`set local role ${config.role ?? 'app_rw'}`);
    await client.query('select set_config($1, $2, true)', [
      'request.jwt.claims',
      JSON.stringify({ org_id: tenant.orgId, sub: tenant.userId }),
    ]);
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function isUniqueViolationOn(error: unknown, constraint: string): boolean {
  if (error === null || typeof error !== 'object') return false;
  const { code, constraint: name } = error as { code?: unknown; constraint?: unknown };
  return code === '23505' && name === constraint;
}

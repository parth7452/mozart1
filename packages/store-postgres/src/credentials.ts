/**
 * `PostgresQboTokenStore` — the `QboTokenStore` ADR 0026 left as a port, on
 * Postgres, sealed (ADR 0033, migration 0025).
 *
 * The rule the whole file serves: **what is written to `accounting_credentials`
 * is ciphertext.** The plaintext exists in this process between a `TokenCipher`
 * call and a `QboClient` header, and nowhere else — not in a column, not in a
 * log line, not in an error message, and not in an event payload.
 *
 * As everywhere else here, it runs as `app_rw` with the tenant's claims set
 * transaction-locally (`withTenant`, the shape `workflow.ts`, `discovery.ts`
 * and `connections.ts` all repeat rather than reach into). The service role
 * appears nowhere, and the KMS credentials that can open a row are held by the
 * application, never by the database.
 *
 * **One store, one connection.** The port's `load(realmId)` / `save(realmId, …)`
 * signature invites a realm-keyed map, and that is the wrong reading here: a
 * store that resolved a realm to a connection at call time could be asked for a
 * realm it was not built for, and the answer would come from a lookup rather
 * than from the claims the transaction is running under. So the realm is fixed
 * at construction — from the connection row the job already read through RLS —
 * and a call naming a different one is `QboRealmMismatchError` (ADR 0033 §5).
 */

import type { Pool, PoolClient } from 'pg';
import type { QboTokenStore, QboTokens } from '@recouple/qbo';
import type { SealedToken, TokenCipher } from '@recouple/crypto';
import { sessionPool, type PostgresStoreConfig, type TenantContext } from './store';
import { withLedgerAccountLock } from './ledger-lock';

/** Which connection this store is for, and which company that connection names. */
export interface QboCredentialScope {
  readonly connectionId: string;
  /** `accounting_connections.provider_account_id` — QBO's `realmId`. */
  readonly realmId: string;
}

/**
 * The port was asked about a company this store is not for.
 *
 * Named rather than a bare `Error` because the two ways it can happen want
 * different fixes: a caller that built the store from one connection and the
 * adapter from another, or a connection whose `provider_account_id` changed —
 * which migration 0024 refuses, so in practice it is the first. Neither realm
 * is a credential (migration 0024 says so of `provider_account_id` in as many
 * words), so both are named: a mismatch nobody can see is a mismatch nobody
 * fixes.
 */
export class QboRealmMismatchError extends Error {
  constructor(
    readonly connectionId: string,
    readonly expectedRealmId: string,
    readonly askedRealmId: string,
  ) {
    super(
      `connection ${connectionId} is for QuickBooks company ${expectedRealmId}, ` +
        `not ${askedRealmId}`,
    );
    this.name = 'QboRealmMismatchError';
  }
}

/**
 * A row came back and did not open, or opened into something that is not a
 * token set.
 *
 * **Ids only.** The credential id, the connection, the cipher and the key —
 * never the ciphertext, never the wrapped key, and never what the plaintext
 * would have been. `TokenDecryptionError` already refuses to carry bytes; this
 * refuses to carry them a second time on the way out.
 *
 * It is thrown rather than answered with `undefined`, and that distinction is
 * the point: `undefined` means "this connection was never authorised" and
 * `QboClient` turns it into "the connection has not been authorised". A row
 * that exists and will not open is a different fact — a key revoked, a region
 * misconfigured, a row from another deployment — and reporting it as the first
 * would send somebody to ask the customer for consent they have already given.
 */
export class CredentialUnreadableError extends Error {
  constructor(
    readonly connectionId: string,
    readonly credentialId: string,
    readonly cipher: string,
    readonly keyId: string,
    readonly reason: string,
  ) {
    super(
      `the stored QuickBooks credential ${credentialId} for connection ${connectionId} ` +
        `could not be read (cipher ${cipher}, key ${keyId}, ${reason})`,
    );
    this.name = 'CredentialUnreadableError';
  }
}

/**
 * A token set arrived with an expiry that is not a date.
 *
 * Loud rather than stored as null or as now(): `refresh_expires_at` is how an
 * operator sees which connections are about to strand, and a wrong value there
 * is worse than a failed save — a failed save is visible immediately and the
 * previous row is still good.
 */
export class CredentialExpiryUnreadableError extends Error {
  constructor(
    /** What the token set is for: a connection, or — before one exists — a company. */
    readonly subject: string,
    readonly field: string,
    readonly value: string,
  ) {
    super(`${subject} was given a ${field} that is not a date: ${JSON.stringify(value)}`);
    this.name = 'CredentialExpiryUnreadableError';
  }
}

/**
 * A token set, sealed, with the two expiries that are stored beside it in the
 * clear — everything an `accounting_credentials` row needs except which
 * connection it hangs off.
 *
 * Separate from the insert on purpose (ADR 0039 §4): the encryption context is
 * `{orgId, realmId}`, both known before any connection row exists, so a connect
 * seals first and then does every write in one transaction. A KMS failure
 * therefore happens before the database is touched, and cannot leave a claimed
 * connection with no tokens behind it.
 */
export interface SealedCredential {
  readonly sealed: SealedToken;
  readonly accessExpiresAt: string | null;
  readonly refreshExpiresAt: string;
}

/** What every sealed token set is bound to (ADR 0033 §3). */
export interface CredentialContext {
  readonly orgId: string;
  readonly realmId: string;
}

/**
 * Seals a token set for one company of one tenant.
 *
 * The expiries are checked first, loudly, and the plaintext exists only as the
 * argument to `encrypt`. `subject` names what it is for in an error — never a
 * token.
 */
export async function sealTokenSet(
  cipher: TokenCipher,
  context: CredentialContext,
  tokens: QboTokens,
  subject: string,
): Promise<SealedCredential> {
  const refreshExpiresAt = isoInstant(tokens.refreshExpiresAt);
  if (refreshExpiresAt === null) {
    throw new CredentialExpiryUnreadableError(subject, 'refreshExpiresAt', tokens.refreshExpiresAt);
  }
  // A missing access token is legitimate — `link:qbo` stores a refresh token
  // alone and the first read refreshes — and so is an unreadable expiry on one,
  // which the adapter already treats as expired. Stored as null either way.
  const accessExpiresAt =
    tokens.accessToken.trim() === ''
      ? null
      : isoInstant(tokens.accessExpiresAt);

  const sealed = await cipher.encrypt(JSON.stringify(tokens), {
    orgId: context.orgId,
    realmId: context.realmId,
  });
  return { sealed, accessExpiresAt, refreshExpiresAt };
}

/**
 * Writes one sealed row, on a client the caller's transaction owns.
 *
 * The one copy of this INSERT. A rotation (`PostgresQboTokenStore.save`) and a
 * connect (`connectQboCompany`) both call it, so the column list cannot drift
 * between the two ways a row is written. `created_by` is the caller's own
 * member, and since migration 0030 the database refuses any other.
 */
export async function insertSealedCredential(
  client: PoolClient,
  row: {
    readonly orgId: string;
    readonly connectionId: string;
    readonly createdBy: string;
    readonly credential: SealedCredential;
  },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into accounting_credentials
       (org_id, connection_id, cipher, key_id, wrapped_key, ciphertext,
        access_expires_at, refresh_expires_at, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     returning id`,
    [
      row.orgId,
      row.connectionId,
      row.credential.sealed.cipher,
      row.credential.sealed.keyId,
      row.credential.sealed.wrappedKey,
      row.credential.sealed.ciphertext,
      row.credential.accessExpiresAt,
      row.credential.refreshExpiresAt,
      row.createdBy,
    ],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('inserting a sealed credential returned no row');
  return id;
}

/** An ISO instant for a column, or null when the value is not a date. */
function isoInstant(value: string): string | null {
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : new Date(at).toISOString();
}

export class PostgresQboTokenStore implements QboTokenStore {
  private readonly pool: Pool;
  private readonly role: string;

  constructor(
    private readonly config: PostgresStoreConfig,
    private readonly tenant: TenantContext,
    private readonly scope: QboCredentialScope,
    private readonly cipher: TokenCipher,
  ) {
    this.pool = sessionPool(config);
    this.role = config.role ?? 'app_rw';
    if (scope.connectionId.trim() === '' || scope.realmId.trim() === '') {
      throw new Error('a QuickBooks token store needs a connection id and a realm id');
    }
  }

  /**
   * The latest row for this connection, opened.
   *
   * `undefined` when there is none, which is what `QboClient` turns into
   * `QboAuthError` rather than into an empty ledger (ADR 0026).
   */
  async load(realmId: string): Promise<QboTokens | undefined> {
    this.assertRealm(realmId);

    const row = await this.withTenant(async (client) => {
      const { rows } = await client.query<{
        id: string;
        cipher: string;
        key_id: string;
        wrapped_key: string;
        ciphertext: string;
      }>(
        `select id, cipher, key_id, wrapped_key, ciphertext
           from accounting_credentials
          where connection_id = $1
          order by seq desc
          limit 1`,
        [this.scope.connectionId],
      );
      return rows[0];
    });

    if (row === undefined) return undefined;

    const sealed: SealedToken = {
      cipher: row.cipher,
      keyId: row.key_id,
      wrappedKey: row.wrapped_key,
      ciphertext: row.ciphertext,
    };

    let plaintext: string;
    try {
      plaintext = await this.cipher.decrypt(sealed, this.context());
    } catch (error) {
      // The class name, and nothing off the row. `TokenDecryptionError`'s own
      // message already carries only the cipher and the key.
      throw new CredentialUnreadableError(
        this.scope.connectionId,
        row.id,
        row.cipher,
        row.key_id,
        error instanceof Error ? error.name : typeof error,
      );
    }

    return this.parse(plaintext, row.id, row.cipher, row.key_id);
  }

  /**
   * Seal and insert. A rotation is a new row; nothing is ever updated.
   *
   * This is the call ADR 0026 requires to have *landed* before the rotated
   * access token is used, because Intuit kills the old refresh token the
   * instant it issues a new one. The insert is what makes it durable: the
   * previous row is still there and still openable until this one commits, so
   * the failure mode of a crash here is a retry, not a stranded customer.
   */
  async save(realmId: string, tokens: QboTokens): Promise<void> {
    this.assertRealm(realmId);

    const credential = await sealTokenSet(
      this.cipher,
      this.context(),
      tokens,
      `connection ${this.scope.connectionId}`,
    );

    await this.withTenant(async (client) => {
      await insertSealedCredential(client, {
        orgId: this.tenant.orgId,
        connectionId: this.scope.connectionId,
        createdBy: this.tenant.userId,
        credential,
      });
    });
  }

  /**
   * Runs `work` holding this company's lock (ADR 0039 §5): the adapter's load →
   * refresh → save happens inside it, and so does every connect and disconnect
   * of the same company, so no two of them interleave.
   *
   * The realm is checked like `load`'s and `save`'s: a store asked to lock a
   * company it was not built for is the same mistake as one asked to read one.
   */
  async withRefreshLock<T>(realmId: string, work: () => Promise<T>): Promise<T> {
    this.assertRealm(realmId);
    return withLedgerAccountLock(
      this.config,
      this.tenant,
      { provider: 'qbo', providerAccountId: this.scope.realmId },
      work,
    );
  }

  /**
   * As `PostgresStore.withTenant`: the role and the claims are transaction-local,
   * so a pooled connection cannot carry one tenant's claims into another's
   * query. Repeated here rather than reached into, exactly as `discovery.ts`
   * and `connections.ts` repeat it — a private method on another class is not
   * an API.
   */
  private async withTenant<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`set local role ${this.role}`);
      await client.query('select set_config($1, $2, true)', [
        'request.jwt.claims',
        JSON.stringify({ org_id: this.tenant.orgId, sub: this.tenant.userId }),
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

  /** What every ciphertext here is bound to (ADR 0033 §3). */
  private context(): { readonly orgId: string; readonly realmId: string } {
    return { orgId: this.tenant.orgId, realmId: this.scope.realmId };
  }

  private assertRealm(realmId: string): void {
    if (realmId !== this.scope.realmId) {
      throw new QboRealmMismatchError(this.scope.connectionId, this.scope.realmId, realmId);
    }
  }

  /**
   * The payload, checked to be a token set.
   *
   * A row that opened into something else is as unusable as one that did not
   * open, and it is reported the same way — a shape, never a value, because the
   * thing whose shape is wrong is a credential.
   */
  private parse(
    plaintext: string,
    credentialId: string,
    cipher: string,
    keyId: string,
  ): QboTokens {
    const unreadable = (reason: string): never => {
      throw new CredentialUnreadableError(
        this.scope.connectionId,
        credentialId,
        cipher,
        keyId,
        reason,
      );
    };

    let parsed: unknown;
    try {
      parsed = JSON.parse(plaintext);
    } catch {
      return unreadable('the sealed payload is not JSON');
    }
    if (parsed === null || typeof parsed !== 'object') {
      return unreadable('the sealed payload is not an object');
    }

    const raw = parsed as Record<string, unknown>;
    const fields = ['accessToken', 'refreshToken', 'accessExpiresAt', 'refreshExpiresAt'] as const;
    for (const field of fields) {
      if (typeof raw[field] !== 'string') {
        return unreadable(`the sealed payload has no ${field}`);
      }
    }

    return {
      accessToken: raw.accessToken as string,
      refreshToken: raw.refreshToken as string,
      accessExpiresAt: raw.accessExpiresAt as string,
      refreshExpiresAt: raw.refreshExpiresAt as string,
    };
  }
}

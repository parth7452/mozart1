/**
 * Email-in's database half (ADR 0047).
 *
 * Two shapes, for the two kinds of caller:
 *
 *  - `inboundAddressFor(token)` is untenanted. The webhook has no session, and
 *    this is the query that decides which tenant it acts for, so it runs with
 *    the claims cleared — `listConnectionsToSync`'s shape — and the database
 *    refuses it to anyone carrying one (§5).
 *  - `PostgresInboundStore` acts as one member of one tenant: the member an
 *    address acts as, for a delivery; an owner, for issuing, adopting and
 *    retiring. Every message row goes through `app.record_inbound_message()`,
 *    because app_rw holds SELECT only on the message tables (§9).
 *
 * The service role appears nowhere (invariant 6).
 */

import type { Pool, PoolClient } from 'pg';
import type {
  InboundAddressResolution,
  InboundClaim,
  InboundMessageRecord,
  InboundMessageStore,
  InboundPartRecord,
  InboundProvider,
  RecordedInboundPart,
} from '@recouple/pipeline';
import {
  inboundClaimPool,
  sessionPool,
  type PostgresStoreConfig,
  type TenantContext,
} from './store';

/** 32 lowercase hex characters: the only shape a token has (§3). */
export const INBOUND_TOKEN = /^[0-9a-f]{32}$/;

/**
 * The database refused to record an email: the caller is not the member the
 * address acts as, the address is retired, a stored part did not arrive by
 * email. Carries the class and the ids, never a filename or anything the
 * email said (§13).
 */
export class InboundRecordRefusedError extends Error {
  override readonly name = 'InboundRecordRefusedError';
  constructor(
    readonly orgId: string,
    readonly addressId: string,
    readonly sqlState: string,
  ) {
    super(`recording an inbound email for org ${orgId} at address ${addressId} was refused (${sqlState})`);
  }
}

/** An owner-only address action refused by the database's policies. */
export class InboundAddressRefusedError extends Error {
  override readonly name = 'InboundAddressRefusedError';
  constructor(
    readonly orgId: string,
    readonly action: 'issue' | 'adopt' | 'retire',
    readonly sqlState: string,
  ) {
    super(`${action} of an inbound address in org ${orgId} was refused (${sqlState})`);
  }
}

function sqlState(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** SQLSTATEs the policies, guards and constraints answer a refusal with. */
const REFUSALS = new Set(['42501', '23514', '23503', '23505', '22023']);

/**
 * The tenant a token belongs to, and the member a delivery to it acts as.
 * Undefined for an unknown token, and for anything that is not a token.
 */
export async function inboundAddressFor(
  config: PostgresStoreConfig,
  token: string,
): Promise<InboundAddressResolution | undefined> {
  if (!INBOUND_TOKEN.test(token)) return undefined;
  const pool: Pool = sessionPool(config);
  const role = config.role ?? 'app_rw';
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local role ${role}`);
    // Cleared rather than assumed: a pooled connection's session could carry
    // a claim, and the function refuses any caller that does.
    await client.query(`select set_config('request.jwt.claims', '', true)`);
    const { rows } = await client.query<{
      address_id: string;
      org_id: string;
      acting_member: string;
      retired: boolean;
    }>('select address_id, org_id, acting_member, retired from app.inbound_address_for($1)', [
      token,
    ]);
    await client.query('commit');
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      addressId: row.address_id,
      orgId: row.org_id,
      actingMember: row.acting_member,
      retired: row.retired,
    };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** One of a tenant's addresses, as Settings → Email shows it (§4). */
export interface InboundAddressRow {
  readonly addressId: string;
  readonly token: string;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly actingMember: string;
  readonly retiredAt?: Date;
  readonly retiredBy?: string;
  readonly lastReceivedAt?: Date;
  /** Emails refused at this address since it was retired. */
  readonly refusedSinceRetired: number;
  readonly lastRefusedAt?: Date;
}

export class PostgresInboundStore implements InboundMessageStore {
  private readonly pool: Pool;
  private readonly claims: Pool;
  private readonly role: string;

  constructor(
    config: PostgresStoreConfig,
    private readonly tenant: TenantContext,
  ) {
    this.pool = sessionPool(config);
    this.claims = inboundClaimPool(config);
    this.role = config.role ?? 'app_rw';
  }

  private async begin(client: PoolClient): Promise<void> {
    await client.query('begin');
    await client.query(`set local role ${this.role}`);
    await client.query('select set_config($1, $2, true)', [
      'request.jwt.claims',
      JSON.stringify({ org_id: this.tenant.orgId, sub: this.tenant.userId }),
    ]);
  }

  private async withTenant<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await this.begin(client);
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

  /**
   * Holds this message's claim while `work` runs, so two deliveries of one
   * email never ingest it at once (§10). Seed 3: next to `withDocumentRead`'s
   * 0, the remittance claim's 1 and the refresh lock's 2. On its own pool of
   * two, with a one-second wait: a delivery that gets neither a connection nor
   * the claim spends nothing, and Postmark comes back.
   */
  async withMessageClaim<T>(
    provider: InboundProvider,
    providerMessageId: string,
    work: () => Promise<T>,
  ): Promise<InboundClaim<T>> {
    let client: PoolClient;
    try {
      client = await this.claims.connect();
    } catch {
      // pg's connection timeout: the pool is full. Nothing was spent.
      return { claimed: false, reason: 'no_connection' };
    }
    let failed: Error | undefined;
    try {
      await this.begin(client);
      const { rows } = await client.query<{ held: boolean | null }>(
        'select pg_try_advisory_xact_lock(hashtextextended($1, 3)) as held',
        [`${this.tenant.orgId}:${provider}:${providerMessageId}`],
      );
      if (rows[0]?.held !== true) {
        await client.query('rollback');
        return { claimed: false, reason: 'held' };
      }
      const result = await work();
      await client.query('commit');
      return { claimed: true, result };
    } catch (error) {
      failed = error instanceof Error ? error : new Error(String(error));
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      // Destroyed after a failure rather than pooled, as withDocumentRead does:
      // an aborted transaction would fail the next delivery to borrow it.
      client.release(failed);
    }
  }

  async receivedMessage(
    provider: InboundProvider,
    providerMessageId: string,
  ): Promise<string | undefined> {
    return this.withTenant(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `select id from inbound_messages
          where org_id = $1 and provider = $2 and provider_message_id = $3
            and outcome = 'received'`,
        [this.tenant.orgId, provider, providerMessageId],
      );
      return rows[0]?.id;
    });
  }

  async recordInboundMessage(
    message: InboundMessageRecord,
    parts: readonly InboundPartRecord[],
  ): Promise<string> {
    const payload = {
      address_id: message.addressId,
      provider: message.provider,
      provider_message_id: message.providerMessageId,
      outcome: message.outcome,
      ...(message.providerReceivedAt !== undefined
        ? { provider_received_at: message.providerReceivedAt.toISOString() }
        : {}),
      ...(message.verdict !== undefined
        ? {
            authenticated: message.verdict.authenticated,
            dkim: message.verdict.dkim,
            dmarc: message.verdict.dmarc,
            spf: message.verdict.spf,
            verdict_source: message.verdict.verdictSource,
            ...(message.verdict.senderDomain !== undefined
              ? { sender_domain: message.verdict.senderDomain }
              : {}),
          }
        : {}),
    };
    const partPayload = parts.map((part) => ({
      ordinal: part.ordinal,
      kind: part.kind,
      outcome: part.outcome,
      ...(part.filename !== undefined ? { filename: part.filename } : {}),
      ...(part.documentId !== undefined ? { document_id: part.documentId } : {}),
    }));
    try {
      return await this.withTenant(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          'select app.record_inbound_message($1::jsonb, $2::jsonb) as id',
          [JSON.stringify(payload), JSON.stringify(partPayload)],
        );
        const id = rows[0]?.id;
        if (id === undefined) throw new Error('app.record_inbound_message returned no id');
        return id;
      });
    } catch (error) {
      const state = sqlState(error);
      if (state !== undefined && REFUSALS.has(state)) {
        throw new InboundRecordRefusedError(this.tenant.orgId, message.addressId, state);
      }
      throw error;
    }
  }

  async inboundMessageParts(inboundMessageId: string): Promise<readonly RecordedInboundPart[]> {
    return this.withTenant(async (client) => {
      const { rows } = await client.query<{
        inbound_message_id: string;
        ordinal: number;
        kind: RecordedInboundPart['kind'];
        filename: string | null;
        outcome: RecordedInboundPart['outcome'];
        document_id: string | null;
      }>(
        `select inbound_message_id, ordinal, kind, filename, outcome, document_id
           from inbound_message_parts
          where org_id = $1 and inbound_message_id = $2
          order by ordinal`,
        [this.tenant.orgId, inboundMessageId],
      );
      return rows.map((row) => ({
        inboundMessageId: row.inbound_message_id,
        ordinal: row.ordinal,
        kind: row.kind,
        outcome: row.outcome,
        ...(row.filename !== null ? { filename: row.filename } : {}),
        ...(row.document_id !== null ? { documentId: row.document_id } : {}),
      }));
    });
  }

  async inboundReadsLastDay(now: Date): Promise<number> {
    return this.withTenant(async (client) => {
      const { rows } = await client.query<{ n: string }>(
        `select count(*) as n
           from inbound_message_parts p
           join inbound_messages m on m.org_id = p.org_id and m.id = p.inbound_message_id
          where p.org_id = $1
            and p.outcome in ('stored', 'already_held')
            and m.received_at > $2::timestamptz - interval '24 hours'`,
        [this.tenant.orgId, now.toISOString()],
      );
      return Number(rows[0]?.n ?? 0);
    });
  }

  /** Issues a new address as this member, who must be an owner (§4). */
  async issueAddress(): Promise<{ readonly addressId: string; readonly token: string }> {
    try {
      return await this.withTenant(async (client) => {
        const { rows } = await client.query<{ id: string; token: string }>(
          `insert into inbound_addresses (org_id, created_by)
           values ($1, $2) returning id, token`,
          [this.tenant.orgId, this.tenant.userId],
        );
        const row = rows[0];
        if (row === undefined) throw new Error('inbound_addresses insert returned no row');
        return { addressId: row.id, token: row.token };
      });
    } catch (error) {
      throw this.refusal(error, 'issue');
    }
  }

  /** Makes this owner the member the address acts as (§4, §6). */
  async adoptAddress(addressId: string): Promise<void> {
    try {
      await this.withTenant(async (client) => {
        await client.query(
          `insert into inbound_address_adoptions (org_id, address_id, adopted_by)
           values ($1, $2, $3)`,
          [this.tenant.orgId, addressId, this.tenant.userId],
        );
      });
    } catch (error) {
      throw this.refusal(error, 'adopt');
    }
  }

  /** Retires the address for good (§4). */
  async retireAddress(addressId: string): Promise<void> {
    try {
      await this.withTenant(async (client) => {
        await client.query(
          `insert into inbound_address_retirements (org_id, address_id, retired_by)
           values ($1, $2, $3)`,
          [this.tenant.orgId, addressId, this.tenant.userId],
        );
      });
    } catch (error) {
      throw this.refusal(error, 'retire');
    }
  }

  private refusal(error: unknown, action: 'issue' | 'adopt' | 'retire'): unknown {
    const state = sqlState(error);
    return state !== undefined && REFUSALS.has(state)
      ? new InboundAddressRefusedError(this.tenant.orgId, action, state)
      : error;
  }

  /** This tenant's addresses, newest first, with what Settings → Email shows. */
  async addresses(): Promise<readonly InboundAddressRow[]> {
    return this.withTenant(async (client) => {
      const { rows } = await client.query<{
        id: string;
        token: string;
        created_by: string;
        created_at: Date;
        acting_member: string;
        retired_at: Date | null;
        retired_by: string | null;
        last_received_at: Date | null;
        refused_since_retired: string;
        last_refused_at: Date | null;
      }>(
        `select a.id, a.token, a.created_by, a.created_at,
                coalesce(
                  (select ad.adopted_by from inbound_address_adoptions ad
                    where ad.address_id = a.id
                    order by ad.adopted_at desc, ad.id desc limit 1),
                  a.created_by) as acting_member,
                r.retired_at, r.retired_by,
                (select max(m.received_at) from inbound_messages m
                  where m.org_id = a.org_id and m.address_id = a.id
                    and m.outcome = 'received') as last_received_at,
                (select count(*) from inbound_messages m
                  where m.org_id = a.org_id and m.address_id = a.id
                    and m.outcome = 'refused_retired') as refused_since_retired,
                (select max(m.received_at) from inbound_messages m
                  where m.org_id = a.org_id and m.address_id = a.id
                    and m.outcome = 'refused_retired') as last_refused_at
           from inbound_addresses a
           left join inbound_address_retirements r on r.address_id = a.id
          where a.org_id = $1
          order by a.created_at desc, a.id`,
        [this.tenant.orgId],
      );
      return rows.map((row) => ({
        addressId: row.id,
        token: row.token,
        createdBy: row.created_by,
        createdAt: row.created_at,
        actingMember: row.acting_member,
        refusedSinceRetired: Number(row.refused_since_retired),
        ...(row.retired_at !== null ? { retiredAt: row.retired_at } : {}),
        ...(row.retired_by !== null ? { retiredBy: row.retired_by } : {}),
        ...(row.last_received_at !== null ? { lastReceivedAt: row.last_received_at } : {}),
        ...(row.last_refused_at !== null ? { lastRefusedAt: row.last_refused_at } : {}),
      }));
    });
  }
}

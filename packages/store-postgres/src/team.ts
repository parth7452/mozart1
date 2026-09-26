/**
 * Settings → Team's database half (ADR 0051, migration 0035).
 *
 * One member of one tenant, as `app_rw` with that member's claims set
 * transaction-locally. The list is an ordinary read through RLS; the three
 * writes are the three definer functions, which decide for themselves whether
 * the caller is an owner and whether the change is allowed. This file never
 * decides either — it names what the database answered.
 *
 * The service role appears nowhere (invariant 6).
 */

import type { Pool, PoolClient } from 'pg';
import { sessionPool, type PostgresStoreConfig, type TenantContext } from './store';

export const MEMBERSHIP_ROLES = [
  'owner',
  'approver',
  'analyst',
  'read_only',
  'accountant_guest',
] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

export function isMembershipRole(value: unknown): value is MembershipRole {
  return typeof value === 'string' && (MEMBERSHIP_ROLES as readonly string[]).includes(value);
}

/** One member of the workspace, as Settings → Team lists them. */
export interface TeamMember {
  readonly userId: string;
  readonly email: string;
  readonly fullName?: string;
  readonly role: MembershipRole;
  readonly memberSince: Date;
  /** `users.auth_user_id` is set: they have reached the app at least once. */
  readonly hasSignedIn: boolean;
  /** An enabled QuickBooks connection runs as them (ADR 0031 §3). */
  readonly holdsLedger: boolean;
  /** A live email address acts as them (ADR 0047 §6). */
  readonly holdsEmail: boolean;
}

/** What an invitation did. */
export interface Invited {
  readonly userId: string;
  /** False when an existing `users` row answered to the address. */
  readonly usersRowCreated: boolean;
  /** They have signed in before (to any workspace), so can sign in here now. */
  readonly hasSignedIn: boolean;
}

/**
 * Why the database refused a team change, one per error code migration 0035
 * raises. Never the database's sentence: a route turns this into a notice key.
 */
export type TeamRefusal =
  | 'not_owner'
  | 'invalid'
  | 'address_ambiguous'
  | 'already_member'
  | 'last_owner'
  | 'not_member'
  | 'holds_ledger'
  | 'holds_email'
  | 'too_few_writers';

const REFUSAL_BY_STATE: Readonly<Record<string, TeamRefusal>> = {
  '42501': 'not_owner',
  '22023': 'invalid',
  '22P02': 'invalid',
  '21000': 'address_ambiguous',
  RCT01: 'already_member',
  RCT02: 'last_owner',
  RCT03: 'not_member',
  RCT05: 'too_few_writers',
};

/** A team change the database refused, by name. Carries ids and a code only. */
export class TeamChangeRefusedError extends Error {
  override readonly name = 'TeamChangeRefusedError';
  constructor(
    readonly orgId: string,
    readonly action: 'invite' | 'change_role' | 'remove',
    readonly refusal: TeamRefusal,
    readonly sqlState: string,
  ) {
    super(`${action} in org ${orgId} was refused: ${refusal} (${sqlState})`);
  }
}

function refusalOf(error: unknown): { refusal: TeamRefusal; state: string } | undefined {
  const state = (error as { code?: unknown } | null)?.code;
  if (typeof state !== 'string') return undefined;
  if (state === 'RCT04') {
    // Both responsibilities share a code; which one is in the fixed wording.
    const message = error instanceof Error ? error.message : '';
    return { refusal: message.includes('QuickBooks') ? 'holds_ledger' : 'holds_email', state };
  }
  const refusal = REFUSAL_BY_STATE[state];
  return refusal === undefined ? undefined : { refusal, state };
}

export class PostgresTeamStore {
  private readonly pool: Pool;
  private readonly role: string;

  constructor(
    config: PostgresStoreConfig,
    private readonly tenant: TenantContext,
  ) {
    this.pool = sessionPool(config);
    this.role = config.role ?? 'app_rw';
  }

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

  private async write<T>(
    action: TeamChangeRefusedError['action'],
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.withTenant(work);
    } catch (error) {
      const refused = refusalOf(error);
      if (refused !== undefined) {
        throw new TeamChangeRefusedError(this.tenant.orgId, action, refused.refusal, refused.state);
      }
      throw error;
    }
  }

  /** Everyone in this workspace: owners first, then by address. */
  async members(): Promise<readonly TeamMember[]> {
    return this.withTenant(async (client) => {
      const { rows } = await client.query<{
        user_id: string;
        email: string;
        full_name: string | null;
        role: MembershipRole;
        created_at: Date;
        signed_in: boolean;
        holds_ledger: boolean;
        holds_email: boolean;
      }>(
        `select u.id as user_id, u.email, u.full_name, m.role, m.created_at,
                u.auth_user_id is not null as signed_in,
                exists (select 1 from accounting_connections c
                         where c.org_id = m.org_id and c.enabled and c.created_by = u.id)
                  as holds_ledger,
                exists (select 1 from inbound_addresses a
                         where a.org_id = m.org_id
                           and not exists (select 1 from inbound_address_retirements r
                                            where r.address_id = a.id)
                           and coalesce((select ad.adopted_by from inbound_address_adoptions ad
                                          where ad.address_id = a.id
                                          order by ad.adopted_at desc, ad.id desc limit 1),
                                        a.created_by) = u.id)
                  as holds_email
           from memberships m
           join users u on u.id = m.user_id
          where m.org_id = $1
          order by array_position(array['owner','approver','analyst','read_only','accountant_guest']::membership_role[], m.role),
                   lower(u.email), u.id`,
        [this.tenant.orgId],
      );
      return rows.map((row) => ({
        userId: row.user_id,
        email: row.email,
        ...(row.full_name === null ? {} : { fullName: row.full_name }),
        role: row.role,
        memberSince: row.created_at,
        hasSignedIn: row.signed_in,
        holdsLedger: row.holds_ledger,
        holdsEmail: row.holds_email,
      }));
    });
  }

  /** Adds a person to this workspace (`app.invite_member`). */
  async invite(input: {
    readonly email: string;
    readonly fullName: string;
    readonly role: MembershipRole;
  }): Promise<Invited> {
    return this.write('invite', async (client) => {
      const { rows } = await client.query<{
        member_user_id: string;
        users_row_created: boolean;
        has_signed_in: boolean;
      }>('select * from app.invite_member($1, $2, $3::membership_role)', [
        input.email,
        input.fullName,
        input.role,
      ]);
      const row = rows[0];
      if (row === undefined) throw new Error('app.invite_member returned no row');
      return {
        userId: row.member_user_id,
        usersRowCreated: row.users_row_created,
        hasSignedIn: row.has_signed_in,
      };
    });
  }

  /** Changes a member's role, and returns the role it was (`app.change_member_role`). */
  async changeRole(userId: string, role: MembershipRole): Promise<MembershipRole> {
    return this.write('change_role', async (client) => {
      const { rows } = await client.query<{ was: MembershipRole }>(
        'select app.change_member_role($1, $2::membership_role) as was',
        [userId, role],
      );
      const was = rows[0]?.was;
      if (was === undefined) throw new Error('app.change_member_role returned no row');
      return was;
    });
  }

  /** Removes a member, and returns the role they held (`app.remove_member`). */
  async remove(userId: string): Promise<MembershipRole> {
    return this.write('remove', async (client) => {
      const { rows } = await client.query<{ was: MembershipRole }>(
        'select app.remove_member($1) as was',
        [userId],
      );
      const was = rows[0]?.was;
      if (was === undefined) throw new Error('app.remove_member returned no row');
      return was;
    });
  }
}

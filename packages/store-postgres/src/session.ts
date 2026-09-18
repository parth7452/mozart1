import { Pool } from 'pg';

/** A membership, as the sign-in path needs it: which tenant, and what they may do. */
export interface OrgMembership {
  readonly orgId: string;
  readonly slug: string;
  readonly name: string;
  readonly role: 'owner' | 'approver' | 'analyst' | 'read_only' | 'accountant_guest';
}

export interface ResolvedSession {
  /** Our user id — what memberships and RLS are keyed on, not the provider's. */
  readonly userId: string;
  readonly orgs: readonly OrgMembership[];
}

export interface SessionResolverConfig {
  readonly connectionString: string;
  readonly role?: string;
}

/**
 * Turns a verified identity-provider session into our user id and their tenants.
 *
 * The caller must already have verified the session; this takes the subject and
 * email on trust, exactly as it takes the tenant claims on trust everywhere else.
 * It runs as the application role — never the service role — so the only reason
 * it can answer at all is the two definer functions migration 0012 added, each of
 * which answers one question and nothing more.
 *
 * Throws when there is no invitation for the address, which is the answer to an
 * authenticated stranger: a verified email is not an entitlement.
 */
export async function resolveSession(
  config: SessionResolverConfig,
  identity: { readonly authUserId: string; readonly email: string },
): Promise<ResolvedSession> {
  const pool = new Pool({ connectionString: config.connectionString, max: 1 });
  try {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`set local role ${config.role ?? 'app_rw'}`);

      const linked = await client.query<{ user_id: string }>(
        'select app.link_auth_user($1, $2) as user_id',
        [identity.authUserId, identity.email],
      );
      const userId = linked.rows[0]?.user_id;
      if (userId === undefined || userId === null) {
        throw new Error('sign-in resolved to no user');
      }

      // Now we know who they are, so the claims can say so — and `my_orgs()`
      // answers for that subject only. The org claim is still unset here; that
      // is the whole reason the function is a definer one.
      await client.query('select set_config($1, $2, true)', [
        'request.jwt.claims',
        JSON.stringify({ sub: userId }),
      ]);

      const { rows } = await client.query<{
        org_id: string;
        slug: string;
        name: string;
        role: OrgMembership['role'];
      }>('select org_id, slug, name, role from app.my_orgs()');

      await client.query('commit');
      return {
        userId,
        orgs: rows.map((row) => ({
          orgId: row.org_id,
          slug: row.slug,
          name: row.name,
          role: row.role,
        })),
      };
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

import { sessionPool } from './store';

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
 * authenticated stranger: a verified email is not an entitlement. Also throws,
 * with a different message, when two users' addresses differ only in case — an
 * operator's problem to resolve, not a refusal of this person (ADR 0045).
 */
export async function resolveSession(
  config: SessionResolverConfig,
  identity: { readonly authUserId: string; readonly email: string },
): Promise<ResolvedSession> {
  // The shared pool, for the same reason the store uses one: this runs on every
  // request, and a connection opened and discarded per request is a connection
  // budget spent on nothing.
  const pool = sessionPool(config);
  {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`set local role ${config.role ?? 'app_rw'}`);
      // `app.link_auth_user()` refuses any caller that carries a claim (ADR
      // 0045): this is the one caller it is for, and it has none yet because it
      // does not know who this is. Stated rather than assumed — every claim here
      // is set transaction-locally, but saying so keeps sign-in from depending
      // on how the pooled connection was last used (`resolveOperator`'s reason).
      await client.query(`select set_config('request.jwt.claims', '', true)`);

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
  }
}

/**
 * Whether the sign-in form may let the provider create an account for this
 * address (ADR 0051 §6): exactly one `users` row answers to it ignoring
 * capitals, and it has a membership.
 *
 * Asked with no claims, like `resolveSession`'s first question, because
 * `app.address_is_invited()` refuses any caller that carries one. One bit comes
 * back and nothing else; a fault throws, and the form says so without saying
 * anything about the address.
 */
export async function addressIsInvited(
  config: SessionResolverConfig,
  email: string,
): Promise<boolean> {
  const client = await sessionPool(config).connect();
  try {
    await client.query('begin');
    await client.query(`set local role ${config.role ?? 'app_rw'}`);
    await client.query(`select set_config('request.jwt.claims', '', true)`);
    const { rows } = await client.query<{ invited: boolean | null }>(
      'select app.address_is_invited($1) as invited',
      [email],
    );
    await client.query('commit');
    // `=== true`: a null is not an invitation.
    return rows[0]?.invited === true;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

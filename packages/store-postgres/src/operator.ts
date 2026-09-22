import type { PostgresStoreConfig } from './store';
import { sessionPool } from './store';
import type { OrgMembership } from './session';

/**
 * Who an operator command acts as: the tenant and the member, as ids.
 *
 * `pnpm link:retailer`, `link:provenance` and `link:qbo` take an org slug and a
 * member's email, and need ids before they can construct a `PostgresStore`.
 * That lookup cannot run under the tenant's policies, because those key on the
 * org id it is trying to learn (ADR 0034, option b). So it asks
 * `app.member_for_link()`, a definer function that answers exactly this and
 * refuses any caller carrying a claim.
 *
 * It runs as `app_rw` with no claims, inside one transaction, on the login
 * `DATABASE_URL` names — which is `recouple_app` in production, a role with no
 * privileges of its own (docs/supabase.md). Never the owner, never the service
 * role.
 */
export interface OperatorIdentity {
  readonly orgId: string;
  readonly userId: string;
  readonly role: OrgMembership['role'];
}

export class UnknownOrganizationError extends Error {
  constructor(readonly slug: string) {
    super(`no organization with slug ${JSON.stringify(slug)}`);
    this.name = 'UnknownOrganizationError';
  }
}

export class NotAMemberError extends Error {
  constructor(
    readonly email: string,
    readonly slug: string,
  ) {
    super(`${email} is not a member of ${slug}`);
    this.name = 'NotAMemberError';
  }
}

export async function resolveOperator(
  config: PostgresStoreConfig,
  who: { readonly slug: string; readonly email: string },
): Promise<OperatorIdentity> {
  const client = await sessionPool(config).connect();
  try {
    await client.query('begin');
    await client.query(`set local role ${config.role ?? 'app_rw'}`);
    // Stated rather than assumed: a pooled connection carries no claims across
    // transactions, but this function is refused if any are set, and saying so
    // here keeps the refusal from depending on how the pool was last used.
    await client.query(`select set_config('request.jwt.claims', '', true)`);
    const { rows } = await client.query<{
      org_id: string;
      user_id: string | null;
      role: OrgMembership['role'] | null;
    }>('select org_id, user_id, role from app.member_for_link($1, $2)', [who.slug, who.email]);
    await client.query('commit');

    const row = rows[0];
    if (row === undefined) throw new UnknownOrganizationError(who.slug);
    if (row.user_id === null || row.role === null) throw new NotAMemberError(who.email, who.slug);
    return { orgId: row.org_id, userId: row.user_id, role: row.role };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

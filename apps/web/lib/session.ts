import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { PostgresStore, resolveSession, type OrgMembership } from '@recouple/store-postgres';
import { env } from './env';
import { supabaseForRequest } from './supabase';

/** Which tenant the reviewer is looking at, when they belong to more than one. */
const ORG_COOKIE = 'recouple_org';

export interface Session {
  readonly userId: string;
  readonly email: string;
  readonly org: OrgMembership;
  readonly orgs: readonly OrgMembership[];
}

/**
 * The reviewer for this request, or a redirect to the login page.
 *
 * Three steps, in this order, because each needs the one before it: Supabase
 * verifies the session and gives us a subject and an email; `resolveSession`
 * turns those into our user id and their tenants (migration 0012); and the
 * chosen tenant becomes the claims every query then runs under.
 *
 * Nothing here trusts a cookie for identity. The org cookie only picks between
 * tenants the database has already said this user belongs to — a forged value
 * falls through to the first real membership.
 */
export async function requireSession(): Promise<Session> {
  const supabase = await supabaseForRequest();
  const { data, error } = await supabase.auth.getUser();
  const user = data.user;
  if (error !== null || user === null || user.email === undefined) {
    redirect('/login');
  }

  let resolved;
  try {
    resolved = await resolveSession({ connectionString: env.databaseUrl }, {
      authUserId: user.id,
      email: user.email,
    });
  } catch (cause) {
    // No invitation, or an address already linked to another identity. Both are
    // refusals rather than bugs, and both say the same thing to the person.
    redirect(`/login?denied=${encodeURIComponent(messageFor(cause))}`);
  }

  if (resolved.orgs.length === 0) {
    redirect('/login?denied=no+membership+for+this+account');
  }

  const wanted = (await cookies()).get(ORG_COOKIE)?.value;
  const org =
    resolved.orgs.find((candidate) => candidate.orgId === wanted) ?? resolved.orgs[0];
  if (org === undefined) redirect('/login?denied=no+membership+for+this+account');

  return { userId: resolved.userId, email: user.email, org, orgs: resolved.orgs };
}

function messageFor(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (message.includes('no invitation')) {
    return 'that address has not been invited to a workspace';
  }
  if (message.includes('already linked')) {
    return 'that address is already linked to another sign-in';
  }
  return 'sign-in could not be completed';
}

/**
 * A store scoped to this request's tenant and actor.
 *
 * Every query it makes runs as `app_rw` with these claims set
 * transaction-locally, so what the page can see is what the policies allow —
 * not what we remembered to filter.
 */
export function storeFor(session: Session): PostgresStore {
  return new PostgresStore(
    { connectionString: env.databaseUrl },
    { orgId: session.org.orgId, userId: session.userId },
  );
}

export { ORG_COOKIE };

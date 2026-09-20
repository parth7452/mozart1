import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { resolveSession, type OrgMembership } from '@recouple/store-postgres';
import { env } from './env';
import { tenantStore, type TenantStore } from './store';
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
    // A refusal the person can act on, or a fault somebody has to fix.
    // `messageFor` decides which, and records the ones that are ours.
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

/**
 * What to show someone whose sign-in failed, and what to record about it.
 *
 * Two of these are answers: the address was never invited, or it belongs to a
 * different sign-in. Both are refusals the person can act on, and both are safe
 * to state because reaching this point already required a verified session.
 *
 * Everything else is a fault — the database unreachable, credentials wrong, a
 * role that cannot become `app_rw`. Those are not the person's problem to read
 * about, but they are somebody's, and the previous version of this function
 * turned every one of them into "sign-in could not be completed" and logged
 * nothing at all. An operator looking at the request log saw a 307 to /login and
 * no error anywhere, which is indistinguishable from the app working.
 *
 * So a fault is logged with its real message and shown with a short code the
 * person can quote. The code is the timestamp, which is enough to find the log
 * line and costs nothing to say out loud.
 */
function messageFor(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);

  if (message.includes('no invitation')) {
    return 'that address has not been invited to a workspace';
  }
  if (message.includes('already linked')) {
    return 'that address is already linked to another sign-in';
  }

  const reference = new Date().toISOString();
  console.error(
    `[sign-in failed] ${reference} — resolveSession could not complete. ` +
      `This is a configuration or connectivity fault, not a refusal. ${message}`,
    cause,
  );
  return `sign-in could not be completed (reference ${reference})`;
}

/**
 * A store scoped to this request's tenant and actor.
 *
 * Every query it makes runs as `app_rw` with these claims set
 * transaction-locally, so what the page can see is what the policies allow —
 * not what we remembered to filter.
 */
export function storeFor(session: Session): TenantStore {
  return tenantStore({ orgId: session.org.orgId, userId: session.userId });
}

export { ORG_COOKIE };

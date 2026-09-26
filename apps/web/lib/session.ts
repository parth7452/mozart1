import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { resolveSession, type OrgMembership, type PostgresStore } from '@recouple/store-postgres';
import { PASSWORD_METHOD, signedInByEmailLink, tokenFacts } from './auth-methods';
import { env } from './env';
import { signInDenied, type SignInNoticeKey } from './notices';
import { tenantStore } from './store';
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
 *
 * An identity the database refuses — no invitation, or no membership anywhere —
 * is signed out before it is sent to the login page (ADR 0045), so its session
 * is not kept alive and refreshed by the proxy for as long as the tab is open.
 * Only those two answers sign anybody out: a fault is not a verdict on the
 * person, and a member whose sign-in hit an unreachable database keeps their
 * session.
 *
 * A session not signed in by one of this app's email links — a password, above
 * all — is refused before the database is asked who it is (ADR 0051 §6). This
 * app offers no password, so one only exists
 * because somebody called the provider directly: with sign-ups on, anyone can
 * register an invited person's address with a password of their choosing, and
 * once the invitee follows the confirmation email that password is a way in.
 * That session alone is signed out (`local` scope, so the invitee's own session
 * survives), and the log says an account has a password somebody knows.
 */
export async function requireSession(): Promise<Session> {
  const supabase = await supabaseForRequest();
  const { data, error } = await supabase.auth.getUser();
  const user = data.user;
  if (error !== null || user === null || user.email === undefined) {
    redirect('/login');
  }

  // How this session signed in, from the token `getUser()` just had verified.
  // Read after it, from the same storage, and tied to it by subject: a token
  // that is not the one verified, or that says nothing about how it was made,
  // is a fault rather than a guess either way.
  const facts = tokenFacts((await supabase.auth.getSession()).data.session?.access_token);
  if (facts === undefined || facts.subject !== user.id) {
    const reference = new Date().toISOString();
    console.error(
      `[sign-in failed] ${reference} — the session's access token could not be read, or ` +
        `names a different subject than the provider verified. Nothing was resolved.`,
    );
    redirect(signInDenied('not_completed', reference));
  }
  if (!signedInByEmailLink(facts.methods)) {
    const reference = new Date().toISOString();
    console.error(
      facts.methods.includes(PASSWORD_METHOD)
        ? `[sign-in refused] ${reference} — auth user ${user.id} presented a session signed in ` +
            `with a password, which this app never offers: somebody holds a password for this ` +
            `account. Refused and signed out locally (ADR 0051 §6). Remove the account's ` +
            `password, or the account, in Supabase → Authentication → Users.`
        : `[sign-in refused] ${reference} — auth user ${user.id} presented a session signed in ` +
            `by ${JSON.stringify(facts.methods)}, none of which this app uses. Refused and ` +
            `signed out locally (ADR 0051 §6).`,
    );
    await signOutRefused(supabase, 'not an email-link session', 'local');
    redirect(signInDenied('email_link_only'));
  }

  let resolved;
  try {
    resolved = await resolveSession({ connectionString: env.databaseUrl }, {
      authUserId: user.id,
      email: user.email,
    });
  } catch (cause) {
    // A refusal the person can act on, or a fault somebody has to fix.
    // `refusalOf` decides which, and `noticeFor` records the ones that are ours.
    const refusal = refusalOf(cause);
    if (refusal === 'not_invited') await signOutRefused(supabase, 'no invitation');
    const notice = noticeFor(cause, refusal);
    redirect(signInDenied(notice.key, ...notice.about));
  }

  if (resolved.orgs.length === 0) {
    await signOutRefused(supabase, 'no membership');
    redirect(signInDenied('no_membership'));
  }

  const wanted = (await cookies()).get(ORG_COOKIE)?.value;
  const org =
    resolved.orgs.find((candidate) => candidate.orgId === wanted) ?? resolved.orgs[0];
  if (org === undefined) redirect(signInDenied('no_membership'));

  return { userId: resolved.userId, email: user.email, org, orgs: resolved.orgs };
}

/**
 * The two answers from the database that are refusals of this identity. Each is
 * also the login page's key for saying so.
 */
type Refusal = Extract<SignInNoticeKey, 'not_invited' | 'linked_elsewhere'>;

/**
 * Whether what `resolveSession` threw is one of `app.link_auth_user()`'s two
 * refusals of the person, or something else.
 *
 * Both are raised with SQLSTATE 42501 and a fixed opening (migrations 0012 and
 * 0033), and both are asked for rather than searched for anywhere in whatever
 * was thrown: one of them now signs a session out, and a fault that happened to
 * mention an invitation must not. 0033's own new refusals — a caller carrying a
 * claim, an address two users answer to — are 42501 and 21000 with other
 * wording, and are faults here: an operator's to fix, not the person's.
 */
function refusalOf(cause: unknown): Refusal | undefined {
  if (!(cause instanceof Error)) return undefined;
  if ((cause as { code?: unknown }).code !== '42501') return undefined;
  if (cause.message.startsWith('no invitation for ')) return 'not_invited';
  if (cause.message.startsWith('account for ') && cause.message.endsWith(' is already linked to another identity')) {
    return 'linked_elsewhere';
  }
  return undefined;
}

/**
 * Ends a session the database has refused, at the provider as well as here.
 *
 * `signOut()`'s default scope is global: it revokes every refresh token this
 * identity holds, so the session cannot be refreshed from any cookie anywhere.
 * In a route handler the cookies are cleared at once. A server component
 * cannot write cookies (`supabaseForRequest` tolerates that), so there the
 * revocation is what counts: the proxy's next `getUser()` is answered
 * `session_not_found`, and auth-js removes the session itself.
 *
 * A sign-out that fails is logged and the refusal goes ahead regardless.
 * `resolveSession` refuses this identity on every request whatever its cookie
 * says, so the cookie outliving the redirect costs a refresh, not access.
 */
async function signOutRefused(
  supabase: Awaited<ReturnType<typeof supabaseForRequest>>,
  why: string,
  scope: 'global' | 'local' = 'global',
): Promise<void> {
  try {
    // The default scope is global; `local` ends only the session presented.
    const { error } =
      scope === 'local' ? await supabase.auth.signOut({ scope }) : await supabase.auth.signOut();
    if (error !== null) {
      console.error(
        `[sign-in refused] ${why}: signing the session out failed ` +
          `(${error.name}, HTTP ${error.status ?? '(none)'}); the refusal stands`,
      );
    }
  } catch (cause) {
    console.error(`[sign-in refused] ${why}: signing the session out threw; the refusal stands`, cause);
  }
}

/**
 * What to show someone whose sign-in failed, as a login notice key and its
 * fragments, and what to record about it.
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
function noticeFor(
  cause: unknown,
  refusal: Refusal | undefined,
): { readonly key: SignInNoticeKey; readonly about: readonly string[] } {
  if (refusal !== undefined) return { key: refusal, about: [] };

  const message = cause instanceof Error ? cause.message : String(cause);
  const reference = new Date().toISOString();
  console.error(
    `[sign-in failed] ${reference} — resolveSession could not complete. ` +
      `This is a configuration or connectivity fault, not a refusal. ${message}`,
    cause,
  );
  return { key: 'not_completed', about: [reference] };
}

/**
 * A store scoped to this request's tenant and actor.
 *
 * Every query it makes runs as `app_rw` with these claims set
 * transaction-locally, so what the page can see is what the policies allow —
 * not what we remembered to filter.
 */
export function storeFor(session: Session): PostgresStore {
  return tenantStore({ orgId: session.org.orgId, userId: session.userId });
}

export { ORG_COOKIE };

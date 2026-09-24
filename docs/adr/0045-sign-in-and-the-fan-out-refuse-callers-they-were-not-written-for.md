# 0045 — Sign-in and the fan-out refuse callers they were not written for

- Status: accepted
- Date: 2026-09-23
- Closes: the open follow-ups of ADR 0037

## Context

ADR 0037 took every grant away from Supabase's request roles, and the Data API
has been off since 2026-09-23. It named what it left open. Two of those items
are still open, and none of this is reachable today. What follows is defence in
depth: each door is closed by a grant and a dashboard switch, and should also
be closed by the code behind it.

**Sign-ups are open.** `apps/web/app/login/page.tsx` calls
`supabase.auth.signInWithOtp({ email, options: { emailRedirectTo } })` with no
`shouldCreateUser`. auth-js then sends `create_user: true` (it defaults
`options?.shouldCreateUser ?? true`, `GoTrueClient.ts:2308` in
`@supabase/auth-js` 2.116.0), so any address typed into the form becomes a
Supabase Auth user and gets a working magic link. The auth logs ADR 0037 read
already showed one such signup. The database refuses that person
(`app.link_auth_user()` raises `no invitation`), but three things still happen:

- They hold a valid Supabase session. `requireSession` redirects them to
  `/login?denied=…` and leaves the cookie in place, and `proxy.ts` refreshes it
  on every request for as long as they keep the tab open.
- A Supabase `authenticated` token is the first step of every Data API path in
  ADR 0037's list. After 0028 that token reaches nothing, but there is no
  reason to hand one to every visitor.
- An invitation is only as closed as the dashboard. The list of Supabase Auth
  users is not a list of invited people. It is everyone who ever typed an
  address.

**`app.ledger_connections_to_sync()` refuses an org claim but not a subject.**
It is the one function whose answer crosses tenants: every enabled connection's
id, org and member (ADR 0031 §5). It refuses a caller that has an `org_id`. A
PostgREST request made with a Supabase token carries a `sub` and no `org_id`,
which is exactly the shape it lets through. `app.member_for_link()` (ADR 0034)
already refuses either claim, and this function should have the same guard.

**`app.link_auth_user(auth_id, claimed_email)` takes the identity as an
argument.** That is right for its one caller. `resolveSession` passes the
subject and email Supabase verified, before it knows which of our users this is
and before it sets any claim. But the function is `security definer` and it
writes `users.auth_user_id`. Any caller that can execute it can pair any
not-yet-linked invited address with an identity of its own choosing. That is
account takeover: the victim's row is then "already linked" to the attacker's
subject, and the attacker's next sign-in resolves to the victim. After 0028
only the application's own login can execute it. Before 0028, an
`authenticated` token could, if `app` had ever been an exposed schema. A
request through the Data API always carries `sub`. `resolveSession` never
carries any claim at this point. The difference between the two callers can be
tested.

It also picks between two people at random. `users.email` is unique only
case-sensitively. When two rows match `lower(claimed_email)`, the unguarded
`select … into` links whichever one the planner returns first. ADR 0034
refused exactly this coin toss for `member_for_link`, because a wrong
`created_by` is invisible. Here the loser is worse off: it is a whole session
resolved to the wrong person.

(ADR 0037's third item, that CLAUDE.md said `link_auth_user()` reads the
claims, has since been corrected in CLAUDE.md. Its fourth, that production did
not yet carry 0028, stopped being true on 2026-09-23.)

## Decision

### 1. The login form creates nobody

`signInWithOtp` is called with `shouldCreateUser: false`. The action moves out
of the page into `apps/web/app/login/actions.ts`, so that it can be tested.

An unknown address now comes back as a refusal from the provider, and **the
form answers a refusal exactly as it answers a sent link**: a redirect to
`/login?sent=1`. The two refusal codes, as the auth server returns them
(`supabase/auth`, `internal/api/otp.go` and `internal/api/signup.go`; the codes
are listed in auth-js's `src/lib/error-codes.ts:22` and `:68`, and
`src/lib/fetch.ts:101-112` copies the body's `code` onto `AuthApiError.code`):

- **`otp_disabled`** (422, "Signups not allowed for otp"): `create_user` is
  false and the provider has no user for the address. This is the refusal of a
  stranger.
- **`signup_disabled`** (422, "Signups not allowed for this instance"): the
  project has sign-ups switched off, and the address either has no user or has
  one that has never confirmed. The second case is an invited person who has
  not yet followed their invitation. The magic-link path tries to sign an
  unconfirmed user up again, and a closed project refuses that.

Both are logged as a warning with the code and nothing that names the address.
"I was invited and no mail came" then has an answer in the log.

**Every failure that only an existing address can produce is also answered as
sent.** This is the part that changes the old docstring's reasoning. Before,
every address reached the mail step, because the provider created an account
first. So a send error said nothing about who existed, and showing it was
harmless. With `create_user: false`, only an address that has an account gets as
far as the mailer. Every error raised there answers "does this address have an
account?":

- the per-address cooldown (`over_email_send_rate_limit`, "you can only request
  this after N seconds"). Submitting the same address twice, a few seconds
  apart, would tell anyone whether it is registered;
- the project's hourly mail quota (the same code);
- the built-in mailer refusing an address outside the Supabase team
  (`email_address_not_authorized`);
- an SMTP failure (a 5xx).

So the form shows a failure only when the provider refused before it looked at
the address: its per-client request limit (`over_request_rate_limit`), or a
request that never got an HTTP answer at all (status 0, the network). Each is
shown in plain words with a reference, never the provider's raw message.
Everything else is logged with `console.error`, a reference, the code, the
status and the provider's message, and the page says it was sent. This is not
swallowing the error, because the log is where the operator looks. It is
choosing who hears about the failure. The notice after sending now always says
what to do if nothing arrives (wait and try again, or ask whoever invited you).
That costs nothing, because every address gets it.

The redirect-URL branch of the old `sendFailure` is dropped. The provider does
not report a callback URL missing from its allow list; it silently substitutes
the Site URL (`apps/web/lib/env.ts` explains how that was found).

### 2. A refused session is signed out

When `resolveSession` refuses an identity with **no invitation**, or resolves
it to a user with **no membership**, `requireSession` calls
`supabase.auth.signOut()` before it redirects to `/login?denied=…`. The default
scope is `global`, which revokes every refresh token that identity holds at the
provider. In a route handler or server action the cookies are cleared at once.
In a server component they cannot be written (Next refuses, and
`supabaseForRequest` already tolerates that). The revocation is what matters
there: the proxy's next `getUser()` gets `session_not_found`, and auth-js
removes the session itself (`src/lib/fetch.ts:138-142` turns that code into
`AuthSessionMissingError`, and `_getUser` removes the session on it,
`GoTrueClient.ts:3274-3279`). So the
stale cookie is gone one request later and cannot be refreshed in between.

**Only those two answers sign anybody out.** Each is the database saying
something definite about this identity. The refusal is recognised by SQLSTATE
`42501` together with the message's prefix (`no invitation for `), not by a
substring anywhere in whatever was thrown. Any other outcome is a fault and
signs nobody out: the database unreachable, a role that cannot become `app_rw`,
a timeout, or the two new refusals in §3. A member whose sign-in hits a bad
moment keeps their session and gets the reference code as before.
`already linked to another identity` is also left alone. It is an operator's
repair (the row points at an older identity of the same person), and the
session becomes useful the moment it is fixed. If `signOut` itself fails, the
failure is logged and the redirect still happens. The refusal is enforced by
`resolveSession` on every request, whatever the cookie says.

### 3. Migration 0033: both definer functions refuse any claim

Two functions are restated in full with `create or replace`. Each keeps the
same signature, return type, `language plpgsql`, volatility and
`security definer`, restates `set search_path = pg_catalog, public, extensions`
(suite 24's pin), and keeps its `revoke all … from public` and
`grant execute … to app_rw` exactly as before:

- **`app.ledger_connections_to_sync()`** raises when
  `app.current_org_id() is not null or app.current_user_id() is not null`.
  This is `member_for_link`'s guard. The message still says `untenanted`,
  which suite 20 and `ledger-connections.test.ts` match. Its only caller,
  `listConnectionsToSync`, sets a role and no claims.
- **`app.link_auth_user(auth_id, claimed_email)`** raises under the same
  condition, before it reads anything. Its only caller, `resolveSession`, calls
  it before any claim is set. It also raises `cardinality_violation` when more
  than one `users` row matches `lower(claimed_email)`, rather than linking one
  of them. Every other behaviour and message is unchanged: the already-linked
  fast path, `no invitation for …`, `account for … is already linked to another
  identity`, and the verified-arguments check. The already-linked path still
  runs before the ambiguity check. `users.auth_user_id` is unique, so it is
  never ambiguous, and a member who has signed in before is untouched by the
  new check.

Neither new refusal contains `no invitation` or `already linked`. The web app
therefore treats them as faults, logs them, and signs nobody out.

`resolveSession` and `listConnectionsToSync` now clear
`request.jwt.claims` transaction-locally before their first statement, as
`resolveOperator` already does (ADR 0034). Every claim in this codebase is set
transaction-locally, so a pooled connection should never carry one. Clearing it
means the refusal does not depend on that staying true.

No other function, grant, policy, trigger or table changes. No UPDATE or
DELETE grant is added.

### 4. Invitations create the auth user; the dashboard switch is the founder's

With the form creating nobody, an invitation has two halves, in this order:

1. The `users` and `memberships` rows, as before. `link_auth_user()` still
   refuses anyone without them.
2. Supabase dashboard → **Authentication → Users → Add user → Send
   invitation** (the "invite user" dialog), with the same address. This
   creates the auth user and emails an invitation.
3. The person follows the invitation link once, which confirms the address,
   and then signs in from the login form like anyone else. The invitation link
   does not sign them in by itself. A dashboard invitation has no PKCE
   challenge, so the provider sends it back to the Site URL with the session in
   the URL fragment. This app only takes a session from `/auth/callback`, and a
   fragment never reaches the server. Making the invitation link sign in
   directly means changing the invite email template and having the callback
   accept `type=invite`. That is a follow-up, not needed for the procedure to
   work.

`apps/web/DEPLOY.md`, `docs/supabase.md` and `README.md` say this the same way.

**"Allow new users to sign up" off** (Authentication → Sign In / Providers) is a
second lock no code can set. It stops anything but an invitation from creating
a user, whatever a future client sends. It is recommended and it is the
founder's switch, like the Data API switch (ADR 0037 §8). Flip it after this
change is deployed and both members have signed in through the new form. Its
one cost is named in §1, and it is why step 3 says "follow the invitation link
once": an invited person who has not yet followed their invitation cannot get a
link from the form (`signup_disabled`). The answer is to re-send the invitation
from the dashboard. The page cannot say so without saying who was invited.

## Consequences

**What this makes true.** The login form no longer creates identities, and
says the same thing for every address, including when the mailer fails. A
refused identity keeps no working session. Both definer functions that answer
beyond the caller's tenant are refused to every caller carrying a claim, so a
Data API request cannot reach either one. That now holds even if the grants,
the exposed schemas and the Data API switch all went wrong together. A sign-in
can no longer resolve to one of two people at random.

**What it costs.**

- A member whose link was held back by the provider's quota or cooldown now
  sees "sent" rather than the reason. The old docstring warned about exactly
  this ("staring at an empty inbox with no idea why"). What remains is the
  hint on every sent notice and a `console.error` line with a reference for
  the operator. That trade is deliberate: the alternative tells strangers who
  has an account.
- Inviting someone now needs the dashboard as well as SQL. That is the point:
  the list of auth users becomes the list of invited people.
- Anyone who signed up while sign-ups were open keeps their auth user until
  someone deletes it in the dashboard (ADR 0037 saw one signup verification in
  the auth logs). They can do nothing with it, and their next visit signs them
  out (§2).

**What it does not close.** The form's latency still differs between an
address that gets mail and one that does not, because the provider sends
synchronously. That is a timing oracle, much weaker than a message, and not
addressed here. The refusal message after a verified sign-in (`that address has
not been invited to a workspace`) is shown only to the person who controls that
mailbox, as before.

**Production.** 0033 is not applied. It goes to `mozart-preview` first and then
production, on the founder's go, and is read back as each earlier migration
was: the stored statement's md5 against the file, both functions still
`security definer` and pinned, the same result types, EXECUTE held by `app_rw`
alone, and both members still able to sign in. Neither member is affected. Both
are already linked, so `link_auth_user()` returns on its first lookup, and
`resolveSession` sets no claim before calling it. The web change deploys on
merge and needs no migration.

## Invariants touched

- **6 (RLS; the service-role key).** Strengthened. The two definer functions
  that read past RLS now refuse every caller that carries a claim. Enforced by
  migration 0033, suite 29 and the store tests. The service-role key still
  appears nowhere.
- **1, 2, 3, 4, 5, 7.** Untouched. No table, trigger, grant or threshold
  changes. Suite 24's enumeration covers both restated functions' pins.

## Rollback

The web half is a revert: drop `shouldCreateUser: false` and the sign-out, and
the form goes back to creating users. There is no reason to. If a future flow
needs self-service sign-up, that is a new ADR about who may create a tenant, not
a revert of this one.

The database half is a new migration restating 0024's and 0012's bodies. That
reopens a subject-only caller's path into both functions and should not be
needed. Neither of their callers sets a claim.

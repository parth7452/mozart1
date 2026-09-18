# 0015 — The web app authenticates with Supabase and reads as `app_rw`

- Status: accepted
- Date: 2026-09-18

## Context

`apps/web` needs to know who is asking and what they may see. Supabase Auth
answers the first. The second is already answered — by the RLS policies, the
role predicate from ADR 0012's migration, and the approval gate — and the
question was how to reach that answer from a request without building a second
one beside it.

The obvious path is the one Supabase documents: the browser holds a session, the
Supabase client carries its JWT to PostgREST, and the policies read `org_id` out
of the token. It needs a custom access token hook to put `org_id` there, and it
only works on Supabase. Everything in `supabase/migrations` runs unchanged on a
bare Postgres 16, which is what makes `pnpm db:test` two seconds instead of a
deployment, and what let the policies be tested before auth existed at all.

## Decision

**Supabase Auth for identity, `PostgresStore` for everything else.**

The browser's session is used for exactly one thing: `supabase.auth.getUser()`,
which says who this is. From there the request opens a Postgres connection as
`app_rw` and sets `request.jwt.claims` transaction-locally to
`{ sub: <our user id>, org_id: <the tenant> }` — the same thing the pipeline and
the test suite already do. So the policies decide, on one set of claims, reached
one way.

Three consequences that are the point rather than side effects:

- **The service-role key does not appear in this app.** Not in a route, not in
  an environment variable, not in a comment. Invariant 6 is the one the database
  cannot enforce for us, and the way to keep it is to never need the key.
- **The publishable key is the only Supabase credential the app holds**, and it
  is designed to be public.
- **A document's bytes are served by a route, not a signed URL** (ADR 0014), so
  they pass the same policies as the row that describes them.

**Sign-in resolves, it does not create.** `app.link_auth_user()` links a verified
identity to a user that was already invited, and refuses an address with no
invitation and a second identity claiming an account already linked. A tenant is
not something a request may bring into existence.

**A cookie picks the tenant; it never asserts one.** `recouple_org` chooses
among the memberships `app.my_orgs()` returned. A forged value matches nothing
and falls through to the first real membership.

**`proxy.ts` refreshes the session and authenticates nothing.** A server
component cannot set cookies, so a token expiring mid-review would log someone
out with nothing to show for it; the proxy runs where cookies can still be
written. Every page and route still calls `requireSession()`, because a redirect
in the proxy would be one more place that has to agree with the database about
who may see what.

**The views are pure functions of what the store returned.** `components/` holds
them, `app/` reads and renders them. That is what makes them testable without a
signed-in browser, and `apps/web/test/views.test.tsx` covers the parts a reviewer
acts on — the money, the deadlines, the three-way quote mark, and that text out
of somebody else's document arrives as text and not as markup.

**There is no approve button.** Approving is a recorded act by a second person
that the database's gate makes meaningful (invariant 1). A button that only
looked like one would be worse than none, so the review page says plainly that
nothing has been sent anywhere.

## Consequences

The app needs a Postgres connection string whose role may `set role app_rw`,
which is a secret the browser never sees and a thing to provision per
environment. Supabase's pooler is fine for it; the role is not the postgres
superuser in production.

Reads are two round trips from the server rather than one from the browser:
resolve the session, then query. `resolveSession` is a single short transaction
and the alternative is a second authorization model, which is a worse trade.

Real-time subscriptions, Supabase Storage and PostgREST are all unavailable to
this app by construction. If one of them becomes necessary, the custom access
token hook is the path — and the cost is that the policies then depend on a
Supabase-only feature, so the local suite stops proving what it proves today.

## Invariants touched

**6**, upheld: the service-role key is absent from the request path by design.

**1**, respected rather than implemented: the review page reads, and says why it
cannot approve.

## Rollback

Reverting to the PostgREST-and-token-hook shape means writing the policies
against a Supabase-only claim source and losing the local invariant suite's
independence. The parts worth keeping either way are `app.link_auth_user()` and
`app.my_orgs()`, which answer questions the token hook would also have to.

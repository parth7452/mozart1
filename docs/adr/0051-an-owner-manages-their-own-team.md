# 0051 — An owner manages their own team

- Status: proposed (2026-09-26), for the founder; §6 records the founder's
  decision the same day to switch "Allow new users to sign up" on
- Date: 2026-09-26
- Amends: ADR 0015 (who creates a `users` row), ADR 0039 §8 (owner-only
  membership writes now have a door and a floor), ADR 0045 §1 (the form lets
  the provider create an account for an invited address, and a session not made
  by an email link is refused)

## Context

Every person in every workspace was added by an operator. `docs/ONBOARDING.md`
§1 inserts a `users` row and a `memberships` row as the database owner in the
SQL editor, §5 changes or removes a membership the same way, and §2 then sends
an invitation from Supabase → Authentication → Users, because the login form
creates no Auth user (`shouldCreateUser: false`, ADR 0045). The first pilot
customer onboards on 2026-09-28. After that call, a customer who hires an
analyst has to ask us, and we have to open the production SQL editor.

Three things in the schema make a request unable to do this today:

1. `users` has a SELECT-only policy for `app_rw` (0010) and no tenant column,
   so no request can create one. That is deliberate (ADR 0015): creating a
   person is not something a request may do *in general*.
2. `memberships` writes have been owner-only since 0030, but nothing guards the
   result. An owner could demote themselves, or delete the last owner row, and
   leave a workspace nobody can administer. ONBOARDING's §5 blocks re-check
   after the fact; a request path would not.
3. `users.email` is unique case-sensitively only. Two rows that differ in
   capitals make that person unable to sign in (`link_auth_user()` refuses,
   0033; ONBOARDING's R4). The create block reuses a row ignoring capitals; a
   request path has to do the same, and has to do it without being able to
   read `users` rows outside its own tenant.

## Decision

### 1. Three definer functions are the only door, and each is an owner's act

`app.invite_member(email, full_name, role)`, `app.change_member_role(user_id,
role)` and `app.remove_member(user_id)`, in migration 0035. Each is `security
definer`, `search_path` pinned to `pg_catalog, public, extensions`, EXECUTE
revoked from PUBLIC and granted to `app_rw` alone — `app_ro` is read-only and
never executes a writing function.

Each is bounded to the caller's own org claim: none takes an org argument, and
a `user_id` that is not a member of the caller's org is `RCT03` ("not a member
of this workspace"), whether it exists elsewhere or not. Each refuses (42501) a
caller without both an `org_id` and a `sub` claim, and a caller for whom
`app.member_is_owner()` is false. `member_is_owner()` is not definer and reads
the caller's own membership; inside a definer function it reads as the owner,
with the caller's claims, so it answers the same question.

Definer is needed for exactly one table: `users`, which has no write policy and
is shared across tenants. The function reads it only by the address it was
given, and writes it only to insert a new row. It never renames an existing
row: that person may belong to other workspaces, and an owner of one has no
business editing what another sees.

### 2. An address is one person, ignoring capitals

`invite_member` trims and checks the address (the create block's pattern, at
most 254 characters) and the name (at most 200). Under an advisory lock on the
lower-cased address (seed 4, next to 0 for a document read, 1 for a
remittance claim, 2 for a ledger refresh and 3 for an inbound message), it
counts `users` rows with that address ignoring capitals:

- none → insert one, with the address as typed;
- one → reuse it, whatever its capitals and whatever its name;
- more than one → refuse (`cardinality_violation`), as `link_auth_user()` and
  the create block do. An operator decides which row the person is.

A person already in this workspace is refused by name (`RCT01`, "already a
member of this workspace as <role>"): a role change is its own act, never a
side effect of an invitation, as in the create block.

### 3. A workspace always has an owner, and the database says so

An `AFTER UPDATE OR DELETE` row trigger on `memberships`,
`app.membership_keeps_an_owner()`, refuses (`RCT02`, "that would leave <slug>
with no owner") any change after which an org that lost an owner row has none.
It covers every path — these functions, a raw update by an owner as `app_rw`,
and the operator's SQL blocks, whose own after-the-fact check now never fires
first. It takes the org's advisory lock (seed 4 on `team:<org>`) before it
counts, so two owners demoting each other at once cannot both succeed: the
second waits, then counts with a fresh snapshot and sees the first. An AFTER
trigger sees the whole statement's effect, so a multi-row delete is judged on
where it ends. It is not deferrable: to hand over, promote first, then demote.

### 4. The rest of the runbook's refusals move into the functions

ONBOARDING §5's blocks refuse three more things, and the functions refuse them
too, so the page and the runbook say one thing:

- fewer than two people who can write (owner, approver, analyst) after a role
  change or a removal (`RCT05`): with one, nobody can approve what they
  prepared (separation of duties, migration 0005);
- demoting below owner, or removing, the member an enabled QuickBooks
  connection runs as (`RCT04`): the nightly sync acts as them (ADR 0031 §3);
- demoting below writer, or removing, the member a live email address acts as
  (`RCT04`): every delivery would be refused (ADR 0047 §6).

Those three are the functions' rules, not a trigger's: an operator may still
need to do what they refuse, knowingly, in the SQL editor.

### 5. Every act leaves one audit row naming who

`membership.invited` (`{role, users_row: created|reused}`),
`membership.role_changed` (`{from, to}`) and `membership.removed` (`{role}`),
`subject_table = 'memberships'`, `subject_id` the member's user id, `actor_id`
the caller — 0030's rule for an audit row. The address is not in the payload:
the chain is append-only and hash-linked, and the user id is enough to find it.
A no-op role change writes nothing.

Removing deletes the membership and nothing else. The `users` row stays: their
decisions, approvals and events name it, and it may be another workspace's
member. Their next request resolves no membership and is signed out at the
provider (ADR 0045).

No append-only table is touched. `memberships` and `users` keep exactly the
grants they had (0006's mutable list); no UPDATE or DELETE grant is added
anywhere.

### 6. The person's sign-in: the form makes the account, and three layers gate it

**What was found first.** The preferred design — the login action asks the
database whether the address is invited and only then calls `signInWithOtp`
with `shouldCreateUser: true` — does not work while "Allow new users to sign
up" is off. Supabase Auth's own code rules it out (`supabase/auth` master at
`ce9a8ee`, read 2026-09-26): for an address with no Auth user, or an
unconfirmed one, the magic-link path calls `Signup`, and `Signup` begins
`if config.DisableSignup { return … "signup_disabled" }`
(`internal/api/magic_link.go`, `signup.go`). The first version of this ADR
stopped there and set out options A–F for the founder.

**The founder's decision (2026-09-26): sign-ups on.** That makes the form work,
and it also reopens what ADR 0045 closed. The anon key is public, so anyone can
call the provider's `/signup` and `/otp` directly, whatever our form decides.
Reading the source showed that this is worse than stray accounts:

- **Pre-registration takeover.** An attacker calls `/signup` with an invitee's
  address and a password they choose. The provider makes an unconfirmed
  account and mails the invitee a confirmation, which looks exactly like the
  invitation they were told to expect. When the invitee clicks it, the account
  is confirmed *with the attacker's password*. The invitee asking our form for
  a link does not help: for an unconfirmed account `Signup` deliberately does
  not touch it ("we can't be sure of their claimed identity", `signup.go`), so
  the password survives. The attacker then signs in with it, and
  `link_auth_user()` resolves the session to the invitee's `users` row.
- **Strays.** Every other address typed at `/signup` becomes an Auth user.

So "sign-ups on" ships with three layers, and each covers a gap in the others:

1. **The form asks the database.** `app.address_is_invited(email)` — definer,
   pinned, EXECUTE for `app_rw`, refused to any caller carrying a claim
   (0033's guard), one boolean — is true when exactly one `users` row answers
   to the address ignoring capitals and it has a membership. Two rows answering
   is not an invitation, because `link_auth_user()` would refuse the sign-in
   anyway. `sendSignInLink` sets `shouldCreateUser` to that answer. Every
   address still gets the same "sent" page, invited or not; a fault asking the
   database is shown with a reference, because it does not depend on the
   address. The first email an invitee gets is the provider's "Confirm signup"
   template, whose link signs them in through `/auth/callback` (PKCE,
   `email/signup`).
2. **The provider asks the database.** `hooks.before_user_created(event
   jsonb)`, the before-user-created hook, answers `{}` for an address
   `app.invited_address()` accepts and
   `{"error":{"http_code":403,"message":…}}` for everything else, so a direct
   `/signup`, `/otp`, OAuth or anonymous sign-in cannot make an account for an
   address nobody invited. It lives in its own schema, `hooks`, so
   `supabase_auth_admin` — the role the provider connects as — holds USAGE on
   one function and nothing in `app`. It is definer and pinned, and refuses any
   caller carrying a claim. **The founder enables it** in the dashboard:
   Authentication → Hooks → Before User Created → Postgres →
   `hooks.before_user_created`.
3. **The app refuses a session it did not make.** `requireSession` reads the
   `amr` claim of the access token `getUser()` has just had the provider
   verify, checks its `sub` is the verified user, and refuses — before the
   database is asked who this is — any session whose methods are not all
   `otp`, `magiclink` or `email/signup`. Those three are the only ways this
   app signs anyone in: a PKCE magic link, a PKCE sign-up confirmation, and a
   `token_hash` link (`internal/models/factor.go`, `verify.go`, `token.go`).
   A password sign-in is recorded as `password` for the session's whole life,
   refreshes included (`sessions.go`, `CalculateAALAndAMR`), so the takeover
   above is refused, and logged as an account somebody holds a password for.
   Only that session is signed out (`local` scope), so the invitee's own
   session survives. A token that cannot be read is a fault, not a guess.

What the source says about the hook, and why layer 3 is still needed:

- **Which paths call it.** Sign-up (and so a magic link with `create_user`),
  phone OTP, OAuth, OIDC, SAML, web3, anonymous sign-in, generated sign-up and
  invite links, and **the admin invitation the dashboard sends**
  (`internal/api/hooks.go` and its callers). The one path that does not is the
  admin create-user endpoint (`admin.go`), which needs the service-role key.
- **An account that already exists, unconfirmed, never reaches it.** Anything
  pre-registered while sign-ups were on and the hook was off is past the hook
  for good. Layer 3 is what makes such an account harmless, and the operator
  can find and delete them (PR body, and ONBOARDING §2).
- **It is a gate on creation, not on use.** Once an account exists, the hook
  has nothing to say about how it signs in.
- **The output must be exact.** An error with no message, or an `http_code`
  sent as a string, *allows* the account. The function builds its answer with
  `jsonb_build_object` and an integer, and suite 31 pins the exact JSON. An
  exception fails the request closed.

**Three dashboard settings layer 3 depends on, which stay as they are.**
"Confirm email" on: with it off, `/signup` for an existing unconfirmed address
hands back a session at once (a `password` one, which layer 3 refuses, but
nothing should rest on one layer). "Secure email change" on: a session the app
refuses is still a session to the provider, and without it a password session
could move the account to an attacker's address and come back through an email
link. The phone provider off: `otp` is also what a phone code records, though a
phone-only account has no address `link_auth_user()` could match. A Custom
Access Token hook could refuse a password session at the provider itself; that
is a follow-up, not needed for layer 3 to hold.

**What an operator's dashboard invitation does now.** It runs the hook too, so
inviting an address with no `users` row and membership is refused. Add the
person first (Settings → Team, or ONBOARDING §1), and then either nothing more
is needed — their first link makes the account — or the dashboard invitation
works as before.

**Enumeration is no worse than before.** With the hook on, a direct `/otp` with
`create_user` answers 403 for an address nobody invited and 200 for an invited
one or an existing account. With sign-ups off it answered 422 for a new address
and 200 for an existing account. Both have told an anon-key holder whether an
address is a Mozart user. Our own form answers every address alike.

**Timing.** The first link's PKCE code expires five minutes after it was
*sent*, not after the click (`flow_state.go`, `IsExpired`, for any method but
`magiclink`). A late click still confirms the address, the callback then says
"that link has expired", and the next link — now an ordinary magic link —
works. The welcome message says so.

**Options not taken.** C (gate only in the form) is what "sign-ups on" would
have been without layers 2 and 3. D (Admin API from a route) is forbidden by
invariant 6. E (Admin API from a job) and F (an operator script) still need
the service-role key and are unnecessary now. Sending our own invitation email
would be a new outbound side effect and is not done.

## Consequences

- A customer's owner adds a teammate, changes a role and removes someone from
  **Settings → Team**, and the person signs in at app.mozart.financial with
  that address: the first link they ask for makes their account. Nobody
  presses anything in the Supabase dashboard. The SQL route in ONBOARDING
  stays as the fallback and is still tested.
- The founder must enable the before-user-created hook after migration 0035 is
  applied. Until then, layer 1 and layer 3 hold, and strays can still be made
  through the API.
- An operator's dashboard invitation now needs the `users` row and membership
  first, because the hook refuses anyone else.
- The last-owner rule now holds on every path, the operator's included.
- Everyone in a workspace sees its member list: names, addresses, roles and
  whether each has signed in. `read_only` and `accountant_guest` included. That
  was already readable through RLS (0010's `users` policy); now it is shown.
- Every request now reads the verified token's `amr`. Supabase has always
  written it; if a custom access-token hook ever rewrote it, every sign-in
  would fail loudly with a reference rather than let a session through.

## Invariants touched

- **2 (append-only):** no table's mutability changes; `audit_log` gains rows
  only. No UPDATE/DELETE grant added.
- **6 (RLS; no service role in a request path):** the only definer writes are
  the three team functions, bounded by the caller's claims and ownership. The
  two definer reads (`app.address_is_invited`, `hooks.before_user_created`)
  answer one bit about one address, and refuse any caller carrying a claim.
  `supabase_auth_admin` gets USAGE on the `hooks` schema and EXECUTE on the one
  function, and nothing else. The service role appears nowhere (§6 rejects D).

## Rollback

First disable the hook in the dashboard (Authentication → Hooks): while it is
enabled, a dropped function is an error on every account the provider would
create, which fails closed but fails everyone.

Then drop what 0035 added:
`drop function hooks.before_user_created(jsonb); drop schema hooks;`
`drop function app.address_is_invited(text), app.invited_address(text),
app.invite_member(text, text, membership_role),
app.change_member_role(uuid, membership_role), app.remove_member(uuid),
app.team_owner_org(text), app.team_member_holds(uuid, uuid, text)`;
`drop trigger membership_keeps_an_owner on memberships; drop function
app.membership_keeps_an_owner()`.

The audit rows stay, because `audit_log` is append-only, and the memberships
they describe are ordinary rows. Revert the web change with it, since the login
form asks `app.address_is_invited()` on every send. If the migration is rolled
back and sign-ups stay on, switch them off: layers 1 and 2 are gone.

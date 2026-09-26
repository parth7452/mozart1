# 0051 — An owner manages their own team

- Status: proposed (2026-09-26), for the founder
- Date: 2026-09-26
- Amends: ADR 0015 (who creates a `users` row), ADR 0039 §8 (owner-only
  membership writes now have a door and a floor)
- Leaves open: how a new person's Supabase Auth user is created (§6) — a
  decision for the founder, with the options set out below

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

### 6. What this does not do: create the person's sign-in

**The preferred design does not work while sign-ups are off.** It was: the
login action asks the database (a claimless definer function, 0033's shape)
whether the address has a `users` row with a membership, and only then calls
`signInWithOtp` with `shouldCreateUser: true`, so Supabase creates the Auth
user and mails one link. Supabase Auth's own code rules it out
(`supabase/auth`, `internal/api/magic_link.go` and `signup.go`, read
2026-09-26): for an address with no Auth user, or one never confirmed, the
magic-link path calls `Signup`, and `Signup` begins

```go
if config.DisableSignup {
    return … ErrorCodeSignupDisabled, "Signups not allowed for this instance"
}
```

So with "Allow new users to sign up" off — production's setting since ADR 0045
— `shouldCreateUser: true` still answers `signup_disabled` for exactly the
people it was meant to reach. ADR 0045 §1 described the same path from the
other side.

This ADR therefore stops there, as the brief required, and ships the half that
does not depend on it: an owner adds, re-roles and removes people with no SQL.
The Auth user is still created as today, by the founder's dashboard invitation,
and the page says so rather than claiming the person can sign in:

- an invitee whose `users` row is already linked (`auth_user_id` not null — for
  example our analyst, who signs in to other workspaces) can sign in at once,
  and the page says "They can now sign in at app.mozart.financial with this
  address";
- anyone else is shown as **waiting for their sign-in invitation**, with the
  copyable welcome message for when it has been sent.

The options, for the founder:

| | Option | What it costs |
| --- | --- | --- |
| A | Keep the dashboard invitation (this PR as it stands) | One click per person by us. No new risk. The customer's owner cannot finish an invitation alone |
| B | Turn sign-ups back on, gated by a **`before-user-created` Auth hook** (a Postgres function the Auth server calls before it creates any user) that refuses an address with no invited `users` row + membership, and switch the login action to `shouldCreateUser: true` for invited addresses | The gate stays in the database, and covers every creation path (the form, a direct call to the Auth API with the public anon key, OAuth), not only our form. Costs a migration granting `supabase_auth_admin` EXECUTE on one function, a dashboard change, and a way to test it (the hook cannot run in `pnpm db:test`'s vanilla Postgres; the function can). The first link is Supabase's confirmation email rather than its magic-link template. Recommended if A is too slow |
| C | Turn sign-ups on and gate only in the login action | **Loosens.** The anon key is public, so anyone can call `/auth/v1/otp` or `/signup` directly and create Auth users for any address — exactly what ADR 0045 closed. Not recommended |
| D | Call the Admin API (`inviteUserByEmail`) from a route | Needs the service-role key in a request path. **Forbidden by invariant 6** |
| E | Call the Admin API from an Inngest job queued by the invite route | Invariant 6's letter allows a server-side job; but the key would sit in the same Vercel deployment as every request path, CLAUDE.md's `web` row says it "appears nowhere", and it is a new outbound side effect (Supabase mails the person). Needs its own ADR |
| F | An operator command, `pnpm invite:auth`, run by us with the service-role key from `.env` | No request path touches the key; still us, but no dashboard. Marginal over A |

Sending our own invitation email is also a new outbound side effect and is not
done here.

## Consequences

- A customer's owner can add a teammate, change a role and remove someone from
  **Settings → Team**. For a new address, we still send the dashboard
  invitation until §6 is decided. The SQL route in ONBOARDING stays as the
  fallback and is still tested.
- The last-owner rule now holds on every path, the operator's included.
- Everyone in a workspace sees its member list: names, addresses, roles and
  whether each has signed in. `read_only` and `accountant_guest` included. That
  was already readable through RLS (0010's `users` policy); now it is shown.

## Invariants touched

- **2 (append-only):** no table's mutability changes; `audit_log` gains rows
  only. No UPDATE/DELETE grant added.
- **6 (RLS; no service role in a request path):** the only definer writes are
  the three functions, bounded by the caller's claims and ownership. The
  service role appears nowhere (§6 rejects D).

## Rollback

`drop function app.invite_member(text, text, membership_role),
app.change_member_role(uuid, membership_role), app.remove_member(uuid)`;
`drop trigger membership_keeps_an_owner on memberships; drop function
app.membership_keeps_an_owner()`. The audit rows stay (append-only), and the
memberships they describe are ordinary rows. The page would then fail loudly on
its first write, so revert the web change with it.

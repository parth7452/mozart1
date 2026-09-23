# 0039 — A customer connects their own ledger

- Status: accepted
- Date: 2026-09-23

## Context

ADR 0031 built the scheduler, ADR 0033 sealed the tokens, and ADR 0035 and
0036 made what the sync reads correct. Production's first real sync completed
on 2026-09-23 and opened two cases. Nothing yet lets a **customer** connect a
ledger. The one way in is `pnpm link:qbo`: an operator pastes a refresh token
from Intuit's OAuth playground into a laptop `.env`, and ADR 0033 named that
exposure itself. Until the customer can press a button, the coverage thesis
depends on someone holding their credentials by hand.

Building the button showed that the rules around a connection were never
decided, because nothing but an operator had ever made one:

1. **Who may connect?** `accounting_connections.tenant_insert` asks
   `app.member_may_write()`, so any analyst could make the connection that
   every nightly sync then acts as (ADR 0031 §3). Nothing ties `created_by` to
   the caller, so an insert could name any user id at all, and the trigger
   that freezes the company does not freeze `created_by`.
2. **How does a connection move?** ADR 0031 §3 says a connection whose member
   has left is moved as "a new row, `created_by` somebody current". But
   `unique (org_id, provider, provider_account_id)` forbids a second row.
   docs/qbo-credentials.md tells the operator to re-run `link:qbo` "as somebody
   current" after a `refused` run. That only appends tokens to the old row, so
   the run stays `refused`.
3. **Can two workspaces read one company?** Nothing stops it. If they do, both
   open cases for the same short-pays, both dispute them with the payer, and
   both bill the fee.
4. **Is token refresh serialized?** No. It is safe today only because the
   nightly sync is the one thing that refreshes. A consent flow adds three
   more writers of a company's tokens: connect, disconnect and the first sync
   it queues. Intuit replaces a refresh token on every refresh, so two
   refreshes racing on one token leave one of them holding a dead token.
5. **What does a failed reconnect cost?** A reviewer found that the first
   design's order (claim the connection, commit, then seal and store the
   tokens) could leave a working connection disabled behind an enabled one
   with no tokens.

Reading the policies also turned up a gap that is not about ledgers:
`memberships` takes migration 0010's generic write policies, so any writer can
update their own membership to `owner`. "Owner only" is only as strong as the
rule for who can become an owner.

## Decision

### 1. Consent runs in the app, as OAuth 2.0 authorization code

- The start route is `POST /settings/quickbooks/connect`. It sends the browser
  to Intuit's authorization endpoint with:
  - `response_type=code`;
  - one scope, `com.intuit.quickbooks.accounting`, and no `openid`, `profile`
    or `email`;
  - a `redirect_uri`;
  - a `state`.
- Intuit sends the browser back to `GET /settings/quickbooks/callback` with a
  `code`, the `state` and the `realmId`.
- The endpoints are the ones Intuit's discovery documents publish, identical
  for sandbox and production:
  - authorization: `appcenter.intuit.com/connect/oauth2`;
  - token: `oauth.platform.intuit.com/oauth2/v1/tokens/bearer`;
  - revocation: `developer.api.intuit.com/v2/oauth2/tokens/revoke`.

**The redirect URI is derived rather than configured:
`${env.siteUrl}/settings/quickbooks/callback`.** In production that is
`https://app.mozart.financial/settings/quickbooks/callback`, the value
registered at Intuit. A derived value cannot be mistyped. Intuit refuses any
redirect URI it does not have registered, so a deployment whose origin does
not match fails closed with an error on Intuit's own page.

**The start route refuses to begin on any other host.** The state cookie in §2
is host-only, and so is the session. A Connect pressed on
`mozart1-web.vercel.app` would come back to `app.mozart.financial` with
neither. So the start route compares the request's host with the redirect
URI's host. If they differ, it sends the person to the canonical settings page
to press Connect there. Nothing goes to Intuit.

### 2. State is a single-use nonce in a host-only cookie

- The start route mints 32 random bytes, base64url-encoded, as the `state`.
- It sets a cookie, `__Host-recouple_qbo_oauth`, holding the nonce, the org,
  the user and the time it was issued.
- The cookie is `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/` and
  `Max-Age=600`.

The callback compares the `state` parameter with the cookie's nonce in
constant time, and refuses a cookie older than ten minutes. It clears the
cookie on every path through its own code. It then re-derives everything else
from the live session:

- the cookie's user must be the session's user;
- the cookie's org must be one of the session's own memberships, and the
  member must still be an owner there;
- `app.member_may_write()` is asked of the database.

The nonce is the only claim the cookie makes that is taken on trust. That is
why there is no table for OAuth state, which would be a mutable table and a
cleanup job for a ten-minute value. It is also why there is no HMAC, which
would need a new secret for claims that are all re-checked anyway.

*Amended 2026-09-23, after the first production click-through.* The callback
was requested twice, a second apart. The first request connected and spent the
cookie, so the second was refused, correctly, and its "could not be matched"
notice replaced the success on the owner's screen. A refusal is still a refusal:
it exchanges nothing. What changes is the notice in the two cases that explain
themselves, and only when **this member's own** connection to the company in the
URL stored a sign-in in the last two minutes:

- the arrival has **no cookie at all** — the first arrival spent it;
- the arrival still carried the cookie, but Intuit refused its code as already
  spent — the first arrival was still running. The callback asks once a second
  for up to five seconds, since the first may still be finishing.

Either way the page says the company is connected. That is a read through RLS
of what the settings page shows anyway, so a forged link learns nothing and
changes nothing by it. A mismatched, malformed or other member's cookie is
refused exactly as before, and the cookie now outlives the state by a minute so
that an expired consent arrives with its cookie and is refused as expired
rather than looking like a repeat. Every refusal and every connect is logged
with the request's `Sec-Fetch-*` and `Sec-Purpose` headers and the notice
given (never a value from the URL), so the next double request will show where
it came from.

**The callback is the one GET in this app that writes.** It is reached by a
cross-site top-level redirect from Intuit, so `Sec-Fetch-Site` is `cross-site`
and `isCrossSite` would refuse it. It does not call `isCrossSite`, and says
why in a comment. The state is its CSRF defence, which is why the tests that
pin state handling are the load-bearing ones. `SameSite=Lax`, not `Strict`,
because a `Strict` cookie is not sent on that redirect. The start route is a
POST and does call `isCrossSite`.

### 3. The code is exchanged in the request, and proven before anything is written

The callback exchanges the code for tokens in the request, never in a job:

- the authorization code is a credential, and ADR 0021 and 0031 keep event
  payloads to ids;
- the request is also where a person is waiting to be told what happened.

Before any row is written, the new access token must read
`GET /v3/company/{realmId}/companyinfo/{realmId}`. Only an answer of 200
proceeds. `realmId` arrives as a query parameter anyone can edit, and it is
checked to be digits before any request is built (`assertQboId`). Without this
check, a member could file a company they do not administer and, under §7,
lock its real owner out of it.

### 4. Sealed before the database is touched, then one transaction

The encryption context is `{orgId, realmId}` (ADR 0033 §3), and both are known
before any connection row exists. So the order is:

1. exchange the code and verify the company (§3);
2. seal the token set;
3. take the company's lock (§5);
4. in **one** transaction:
   - claim the connection (§6);
   - insert the sealed credential row;
   - write the audit row.

A failure anywhere in step 4 rolls all three back. That includes another
workspace holding the company (§7), a policy refusal, and a statement the
database refuses. A reconnect that fails therefore leaves the connection that
was working exactly as it was: still enabled, with its latest tokens still the
latest row. On a cross-workspace refusal, the one data key spent sealing
tokens that are never stored is the whole cost.

The insert statement is shared, not copied. `PostgresQboTokenStore.save` (a
rotation) and the claim both call one helper that writes a sealed row on a
client they pass in.

### 5. One lock per company, taken by everything that changes its tokens

`pg_advisory_xact_lock(hashtextextended(provider || ':' || realm, 2))` is the
waiting form, on the store's lock pool. The pieces:

- **Seed 2.** Seed 0 is taken by `withDocumentRead`'s document ids and the two
  hash-chain triggers' keys. Seed 1 is taken by `withInvoiceClaim`'s
  org:invoice keys. Seed 2 cannot collide with either.
- **Transaction-scoped.** The pooler is transactional (`withDocumentRead`'s
  reason). The lock connection holds nothing but the lock. The work runs on
  the ordinary pool and commits there before the lock is released.
- **The waiting form, not `try`, with a bound.** The work inside is short, and
  a caller that gave up at once would fail a connect or a sync for no reason.
  But a holder's work includes a call to Intuit, so the wait is capped:
  `lock_timeout` of 15 seconds, and a wait that runs out is
  `LedgerAccountBusyError` with nothing changed. Every OAuth call is bounded
  at 10 seconds, body included, so a callback — two calls, a seal and at most
  one wait — ends inside its 60-second budget with a notice rather than being
  killed after the code was spent.
- **A failed lock connection is destroyed, not pooled.** Its transaction may
  still be open or aborted, and the next borrower of the lock pool — a
  document read, an invoice claim — would fail on it. The same now holds for
  `withDocumentRead` and `withInvoiceClaim`, which share that pool.

It is taken by:

- **every token refresh.** `QboTokenStore` gains `withRefreshLock(realmId,
  work)`. When `QboClient` finds the access token near expiry, it takes the
  lock and **reads the tokens again under it**. It refreshes only if they
  still need it. Whoever held the lock before may already have rotated them,
  and refreshing again with the token they replaced is exactly the race this
  exists to stop. The in-memory store implements the same method with a
  promise chain.
- **connect, reconnect and move** (§6), around the one transaction of §4.
- **disconnect** (§9), around the disable and the revoke.
- **`pnpm link:qbo` and `pnpm unlink:qbo`**, because they call the same
  functions (§11).

It is never nested. Each of those paths takes it once, and nothing inside one
takes it again.

### 6. The claim rule

Under the lock, reading only this org's rows (RLS):

1. If another member's row in this org holds the company enabled, it is
   disabled. This is the move ADR 0031 §3 asked for, and it is finally
   possible.
2. If this member already has a row for the company, it is re-enabled and
   reused. Its run history and credential chain carry on.
3. Otherwise a new row is inserted, `created_by` this member.

The outcome is:

- `moved` when step 1 disabled something;
- `reconnected` when step 2 found this member's row;
- `connected` otherwise.

The replaced connection's id travels with a move. `unique (org_id, provider,
provider_account_id, created_by)` makes "this member's row" unambiguous, so a
member has at most one row per company per org, however many times the
connection moves.

The old `unique (org_id, provider, provider_account_id)` is dropped, since it
is what made a move impossible. `connectionForAccount` now prefers the enabled
row and otherwise takes the most recently updated one.

### 7. At most one enabled connection per company, across the deployment

A partial unique index enforces it:
`accounting_connections_one_enabled_per_account on (provider,
provider_account_id) where enabled`. For enabled rows it also covers the old
per-org rule.

If another workspace holds the company enabled, the claim's insert or
re-enable raises `23505` on that index. It is mapped to
`AccountConnectedElsewhereError` only after the store has confirmed that no
row in this org holds the company enabled, which the claim has just ensured.
So the mapping cannot misreport a same-org conflict. The index name is pinned
by a test, because a rename would turn the named refusal into a generic
failure.

This discloses one fact across tenants: some other workspace here holds this
company. It is disclosed to a person who has just proved at Intuit that they
administer those books, and it names nothing else. That is the price of not
disputing and billing the same short-pay twice.

**The protection is partial, and that is said here.** It stops two workspaces
reading one company at the same time. It does not stop a hand-over: workspace
A disconnects, workspace B connects, and B's first sync rediscovers
deductions A already disputed or billed. Refusing that needs the
identity-resolution record to cross tenants, which is a larger decision than
this one.

### 8. Only an owner, and the database says so

- **`app.member_is_owner()`**: `language sql stable`, not `security
  definer`, with a pinned `search_path` (0010 §4, ADR 0037). It reads the
  caller's own membership under the same RLS `app.member_may_write()` does.
  EXECUTE is granted to `app_rw` and `app_ro` and revoked from `public`.
- **`accounting_connections`**: insert, update and delete require an owner.
  Insert also requires `created_by = app.current_user_id()`, so the member a
  sync acts as is always the member who made the connection. The trigger now
  freezes `created_by` beside the org and the company, so a different member
  always means a different row (§6).
- **`memberships`**: insert, update and delete require an owner. This closes
  the path by which any writer could promote themselves (0010's generic
  policies). Nothing in the application writes `memberships`. Members are
  added by an operator as the table owner, and that is unchanged.
- **`accounting_credentials`**: insert keeps `app.member_may_write()`. The
  sync acting as `created_by` writes every rotation, and that member may have
  been demoted to an analyst since. It now also requires `created_by =
  app.current_user_id()`: a token set always names who stored it.
- **`audit_log`**: insert requires `actor_id = app.current_user_id()`. This
  change is its first writer, and an audit row naming somebody who did not act
  is worse than no row.

All five are tightenings of INSERT/UPDATE/DELETE **policies**. No grant is
added anywhere, and no append-only table gains UPDATE or DELETE.

The route checks the role first, so a non-owner gets a sentence rather than a
policy error. That check is the better error message, not the enforcement.
The store asks `app.member_is_owner()` before its first write and raises
`OwnerRequiredError` by name. The policies are what refuse.

### 9. Disconnect disables first, then revokes, and says which happened

Under the lock:

1. `enabled = false` and an audit row, committed together. The database is
   the truth of whether we sync, and from this commit on nothing does.
2. The latest tokens are opened and the refresh token is revoked at Intuit.
3. A second audit row records the result: `confirmed`, `failed` or
   `not_attempted` (not attempted when this deployment cannot build the Intuit
   app config or the cipher).

A failed revoke is reported, not swallowed. It does not undo the disable. The
notice tells the owner to also remove the app under QuickBooks → Settings →
Apps.

**Revoking happens only on an explicit Disconnect**, never on a reconnect, a
move or a cross-workspace refusal. Whether Intuit's revoke ends one grant or
the app's access to the company as a whole is not verified. If it is the
whole company, revoking on a move would kill the connection that was just
made. The same unknown decides what a move leaves behind: the previous
member's grant stays sealed on the disabled row, unrevoked and unused, until
Intuit expires it (100 days without a refresh) or a later Disconnect's revoke
turns out to cover it. It is ciphertext in our database, not a plaintext
credential anywhere. The sandbox click-through checks both unknowns before a
real customer connects.

### 10. The first sync is queued on connect

On a successful claim, the callback sends one `ledger/sync.requested` on the
existing event, with a fresh `syncKey`. The sync acts as the new `created_by`.
Its per-org concurrency is already one, so it cannot race the daily run.

A failed send is logged, and the notice says the connection is made and the
daily run will pick it up. A deployment with no Inngest keys has no scheduler
at all, because the daily fan-out is itself an Inngest function. The notice
says that instead of promising a 07:00 run that will not happen.

### 11. One path for the button and the operator, and an operator's release

`pnpm link:qbo` calls the same `connectQboCompany`, so it now enables and
moves exactly as the button does. It refuses a member who is not an owner, by
name. Its `--dry-run` says whether the real run would connect, reconnect or
move.

The reviewer's hardest question was this: with one enabled connection per
company, a connection that stays enabled after its grant died blocks every
other workspace for good. Examples are an agency that stopped working for the
manufacturer, or an org whose owner left. **`pnpm unlink:qbo` is the
release**:

- an operator acting as an owner of the holding org (`--org`, `--as`, ADR
  0034) runs `disconnectLedger`;
- the audit rows say `operator_command`;
- it revokes where it can.

Releasing automatically after Intuit answers `invalid_grant` is not built. It
would be a write from the job and a new way for a connection to change state
without a person, and it is named as a follow-up rather than slipped in.

### 12. What the settings page shows

`/settings/quickbooks` is a pure view over one read,
`ledgerConnectionOverview()`. It shows:

- each connection's company, whether it is enabled, and who connected it;
- when its token set was last stored and when the refresh token expires
  (`refresh_expires_at`, a plaintext column that is not a credential);
- how its last sync ended, from `ledger_sync_runs`.

It says **needs reconnecting** when:

- there is no credential row;
- the last run failed with `QboAuthError` or `CredentialUnreadableError`;
- the last run was refused with `LedgerSyncRefusedError`, which means
  reconnect as a current owner, and §6 now makes that work.

A run counts only if it finished at or after the latest credential was
stored, so a reconnect clears the warning at once rather than at the next run.
And `QboAuthError` has to mean a refusal: from Intuit's token endpoint only a
400 or 401 (`invalid_grant`, `invalid_client`) is one. A 429 is
`QboRateLimited` and anything else `QboRequestFailed`, so an Intuit outage
during the nightly refresh is a failed run, not an instruction to reconnect.

A deployment that cannot connect shows why, naming the missing variables.

Every member sees the page. Only an owner sees the buttons. Which Intuit
environment the deployment reads is shown as a fact about the deployment, and
recorded on each connect's audit row. A connection made before this change has
no such row, and the page does not guess its environment.

## Options not taken

- **Keep `link:qbo` as the only way in.** It keeps a live refresh token in a
  laptop `.env`, and no customer can connect themselves.
- **A table for OAuth state.** A mutable table and a cleanup job for a value
  that lives ten minutes and is re-checked against the session anyway.
- **An HMAC-signed state cookie.** A new secret to protect claims that are
  all re-verified. Only the nonce is trusted.
- **Exchanging the code in an Inngest job.** The authorization code would sit
  durably in a third party's event store.
- **Updating `created_by` in place to move a connection.** It would silently
  re-attribute every past run and case to someone who did not make them.
- **Letting two workspaces connect one company.** Double discovery, double
  disputes, double fees.
- **A definer function answering "is this company connected elsewhere?".** A
  new cross-tenant read, where the unique index already is the referee.
- **Revoking on reconnect, move or conflict.** It might end the grant that is
  live (§9).
- **A disable-only Disconnect.** A live grant sealed in our database that
  nothing uses. Intuit's production review also expects Disconnect to revoke.
- **Running the first sync inline in the callback.** A ledger walk can outlast
  the request.
- **Releasing a dead connection automatically on `invalid_grant`.** It may be
  right later (§11). Not without its own decision.
- **Leaving `memberships` writable by any writer and calling owner-only
  "enforced by the database".** It would not have been true.

## Consequences

- A customer's owner connects QuickBooks from Settings in about thirty seconds
  at Intuit. The operator's `.env` path remains, as a fallback that now
  follows the same rules.
- **Plaintext tokens now exist briefly in a request function** a browser can
  trigger, not only in the scheduled job, which already runs in the same
  Vercel project:
  - between the exchange and the seal on the callback;
  - between opening a row and the revoke on disconnect.
  They are never logged, never put in an event, a redirect or an audit
  payload, and never in an error message. A test spies on the logs, the
  redirect URLs, the audit payloads and the sent events for them.
- The callback is a GET that writes. Its CSRF defence is the state cookie
  alone (§2).
- Previews cannot complete the flow. By policy they hold no QBO or KMS keys
  (docs/supabase.md), so the page says "not configured" there and the start
  route sends nothing to Intuit.
- **Who may run `link:qbo` changes.** It now needs an owner, and it now
  enables and moves. Production's one connection was made by the owner, who
  remains the owner, so nothing already there changes.
- `createConnection` is removed. The claim is the one way a connection row is
  made, so two insert paths cannot drift.
- Suites 20, 21 and 23 create their connections as an owner, because an
  analyst can no longer do so. Suite 20 adds the assertion that an analyst is
  refused. No assertion is removed. Suite 26 reads this migration's end state
  back.
- Not verified at Intuit, and to be checked on the sandbox before a real
  customer connects:
  - whether a revoke ends one grant or all of them (§9);
  - whether a second consent for the same app and company leaves the first
    grant valid.
  Neither rule here depends on the answer to the second.
- No agent decision path is added and no model is called, so no cassette is
  needed.

## Invariants touched

- **1 (approval gate).** Untouched. Nothing here writes `submissions`,
  `writebacks` or `writeoffs`, and no gate function is read or replaced. The
  cases a sync opens enter at review like any other.
- **2 (append-only).** `accounting_credentials` and `audit_log` get a
  narrower INSERT policy and nothing else. No UPDATE, DELETE or TRUNCATE grant
  is added anywhere, and both tables keep their triggers. `audit_log` gains
  its first writer, appended and hash-chained by `app.chain_audit_log()` as
  0004 built it. `accounting_connections` stays mutable (ADR 0031 §1).
- **3 (integer cents).** Not engaged. There is no money on this path.
- **4 (untrusted content).** No model is constructed. What arrives untrusted
  is Intuit's redirect query: `code`, `state`, `realmId`, `error` and
  `error_description`. `realmId` is checked to be digits. `state` is compared,
  never displayed. `error_description` is never rendered or logged. The
  notices are keys (`lib/notices.ts`).
- **5 (Jev behind `DecisionProvider`).** Not engaged.
- **6 (RLS; the service role).** Strengthened: owner-only in the database,
  `created_by` pinned to the caller and frozen, and self-promotion through
  `memberships` closed. RLS is on every table touched, no definer function is
  added, and the service role appears nowhere.
- **7 (thresholds).** Not engaged.

## Rollback

A new migration, never an edit to 0030:

- drop `accounting_connections_one_enabled_per_account` and
  `accounting_connections_one_per_member`;
- restore the four policies on `accounting_connections` and `memberships`
  to `app.member_may_write()`;
- restore the INSERT policies on `accounting_credentials` and `audit_log`;
- restore the trigger function without the `created_by` check;
- drop `app.member_is_owner()`.

Re-adding `unique (org_id, provider, provider_account_id)` succeeds only if no
org holds two rows for one company. After a move, one of them has to be
retired first, and its run rows name it, so that is a decision about history
rather than a statement to run.

In code: revert the three routes, the page, `connectQboCompany`,
`disconnectLedger`, `unlink-qbo.ts` and `withRefreshLock`. With the lock gone,
refresh goes back to being safe only while the nightly sync is its sole
caller.

Connections made through the button stay, and their sealed tokens stay
readable by the existing store. Audit rows are append-only history of what
happened, and they stay.

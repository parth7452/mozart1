# 0046 — A connection Intuit has refused is released

- Status: accepted
- Date: 2026-09-24
- Closes: the follow-up ADR 0039 §11 named ("releasing automatically after
  Intuit answers `invalid_grant`")

## Context

ADR 0039 made a QuickBooks company connectable from one workspace at a time: a
partial unique index allows one **enabled** `accounting_connections` row per
company across the deployment. It also named the cost of that rule. A
connection that stays enabled after its grant has died holds the company from
every other workspace — an agency that stopped working for a manufacturer, an
org whose owner disconnected the app inside QuickBooks. `pnpm unlink:qbo` is
the release, and it needs an operator. ADR 0039 said that releasing
automatically "would be a write from the job and a new way for a connection to
change state without a person", and left it for its own decision. This is that
decision.

What happens today when a grant dies:

- Every daily run refreshes the token, Intuit answers `400 invalid_grant`,
  `QboClient` throws `QboAuthError`, and the run is recorded `failed`.
- The failure is retriable, so Inngest runs it twice more: three `failed` rows
  a day, and three refreshes with a dead token, for as long as nobody acts.
- The settings page says "Connected — needs reconnecting". Nothing reads the
  company, and no other workspace may connect it.

A grant can die in several ways, and every one of them is final from where we
stand. The customer removes the app inside QuickBooks. The refresh token passes
the expiry Intuit gave it (about 100 days, only reachable if nothing has synced
for that long). A rotated token is lost between Intuit issuing it and us
storing it. After any of these, nothing we can do brings the stored sign-in
back. A person has to consent again.

## Decision

### 1. Exactly two answers mean the stored sign-in is dead

- **Intuit refuses a refresh with `invalid_grant`.** A `400` from the token
  endpoint whose OAuth `error` is `invalid_grant`, on a `refresh_token` grant.
  `QboAuthError` now carries this as `refusal: 'grant_refused'`.
- **The refresh token's own expiry has passed.** `QboClient` refuses to send an
  expired refresh token to Intuit at all. That is Intuit's own
  `x_refresh_token_expires_in`, recorded when the token was issued. It is
  `refusal: 'refresh_expired'`.

Nothing else counts, and each exclusion is deliberate:

- `invalid_client` means Intuit refused **our app's** credentials. That is this
  deployment's fault. It would take every connection down at once, and they
  all come back when the secret is fixed. Releasing them would make every
  customer consent again for our mistake.
- A `429`, a `5xx`, a timeout or an unreadable token response is an outage.
  The next run may answer differently.
- A `401` from the accounting API says an **access** token was refused. The
  next refresh tells us whether the grant behind it is dead.
- No stored token set, or one that will not decrypt
  (`CredentialUnreadableError`), is our problem, not a refusal. The settings
  page already sends a person to the right place for each.

`deadGrantOf(error)` in `packages/qbo` is the one place that answers the
question. It returns `grant_refused`, `refresh_expired` or nothing.

### 2. The release is one transaction, under the company's lock, and conditional

After the run row is written, the job releases the connection through
`releaseDeadLedger` (store-postgres). The release:

1. takes the company's lock, the same advisory lock that connect, disconnect
   and every token refresh take (ADR 0039 §5);
2. in one transaction, as the member the run acts as:
   - reads the latest stored credential for the connection. If it is **not**
     the one the refused refresh presented, it stops. A newer sign-in was
     stored since: the owner reconnected while the run was failing. Turning
     the connection off then would undo a connect that works. Answer:
     `newer_sign_in`, nothing written;
   - turns the connection off (`enabled = false`, only if it is still on).
     Otherwise it answers `already_off` and writes nothing;
   - writes `accounting_connection.disconnected` with
     `{provider, provider_account_id, via: 'ledger_sync', reason,
     credential_id}`. `reason` is `grant_refused` or `refresh_expired`;
     `credential_id` is the dead row;
   - writes `accounting_connection.revoke` with `result: 'not_attempted'` and
     the same `via`. Every disconnect has its revoke row, and this one says
     truthfully that no revoke was sent (§4).

The credential check is why the release can run after the refresh's own lock
is released. Both a reconnect and a rotation store a new credential row under
the same lock. So if the latest row is still the dead one when the release
holds the lock, nothing has signed in since, and turning the connection off
cannot race either of them.

The token store says which row it last opened: `QboTokenStore.loadedCredential()`,
implemented by `PostgresQboTokenStore` as the id of the row `load` read.
`QboClient` re-reads the tokens under the lock before every refresh. So the
last row loaded is the row whose refresh token Intuit refused.

### 3. Owner-only stays owner-only

The release is an UPDATE on `accounting_connections`. Migration 0030 lets only
an owner write that (`app.member_is_owner()`), and nothing here changes it.
The run acts as the connection's `created_by`, who was an owner when they
connected it.

If that member is no longer an owner, the release is refused
(`OwnerRequiredError`). The refusal is logged, the run's failure stands as
recorded, and the operator's `pnpm unlink:qbo` is still the way out. The job
gets no new privilege, the service role appears nowhere (invariant 6), and no
definer function is added.

### 4. What it does not do

- **No revoke call.** Intuit has just said the grant is dead; revoking a dead
  refresh token is a request that can only fail. The revoke row says
  `not_attempted`.
- **Nothing is deleted.** `accounting_credentials` is append-only and keeps
  the dead row. Cases, runs and anomalies the connection produced are
  untouched.
- **No migration.** `enabled` already flips, `app_rw` already holds UPDATE on
  the table under 0030's owner policy, and an audit row already has to name
  its caller as `actor_id`.

### 5. The run fails once, not three times

The run row is written first, `failed` with `QboAuthError`, exactly as today:
it is the record that a walk of the window was attempted and did not finish
(ADR 0031 §2). Then comes the release, and then the error is re-thrown.
`asLedgerSyncFailure` now treats a dead grant as settled and returns a
`NonRetriableError`: a refused grant does not come back because we asked twice.

### 6. What people see

- **Settings → QuickBooks** says "Not connected". Beneath that:
  - When the latest turn-off was this release, one line says so: "QuickBooks
    refused the stored sign-in for company … on YYYY-MM-DD, so it was turned
    off automatically and nothing reads it now. Connect QuickBooks to sign in
    again."
  - The **Earlier connections** table's "Turned off" cell adds "after
    QuickBooks refused its sign-in".
  - An owner's **Connect QuickBooks** reconnects the same row
    (`connectQboCompany`), exactly as Reconnect did.
- **The daily fan-out** lists enabled connections only, so it stops syncing
  the company.
- **Another workspace** may now connect the company.
- **/coverage** still shows the failed run.
- **The logs** say which of the three the release answered. The line carries
  ids and one of three outcomes, nothing from Intuit:
  `[recouple] ledger sync: connection … for org …: QuickBooks refused its
  stored sign-in (grant_refused); released …`.

## Options not taken

- **Release on any `QboAuthError`.** `invalid_client` and an unreadable token
  response would take every customer's connection down for a deployment
  fault (§1).
- **Release after N consecutive failures.** A refused grant is final at the
  first answer. Waiting only keeps the company held for longer and writes more
  failed rows. The race that matters (a reconnect in between) is answered
  exactly by the credential check, not approximately by a count.
- **Release inside the token store, in the refresh's own lock.** Race-free
  without the credential check. But it would hide a connection's lifecycle
  inside a class whose job is keeping tokens, and every other caller of
  `QboClient` would inherit it.
- **Keep the row enabled and mark it dead in a new column.** That needs a
  migration, and the unique index would still hold the company, which is the
  harm this ADR exists to remove.
- **Revoke as well.** There is nothing live to revoke (§4).
- **Delete the connection.** Nothing here ends that way.

## Consequences

- A dead connection frees its company on the first run that meets the
  refusal: the next daily run at 07:00 UTC, or the first sync after a
  connect.
- A company whose grant died is read by nobody until a person consents again.
  That was already true. What is new is that the page says so plainly, and the
  company is no longer held from anyone.
- A wrong release costs one Connect press. That would take Intuit answering
  `invalid_grant` to a grant that is alive, which its own OAuth contract says
  does not happen. Nothing is deleted, and the same owner's connect re-enables
  the same row.
- A connection whose member is no longer an owner is not released
  automatically (§3). This is the one case that still needs the operator
  command.

## Invariants touched

None of the seven. Invariant 2: every write is an INSERT into `audit_log` or
the UPDATE of `enabled` that 0030 already allows, and nothing append-only is
updated or deleted. Invariant 6: the job runs as `app_rw` with the member's
claims, as every sync does. Invariant 7: no threshold moves.

## Rollback

Revert the code. Connections already released stay off until a person
connects them, and that is the correct state for a dead grant. There is no
schema to undo.

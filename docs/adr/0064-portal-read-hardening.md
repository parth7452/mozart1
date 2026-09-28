# 0064 — Portal read hardening: a capture is written with its arrival, a held connection stays off, and a capture belongs to its run

- Status: accepted pending the founder's go for applying migration 0039. The
  code change (§1) ships with the branch; the migration is applied to
  `mozart-preview` first and then production only on the founder's word, as
  every migration is.
- Date: 2026-09-28
- Amends: ADR 0057 §15 (how `portal_captures` is written and who may write
  it) and its §8 (the refused-credential hold), by moving two rules the store
  kept into the database. Migration 0038 is not edited.
- Adds: no table, no column, no grant, no outbound side effect.

## Context

The review of PR #129 (portal-read plumbing, migration 0038) left four
non-blocking notes on the money path:

1. `PostgresPortalStore.recordCapture` wrote the `portal_captures` row in a
   transaction of its own, after `ingestDocument` had committed the capture's
   `uploads` and `documents` rows in theirs. ADR 0057 §15 and
   `contracts.ts` say a new document's capture row is written in the
   transaction that wrote its `uploads` row. As built, a capture-row failure
   left a `portal_fetch` arrival and a document that no capture row named:
   a stored page with no trail back to the run that fetched it, which is the
   post-audit trail §9 exists for.
2. The refused-credential hold — a connection turned off because the portal
   refused its sign-in (`credential_rejected`), or because its credential was
   removed (`credential_removed`), stays off until a newer credential is
   stored — was enforced only by `PostgresPortalStore.enableConnection`
   reading `audit_log`. Any other writer holding UPDATE on
   `portal_connections (enabled)` — an owner's session through SQL, a future
   route that forgot the store — could turn it back on, and the next run
   would type the password the portal refused.
3. `portal_captures`' INSERT policy admitted any writer of the org. The
   consistency trigger checks the run is not a dry run and the version is the
   run's, but not that the caller is the member the run acts as, nor that the
   run is still going: any analyst could append a capture row to any run.
4. Two comments said a start with no recipe version "ends not_configured";
   it can also end `refused` (a member who may no longer write, a connection
   turned off, terms not allowed).

## Decision

1. **A new capture's row is written with its arrival.** `ingestDocument`
   takes an optional `storeNewDocument` in its deps; when given, it replaces
   the `recordUpload` + `putDocument` pair for a document the tenant does not
   hold. The portal job passes one that calls
   `PostgresPortalStore.recordNewCapture`, which writes the `uploads` row
   (`portal_fetch`, no member), the `documents` row, its bytes
   (`document_blobs`), its text pages and the `portal_captures` row in one
   transaction as `app_rw` with the run's member's claims. A failure anywhere
   writes none of them. A capture of bytes the tenant already held, and a
   capture the door refused, write no `uploads` row, and keep
   `recordCapture` in a transaction of its own — which is what the contract
   says of them.
2. **The database refuses re-enabling a held connection.** Migration 0039
   adds `app.portal_connection_enable_is_not_held()`, a BEFORE UPDATE
   trigger on `portal_connections` that refuses `enabled` false → true while
   a `portal_connection.disabled` audit row with reason `credential_rejected`
   or `credential_removed` names the connection's latest credential (or,
   with none stored, names none) — the store's rule, read from the same
   append-only rows. Invoker, pinned. SQLSTATE 23514, message
   `portal connection enable blocked`.
3. **A capture belongs to its run.** Migration 0039 replaces
   `portal_captures`' `tenant_insert` policy: the caller may write, the run's
   start is this org's and names the caller as `requested_by`, and the run has
   no outcome row yet. The consistency trigger is unchanged.
4. The comments are corrected: `contracts.ts` in place, 0038's header by a
   note in 0039's (0038 is merged and applied, and is not edited).

## Consequences

- A portal document without a capture row naming its run can no longer be
  produced by a failed capture write; a re-delivered step finds the bytes and
  replays the row through `recordCapture`, as before.
- `document_blobs` for a portal capture is written in the same transaction as
  its row, rather than first in its own, so a failed capture leaves no
  unreferenced bytes either.
- The hold has two enforcers that must agree: the store answers with a named
  `PortalCredentialReplacementRequiredError` before it tries, and the trigger
  is the backstop for every other path.
- A capture row can no longer be written after the run's outcome row. The job
  writes its capture rows before its `finish` step, so nothing it does
  changes; a replay after the outcome is answered by `recordCapture`'s
  lookup, which inserts nothing.
- No invariant is loosened: no UPDATE or DELETE grant, no change to an
  append-only table's shape, no service role anywhere.

## Rollback

Migration 0039 is additive and idempotent. To roll it back, a later
migration drops the trigger `enable_is_not_held` on `portal_connections` and
its function, and restores 0038's `tenant_insert` policy on
`portal_captures` verbatim. The code change is reverted by reverting its
commit; `recordCapture` still works on its own, only without the shared
transaction.

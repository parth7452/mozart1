# Draft H — Reading a retailer portal, one retailer at a time, and never writing to it

- Status: **proposed**
- Date: 2026-09-24
- Builds on: STRATEGY §5.1 and §5.4 (portal **read** moves to Phase 2; portal
  **write** stays in Phase 6), CLAUDE.md ("Portal credentials, when they
  arrive, belong in KMS-backed storage…"), ADR 0033's sealed-token pattern,
  `EvidenceSource` (`kind: 'portal'`), `uploads.source` `portal_fetch`

## Context

A payer's portal holds what the ledger cannot:

- the claim number and reason code;
- the payer's own backup documents;
- the dispute deadline;
- the claim's status.

Reading it serves two jobs:

- **discovery:** deductions the supplier never forwarded;
- **evidence:** the payer's own backup for a case we hold.

There is no portal interface today. `portal_fetch` exists as an upload source,
and `EvidenceSource` has a `portal` kind. Portals bring operational weight:

- MFA;
- session expiry;
- credential rotation;
- per-portal terms of service;
- no stable API.

## Decision

1. **Read only, in code and in the credential.** A portal adapter implements
   `listClaims(window)` and `fetchBackup(claimId)`. It has **no method that
   submits, uploads, clicks "dispute" or changes anything**. A reviewer can
   check that by reading the interface. Portal write is Phase 6 and is refused
   here by name.
2. **One portal at a time, each with its own short ADR** confirming:
   - the terms of service were read and allow automated access;
   - how login and MFA work;
   - the rate limits;
   - what the export gives.

   The first is chosen by the first customer who uses one.
3. **Credentials are sealed like QuickBooks tokens.** They use envelope
   encryption through `TokenCipher` and KMS (ADR 0033), in an append-only
   `portal_credentials` table with a new row per rotation. Nothing is in
   plaintext, in an application column, or in a log. An owner enters them in
   Settings.
4. **A failure degrades, never fails the case.** A login failure, MFA prompt,
   changed page or timeout records a `portal_read_runs` row with a class name
   (the `ledger_sync_runs` pattern). The case goes on with upload and email as
   its evidence path, and the settings page says the portal needs attention.
5. **Everything read is a document, through the same door as an upload.**
   - Every fetched file gets an `uploads` row with source `portal_fetch`, then
     `acceptUpload`, the fail-closed scan gate, and the reader. It is
     untrusted content like every other document (invariant 4).
   - Discovery opens cases through the same identity resolution, so a claim
     seen in the portal and in the ledger converges on one case (ADR 0025).
6. **It runs as a scheduled job, as a member,** exactly like the ledger sync
   (ADR 0031): Inngest, `app_rw` with that member's claims, never the service
   role.

## Options not taken

- **A browser agent that can also submit.** That is Phase 6, and an approval
  gate cannot supervise a tool that can do both.
- **Storing portal passwords in `org_settings`.** CLAUDE.md forbids it.
- **Screen-scraping with screenshots and a vision model.** Where a portal
  offers an export or an API, that is used. Where only pages exist, a
  deterministic parser of the page structure (STRATEGY §6.8) comes before any
  model.

## Consequences

- Coverage gains the channel that sees deductions the customer never
  forwarded, and the payer's own backup.
- Each portal is real work and real operational load, so portals are added
  when a customer needs one, not speculatively.

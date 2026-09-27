# 0061 — An approved packet may be filed on a portal by a recipe, never by an agent

- Status: proposed (2026-09-27). The founder accepts or rejects it, including
  each choice in §6. Nothing is built.
- Date: 2026-09-27
- Depends on: ADR 0057 accepted (worker, recipe registry, sealed
  credentials), and one accepted submission ADR per portal (§3).
- Amends, if accepted: `CLAUDE.md`'s "Do not build yet" and build order (§6);
  ADR 0057's "never written" and its "`portal_agent` stays Phase 6", for
  submit recipes only.
- Adds, if accepted: one outbound side effect (filing a dispute on a payer's
  portal); a `submit` recipe kind; two append-only tables; one channel-scoped
  check on `submissions`; an owner-set switch per connection.

## Context

The founder asked for "a primarily headless agent that goes on the retailer
portal and applies for appeals with the proof packet".

What the code says today:

- `app.require_approval('submit')` (migration 0005) refuses a `submissions`
  row unless an `approvals` row exists for that decision, action `submit`, same
  org and deduction. It checks that an approval exists, not which packet: the
  store compares hashes (`packages/store-postgres/src/workflow.ts`, "The
  database deliberately permits the mismatch", asserted by suite 11).
- An approval names its packet by foreign key onto
  `packets (decision_id, content_hash)` (0016). The hash covers the narrative,
  the ordered document ids and those documents' own hashes.
- `submissions.channel` already admits `portal_agent`, and
  `unique (decision_id, channel)` is once per channel, not across channels: a
  manual row and an automated row for one decision are both admissible today.
- 0017 freezes `packet_hash`, `confirmation_number` and `submitted_at` at
  insert. 0018 settles completeness for `manual_portal` only, leaving every
  other channel to "its own ADR and its own migration".
- `SubmissionChannel` (`packages/adapters/src/submission.ts`):
  `SubmitCtx.approvalId`, "No channel may submit without one".
- ADR 0057: promoted recipes with read-only step kinds, run by
  `services/portal-read`, with credentials only the worker opens, on a role
  "that cannot dispute".
- ADR 0058: UNFI's Dispute Center is Direct Commerce's, on
  `my.directcommerce.com`, whose `robots.txt` disallows all user agents
  (2026-09-26). Its terms check is pending.

## Options

- **A. Keep "never written".** A person files by hand. It stays the fallback.
- **B. An agent that chooses clicks** (STRATEGY's Phase 6 shape). Not taken. A
  model acting on an untrusted page holds tools, so the page can steer it
  (invariant 4), and what it clicks cannot be reviewed beforehand.
- **C. Submit without an approval, or on a blanket one.** Not taken.
  Invariant 1 is a one-way door, and the trigger stays.
- **D. Email submission.** Not taken here. It learns its reference late (ADR
  0022), needs its own ADR, and does not help a payer who takes disputes only
  in the portal.
- **E. A deterministic submit recipe, run for an approved packet only.**
  Chosen.

## Decision (proposed)

### 1. A submission is a recipe run, gated by the database before the browser opens

- `portal_agent` (0005's name) is implemented in the worker as a
  `SubmissionChannel`. No model is involved.
- A **submit recipe** is a new kind in ADR 0057's registry: versioned,
  effective-dated, promoted by a person. Its step kinds are the read kinds plus
  three. `fill` puts a packet value into a named field. `attach` uploads one
  enclosure, identified by hash. `final_submit` presses the one control the
  recipe names, once. No step takes an argument from the page, and no model
  sees the page.
- **Order.** The job names a decision and an approval id only, and the
  worker reads as `app_rw` with the tenant's claims. Its first write, before
  any browser opens, is a
  `portal_submission_attempts` row (append-only, `unique (decision_id)`)
  naming the approval, the packet hash and the recipe version. The same
  `app.require_approval('submit')` trigger is attached to that table, with a
  check that its hash equals the approval's. No approval, no attempt, no
  browser. It cannot be the `submissions` row, because 0017 freezes the
  confirmation number at insert.
- Once the confirmation page has been read, the worker writes the
  `submissions` row: `channel = 'portal_agent'`, `status = 'sent'`, the
  packet hash, the portal's confirmation number and `submitted_at`. The gate
  fires a second time. A new migration adds three checks for `portal_agent`
  only: 0018's completeness rule, packet hash equal to the approval's, and an
  attempt row for the decision. This tightens the gate; being channel-scoped,
  suite 11's assertion about manual filings still holds.

### 2. It fills only what was approved, and keeps what the portal said

- A recipe maps a portal field to one key from a closed set of packet keys:
  claim id, deduction reference, amount (from the case's cents, formatted by
  our code), the packet narrative as the reason, and enclosures. If a required
  field has no mapping, the run stops. A narrative longer than the portal's
  limit (`PlaybookChannelSpec.descriptionCharLimit`) stops the run and is never
  truncated, because truncating it would file words nobody approved.
- For each of the packet's `file_document_ids`, the worker fetches the file
  through `servingRefusal` (clean latest verdict), recomputes its sha256 and
  attaches it only if the hash matches the stored one. If the portal refuses a
  file, the run stops.
- The filled form before `final_submit` and the confirmation page after it
  are captured (screenshot and HTML) and stored as documents through the
  door, with an `uploads` row at ingest, linked to the case. Nothing opens a
  case from them. The confirmation number is read at a named selector and
  must match the recipe's pattern, up to 120 characters (0018).

### 3. Separate from reading

- **Recipes.** A read recipe cannot carry a submit step, and a submit recipe
  is promoted separately, by an owner.
- **Guards.** Its own host and POST allowlist, naming only the dispute
  endpoint. ADR 0057's never-click floor applies to every step but
  `final_submit`; only `attach` touches a file input.
- **Credential.** Reading keeps its least role. Submission uses a
  dispute-capable user sealed as its own `portal_credentials` row and binding,
  which the read connection never receives.
- **Switch.** `may_submit` on the connection is off by default. Only an owner
  may change it (`app.member_is_owner()`, 0030's pattern), and every change
  writes an audit row.
- **Per-portal ADR.** The channel refuses a portal until its submission ADR,
  confirming the terms allow automated submission, is accepted. **UNFI is not
  established.** The Dispute Center's host disallows all agents, and its terms
  are unread (ADR 0058 §2). UNFI submission stays manual.

### 4. Failure stops before the final submit, and a person files by hand

- Before `final_submit`, anything unexpected (a failed `expect`, a challenge,
  a terms prompt, an unmapped field, a refused file, a lost session) ends the
  attempt, unretried. The case stays `awaiting_approval`, approval intact, and
  the page offers today's manual filing with the packet zip.
- **Idempotency.** Right after sign-in, a read step searches the portal's
  disputes for the claim id; a match stops as `already_on_portal`. And
  `unique (decision_id)` gives each decision one automated attempt ever.
- **After the press.** If no confirmation number is read after `final_submit`,
  the outcome is `outcome_unknown`. It is never retried. The case page says the
  portal may already hold the dispute. A manual filing after an unknown outcome
  is refused until the person records that they searched the portal.
- **Recording the end.** Each attempt ends with one append-only
  `portal_submission_ends` row. It holds the attempt id (unique), one of
  `submitted`, `stopped_before_submit`, `already_on_portal` or
  `outcome_unknown`, and a reason constant. It holds no page text.
- **Across channels.** A trigger refuses a `manual_portal` submission while an
  attempt has no end row. It also refuses an attempt once any submission
  exists for the decision.

### 5. Build order and `CLAUDE.md`

- Recipe filing becomes buildable for a portal once its read (ADR 0057 §14)
  runs and its submission ADR is accepted. Browser-*agent* submission stays
  under "Do not build yet"; Phase 6 keeps careful autonomy.
- Lines amended:
  - "**Do not build yet**: browser-agent auto-submission (Phase 6), portal
    *write* of any kind" becomes "browser-agent submission (a model choosing
    clicks), and any portal write other than filing an approved packet by
    recipe (ADR 0061)".
  - The build order gains "recipe filing on a portal (ADR 0061), after that
    portal's read".
  - The opening line "a human approves and submits" becomes "a human approves,
    and submits or has a recipe file the approved packet".
  - ADR 0057's title and §1 are amended for submit recipes only. Its read
    runner is unchanged. "Exactly two bounded steps" is unchanged.

### 6. What the founder decides

1. Accept or reject recipe filing of approved packets.
2. Who starts a filing. Recommended: a "File on the portal" press after
   approval, by any member who may write; the approval stays the authorising
   act.
3. Dry runs. Recommended: for each portal's first five filings the worker
   fills and captures, stops before `final_submit`, and a person files by hand
   and compares.
4. The first portal: one whose terms allow automated submission. Not UNFI
   until its submission ADR is accepted.

## Consequences

- An approved case is filed with no one typing, on portals that allow it.
- A new irreversible outward effect, bounded by the gate, one attempt per
  decision, the existing-dispute check and the stop before submit.
- Each portal needs its own ADR, dispute-capable user and owner switch.

## Invariants touched

- **1**: the trigger is unchanged and runs twice per filing. For
  `portal_agent` the database also checks the packet hash. Nothing is
  relaxed.
- **2**: two new append-only tables and no UPDATE or DELETE grant.
  `submissions.status` stays the only column that can be updated.
- **3**: the amount comes from the case's integer cents.
- **4**: no model sees a portal page on this path, and step inputs come only
  from the packet. Captures are untrusted documents.
- **5, 7**: no model call, no threshold.
- **6**: RLS on both tables, and the worker writes as `app_rw` with claims.

## Rollback

- Turn off every `may_submit`, retire every submit recipe version, and have
  the worker refuse submit jobs. Every case is then filed by hand, as today.
- Rows and captures stay as the record. The channel-scoped check stays
  harmless.

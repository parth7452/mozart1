# 0057 — A portal is read, never written, by a recipe a person promoted

- Status: proposed (2026-09-26). The founder accepts or amends it, including
  each choice in §17. Nothing here is built: no code, no migration, no
  service.
- Date: 2026-09-26
- Promotes: Draft H (`docs/plans/phase-2/adr-drafts/H-portal-read.md`), which
  this supersedes. Draft H's six decisions are kept; where the code contradicts
  Draft H, this ADR follows the code and says so (see *Where this departs from
  Draft H*).
- Amends, if accepted: the build order in `CLAUDE.md`. Portal read for the
  first portal moves ahead of the rest of Phase 2 (§14).
- Adds, if accepted: one new outbound side effect (signing in to a payer's
  portal and reading it); one new separate service (a browser worker); one
  registry and five append-only tables; one new document type at the door, for
  one source only (a page snapshot); and the bounded cold-start loop that
  `CLAUDE.md` already reserves (unknown-payer cold start)

## Context

### What a portal holds, and why reading it comes early

A payer's portal holds what the ledger cannot: the claim number and reason
code, the payer's own backup, the dispute deadline and the claim's status
(STRATEGY §5.1). Reading it does two jobs:

- **discovery**: deductions the supplier never forwarded to us;
- **evidence**: the payer's own backup for a case we already hold.

STRATEGY §5.4 moved portal **read** to Phase 2 and left portal **write** in
Phase 6. Draft H (2026-09-24) wrote that down as six decisions. Since then the
founder and Claude have settled how a portal is actually read: by a recipe
held as data, run by a browser outside Vercel, with a model that reads what
was captured and never drives the browser. This ADR promotes Draft H with
those additions.

### What the code says today

A survey of the code on this branch (HEAD `93e651d`) found that several of
Draft H's premises are only half true:

- **`portal_fetch` is admitted by the database, not by the pipeline.**
  Migration 0014 admits it on `uploads.source`. But `IngestSource` is
  `web_upload | email_in | email_body` (`packages/pipeline/src/ports.ts:58`),
  and `PipelineStore.recordUpload` and `PostgresStore.recordUpload` are typed
  the same way. The ERP path went round that with its own insert
  (`packages/store-postgres/src/discovery.ts:497-534`).
- **There is no portal port.** `'portal'` is one value of
  `EvidenceItem.sourceKind` (`packages/adapters/src/evidence.ts:32`).
  `EvidenceSource.fetch(evidenceType, ctx)` needs a case to exist already
  (STRATEGY §5: "the seams are for evidence retrieval, not deduction
  discovery"). `listClaims` and `fetchBackup` exist nowhere.
- **The door refuses what a portal hands out.** `ALLOWED_MIME_TYPES` is PDF,
  PNG, JPEG, GIF, WebP, TIFF and HEIC (`packages/ingest/src/sniff.ts:26-39`).
  HTML, CSV and XLSX are refused. ADR 0056 (spreadsheets) is accepted and not
  built.
- **The cipher is QuickBooks-shaped.** `TokenEncryptionContext` is
  `{orgId, realmId}` (`packages/crypto/src/cipher.ts:29-33`), and the AAD tag
  is `recouple-token-v1` (`:145-151`). The KMS key is configured as
  `QBO_TOKEN_KMS_KEY_ID`.
- **Nothing on Vercel can hold a browser session for long.** The Inngest route
  runs with `maxDuration = 300` (`apps/web/app/api/inngest/route.ts:43`), and
  the plan allows five functions in flight (`apps/web/lib/inngest.ts:44`).
- **A portal document would open a case by itself today.** `byEmail` covers
  only `email_in` and `email_body` (`packages/pipeline/src/steps.ts:904-905`),
  and `allowCaseOpen` defaults to true (`steps.ts:897`). So a `portal_fetch`
  notice would pass the floor and `typeFits` gate (ADR 0044) and open.

### A browser is tools

Most payer portals, the first one included (ADR 0058), publish no API. What a
portal offers is pages and, sometimes, an export button. Reading them needs a
browser that signs in, clicks and downloads, and a browser is exactly the kind
of tool invariant 4 keeps away from anything that reads untrusted content. A
page is untrusted content. So the design has to separate what drives the
browser from what reads the page, and it has to keep a model that sees a page
from choosing what the browser does next, except inside the one bounded loop
`CLAUDE.md` reserves for it.

## Options

**A. An API or an export only; no browser.** The cleanest source where it
exists, and it is always the first choice for a portal (§3). But most portals,
UNFI's included, document none, so this alone reads nothing.

**B. A general browser agent that a model drives on every run.** It adapts to
a changed page by itself. It is also an unbounded tool loop that sees untrusted
pages every day, is not replayable, and costs a model call per click on a
schedule. Rejected under invariant 4, and because nothing a person reviewed
decides what it does on a given day.

**C. A recipe held as data, run by a read-only runner outside Vercel; a model
reads the captures with no tools; a bounded agent drafts or repairs a recipe
for a person to promote. Recommended.** The scheduled run is deterministic and
reviewable. The model only reads documents, as it does today. The agent is
used rarely, on demand, and what it produces does nothing until a person
promotes it.

**D. Screenshots and a vision model, for driving or for reading.** Rejected,
as Draft H did: where a portal has pages, a deterministic reading of the page
structure comes before any model (STRATEGY §6.8), and captured pages are read
as documents (§4), not as screenshots.

## Decision (proposed)

Option C.

### 1. Read only: in the port, the recipe, the runner and the credential

- **A new port, `PortalSource`.** It is not `EvidenceSource`, whose one method
  needs a case, and not `SubmissionChannel`. Its closest model is
  `AccountingSource`, which is "read-only by construction"
  (`packages/adapters/src/accounting.ts:40-44`). It has one kind of method: run
  a promoted recipe for a connection and return what was captured. It has no
  method that submits, uploads, disputes, accepts or changes anything, and a
  reviewer can check that by reading the interface.
- **It never implements `SubmissionChannel`.** `ChannelKind` already includes
  `'portal_agent'` (`packages/adapters/src/submission.ts:10`), and
  `SubmissionChannel.submit` exists. Both stay Phase 6, untouched.
- **The recipe can only express reads** (§3). The runner that interprets it
  knows a closed set of step kinds, and none of them writes.
- **The runner refuses writes whatever a recipe says.** It never interacts with
  a file input. It never clicks an element whose accessible name or visible
  text matches its own never-click list (dispute, appeal, submit, upload,
  attach, approve, accept, agree, delete, remove, save, create, request, send,
  pay). A recipe may add names to that list for its portal and cannot remove
  one. The one exception is a `dismiss` step (§3) for a control the portal's
  own ADR names. A request to a host not on the recipe's allowlist is blocked. A
  non-GET request during a step that is not `sign_in`, `answer_mfa` or
  `search` is refused, unless the recipe names that path as a read (some
  portals load data by POST).
- **A prompt to accept new terms is a stop.** Accepting a portal's terms is
  the founder's act, recorded in that portal's ADR, never the runner's.
- **A challenge is a stop.** A CAPTCHA or bot challenge is never solved,
  evaded or retried around. The run ends `needs_attention` (§13).
- **The credential is read only where the portal allows it.** The dedicated
  user (§8) is given the least role the portal offers. Where a portal has a
  role that cannot dispute, that is the role.

### 2. One portal at a time, each with its own ADR

Kept from Draft H. Before a recipe runs on a schedule against a portal, a
short per-portal ADR records:

- that the founder read the portal's terms, which documents and versions,
  and what they say about automated access, shared logins, agents and
  confidentiality;
- how sign-in and MFA work;
- what is known of rate limits, and the schedule chosen;
- what each screen and each export gives;
- the hosts the recipe may visit, and the portal's own never-click names.

The first is ADR 0058 (UNFI). Draft H said the first portal would be chosen
by the first customer who uses one. It was chosen instead for the market the
pilot sells into, for reasons ADR 0058 gives.

### 3. A recipe is versioned, effective-dated data with provenance

How to read one portal is a **recipe**: data, not code. It follows Draft D's
discipline for playbooks: versioned, effective-dated, append-only, with
provenance, and used only once a person has promoted it.

**Why data and not code.** Draft D rejected "a JSON file per payer in the
repo" as code by another name. The same test applies here. The runner is
code: a closed instruction set, reviewed once. The recipe is the per-portal
part. It changes when the portal changes, which a payer decides, not a deploy.
It needs per-version provenance (who walked the portal, when, and under which
per-portal ADR). And a person promotes each version. Because the runner's step
kinds are all reads, a recipe cannot express a write, and a reviewer can
check a recipe by reading its steps.

**Step kinds** (the runner knows no others):

| Step | What it does |
| --- | --- |
| `open` | Load an address on the recipe's host allowlist, by GET |
| `sign_in` | Fill the named username and password fields from the sealed credential and press the named sign-in control. The only step that types a secret |
| `answer_mfa` | Enter a code from the connection's TOTP secret or code channel (§8). Anything else is a stop |
| `dismiss` | Press one named control on a notice or banner, located by selector and matched by exact text. A control on the never-click list (a cookie notice's "Accept") is pressed only when the portal's ADR names that exact control. A prompt to accept terms of use never is |
| `follow` | Click a link or tab located by selector, subject to the never-click list |
| `search` | Fill named filter fields from the run's parameters (a date range, a payment or deduction number) and press the search control of a form the recipe marks as a search. Refused if that form has a file input or a field the recipe does not name |
| `wait_for`, `expect` | Wait for, or assert, a selector or text. A failed `expect` ends the run as `page_changed` |
| `capture_page` | Snapshot the page (§9) |
| `download` | Press a named export or download control and keep the file that arrives |
| `for_each`, `next_page` | Repeat a block over rows, or follow pagination, each capped |
| `sign_out` | End the session |

**What a recipe version holds:** the portal key; the step list; the host
allowlist; the portal's never-click names; the paths it may POST to as reads;
caps on pages, downloads and run time; `effective_from`; who drafted it (a
person, or an agent session by id, §5) and from what (a hand walk-through on a
date, or that session's recording); and the per-portal ADR it runs under.

**Promotion.** A version is immutable. A person promotes it with a separate
append-only review row, written by the caller (the authorship-trigger pattern
of 0016 and 0041), and only an owner may. Only a promoted version in effect
runs on the schedule. A changed portal means a new version, never an edit.

**Scope.** A recipe is per tenant at first. A recipe drafted on one customer's
login can carry that customer's identifiers, so sharing one across tenants is
cross-tenant data and a later decision with its own ADR, as ADR 0056 §11 said
of column mappings. Run parameters that differ per customer (supplier numbers,
regions) belong on the connection, not in the recipe, so that sharing stays
possible later.

**Prefer the export.** Where a portal offers an export, the recipe downloads
it rather than walking list pages. A spreadsheet export is read by ADR 0056's
deterministic reader with a confirmed column mapping once that is built, with
no model involved. Page snapshots are for what no export gives.

### 4. A model reads what was captured, and never drives the browser that captured it

- Every capture becomes a document (§9) and is read by the existing reader:
  the same `readDocument`, the same classification and extraction ports and
  the same providers (invariant 5). The reader is constructed with no `tools`
  parameter and receives the text inside `<untrusted_document>` delimiters
  (invariant 4). Nothing about the reader changes.
- A scheduled run sends nothing to a model while the browser is open. The
  runner executes the recipe's steps and nothing else. No text on a page
  reaches the runner as an instruction.
- The captures are read after the run has ended and the browser is closed, by
  a separate job step. The model that reads a page cannot affect what the
  browser did, because the browser is gone.

### 5. A bounded agent drafts or repairs a recipe; a person promotes it

This is the "unknown-payer cold start" loop `CLAUDE.md` reserves.

- **When it runs.** Only when an owner starts it, for one connection: to draft
  a portal's first recipe, or to repair a version whose run ended
  `page_changed`. Never on the schedule, and never as a retry.
- **What it can do.** It drives the worker's browser through the same runner,
  with the same refusals, host allowlist and caps. It does not act freely.
  Code indexes the page's elements and lists the read-only operations that are
  legal on them, and the model picks one (STRATEGY §6.8). The model answers a
  structured choice. It is **not** given a `tools` parameter, and code executes
  the choice.
- **What it never sees.** The credential. `sign_in` is an operation the agent
  may choose; the runner performs it from the sealed credential.
- **What it produces.** A draft recipe version: data, inert until a person
  promotes it (§3). Deterministic code writes the draft row. The agent writes
  nothing else and triggers nothing outbound beyond the read-only browsing
  itself.
- **Bounds.** A step cap and a spend cap per session, both in code. Reaching
  either ends the session with what it has.
- **Recording.** Its model calls go through a port, never a raw client
  (invariant 5), and are recorded on `model_calls` with purpose
  `playbook_draft`, which migration 0007 already admits (a recipe is
  playbook-shaped data; a separate purpose is a check-constraint change the
  build may choose instead). If Jev picks operations, it does so through
  `DecisionProvider` as a registered, versioned question set (STRATEGY §6.7).
- **Cassettes.** Its paths get recorded cassettes for both the Claude and the
  Jev call, as `CLAUDE.md` requires for every agent decision path. They are
  recorded against a fixture portal (a static site kept in the repo), not a
  real one, so CI replays them with no network. The reader's calls on
  captures get cassettes like every other document's.

### 6. The browser runs outside Vercel

- **Why not Vercel.** A sign-in, an MFA prompt, pagination and downloads can
  outlast the 300-second `maxDuration`. A killed run is retried at full cost
  with nothing recorded, which is why paging is off in the app (ADR 0053).
- **Default: our own worker**, `services/portal-read`, deployed the way
  `services/clamav-scan` is (ADR 0018): a container behind an HTTPS front door
  that checks a bearer token in constant time, refuses to start without its
  token, answers `/health`, and runs with billing on so machines are not
  stopped mid-run.
- **Open choice: a hosted browser provider.** Less to operate. The cost is
  that the customer's portal password is typed into a browser a third party
  runs, whose session recordings and logs we do not control. That needs its
  own data-processing review. The default is our own worker.
- **The worker holds no database credential and no model key.** ADR 0055
  (option E) kept a database credential out of a separate service, and the
  same reasoning holds here. The job, running as `app_rw` with the member's
  claims, reads the promoted recipe and the sealed credential. It hands both
  to the worker and writes everything that comes back. The worker holds its
  bearer token and permission to decrypt under the portal-credential key
  (§7), and nothing else.
- **The worker decrypts the credential itself.** The job passes the sealed
  credential as ciphertext. Every field of a `SealedToken` is safe in a
  column (`cipher.ts`), so ciphertext is safe in an authenticated request
  body. The plaintext exists only in the worker's memory for the run and in
  the portal's sign-in form.
- **What a job step may return.** The Inngest event carries ids only
  (ADR 0021). A step's return value is durable in the queue, so:
  - the step that reads the sealed credential sends it to the worker and
    returns only the worker's run handle;
  - the job then polls in later steps;
  - each capture is fetched and passed through `ingestDocument` inside one
    step, which returns only the document id.

  No step returns a credential, a code or a capture's bytes. Every step stays
  well under the function limit.
- **No state between runs.** Each run starts from an empty browser profile and
  discards it afterwards. Keeping a "remember this device" cookie would be
  keeping a credential, so a portal that needs one decides that in its own
  ADR, and seals it like the password.
- **Egress.** The worker's browser blocks every request to a host not on the
  recipe's allowlist.
- **Production only.** The worker's token and the portal KMS key are set for
  Production alone. Previews hold no Inngest keys (`docs/supabase.md`), so a
  preview cannot start a portal read.

### 7. Credentials are sealed: the app seals, only the worker opens

- **Where they live.** In a new append-only `portal_credentials` table, under
  envelope encryption with a cloud KMS, as ADR 0033 §1(b) chose for QuickBooks
  tokens. `CLAUDE.md` says portal credentials belong "in KMS-backed storage and
  never in an application table". ADR 0033 read that as "never in plaintext in
  one": ciphertext at rest in Postgres, with the key outside the database, is
  KMS-backed storage. This ADR takes the same reading and cites it rather than
  reopening it.
- **What is sealed.** The username, the password and the TOTP secret if any,
  as one sealed payload. No other column says anything about them: a label,
  the connection, `seq`, `cipher`, `key_id`, `wrapped_key`, `ciphertext`,
  `created_by`. A rotation is a new row, and the latest by `seq` is current.
- **A new table, not `accounting_credentials`**, whose `refresh_expires_at` is
  `not null` (migration 0025) and so fits QuickBooks only.
- **A purpose in the encryption context.** Reusing `{orgId, realmId}` would put
  a portal connection id where a QuickBooks realm id goes, and nothing would
  tell a portal ciphertext from a QuickBooks one. The build adds a purpose
  to `TokenEncryptionContext`, `portal_credential`, with its own AAD tag. This
  is an edit to `@recouple/crypto`. Existing QuickBooks rows keep their
  context byte for byte, so they still open.
- **A separate KMS key**, not the QuickBooks one. The app's AWS identity may
  generate data keys under it (to seal) and may not decrypt. The worker's
  identity may decrypt and may not generate. So the app can seal a portal
  password and can never open one.
- **Entry.** Settings → Portals, owner only (`app.member_is_owner()`, 0030's
  rule). The credential is sealed before anything is written, as
  `connectQboCompany` does (`packages/store-postgres/src/connect-qbo.ts:122`),
  so a KMS failure writes nothing. Replacing a credential writes a new row;
  removing one disables the connection.
- **Never anywhere else.** No credential, code, cookie or session token goes
  into an event, a log line, a run row, an audit payload, an error message or
  a capture. As ADR 0039's tests do, the build's tests spy on each of those.

### 8. MFA and the dedicated user

- **A dedicated portal user per customer.** The customer's portal owner creates
  a user for this service, with the least role the portal offers. It is never
  a person's own login. Many portals' terms forbid sharing a login, and the
  per-portal ADR checks that the portal allows a separate user used this way.
- **MFA, in order of preference:**
  1. **A TOTP secret**, enrolled for the dedicated user and sealed with its
     password. The worker computes the code, and only the code crosses the
     network, into the portal's form.
  2. **Codes by email to an issued inbound address** (ADR 0047), one per
     connection. ADR 0047's door records every message and part append-only,
     and a code must never land in a row. So this needs a variant: an address
     issued for portal codes, whose messages are recorded as having arrived
     (an id and a time) and whose body goes only to the waiting run, never to
     storage or the reader. The variant is designed in the build and used only
     for a portal that offers no TOTP.
  3. **Anything else** (SMS, a phone call, an app push, a security question the
     recipe cannot answer) is a stop.
- **A prompt the recipe cannot answer degrades.** The run ends
  `needs_attention` with the reason `mfa_unanswerable`. The case goes on by
  upload and email, and Settings says, in words, that the portal needs a
  person.
- **A rejected credential is not tried again.** If the portal refuses the
  sign-in, the connection is disabled until an owner replaces the credential,
  as ADR 0046 does for a grant Intuit refused. Repeated failed sign-ins would
  lock the dedicated user out.

### 9. Everything captured is a document, through the same door

- **Every capture is a document.** Each page snapshot or downloaded file is
  stored with an `uploads` row whose source is `portal_fetch`, through
  `ingestDocument` (`packages/pipeline/src/steps.ts:185-253`). It is checked
  by magic bytes in `acceptUpload`, deduplicated by hash, gets its `uploads`
  row, is stored, then scanned. Draft H put the `uploads` row before
  `acceptUpload`. The code does the reverse, and this ADR follows the code.
- **`IngestSource` is widened.** Today it admits only the three doors that
  exist (`ports.ts:58`). The build widens it to include `portal_fetch`, rather
  than writing a third bespoke insert. `uploads.created_by` is null, as for
  `erp_sync`, because no member put the file in front of the pipeline; the run
  that captured it is named on `portal_captures` (below). An arrival cannot be
  asserted later for `portal_fetch` (migration 0019 refuses it), so the
  `uploads` row must be written at ingest, and it is.
- **A re-captured file keeps its first arrival.** A file whose bytes the
  tenant already holds keeps its first arrival and gets no second `uploads`
  row (`steps.ts:199-207`). A backup the customer uploaded last week stays
  `web_upload`, and coverage is not moved to the portal. The capture row still
  records that the run saw it.
- **A page snapshot is not a file the portal sent.** It is the worker's
  serialisation of what the browser displayed. It keeps the visible text and
  the table structure exactly. It drops what can carry a session: scripts,
  hidden inputs, every input's value, cookies, and the query string and
  fragment of every link and of the page's own address. The serialisation rule
  is versioned code, named on the capture. The result is stored as
  serialised, hashed, and never altered.
- **HTML is a new type at the door, for this source only.** HTML is not an
  accepted type today. A page snapshot is accepted only for `portal_fetch`,
  chosen by the source as `acceptEmailBody` is chosen for an email body
  (ADR 0016), never by a caller's flag or a declared type. HTML uploaded or
  emailed is still refused. A snapshot is scanned like any file. Its text
  layer is written by code from the serialised page, and it is read as text,
  the way an email body is. It is never served inline: the case page shows it
  as escaped text, and the original is offered only as a download.
- **A downloaded file is stored byte for byte**, as it arrived. A type the
  door refuses (a spreadsheet until ADR 0056 is built, a zip, a Word file) is
  not stored. The run records a refused capture: the step and the refusal,
  with no bytes. The run then ends `needs_attention` so that a person fetches
  the file by hand.
- **No scan exemption.** `portal_fetch` is not exempt from the scan gate
  (`packages/pipeline/src/serving.ts:28-42`). A capture without a clean
  verdict is neither read nor served.
- **`portal_captures`** (append-only) records, for each capture: the document,
  the run, the recipe version, the step that captured it, the page's path
  without its query, and the time. That is the post-audit trail. A number on a
  case leads to its quote, the quote to the stored snapshot, and the snapshot
  to the run, recipe version and step that fetched it.

### 10. Whether a capture opens a case by itself

Draft H is silent on this. Today a `portal_fetch` notice or remittance would
open its cases through the ordinary gate, the floor and `typeFits` (ADR 0044).
There are two choices:

- **(a) The ordinary gate**, as for an upload.
- **(b) Hold every capture that would open a case**, with a new hold reason
  `by_portal`, until a person opens it with "Open a case from it"
  (`openHeldDocument`), as ADR 0047 does for email. The hold reasons are
  application data (`packages/pipeline/src/hold.ts:60`), so `audit_log` needs
  no change.

**Recommended: (b) for the first portal.** A new door starts held. The pilot's
volume is small. A wrong capture that opens cases is harder to undo than a
hold is to release. Lifting the hold for a portal is a decision recorded in
that portal's ADR, not a setting. "Read again" keeps its conservative rule for
any source but `web_upload`
(`apps/web/app/documents/[id]/reread/route.ts:108-110`).

### 11. How a portal claim and a ledger short-pay meet

Draft H said a claim seen in the portal and in the ledger "converges on one
case (ADR 0025)". In the code it converges more slowly than that:

- **An exact match counts only within one identifier kind**
  (`packages/core-domain/src/identity.ts:144-150`). A ledger arrival carries a
  `ledger_invoice_id` and an `invoice_number`, and no claim id
  (`packages/pipeline/src/discovery.ts:195-205`). A portal claim is recorded
  under the kind `portal_claim_id`, with source `portal_fetch`. So the two
  never match exactly on a claim.
- **The portal path follows ADR 0028's rule.** A portal claim records its
  `portal_claim_id` and, where the page prints one as its own field, the
  `invoice_number`. The invoice number is recorded as a name and **not
  matched as an exact key**, because one invoice carries many deductions
  (ADR 0028 §6, ADR 0048).
- **So they converge through a person.** Invoice, amount and date agreeing is
  `probable`. The pair is shown to a person (ADR 0032). If confirmed, it is
  merged (ADR 0042). Only exact matches merge without a person. Nothing here
  loosens that.
- **The ledger path matches the other way round.** It does pass
  `invoice_number` as an exact identifier. So a short-pay that arrives
  **after** exactly one portal case on its invoice resolves `exact` to that
  case and is skipped. After two or more, it is `ambiguous` and declined as
  `duplicate_of_other` (`packages/core-domain/src/triage.ts`). That is the
  ledger path's existing rule. This ADR does not change it. It notes that the
  outcome depends on which source arrives first, and leaves any change to an
  identity follow-up.
- **One short-pay may be several claims.** A ledger short-pay is one gap per
  invoice, while a payer may take several deductions against one invoice. One
  ledger gap may therefore be the sum of several portal claims. This is not
  solved by matching sums: a person sees the pair or pairs. It is a known
  limit, written down here so it is not discovered later.

### 12. Payer codes map by playbook data, never by code

- A portal's printed reason codes stay as printed on the case
  (`reason_code_as_printed`). They map into `reason-codes.ts` only through
  Draft D's code-map rows: an exact normalised match, else **unmapped**, which
  is a finding on the case. It is never the nearest match, and a model never
  maps.
- A printed code whose meaning depends on the backup maps to nothing by code.
  ADR 0058 names one: UNFI's `-111` means a shortage or a price discrepancy.
  A person picks the canonical code from the backup.
- The taxonomy grows only by an ADR-tracked edit to `reason-codes.ts`, under
  its 60-code ceiling.
- This ADR therefore needs Draft D's tables (task 04) for its first demo, and
  §14 moves them with it.

### 13. Runs, failures and the schedule

This follows the ledger sync (ADR 0031) in all three of its parts. Draft H
named none of them.

- **A registry, `portal_connections`,** like `accounting_connections`
  (migration 0024). It holds: the org; the portal key; a label; the portal
  account's public identifier (a supplier or vendor number, never the
  username); `enabled`; and `created_by`, the member a scheduled read acts as,
  frozen by trigger as 0030 does. Writes are owner-only through
  `app.member_is_owner()`. There is one enabled connection per portal account
  across the deployment, as 0030's partial unique index does for ledgers, so
  that two workspaces of one agency do not both read one supplier's account.
  It is not append-only, because `enabled` flips.
- **A run table, `portal_read_runs`,** append-only. A run is written once,
  when it ends, and complete (ADR 0023's shape). It is written only through a
  definer function, `app.record_portal_read_run()`, bounded to the caller's
  own org claim and subject. `app_rw` holds SELECT only, as with
  `app.record_ledger_sync_run` (migration 0024). The outcomes are:
  - `completed`;
  - `not_configured`;
  - `refused`: the member may no longer write;
  - `needs_attention`, with a reason code: `mfa_unanswerable`, `challenge`,
    `page_changed`, `terms_prompt`, `credential_rejected` or
    `capture_refused`;
  - `failed`, with a class name only.

  A run records counts (pages, captures, new documents, deduplicated ones,
  refusals). It never records page text, a query string or anything
  credential-shaped.
- **A fan-out lister, `app.portal_connections_to_read()`**, untenanted and
  definer. It hands out ids only and refuses any caller carrying a claim, as
  migration 0033 made the ledger lister do.
- **The job acts as the connection's `created_by`.** It asks `memberMayWrite`
  of the database before anything else, in the ledger job's order
  (`packages/pipeline/src/ledger-job.ts`). It runs as `app_rw` with that
  member's claims and never as the service role.
- **The schedule.** One serial read per connection per day, off-hours for the
  portal, unless that portal's ADR says otherwise. One read per connection in
  flight. The fleet cap counts against the plan's five
  (`apps/web/lib/inngest.ts:44`), alongside document reads and ledger syncs.
  The fan-out mints run keys in a memoized step, as `inngest-ledger.ts` does.
- **Alerts.** A failed run reaches a person: the portal job is added to
  `ALERTED_FUNCTIONS` (`apps/web/lib/alerts.ts:31`).
- **A failure degrades and never fails a case.** `needs_attention` or `failed`
  changes nothing on any case. Settings says what happened, in words derived
  from the outcome code, and the case goes on by upload and email (STRATEGY
  §5.4).

### 14. Build order

- `CLAUDE.md`'s order puts portal read inside Phase 2, with evidence and the
  model decision. This ADR moves **portal read for the first portal** (task 13)
  ahead of the rest of Phase 2.
- It brings along only what the first portal's demo needs:
  - Draft D's playbook tables and code map (task 04);
  - ADR 0056's reader, if the first portal's export is a spreadsheet.
- Tasks 01–03 and 05–12 keep their order and their gates.
- The reason is that the pilot sells to emerging consumer-goods brands whose
  distributor deductions outnumber their direct-retailer ones (ADR 0058).
  Coverage is measured by what arrives, and a decision model has nothing to
  decide until deductions arrive with their reasons.
- Portal write of any kind and browser auto-submission stay Phase 6
  (`CLAUDE.md`, "Do not build yet"). `SubmissionChannel` and `portal_agent`
  are untouched.
- `CLAUDE.md`'s build-order section is amended in the same change that marks
  this ADR accepted.

### 15. Tables, in the next free migration after acceptance

The migration number is taken after a `git fetch`, when the migration is
written; 0036 is next today.

- `portal_connections`: the registry (§13), RLS on, owner-only writes.
- `portal_credentials`: sealed, append-only, with a composite foreign key on
  `(org_id, connection_id)` (ADR 0025 §7's pattern).
- `portal_recipe_versions`: append-only and immutable.
- `portal_recipe_reviews`: append-only; the reviewer must be the caller.
- `portal_read_runs`: append-only, written only by the definer function.
- `portal_captures`: append-only.

Every append-only table gets RLS on, one policy per command, `app_rw` SELECT
and INSERT (SELECT only for the run table), `app_ro` SELECT, `no_update_delete`
and `no_truncate`, and nothing for the request roles (ADR 0037). Suites 01 and
24 are extended, and a new suite reads the credential table's columns back
against the catalogue in both directions, as suite 21 does for QuickBooks. The
migration goes to `mozart-preview` first, then production, and is read back on
both.

### 16. What this does not do

- It writes nothing to any portal, and submits nothing.
- It fetches no backup for a named case. Draft E lists `portal` as a later
  evidence source; a fetch for one case is a later step, and Draft E must give
  it a place in its cost order, because it is not free.
- It shares no recipes across tenants (§3).
- It solves no challenge and evades no bot protection (§1).
- It reads no third party's portal that a payer's site links to (an analytics
  partner, say). That party has its own terms and would need its own ADR.
- It reads no EDI (Phase 2.5).

### 17. What the founder decides

1. **Option C**: recipes as data, a read-only runner, a reader with no tools,
   and an agent that only drafts.
2. **Where the browser runs**: our own worker (default) or a hosted browser
   provider.
3. **Captures that would open a case**: held as `by_portal` (recommended for
   the first portal) or the ordinary gate.
4. **Recipe scope**: per tenant (recommended to start) or shared, which would
   need its own ADR.
5. **Emailed MFA codes**: build the code-address variant now, or TOTP only and
   stop otherwise (recommended until a portal needs email codes).
6. **The cold-start agent**: built with the first portal, or later
   (recommended: later; the first recipe is written from the founder's hand
   walk-through and promoted by the founder).
7. **The build-order change** in §14.

## Where this departs from Draft H

| Draft H said | This ADR |
| --- | --- |
| §1: an adapter with `listClaims(window)` and `fetchBackup(claimId)` | A new read-only `PortalSource` port that runs a promoted recipe. `fetchBackup` for one case waits for Draft E (§16) |
| Builds on `EvidenceSource` (`kind: 'portal'`) | `'portal'` is only a `sourceKind` value, and `fetch` needs a case. A new port instead (§1) |
| `portal_fetch` exists as an upload source | True in the database, not in the pipeline. `IngestSource` is widened (§9) |
| §5: an `uploads` row, then `acceptUpload` | `ingestDocument` runs `acceptUpload` first, then dedupe, then the `uploads` row (§9) |
| §3: sealed through `TokenCipher` in `portal_credentials` | Kept, with a purpose added to the context and a separate KMS key (§7). The "application table" question is settled by citing ADR 0033 §1(b) |
| §4, §6: `portal_read_runs`, "exactly like the ledger sync" | The pattern's three parts named: registry, definer-only run writer, claim-refusing fan-out lister (§13) |
| Silent on where a browser runs | Outside Vercel, in a worker with no database credential (§6) |
| §5: a portal claim and a ledger short-pay converge on one case | Exact matches only within a kind. They converge through a person and a merge (§11) |
| Silent on whether a capture opens a case | A choice for the founder, recommended held (§10) |
| Options not taken: screen-scraping | Kept. The recipe prefers exports, and snapshots are read as documents (§3, §4) |
| No "Invariants touched" or "Rollback" | Added below, as the template requires |

## Consequences

- Coverage gains the channel that sees what the customer never forwarded, and
  the payer's own backup, with every number traceable to a stored capture, the
  run that fetched it and the recipe version a person promoted.
- The daily run is deterministic. It costs no model call until something is
  captured, and it does the same thing every day until a person promotes a
  new version.
- A portal that changes its pages stops the run (`page_changed`) rather than
  reading the wrong thing. Someone has to repair the recipe, by hand or with
  the agent, and until then the customer is back on upload and email. That is
  the right failure, and it is operational load that grows with each portal
  added.
- There is a new service to run, with its own secrets, its own egress and a
  headless browser to keep patched.
- A portal claim and a ledger short-pay meet through a person, not
  automatically, and one ledger gap may be several portal claims. The review
  queue will show pairs for a person to answer.
- HTML enters the door for one source. It is new untrusted-input surface and
  gets the fail-closed treatment the PDF inspector has.

## Invariants touched

- **1 (approval before anything is filed)**: unchanged. No write path exists:
  the port has no submit method, the runner has no write step and refuses
  write controls by name, and `portal_agent` stays Phase 6.
- **2 (append-only)**: five new append-only tables, and one registry that is
  not append-only because `enabled` flips, like `accounting_connections`. No
  UPDATE or DELETE grant is added. A capture's `uploads` row is written at
  ingest, since an arrival cannot be asserted for `portal_fetch` later.
- **3 (money in integer cents)**: every amount from a capture reaches cents
  through `parseMoneyToCents` or `parseUnitPrice`, or through ADR 0056's reader
  for a spreadsheet.
- **4 (untrusted content)**:
  - the reader is unchanged, with no `tools` parameter and delimited text;
  - the scheduled runner sends no page to any model;
  - the agent answers a structured choice over read-only operations that code
    lists and executes, never sees a credential, and produces only data a
    person must promote;
  - page text never becomes an instruction to the runner.
- **5 (providers behind ports)**: the reader uses the existing ports. The
  agent's calls go through a port, and any Jev call through `DecisionProvider`.
- **6 (RLS; no service role in a request path)**: RLS on every new table. The
  job runs as `app_rw` with the member's claims. The worker has no database
  credential. The service role appears nowhere.
- **7 (thresholds only tighten)**: none changed.
- **Playbook rule**: payer codes and recipes are versioned data with
  provenance, never code.
- **New outbound side effect**: signing in to and reading a payer's portal.
  This is its ADR, as `CLAUDE.md` requires before one is built.

## Rollback

- Disable every portal connection and remove the schedule. Nothing reads a
  portal again.
- Stop the worker, and disable the portal KMS key if the credentials must
  become unopenable. They stay as ciphertext in an append-only table.
- Captured documents stay ordinary documents whose quotes still verify against
  what was stored. Cases opened from them stay ordinary cases.
- Take `portal_fetch` back out of `IngestSource` and HTML back out of the door.
- Every case goes on by upload and email, which is where every case was before
  this.

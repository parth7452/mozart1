# 0057 — A portal is read, never written, by a recipe a person promoted

- Status: proposed (2026-09-26). The founder accepts or amends it, including
  each choice in §17. Nothing here is built: no code, no migration, no
  service.
- Date: 2026-09-26
- Promotes: Draft H (`docs/plans/phase-2/adr-drafts/H-portal-read.md`), which
  this supersedes. Draft H's six decisions are kept, except where the table
  *Where this departs from Draft H* says. Where the code contradicts Draft H,
  this ADR follows the code and says so in that table.
- Amends, if accepted: the build order in `CLAUDE.md`. Portal read for the
  first portal moves ahead of the rest of Phase 2 (§14). If the founder builds
  the agent of §5, also `CLAUDE.md`'s "exactly two bounded steps" (§5, §14).
- Adds, if accepted: one new outbound side effect (signing in to a payer's
  portal and reading it); one new separate service (a browser worker); one
  registry and six append-only tables; one new document type at the door, for
  one source only (a page snapshot); one new hold reason, `by_portal`; and,
  only if the founder chooses it (§17.6), a bounded agent that drafts or
  repairs a recipe, which widens the agentic surface `CLAUDE.md` reserves (§5)

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
  (STRATEGY §5: "The existing seams are for evidence retrieval, not deduction
  discovery."). `listClaims` and `fetchBackup` exist nowhere.
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
- **A notice's claim is recorded as `claim_id`.** `openCase` writes it with
  the upload's source (`packages/store-postgres/src/store.ts:2049-2056`), and
  so does the remittance-line path (`openCaseForLine`, `steps.ts:2120`).
  `portal_claim_id` is
  admitted by migration 0020 and written by nothing. The notice path also
  writes no `reason_code_as_printed` (`steps.ts:1275-1286`); only a
  remittance line does (`steps.ts:2096`).

### A browser is tools

No public API was found for the first portal (ADR 0058; research P22), and
the design assumes none. What a portal offers is pages and, sometimes, an
export button. Reading them needs a browser that signs in, clicks and
downloads, and a browser is exactly the kind of tool invariant 4 keeps away
from anything that reads untrusted content. A page is untrusted content. So
the design has to separate what drives the browser from what reads the page,
and it has to keep a model that sees a page from choosing what the browser
does next, except inside the bounded agent session of §5, if the founder
chooses to build one.

## Options

**A. An API or an export only; no browser.** The cleanest source where it
exists, and it is always the first choice for a portal (§3). But no public API
was found for UNFI's (research P22), so for the first portal this alone reads
nothing.

**B. A general browser agent that a model drives on every run.** It adapts to
a changed page by itself. It is also an unbounded tool loop that sees untrusted
pages every day, is not replayable, and costs a model call per click on a
schedule. Rejected under invariant 4, and because nothing a person reviewed
decides what it does on a given day.

**C. A recipe held as data, run by a read-only runner outside Vercel; a model
reads the captures with no tools; a bounded agent may draft or repair a recipe
for a person to promote. Recommended.** The scheduled run is deterministic and
reviewable. The model only reads documents, as it does today. The agent, if
built, is used rarely, on demand, and what it produces does nothing until a
person promotes it.

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
  knows a closed set of step kinds, and none of them is a write step.
- **What the runner guarantees, and what it cannot.** The runner bounds every
  request by method and target, and refuses the controls it can recognise as
  writes. It cannot know what a portal does with a request it allows. So it is
  one of four lines, with the per-portal ADR (§2), the dedicated user's least
  role (§8) and promotion (§3):
  - **Method and target are the guard.** A request to a host not on the
    recipe's allowlist is blocked. A non-GET request is allowed only in three
    cases. During `sign_in` or `answer_mfa`, it may go to the paths the
    credential's binding names (§7), including the SAML assertion-consumer
    paths the binding lists. During `search`, it may go to that form's own
    `action` URL, as recorded when the step was drafted. Otherwise it must
    match a POST-as-read entry, which names the step, the path and, for an
    endpoint that carries reads and writes on one path (`/graphql`, a
    WebForms postback, an RPC `/api`), a body discriminator such as GraphQL's
    `operationName`. Any other body on that path is refused, and so is every
    other non-GET.
  - **No file input.** The runner never interacts with a file input.
  - **The never-click floor is a second line, not the first.** The page
    chooses its own labels, so a list of names cannot be the write guard. It
    catches what the method-and-target rule lets through. The runner never
    clicks an element whose accessible name or visible text matches its own
    list: dispute, appeal, submit, upload, attach, approve, accept, agree,
    delete, remove, save, create, request, send, pay, confirm, continue, yes,
    ok, finish, complete, withdraw, cancel, enroll, opt in, subscribe,
    register, update, edit, reset, resend and authorize. A recipe may add
    names to that list for its portal and cannot remove one. `sign_in` and
    `answer_mfa` submit only the bound forms (§7) and are not subject to the
    floor. The one other exception is a `dismiss` step (§3) whose recorded
    container text matches exactly. A search whose control carries a
    floor-listed name cannot be expressed, and that portal is read without
    it.
- **A prompt to accept new terms is a stop.** Accepting a portal's terms is
  the founder's act, recorded in that portal's ADR, never the runner's. The
  runner cannot recognise a terms prompt by what it means, so it stops on its
  shape. An overlay or dialog (`role=dialog`, `aria-modal`, or an element
  covering the step's target) that carries a floor-listed control, and whose
  text is not a recorded `dismiss` container, ends the run `needs_attention`
  with `terms_prompt` (§13).
- **A challenge is a stop.** A CAPTCHA or bot challenge is never solved,
  evaded or retried around. The run ends `needs_attention` (§13).
- **The credential is read only where the portal allows it.** The dedicated
  user (§8) is given the least role the portal offers. Where a portal has a
  role that cannot dispute, that is the role.

### 2. One portal at a time, each with its own ADR

Kept from Draft H. Before a recipe runs against a portal, a short per-portal
ADR records:

- that the founder read the portal's terms, which documents and versions,
  and what they say about automated access, shared logins, agents and
  confidentiality;
- how sign-in and MFA work;
- what is known of rate limits, and the schedule chosen;
- what each screen and each export gives;
- the hosts the recipe may visit, and the portal's own never-click names.

**The terms are a gate, as Draft H made them.** A recipe runs against a
portal (on the schedule, in a dry run, or under the agent) only when that
portal's ADR records the terms answer as "allowed" or "allowed with
conditions", or records the payer's written consent.

The first is ADR 0058 (UNFI). Draft H said the first portal would be chosen
by the first customer who uses one. It was chosen instead for the pilot
customer, a UNFI supplier, for reasons ADR 0058 gives.

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
kinds are all reads, a recipe cannot express a write step. §1 says what the
runner guarantees beyond that. Promotion (below) checks what a reviewer
cannot see by reading selectors.

**Step kinds** (the runner knows no others):

| Step | What it does |
| --- | --- |
| `open` | Load an address on the recipe's host allowlist, by GET |
| `sign_in` | Type the sealed username and password into the forms the credential's binding names (§7), and submit them. It takes no argument: the origin, paths, forms and fields come from the binding, never from the recipe's selectors or an agent's choice. Refused if a bound form has more than one password input, or if its `action` is not a bound path. The only step that types a secret |
| `answer_mfa` | Enter a code from the connection's TOTP secret or code channel (§8) into the bound MFA form. It takes no argument, as for `sign_in`. Anything else is a stop |
| `dismiss` | Press one named control on a notice or banner, located by selector and matched by exact text. For a floor-listed control (a cookie notice's "Accept"), the step also carries the container's full visible text, or its hash, recorded on the walk-through and named on the review row. The runner presses it only when the container's text matches exactly. Anything else stops the run as `terms_prompt`. An agent-drafted version never carries one (§5) |
| `follow` | Click a link or tab located by selector, subject to the never-click floor |
| `search` | Fill named filter fields from the run's parameters (a date range, a payment or deduction number) and submit a form the recipe marks as a search, only when the form's `method` and `action` match what was recorded when the step was drafted. Refused if that form has a file input or a field the recipe does not name. In an agent-drafted version, only a form with `method=get` |
| `wait_for`, `expect` | Wait for, or assert, a selector or text. A failed `expect` ends the run as `page_changed` |
| `capture_page` | Snapshot the page (§9) |
| `download` | Press a named export or download control and keep the file that arrives |
| `for_each`, `next_page` | Repeat a block over rows, or follow pagination, each capped |
| `sign_out` | End the session |

**What a recipe version holds:**

- the portal key;
- the step list, and for each step the control text and form `action` it was
  drafted against;
- the host allowlist, the sign-in origin and the sign-in and MFA form paths
  (the credential is bound to these, §7);
- the portal's never-click names;
- its POST-as-read entries, each naming a step, a path and, where needed, a
  body discriminator (§1);
- the schedule (§13);
- caps on pages, downloads and run time;
- `effective_from`;
- who drafted it (a person, or an agent session by id, §5) and from what (a
  hand walk-through on a date, or that session's step log: the operations
  chosen and whether each passed, with no page text and no values);
- the per-portal ADR it runs under.

**Promotion.** A version is immutable. A person promotes it with a separate
append-only review row, written by the caller (the authorship triggers of
migration 0016 and of migration 0031, ADR 0041), and only an owner may, as the
database's rule (§15). The review screen shows, for each step, the recorded
control text and form `action` the step was drafted against. Promotion
refuses, in code, a version drafted by an agent session that adds a host, a
POST-as-read entry or a floor-listed `dismiss` beyond the previous promoted
version. Only a person-authored version may add one, and its review row names
each addition. Only a promoted version in effect runs on the schedule. A
changed portal means a new version, never an edit.

**A dry run.** Before a version is promoted, an owner may start a dry run of
it. It is the same runner, with the same refusals, host allowlist, binding and
caps. A `capture_page` or `download` step does nothing and stores nothing, no
model is called, and the run records a step log only (step names and pass or
fail, no values). It gets start and outcome rows like any run (§13). The terms
gate (§2) applies to it. It is how a portal's first version is checked before
a person promotes it.

**Scope.** A recipe is per tenant at first. A recipe drafted on one customer's
login can carry that customer's identifiers, so sharing one across tenants is
cross-tenant data and a later decision with its own ADR, as ADR 0056 §11 said
of column mappings. Run parameters that differ per customer (supplier numbers,
regions) belong on the connection, where they are frozen (§13), not in the
recipe, so that sharing stays possible later.

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
- A scheduled run, or a dry run, sends nothing to a model while the browser is
  open. The runner executes the recipe's steps and nothing else. No text on a
  page reaches the runner as an instruction. §5 says what an agent session
  changes.
- The captures are read after the run has ended and the browser is closed, by
  a separate job step. The model that reads a page cannot affect what the
  browser did, because the browser is gone.

### 5. A bounded agent may draft or repair a recipe; a person promotes it

**This widens what `CLAUDE.md` reserves, and says so.** The reserved
"unknown-payer cold start" drafts playbook rows from documents (Draft D §4,
the `/new-playbook` workflow: "A model may *propose* rows from a routing
guide"). A model choosing operations in a live, credentialed browser over a
DOM index is the shape STRATEGY gives Phase 6's `portal_agent` (§6.8, and the
roadmap row for Phase 6). Repairing a known payer's recipe is not
"unknown-payer" at all. So building this agent amends `CLAUDE.md`'s "exactly
two bounded steps", and §14, §17.6 and *Invariants touched* list it as that
amendment. The recommended choice is to build it later (§17.6).

**A narrower alternative**, which the founder may choose instead: the agent
drafts offline, from stored and scanned snapshots (§9) of a walk-through or of
the page where a run stopped, with no live browser. Page text then drives no
action at all. It still widens cold start from documents to recipes, and from
unknown payers to repairs, and §14 says so.

The rest of this section describes the live agent, if chosen.

- **When it runs.** Only when an owner starts it, for one connection: to draft
  a portal's first recipe, or to repair a version whose run ended
  `page_changed`. Never on the schedule, and never as a retry.
- **What it can do.** It drives the worker's browser through the same runner,
  with the same refusals, host allowlist, binding and caps. It does not act
  freely. Code indexes the page's elements and lists the read-only operations
  that are legal on them, and the model picks one (STRATEGY §6.8). The model
  answers a structured choice, one index number. It is **not** given a
  `tools` parameter, and code executes the choice. In an agent session,
  `dismiss` is never allowed on a floor-listed control, `search` is allowed
  only on a form with `method=get`, and no POST-as-read entry applies.
- **What it never sees, and never directs.** The credential. The agent may
  invoke `sign_in` and `answer_mfa` only as operations with no argument. The
  origin, path, form and fields come from the credential's binding (§7),
  never from the agent's choice. A decoy "session expired, re-enter your
  password" form, or a change-password form, on an allowed page is refused
  if the agent chooses it. The fixture portal (below) carries both, and a
  test asserts each refusal.
- **What page text can do.** During an owner-started session, page text can
  influence which permitted read happens next. That is bounded by the closed
  read-only operation set, the host allowlist and binding, the
  method-and-target rule, the never-click floor and the caps. The output is
  inert until a person promotes it under §3's checks.
- **How a turn runs.** The worker has no model key, so the loop runs in the
  job, one job step per turn. The step fetches the element index from the
  worker, calls the model, and returns only the chosen operation's index
  number. The index is never a step's return value or an event, because a
  step's return is durable in the queue (ADR 0021: "No bytes, no page text").
  It reaches the model inside `<untrusted_document>` delimiters (`quarantine`,
  `packages/core-domain/src/invariants/index.ts`), serialised by §9's rules,
  with no input values and the sealed username replaced by the placeholder.
  Unlike every document read today, the index is not scanned: it is text the
  worker's code built from the live page, and it goes only to the chooser,
  never to the reader or to storage.
- **What it produces.** A draft recipe version: data, inert until a person
  promotes it (§3). Deterministic code writes the draft row, and its
  provenance is the session's step log (§3). The agent writes nothing else and
  triggers nothing outbound beyond the read-only browsing itself.
- **Bounds.** A step cap and a spend cap per session, both in code. Reaching
  either ends the session with what it has.
- **Recording.** Its model calls go through a new port, `PortalStepChooser`,
  never a raw client (invariant 5). It is not `DecisionProvider`: that port's
  `DecisionState` requires a `deductionId`, which a session does not have,
  and forbids raw document text (`packages/decision/src/types.ts:63-72`,
  STRATEGY §6.6). It is not the reader's port either. Its Claude
  implementation is constructed with no `tools` parameter. Its calls are
  recorded on `model_calls` with purpose `playbook_draft`, which migration
  0007 already admits, and with no page text in `detail`. No Jev call is on
  this path. One would put page text into a decision, which STRATEGY §6.6
  allows only with an ADR arguing why the blast radius is bounded, and a
  `DecisionState` variant with no `deductionId` and no page text.
- **Cassettes.** Its path gets a recorded cassette for the Claude call.
  `CLAUDE.md`'s rule for the Jev call applies if one is ever added under that
  ADR. Cassettes are recorded against a fixture portal (a static site kept in
  the repo), not a real one, so CI replays them with no network. The reader's
  calls on captures get cassettes like every other document's.

### 6. The browser runs outside Vercel

- **Why not Vercel.** A sign-in, an MFA prompt, pagination and downloads can
  outlast the 300-second `maxDuration`. A killed run is retried at full cost
  with nothing recorded, which is why paging is off in the app (ADR 0053).
- **Default: our own worker**, `services/portal-read`, deployed the way
  `services/clamav-scan` is (ADR 0018): a container behind an HTTPS front door
  that checks a bearer token in constant time, refuses to start without its
  token, answers `/health`, and runs with billing on so machines are not
  stopped mid-run.
- **Open choice: a hosted browser provider.** Less to operate. Under it our
  worker still holds decrypt, and drives the provider's remote browser over
  CDP with the provider's session recording and logging contractually off and
  verified before use. Even so, the customer's portal password is typed into
  a browser a third party runs. So the credential split (§7) and `CLAUDE.md`'s
  rule that portal credentials stay in KMS-backed storage are otherwise not
  met. It needs its own data-processing review. The default is our own worker.
- **The worker holds no database credential and no model key.** ADR 0055
  (option E) kept a database credential out of a separate service, and the
  same reasoning holds here. The job, running as `app_rw` with the member's
  claims, reads the promoted recipe and the sealed credential. It hands both
  to the worker and writes everything that comes back. The worker holds its
  bearer token and permission to decrypt under the portal-credential key
  (§7), and nothing else. It does not trust the recipe to say where the
  credential goes: the credential's binding (§7) decides that.
- **The worker decrypts the credential itself, and only for its binding.** The
  job passes the sealed credential as ciphertext, with its binding. Every
  field of a `SealedToken` is safe in a column (`cipher.ts`), so ciphertext is
  safe in an authenticated request body. Before calling `kms:Decrypt`, the
  worker refuses a recipe whose sign-in origin, sign-in paths or
  host-allowlist hash differ from the binding's. The binding is in the
  encryption context, so a binding altered in the row does not decrypt. The
  worker types the username and password only into the bound forms (§3,
  `sign_in`), and a TOTP code only into the bound MFA form. A worker test gives
  it a recipe naming another host, and asserts the refusal comes before
  `kms:Decrypt` is called. The plaintext exists only in the worker's memory
  for the run and in the portal's sign-in form.
- **What a job step may return.** The Inngest event carries ids only
  (ADR 0021). A step's return value is durable in the queue, so:
  - the step that reads the sealed credential sends it to the worker and
    returns only the worker's run handle;
  - the job then polls in later steps;
  - each capture is fetched and passed through `ingestDocument` inside one
    step, which returns only the document id;
  - an agent turn (§5) returns only an index number.

  No step returns a credential, a code, a capture's bytes or page text. Every
  step stays well under the function limit.
- **No state between runs.** Each run starts from an empty browser profile and
  discards it afterwards. Keeping a "remember this device" cookie would be
  keeping a credential, so a portal that needs one decides that in its own
  ADR, and seals it like the password.
- **Nothing is recorded in the worker.** It makes and keeps no Playwright
  trace, HAR file, video or screenshot. A snapshot is §9's serialisation and
  nothing else.
- **Egress.** The worker's browser blocks every request to a host not on the
  recipe's allowlist, which the worker has checked against the binding.
- **Production only.** The worker's token and the portal KMS key are set for
  Production alone. Previews hold no Inngest keys (`docs/supabase.md`), so a
  preview cannot start a portal read.

### 7. Credentials are sealed to a destination: the app seals, only the worker opens

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
  `created_by`, and the binding's `sign_in_origin`, `sign_in_paths` and
  `hosts_hash`, which describe the portal, not the credential. A rotation is a
  new row, and the latest by `seq` is current.
- **A new table, not `accounting_credentials`**, whose `refresh_expires_at` is
  `not null` (migration 0025) and so fits QuickBooks only.
- **A purpose and a destination in the encryption context.** Reusing
  `{orgId, realmId}` would put a portal connection id where a QuickBooks realm
  id goes, and nothing would tell a portal ciphertext from a QuickBooks one.
  The build adds a portal variant to `TokenEncryptionContext`,
  `{purpose: 'portal_credential', orgId, connectionId, signInOrigin,
  signInPaths, hostsHash}`, with its own AAD tag. `hostsHash` is a hash of the
  sorted host allowlist. This is an edit to `@recouple/crypto`. Existing
  QuickBooks rows keep their context byte for byte, so they still open.
- **The destination is bound when the credential is sealed.** Settings →
  Portals takes the binding from a recipe version as the database holds it
  (the promoted version, or, for a dry run, the version an owner names), never
  from a request's fields. A new version that changes the sign-in origin, the
  sign-in paths or the hosts cannot open the credential until an owner enters
  it again under the new binding.
- **A separate KMS key**, not the QuickBooks one. The app's AWS identity may
  generate data keys under it (to seal) and may not decrypt. The worker's
  identity may decrypt and may not generate. So the app can seal a portal
  password and can never open one, and the worker, which can open it, types
  it only where the binding says.
- **Entry.** Settings → Portals, owner only, as the database's rule and not
  only the app's: `app.member_is_owner()` and the caller as `created_by`
  (§15). This is stricter than migration 0030's rule for
  `accounting_credentials` (ADR 0039), which lets any writer store a rotation
  because the QuickBooks sync rotates tokens as a member who may since have
  been demoted. No job rotates a portal credential. The credential is sealed
  before anything is written, as `connectQboCompany` does
  (`packages/store-postgres/src/connect-qbo.ts:122`), so a KMS failure writes
  nothing. Replacing a credential writes a new row; removing one disables the
  connection.
- **Never anywhere else.** No credential, code, cookie or session token goes
  into an event, a log line, a run row, an audit payload, an error message or
  a capture. As ADR 0039's tests do, the build's tests spy on each of those.
  They also assert that the sealed username is absent from every stored
  snapshot and every agent index (§9).

### 8. MFA and the dedicated user

- **A dedicated portal user per customer.** The customer's portal owner creates
  a user for this service, with the least role the portal offers. It is never
  a person's own login. Many portals' terms forbid sharing a login, and the
  per-portal ADR checks that the portal allows a separate user used this way.
- **MFA, in order of preference:**
  1. **A TOTP secret**, enrolled for the dedicated user and sealed with its
     password. The worker computes the code, and only the code crosses the
     network, into the portal's bound MFA form.
  2. **Codes by email to an issued inbound address** (ADR 0047), one per
     connection. ADR 0047's door records every message and part append-only,
     and a code must never land in a row. So this needs a variant: an address
     issued for portal codes, whose messages are recorded as having arrived
     (an id and a time) and whose body goes only to the waiting run, never to
     storage or the reader. The code is taken from the body by code that
     keeps only a run of digits of the length the recipe version names
     (data). It is sent from the inbound route straight to the waiting run
     over the worker's bearer-authenticated endpoint. It never passes through
     an event or a step return, and no model or agent ever sees it. Only the
     first code to arrive while a run waits is used. Postmark signs nothing
     (ADR 0047), so anyone can mail a code to the address. A forged code costs
     one failed MFA prompt, and the run ends `needs_attention`. The variant is
     designed in the build and used only for a portal that offers no TOTP.
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
  Its `portal_captures` row is written in the same transaction as its
  `uploads` row (§15).
- **`IngestSource` is widened.** Today it admits only the three doors that
  exist (`ports.ts:58`). The build widens it to include `portal_fetch`, rather
  than writing a third bespoke insert, and the same change adds the
  `by_portal` hold (§10). `uploads.created_by` is null, as for `erp_sync`,
  because no member put the file in front of the pipeline; the run that
  captured it is named on `portal_captures` (below). An arrival cannot be
  asserted later for `portal_fetch` (migration 0019 refuses it), so the
  `uploads` row must be written at ingest, and it is.
- **A re-captured file keeps its first arrival.** A file whose bytes the
  tenant already holds keeps its first arrival and gets no second `uploads`
  row (`steps.ts:199-207`). A backup the customer uploaded last week stays
  `web_upload`, and coverage is not moved to the portal. The capture row still
  records that the run saw it.
- **A page snapshot is not a file the portal sent.** It is the worker's
  serialisation of what the browser displayed, and the rule is an allowlist:
  text, and table, list and heading elements, with no attribute except
  `colspan` and `rowspan`. Everything else is dropped: scripts, inline event
  handlers, links and their addresses (`javascript:` included), forms and
  their `action`, inputs and their values, hidden inputs, images, frames,
  `srcset`, `<base>` and `<meta http-equiv=refresh>`. Before hashing, the
  worker, which holds the plaintext, replaces every occurrence of the sealed
  username with a fixed placeholder, because a signed-in portal commonly
  prints it in its header. Otherwise the visible text and the table
  structure are kept exactly. The serialisation rule is versioned code, named
  on the capture. The result is stored as serialised, hashed, and never
  altered.
- **HTML is a new type at the door, for this source only.** HTML is not an
  accepted type today. A page snapshot is accepted only for `portal_fetch`,
  chosen by the source as `acceptEmailBody` is chosen for an email body
  (ADR 0016), never by a caller's flag or a declared type. HTML uploaded or
  emailed is still refused. A snapshot is scanned like any file. Its text
  layer is written by code from the serialised page, and it is read as text,
  the way an email body is. It is never served inline. The case page shows it
  as escaped text. The original is offered only as a download, with
  `Content-Disposition: attachment`, `Content-Type: application/octet-stream`,
  `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`,
  and a test asserts all four, because the app's own origin serves it to a
  reviewer who can approve.
- **A downloaded file is stored byte for byte**, as it arrived. A type the
  door refuses (a spreadsheet until ADR 0056 is built, a zip, a Word file) is
  not stored. The run records a refused capture: the step and the refusal,
  with no bytes. The run then ends `needs_attention` so that a person fetches
  the file by hand.
- **No scan exemption.** `portal_fetch` is not exempt from the scan gate. A
  capture without a clean verdict is not read (`assertScannedClean` in
  `readablePayload`, `steps.ts:290-296`) and not served (`servingRefusal`,
  `packages/pipeline/src/serving.ts`).
- **`portal_captures`** (append-only) records, for each capture: the document,
  the run's start row (§13), the recipe version, the step that captured it,
  the page's path without its query, and the time. That is the post-audit
  trail. A number on a case leads to its quote, the quote to the stored
  snapshot, and the snapshot to the run, recipe version and step that fetched
  it, even for a run that never finished.

### 10. A capture that would open a case is held for a person

Draft H is silent on this. Today a `portal_fetch` notice or remittance would
open its cases through the ordinary gate, the floor and `typeFits` (ADR 0044),
because `allowCaseOpen` defaults to true (`steps.ts:897`) and `byEmail` covers
only email (`steps.ts:904-905`). There are two choices:

- **(a) The ordinary gate**, as for an upload.
- **(b) Hold every capture that would open a case**, with a new hold reason
  `by_portal`, until a person opens it with "Open a case from it"
  (`openHeldDocument`), as ADR 0047 does for email. `by_portal` is added to
  `HOLD_REASONS` (`packages/pipeline/src/hold.ts:60`). The hold reasons are
  application data, so `audit_log` needs no change.

**Recommended: (b), for every portal, unconditionally in code.** A new door
starts held. The pilot's volume is small. A wrong capture that opens cases is
harder to undo than a hold is to release.

- **Where it is enforced.** The hold is keyed inside `readDocument` on the
  document's recorded arrival, next to `byEmail` (`steps.ts:904-905`),
  whatever `allowCaseOpen` a caller passes. It must not depend on the caller.
  "Read again" passes `allowCaseOpen` true for any document never read
  (`apps/web/app/documents/[id]/reread/route.ts:109-110`), and a capture
  whose queued read failed is exactly that.
- **When it ships.** The hold is in the same change that lets `ingestDocument`
  accept `portal_fetch`, so no capture is ever read without it, whatever
  §17.3 later decides.
- **Lifting it is a loosening**, and invariant 7's rule applies: it is not a
  setting, and no code names a portal to do it (no retailer rule in code).
  Lifting it for every portal is an amendment to this section, by ADR.
  Lifting it for one portal needs an append-only, effective-dated row keyed
  by the portal key, whose provenance cites that portal's ADR, guarded
  one-way by the database the way `app.guard_threshold_direction()` guards
  thresholds. That row is designed, with its own ADR, when it is first
  wanted.

### 11. How a portal claim and a ledger short-pay meet

Draft H said a claim seen in the portal and in the ledger "converges on one
case (ADR 0025)". In the code it converges only in some shapes, and in one
shape it loses dollars without a trace. This is what the code does today.

- **A portal claim is recorded as `claim_id`, with source `portal_fetch`.**
  That is what `openCase` already writes for every notice
  (`packages/store-postgres/src/store.ts:2049-2056`), and a capture is read by
  the unchanged notice path, so nothing changes in `openCase`. An exact match
  compares the kind and the identifier and ignores the source
  (`packages/core-domain/src/identity.ts:145-156`, the kind check at `:152`).
  So a capture and an emailed or uploaded notice that print the same key meet
  exactly, and the second is refused as a duplicate naming the first
  (`DuplicateCaseError`), as a second upload of one claim is. `portal_claim_id`,
  which migration 0020 admits and nothing writes, stays unused. The
  alternative was to record the key as `portal_claim_id`. Then a deduction
  forwarded by email now (ADR 0058, Decision §12.4) and captured from the
  portal later would be two cases, paired only if invoice, amount and date
  agree.
- **A ledger arrival carries no claim id.** It carries a `ledger_invoice_id`
  and an `invoice_number`, both as exact identifiers
  (`packages/pipeline/src/discovery.ts:194-205`). So a portal claim and a
  ledger short-pay never meet on a claim.
- **The portal path follows ADR 0028's rule.** Where the page prints the
  supplier's invoice number as its own field, a portal claim records it as
  `invoice_number`. The notice path records it as a name and does **not
  match it as an exact key**, because one invoice carries many deductions
  (ADR 0028 §6, ADR 0048).
- **Ledger first, then portal.** A portal claim resolves `probable` against
  the ledger case only when three things hold: the capture prints the invoice
  number as its own field; its amount equals the ledger gap to the cent; and
  its deduction date is within `DEFAULT_DATE_TOLERANCE_DAYS` (seven days) of
  the ledger's last payment date (`identity.ts:214-227`;
  `discovery.ts:289-291`). The pair is then shown to a person (ADR 0032) and,
  if confirmed, merged (ADR 0042). Otherwise the claim resolves `none` and
  opens beside the ledger case.
- **Portal first, then ledger.** The ledger path passes `invoice_number` as an
  exact identifier. So a short-pay that arrives after exactly one portal case
  on its invoice resolves `exact` to that case, and `triageCandidate` skips it
  with no amount check (`packages/core-domain/src/triage.ts:88-94`). The sync
  then only adds its identifiers to that case (`discovery.ts:303-306`). If the
  gap is larger than that one claim, the rest of the gap is neither opened nor
  declined: it leaves discovery without a trace, and later syncs match on
  `ledger_invoice_id` and never see it again. After two or more portal cases
  on the invoice, the short-pay is `ambiguous` and declined as
  `duplicate_of_other`. That is a declined candidate naming the cases, not a
  pair in the possible-duplicate list.
- **One ledger gap may be several portal claims, and no pair is raised.**
  `probableBasis` requires the amounts to agree to the cent, so a ledger gap
  that is the sum of several portal claims opens beside them unpaired, and
  `coverage_by_period*` counts those dollars twice. Surfacing a sum to a
  person is an identity follow-up with its own ADR. It is a known limit,
  written down here so it is not discovered later.
- **A prerequisite, before the first scheduled read.** Portal read makes the
  silent loss above routine, so it is fixed first (§14). In
  `triageCandidate`, an exact match whose only matched kind is
  `invoice_number` skips only when `gapCents` equals the matched case's amount
  to the cent. Otherwise the short-pay opens its case with
  `possibleDuplicateOf` naming the matched case, and a person sees the pair. A
  test covers one portal claim smaller than the ledger gap. Only exact matches
  merge without a person, and nothing here loosens that.

### 12. Payer codes map by playbook data, never by code

- A portal's printed reason codes stay as printed. For a case a remittance
  line opened, that is `reason_code_as_printed` (`steps.ts:2096`). The notice
  path does not write that column (`steps.ts:1275-1286`). So for a case a
  notice opened, a portal capture included, the code map reads the printed
  codes from the notice's extraction (`lines[].reason_code`). They map into
  `reason-codes.ts` only through Draft D's code-map rows: an exact normalised
  match, else **unmapped**, which is a finding on the case. It is never the
  nearest match, and a model never maps.
- A printed code whose meaning depends on the backup maps to nothing by code.
  ADR 0058 names one: UNFI's `-111` means a shortage or a price discrepancy.
  A person picks the canonical code from the backup.
- The taxonomy grows only by an ADR-tracked edit to `reason-codes.ts`, under
  its 60-code ceiling.
- This ADR therefore needs Draft D's tables
  (`docs/plans/phase-2/tasks/04-playbooks.md`) for its first demo, and §14
  moves them with it.

### 13. Runs, failures and the schedule

This follows the ledger sync (ADR 0031) in all three of its parts. Draft H
named none of them.

- **A registry, `portal_connections`,** like `accounting_connections`
  (migration 0024). It holds: the org; the portal key; a label; the portal
  account's public identifier (a supplier or vendor number, never the
  username); the run parameters (§3); `enabled`; and `created_by`, the member
  a scheduled read acts as.
  - **Frozen.** A trigger freezes every column except `enabled` and the label.
    Migration 0030's `app.touch_accounting_connection()` (ADR 0039) freezes
    the org, provider, account and member. Here the parameters are frozen
    too, because the runner types them into the portal's forms. A changed
    account or parameter is a new connection, so a run and its captures,
    keyed by the connection, always describe what they ran with.
  - **Owner-only.** Writes go through `app.member_is_owner()`.
  - **One enabled connection per portal account across the deployment**, as
    migration 0030's partial unique index does for ledgers, so that two
    workspaces of one agency do not both read one supplier's account. The
    index is over the portal key and the account identifier **normalised**
    (case, spaces and punctuation folded). ADR 0039 verified the realm with
    Intuit before writing anything. Here an owner types the identifier and
    nothing checks it before it is written, so every run checks it: a
    recipe's first step after sign-in is an `expect` on the account number
    the portal displays, compared with the connection's. A mismatch ends the
    run `needs_attention` with `account_mismatch` before anything is
    captured.
  - It is not append-only, because `enabled` flips.
- **A run-start table, `portal_read_starts`,** append-only. Its row is written
  before the worker is called: the run id, the connection (whose parameters
  are frozen), the recipe version, whether it is a dry run, and the acting
  member. Each `portal_captures` row names it. A run killed mid-flight leaves
  a start row with no outcome, and its captures still point at it.
- **An outcome table, `portal_read_runs`,** append-only. Its row is written
  once, when the run ends, and complete (ADR 0023's shape), naming its start
  row. Both tables are written only through definer functions,
  `app.record_portal_read_start()` and `app.record_portal_read_run()`, bounded
  to the caller's own org claim and subject. `app_rw` holds SELECT only on
  both, as with `app.record_ledger_sync_run` (migration 0024). The outcomes
  are:
  - `completed`;
  - `not_configured`;
  - `refused`: the member may no longer write;
  - `needs_attention`, with a reason code: `mfa_unanswerable`, `challenge`,
    `page_changed`, `terms_prompt` (an overlay or dialog carrying a
    floor-listed control outside a recorded `dismiss` container, §1),
    `credential_rejected`, `capture_refused` or `account_mismatch`;
  - `failed`, with a class name only.

  A run records counts (pages, captures, new documents, deduplicated ones,
  refusals). It never records page text, a query string or anything
  credential-shaped. A start with no outcome is shown as a run that did not
  finish.
- **A fan-out lister, `app.portal_connections_to_read()`**, untenanted and
  definer. It hands out ids only and refuses any caller carrying a claim, as
  migration 0033 made the ledger lister do.
- **The job acts as the connection's `created_by`.** In the ledger job's order
  (`packages/pipeline/src/ledger-job.ts:377-388`), it checks that the
  connection is still enabled, then asks `memberMayWrite` of the database,
  before any vendor call. It runs as `app_rw` with that member's claims and
  never as the service role.
- **The schedule** is a field of the recipe version, promoted with it. The
  default is one serial read per connection per day, off-hours for the
  portal. One read per connection is in flight at a time. The fleet cap
  counts against the plan's five (`apps/web/lib/inngest.ts:44`), alongside
  document reads and ledger syncs. The fan-out mints run keys in a memoized
  step, as `inngest-ledger.ts` does.
- **Alerts.** A failed run reaches a person: the portal job is added to
  `ALERTED_FUNCTIONS` (`apps/web/lib/alerts.ts:31`).
- **A failure degrades and never fails a case.** `needs_attention` or `failed`
  changes nothing on any case. Settings says what happened, in words derived
  from the outcome code, and the case goes on by upload and email (STRATEGY
  §5.4).

### 14. Build order

- `CLAUDE.md`'s order puts portal read inside Phase 2, with evidence and the
  model decision. This ADR moves **portal read for the first portal**
  (`docs/plans/phase-2/tasks/13-portal-read.md`) ahead of the rest of Phase 2.
- It brings along only what the first portal needs:
  - Draft D's playbook tables and code map
    (`docs/plans/phase-2/tasks/04-playbooks.md`), once Draft D is promoted to
    a numbered ADR;
  - ADR 0056's reader, if the first portal's export is a spreadsheet;
  - the triage change of §11, before the first scheduled read.
- Tasks 01–03 and 05–12 keep their order and their gates.
- **The reason.** The pilot customer is a UNFI supplier (ADR 0058). The
  founder's judgement, which the research did not measure (ADR 0058), is that
  for brands like it distributor deductions outnumber direct-retailer ones.
  Coverage is measured by what arrives, and a decision model has nothing to
  decide until deductions arrive with their reasons.
- Portal write of any kind and browser auto-submission stay Phase 6
  (`CLAUDE.md`, "Do not build yet"). `SubmissionChannel` and `portal_agent`
  are untouched.
- **The `CLAUDE.md` edit**, made in the same change that marks this ADR
  accepted:
  - The build-order line becomes: Phase 0 foundations → 1 ingest+classify →
    3 packet+approval+manual submission+outcomes, human-decided (ADR 0020) →
    1.5 ERP read + triage → **2a portal read, first portal, with Draft D's
    tables (ADR 0057)** → 2 evidence+decision (EV-gated) → 2.5 EDI 812/820 →
    4 QBO write-back + contingency billing → 5 learning loop → 6 careful
    autonomy.
  - If the founder builds the live agent (§5, §17.6), "Agentic loops are
    reserved for exactly two bounded steps" is amended to name it. The
    offline alternative still widens cold start to drafting and repairing
    recipes, and the edit says so.
  - If the pilot's market changes `CLAUDE.md`'s go-to-market paragraph (ADR
    0058, Context), that edit is part of the same change.
- **The Phase 2 plan**, in the same change: task 13's *Starts when* becomes
  "ADR 0057 accepted; the portal's own ADR (0058 for UNFI) accepted with its
  terms record filled", and `docs/plans/phase-2/README.md` points row H and
  row 13 at that. Draft H is superseded and can no longer be accepted, so the
  old gate could never be met.

### 15. Tables, in the next free migration after acceptance

The migration number is taken after a `git fetch`, when the migration is
written.

- `portal_connections`: the registry (§13). RLS on, owner-only writes, every
  column except `enabled` and the label frozen by trigger, and a partial
  unique index over the normalised account identifier.
- `portal_credentials`: sealed, append-only, with a composite foreign key on
  `(org_id, connection_id)` (ADR 0025 §7's pattern). INSERT policy:
  `org_id = app.current_org_id() and app.member_is_owner() and created_by =
  app.current_user_id()`.
- `portal_recipe_versions`: append-only and immutable. A version names its
  author: the person who wrote it as the caller, or, for an agent draft, the
  owner who started the session and the session's id.
- `portal_recipe_reviews`: append-only. INSERT policy:
  `org_id = app.current_org_id() and app.member_is_owner() and reviewer =
  app.current_user_id()`.
- `portal_read_starts`: append-only, written only by its definer function.
- `portal_read_runs`: append-only, written only by its definer function.
- `portal_captures`: append-only, written in the same transaction as its
  capture's `uploads` row.

Every append-only table gets RLS on, one policy per command, `app_rw` SELECT
and INSERT (SELECT only for the two run tables, and INSERT owner-only as above
for credentials and reviews), `app_ro` SELECT, `no_update_delete` and
`no_truncate`, and nothing for the request roles (ADR 0037). Suites 01 and 24
are extended, suite 01 covering the start table too. A new suite reads the
credential table's columns back against the catalogue in both directions, as
suite 21 does for QuickBooks, and asserts the owner-only INSERT policies on
credentials and reviews. The migration goes to `mozart-preview` first, then
production, and is read back on both.

### 16. What this does not do

- It writes nothing to any portal, and submits nothing.
- It fetches no backup for a named case. Draft E lists `portal` as a later
  evidence source; a fetch for one case is a later step, and Draft E must give
  it a place in its cost order, because it is not free.
- It shares no recipes across tenants (§3).
- It solves no challenge and evades no bot protection (§1).
- It reads no third party's portal that a payer's site links to (an analytics
  partner, say), unless that portal's ADR covers the linked party's terms.
  That party has its own terms. ADR 0058 covers Direct Commerce, which built
  UNFI's Dispute Center, and not Crisp.
- It reads no EDI (Phase 2.5).

### 17. What the founder decides

1. **Option C**: recipes as data, a read-only runner, a reader with no tools,
   and an agent that only drafts.
2. **Where the browser runs**: our own worker (default) or a hosted browser
   provider. Under the provider, our worker still holds decrypt and drives it
   over CDP with recording and logging off, and the credential split and
   `CLAUDE.md`'s storage rule are otherwise not met (§6).
3. **Captures that would open a case**: held as `by_portal` for every portal
   (recommended), or the ordinary gate. Either way the hold ships with the
   door, and choosing the gate later is a loosening under §10.
4. **Recipe scope**: per tenant (recommended to start) or shared, which would
   need its own ADR.
5. **Emailed MFA codes**: build the code-address variant now, or TOTP only and
   stop otherwise (recommended until a portal needs email codes).
6. **The agent**: later (recommended; the first recipe is written from the
   founder's hand walk-through and promoted by the founder). When it is built:
   offline, from stored snapshots, or live, which amends `CLAUDE.md`'s
   reserved agentic surface (§5, §14).
7. **The build-order change** in §14.

## Where this departs from Draft H

| Draft H said | This ADR |
| --- | --- |
| §1: an adapter with `listClaims(window)` and `fetchBackup(claimId)` | A new read-only `PortalSource` port that runs a promoted recipe. `fetchBackup` for one case waits for Draft E (§16) |
| Builds on `EvidenceSource` (`kind: 'portal'`) | `'portal'` is only a `sourceKind` value, and `fetch` needs a case. A new port instead (§1) |
| §2: each portal's ADR confirms the terms "allow automated access" | Kept as a gate (§2). The ADR records one of four answers, and a recipe runs only on "allowed", "allowed with conditions" or the payer's written consent |
| §2: the first portal is chosen by the first customer who uses one | Chosen for the pilot customer, a UNFI supplier (§2, ADR 0058) |
| `portal_fetch` exists as an upload source | True in the database, not in the pipeline. `IngestSource` is widened (§9) |
| §5: an `uploads` row, then `acceptUpload` | `ingestDocument` runs `acceptUpload` first, then dedupe, then the `uploads` row (§9) |
| §3: sealed through `TokenCipher` in `portal_credentials` | Kept, with a purpose and a bound destination added to the context and a separate KMS key (§7). The "application table" question is settled by citing ADR 0033 §1(b) |
| §4, §6: `portal_read_runs`, "exactly like the ledger sync" | The pattern's three parts named: registry, definer-only run writers, claim-refusing fan-out lister, plus a run-start row (§13) |
| Silent on where a browser runs | Outside Vercel, in a worker with no database credential (§6) |
| §5: a portal claim and a ledger short-pay converge on one case | Exact matches only within a kind, and the ledger's exact match on an invoice skips with no amount check. They converge through a person and a merge only when invoice, amount and date agree, and a triage change comes first (§11) |
| Silent on whether a capture opens a case | Held as `by_portal` for every portal, in code, recommended (§10) |
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
  the agent if it is built, and until then the customer is back on upload and
  email. That is the right failure, and it is operational load that grows
  with each portal added.
- A recipe version that changes the sign-in origin, paths or hosts needs an
  owner to enter the credential again (§7).
- There is a new service to run, with its own secrets, its own egress and a
  headless browser to keep patched.
- A portal claim and a ledger short-pay meet through a person, and only when
  invoice, amount and date agree. Two limits are known and written down
  (§11). A ledger gap that is the sum of several portal claims opens beside
  them unpaired, and coverage counts it twice until an identity follow-up.
  And until §11's triage change lands, a gap larger than the one portal claim
  on its invoice is skipped whole: the rest is neither opened nor declined.
- HTML enters the door for one source. It is new untrusted-input surface and
  gets the fail-closed treatment the PDF inspector has.

## Invariants touched

- **1 (approval before anything is filed)**: unchanged. No write path exists:
  the port has no submit method, the runner has no write step, bounds every
  request by method and target and refuses write controls by name, and
  `portal_agent` stays Phase 6.
- **2 (append-only)**: six new append-only tables, and one registry that is
  not append-only because `enabled` flips, like `accounting_connections`, with
  every other column but its label frozen. No UPDATE or DELETE grant is added.
  A capture's `uploads` row is written at ingest, since an arrival cannot be
  asserted for `portal_fetch` later.
- **3 (money in integer cents)**: every amount from a capture reaches cents
  through `parseMoneyToCents` or `parseUnitPrice`, or through ADR 0056's reader
  for a spreadsheet.
- **4 (untrusted content)**:
  - the reader is unchanged, with no `tools` parameter and delimited text;
  - the scheduled runner sends no page to any model;
  - on a scheduled run or a dry run, page text never becomes an instruction
    to the runner;
  - during an owner-started agent session, if one is built, page text can
    influence which permitted read happens next, bounded as §5 says. The
    index reaches the model inside `<untrusted_document>` delimiters, the
    agent never sees or directs a credential, and it produces only data a
    person must promote under §3's checks.
- **5 (providers behind ports)**: the reader uses the existing ports. The
  agent's calls go through their own port, `PortalStepChooser`, not
  `DecisionProvider`, and no Jev call is on its path (§5).
- **6 (RLS; no service role in a request path)**: RLS on every new table. The
  job runs as `app_rw` with the member's claims. The worker has no database
  credential. The service role appears nowhere.
- **7 (thresholds only tighten)**: none changed. Lifting the `by_portal` hold
  is a loosening, and needs an ADR and a one-way database guard (§10).
- **Playbook rule**: payer codes and recipes are versioned data with
  provenance, never code. No code names a portal, the hold's scope included.
- **`CLAUDE.md`'s reserved agentic surface**: widened only if the founder
  builds the agent (§5, §17.6), and then by the explicit amendment §14 names.
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

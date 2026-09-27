# UNFI portal read: the plan

*Drafted 2026-09-26 on branch `claude/trusting-brown-ordc3m`. **A plan, not a
build.** Nothing here is implemented. Each step says who does it, what "done"
means, and what it waits on. The decisions behind it are ADR 0057 (a portal
is read, never written) and ADR 0058 (UNFI is the first portal). Both are
proposed. The public research is in [`research.md`](research.md). ADR 0058
numbers two parts separately, *What the research says* and *Decision*, so a
section of it is always named with its part.*

## The first demo

**One real UNFI deduction pulled, read, matched to its QuickBooks short-pay,
and given a canonical reason code.** Concretely:

1. **Pulled.** A run of the promoted UNFI recipe captures the deduction's
   page or backup, and the capture is stored as a document from
   `portal_fetch`, scanned clean.
2. **Read.** The existing reader reads it, with every field's quote verified
   against the stored capture. It is held as `by_portal` (ADR 0057 §10).
3. **Matched.** A person opens the held capture ("Open a case from it"). If
   the capture prints the invoice number as its own field, its case and the
   case the QuickBooks sync opened for the same short-paid invoice meet as a
   possible duplicate. A person confirms them and they merge into one case
   (ADR 0057 §11). That also needs the QuickBooks gap to equal this one
   deduction to the cent, and the deduction date to be within seven days of
   the invoice's last payment date (ADR 0058, Decision §9). If the ledger
   arrives second, it may instead resolve to the portal case exactly and open
   nothing.
4. **Coded.** The case shows a canonical reason code from a reviewed UNFI
   code-map row. For a `-111`, a person picks the code from the backup.

Pick a demo deduction that is the only deduction on its invoice, and whose
documents were **not** uploaded by hand in step 4. A capture whose bytes are
already stored keeps its first arrival (`web_upload`), so it would not show
as pulled.

If the terms answer (step 1) rules out automated reads, the demo runs on the
same deduction uploaded by hand, and "pulled" waits for UNFI's consent.

## Where things stand

| Item | State |
| --- | --- |
| ADR 0057, portal read | Proposed; the founder accepts or amends |
| ADR 0058, UNFI first | Proposed; the terms check is pending |
| Draft D, playbooks and code maps | Proposed (Phase 2 task 04). The code map needs it, promoted to a numbered ADR |
| ADR 0056, spreadsheets | Accepted, not built. Needed only if UNFI's export is a spreadsheet |
| The ledger triage change (ADR 0057 §11) | Not built. Needed before the first scheduled read |
| QuickBooks read | Live (Phase 1.5). The pilot customer must have connected their company |
| Email-in | Live (ADR 0047). UNFI's emailed remittances can be forwarded today |

## The founder's steps

These come first. Nothing Claude builds against UNFI runs before steps 1–3.

### 1. Read UNFI's terms and record the answer

- **Who:** the founder.
- **What:** read, in a browser, the myUNFI Terms of Use, UNFI's site Terms of
  Use, the Supplier Terms, the Dispute Center's own terms (Direct Commerce's)
  and the Supplier Code of Conduct (and the SVHarbor terms, if the
  conventional side is used). Archived copies of the first three are listed
  in `research.md`, *Still unknown*. Answer the five questions in ADR 0058,
  Decision §2:
  - which documents govern, and the version or date of each as read;
  - automated access, including whether Direct Commerce's `robots.txt`
    binds a user the supplier authorised;
  - a separate user for a service provider;
  - whether we are a "third-party" under the confidentiality clause;
  - anything shown at sign-in.
- **Done means:** ADR 0058, Decision §2's record is filled in, with the
  documents, their versions and dates, the answer and any conditions, and the
  founder's date. If the answer is "needs UNFI's written consent", the
  request to UNFI is sent and its answer recorded.
- **Waits on:** nothing.
- **Blocks:** step 2 (the login), and any automated read (steps 14 and 15,
  and the "pulled" in step 19).

### 2. Create a dedicated UNFI login

- **Who:** the founder, with the pilot customer's UNFI portal owner.
- **What:** the owner adds a separate user for this service, with the least
  role that can see deductions, payments and backup (ADR 0058, Decision §3).
  If a role exists that cannot dispute, use it: the Dispute Center and ePASS
  are read by machine only with such a role. It must not be anyone's own
  login. On the conventional side, check first whether a user adds to the
  SVHarbor fee.
- **Done means:** the user exists and the founder holds its credentials in a
  password manager. They are **never** pasted into chat, an email, an issue
  or the repository. They go into the product only through Settings → Portals
  (steps 9 and 14), once that exists.
- **Waits on:** step 1's questions on automated access and on a separate user
  answered "allowed" or "allowed with conditions", and the pilot customer's
  agreement.

### 3. Walk the portal once by hand

- **Who:** the founder, signed in as the dedicated user.
- **What:** answer the twenty open items in ADR 0058, Decision §11. For each
  screen, record what it shows and which exports exist, in what format. Also
  record every host visited, the exact text of every control that writes,
  whether the user's role can dispute in the Dispute Center or ePASS, and
  what sign-in and MFA asked.
- **How it is recorded:** as labels, hosts, column headers and counts only.
  No values, no customer names, no deduction numbers, no screenshots with
  data, and no credentials, in chat or in the repository. Claude writes the
  answers into ADR 0058, Decision §11.
- **Done means:** every open item has an answer or "not seen".
- **Waits on:** steps 1 and 2.

### 4. Gather 3–5 real deductions with their backup

- **Who:** the founder, with the pilot customer.
- **What:** choose three to five real UNFI deductions, if possible of
  different kinds (a `-111`, an MCB, a compliance fee), each with its backup.
  Each one's short-pay must be visible in the customer's connected
  QuickBooks. Upload each deduction's documents on the case page of the
  ledger case QuickBooks opened for that invoice, so that they file as
  evidence and open no case of their own. An upload from the case list would
  open a second case beside the ledger's. A deduction QuickBooks opened no
  case for is left out, because it cannot show a match. Never upload into the
  repository or chat. Keep one deduction back for the demo, the only
  deduction on its invoice (see *The first demo*).
- **Also decide:** whether the customer permits these documents, redacted, to
  become eval fixtures (step 18), or only synthetic copies of their
  structure. Record the answer in writing.
- **Done means:** each deduction's documents are on its ledger case; the demo
  deduction is identified by the founder, off the repository; and the
  fixture permission is recorded.
- **Waits on:** the pilot customer having connected QuickBooks.

### 5. Decide ADR 0057, Draft D and ADR 0058

- **Who:** the founder decides; Claude writes the numbered ADR Draft D is
  promoted to.
- **What:** accept or amend ADR 0057, including each choice in its §17.
  Promote Draft D to a numbered ADR (its number taken after a `git fetch`),
  whole or the part the code map needs, and accept it. The migration hook
  needs a numbered ADR, not a draft. Accept ADR 0058 once step 1's answer is
  recorded.
- **Done means:** each is marked accepted (or amended) with a date.
  `CLAUDE.md`'s build order, and the Phase 2 plan's task 13 gate, are amended
  in the same change as ADR 0057 (ADR 0057 §14).
- **Waits on:** step 1 for ADR 0058; nothing for the other two.

**Meanwhile, with no build:** the customer can forward UNFI's remittance and
backup emails to their workspace's issued address. PDF and image
attachments, and the body, are stored and held by email for a person to open
(ADR 0047). A zip attachment is recorded as a refused part and not stored,
and so is a spreadsheet until ADR 0056 is built. A SharePoint link is not
followed.

## Claude's steps

Each code step ends in a PR with `pnpm verify` green. Steps 14 and 16 end in
promoted data rows instead. Migration, ADR and suite numbers are taken after
a `git fetch`, when the step starts.

### 6. The recipe schema and the runner's refusals

- **Who:** Claude.
- **What:** the recipe as a typed, versioned data shape: ADR 0057 §3's step
  kinds, host allowlist, sign-in binding, never-click names, POST-as-read
  entries (step, path and discriminator), the control text and form `action`
  each step was drafted against, the schedule, caps and provenance. Also the
  runner's own refusals, as code:
  - method and target: a non-GET only to a bound sign-in path, a search
    form's recorded `action`, or a POST-as-read entry;
  - file inputs, the never-click floor and off-allowlist hosts;
  - a `dismiss` only on an exact container match;
  - `sign_in` and `answer_mfa` taking no argument;
  - terms prompts and challenges.

  Also a dry-run mode that records only step names and pass or fail, and
  captures nothing (ADR 0057 §3). All of it is tested against a fixture
  portal: a static site in the repository with a sign-in, a list, a detail
  page and a download, and decoys: "Dispute", "Upload" and "Accept terms"
  controls, a "session expired, re-enter your password" form and a
  change-password form.
- **Done means:** every refusal has a test that fails when the refusal is
  removed; no step kind can express a write; and the decoy dispute control
  is refused, which ADR 0058, Decision §3 relies on.
- **Waits on:** ADR 0057 accepted (step 5), and step 3 for any step kind UNFI
  turns out to need.

### 7. The worker

- **Who:** Claude builds; the founder sets its secrets and turns billing on.
- **What:** `services/portal-read`, deployed like `services/clamav-scan`: a
  headless browser running the runner from step 6; a bearer token compared in
  constant time; `/health`; an egress allowlist; an empty browser profile per
  run; no database credential and no model key; no Playwright trace, HAR,
  video or screenshot. It decrypts a sealed credential with its own KMS
  permission, only for the credential's binding (ADR 0057 §6, §7), and
  nothing credential-shaped reaches a log.
- **Done means:** its tests run the fixture portal end to end, and assert
  that no credential, code, cookie or username appears in any log line,
  response or snapshot, and that a recipe naming another host is refused
  before `kms:Decrypt` is called.
- **Waits on:** step 6, and the founder choosing our own worker over a
  hosted browser provider in step 5.

### 8. The migration

- **Who:** Claude builds; the founder approves applying it to
  `mozart-preview` and production.
- **What:** the tables of ADR 0057 §15:
  - `portal_connections`;
  - `portal_credentials`;
  - `portal_recipe_versions`;
  - `portal_recipe_reviews`;
  - `portal_read_starts`;
  - `portal_read_runs`;
  - `portal_captures`.

  With them come: the definer start and run writers and the claim-refusing
  fan-out lister; the owner-only INSERT policies on credentials and reviews;
  the connections' frozen-column trigger and normalised unique index; a
  purpose and a binding in `TokenEncryptionContext`; and the suites (01 and
  24 extended, and one new suite reading the credential table's columns
  back).
- **Done means:** `pnpm db:test` green; applied to `mozart-preview` first, then
  production, and read back on both.
- **Waits on:** ADR 0057 accepted. This is a human gate: the hook
  (`.claude/hooks/require-adr.sh`) only checks that the branch carries an
  ADR, which this branch already does.

### 9. Sealed credential entry, and writing a recipe

- **Who:** Claude builds; the founder creates the KMS key.
- **What:** Settings → Portals, owner only. It seals before it writes, under a
  separate KMS key that the app may seal with and not open, bound to a
  recipe version's sign-in origin, paths and hosts (ADR 0057 §7). A
  replacement is a new row. Includes a short setup note for the KMS key and
  its split permissions, written for someone who does not work in AWS (as
  `docs/qbo-credentials.md` is). Also an owner-only way to write a recipe
  version and a review row as the caller: Settings → Portals, or a `pnpm`
  operator command writing through `PostgresStore` as `app_rw` with the
  caller's claims, as `link:qbo` and `link:retailer` do. Never the service
  role, and never the SQL editor as `postgres`.
- **Done means:** only ciphertext exists anywhere. The route and store tests
  spy on logs, events, redirects and audit payloads. An owner can write a
  recipe version and its review, and nobody else can.
- **Waits on:** steps 7 and 8.

### 10. Draft D's tables (Phase 2 task 04)

- **Who:** the founder accepts (step 5); Claude builds
  `docs/plans/phase-2/tasks/04-playbooks.md`.
- **What:** the playbook and code-map tables of the ADR Draft D was promoted
  to, and `mapPayerCode`.
- **Done means:** the migration is applied to `mozart-preview`, then
  production, and read back; code-map rows can be written with provenance.
- **Waits on:** step 5.

### 11. ADR 0056's reader, only if the export needs it

- **Who:** Claude.
- **What:** ADR 0056's spreadsheet reader, built only if step 3 finds that the
  export UNFI gives is XLSX or CSV.
- **Done means:** as ADR 0056 defines it.
- **Waits on:** step 3.

### 12. Capture to ingest, with the hold

- **Who:** Claude.
- **What:**
  - widen `IngestSource` to `portal_fetch`, and in the same PR hold anything
    that would open a case as `by_portal`, keyed in `readDocument` on the
    recorded arrival (ADR 0057 §10). It is fail-closed in code before ADR
    0057 §17.3 is decided;
  - accept a page snapshot at the door for that source only, serialised by
    ADR 0057 §9's allowlist with the username replaced, and served only as a
    download with §9's four headers;
  - send each capture through `ingestDocument` inside one job step, and write
    its `portal_captures` row in the same transaction as its `uploads` row;
  - record a refused capture on the run.
- **Done means:** a capture from the fixture portal becomes a scanned, read,
  held document whose quotes verify against the stored snapshot. An HTML
  file uploaded or emailed is still refused. "Read again" on a capture never
  read still holds it.
- **Waits on:** step 8.

### 13. The ledger triage change

- **Who:** Claude.
- **What:** ADR 0057 §11's prerequisite. In `triageCandidate`, an exact match
  whose only matched kind is `invoice_number` skips only when the gap equals
  the matched case's amount to the cent. Otherwise the short-pay opens its
  case with `possibleDuplicateOf` naming the matched case. Tests cover both
  orders of arrival, one portal claim smaller than the ledger gap, and one
  ledger gap that is several deductions. The last asserts the limit ADR 0057
  §11 records: no pair is raised, and both open.
- **Done means:** the tests are green, and no other triage outcome moves.
- **Waits on:** ADR 0057 accepted (step 5).

### 14. UNFI recipe, version 1

- **Who:** Claude drafts; the founder enters the credential, runs the dry run
  supervised and promotes the version.
- **What:** Claude writes the first recipe as data, from step 3's answers:
  hosts, controls by their accessible names with their recorded text, the
  export if one exists, otherwise detail pages and backup downloads. The
  founder, an owner of the pilot workspace, writes it there through step 9's
  owner-only path as its author of record; its provenance says Claude drafted
  it from the walk-through. The founder enters the dedicated login from step
  2, bound to this version (ADR 0057 §7). It is run once as a dry run (ADR
  0057 §3), supervised by the founder: a step log only, nothing captured and
  no model. The founder then promotes it.
- **Done means:** a promoted UNFI recipe version exists, citing ADR 0058.
- **Waits on:** steps 1, 3 and 9; ADR 0058 accepted.

### 15. The scheduled read

- **Who:** Claude builds; the founder enables the pilot connection's schedule.
- **What:** the fan-out and the per-connection job, following the ledger sync:
  - acts as the connection's member: checks the connection is enabled, then
    asks `memberMayWrite`;
  - writes a run-start row before the worker is called;
  - one serial read per connection per day, off-hours, from the recipe
    version's schedule;
  - an outcome row with counts;
  - the portal job added to failure alerts;
  - the "needs attention" notice in Settings.

  The job steps return ids only, never ciphertext or bytes.
- **Done means:** tests on the fixture portal cover every outcome. In
  production the schedule is enabled for the pilot connection only after
  steps 12 and 13 are merged and deployed and step 1's answer allows it.
- **Waits on:** steps 12, 13 and 14.

### 16. The UNFI code map, as playbook data

- **Who:** Claude drafts the rows; the founder reviews and promotes the
  version.
- **What:** UNFI code-map rows in Draft D's tables, each with provenance,
  drafted from step 4's real deductions and from the Supplier Deduction Key
  if step 1's answer lets the customer share it. `research.md`'s seed list is
  a starting point only. `-111` maps to nothing by code. A reason is mapped
  only from a reason field the page prints on its own, never by parsing a key
  (ADR 0058, Decision §10). Gaps go to Draft D's taxonomy edit, never to a
  nearest match.
- **Done means:** each of step 4's deductions shows a canonical code, or an
  "unmapped" finding a person resolves.
- **Waits on:** steps 4 and 10.

### 17. Identity on real deductions

- **Who:** Claude checks; a person opens the held captures and confirms the
  pairs.
- **What:** a portal claim records its key as `claim_id`, with source
  `portal_fetch`, and, where printed as its own field, its `invoice_number`.
  It is never matched on the invoice as an exact key by the notice path. The
  pair with the ledger case reaches the possible-duplicate list, and
  confirming it merges the two (ADR 0057 §11; ADRs 0032, 0042).
- **Done means:** for each of step 4's deductions, exactly one open case
  remains: merged after a person confirmed the pair, or the ledger short-pay
  resolved exact to the portal case. A deduction for which ADR 0057 §11's
  conditions do not hold (no invoice number printed on its own, or several
  deductions on the invoice) is recorded here as that known limit, not
  forced. Nothing merges without a person except an exact match.
- **Waits on:** steps 4 and 15, and ADR 0058, Decision §11 item 16 (how the
  customer's books record a UNFI deduction).

### 18. Eval fixtures and cassettes from real documents

- **Who:** Claude records; the founder approves the spend.
- **What:** a `unfi` eval suite, scored separately and never blended:
  - redacted real documents if step 4 recorded permission, otherwise
    synthetic copies built from their structure;
  - cassettes for the reader, recorded with `pnpm record:cassettes`, which
    spends money and is asked first;
  - a baseline recorded for this suite alone.

  If the agent is built later, its cassettes are recorded against the
  fixture portal.
- **Done means:** `pnpm eval` scores the suite. No other suite's baseline
  moves.
- **Waits on:** step 4, and the founder's go on the spend.

### 19. The first demo, end to end

- **Who:** Claude runs it; the founder watches and does the person's parts:
  opening the held capture ("Open a case from it"), confirming the pair and
  picking a `-111` code.
- **Done means:** the demo deduction from step 4 is pulled, read, matched to
  its QuickBooks short-pay and coded, as described at the top. It is
  recorded in `docs/DEMO.md`.
- **Waits on:** steps 14–17.

## Later, not needed for the demo

- The agent that drafts or repairs a recipe (ADR 0057 §5), which amends
  `CLAUDE.md`'s reserved agentic surface when it is built.
- The emailed-MFA-code address (ADR 0057 §8), if UNFI offers no TOTP.
- The conventional side (SVHarbor ePASS), as its own recipe.
- Lifting the `by_portal` hold. It is a loosening under ADR 0057 §10: an ADR
  and a one-way guarded row, never a setting.
- A second portal, with its own ADR (KeHE is the likely one; the founder
  decides).

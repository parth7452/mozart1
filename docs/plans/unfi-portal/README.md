# UNFI portal read: the plan

*Drafted 2026-09-26 on branch `claude/trusting-brown-ordc3m`. **A plan, not a
build.** Nothing here is implemented. Each step says who does it, what "done"
means, and what it waits on. The decisions behind it are ADR 0057 (a portal
is read, never written) and ADR 0058 (UNFI is the first portal). Both are
proposed. The public research is in [`research.md`](research.md).*

## The first demo

**One real UNFI deduction pulled, read, matched to its QuickBooks short-pay,
and given a canonical reason code.** Concretely:

1. **Pulled.** A run of the promoted UNFI recipe captures the deduction's
   page or backup, and the capture is stored as a document from
   `portal_fetch`, scanned clean.
2. **Read.** The existing reader reads it, with every field's quote verified
   against the stored capture.
3. **Matched.** Its case and the case the QuickBooks sync opened for the same
   short-paid invoice meet as a possible duplicate. A person confirms them
   and they merge into one case (ADR 0057 §11). If the ledger arrives second,
   it may instead resolve to the portal case exactly and open nothing.
4. **Coded.** The case shows a canonical reason code from a reviewed UNFI
   code-map row. For a `-111`, a person picks the code from the backup.

Pick a demo deduction that was **not** uploaded by hand in step 4. A capture
whose bytes are already stored keeps its first arrival (`web_upload`), so it
would not show as pulled.

If the terms answer (step 2) rules out automated reads, the demo runs on the
same deduction uploaded by hand, and "pulled" waits for UNFI's consent.

## Where things stand

| Item | State |
| --- | --- |
| ADR 0057, portal read | Proposed; the founder accepts or amends |
| ADR 0058, UNFI first | Proposed; the terms check is pending |
| Draft D, playbooks and code maps | Proposed (Phase 2 task 04). The code map needs it |
| ADR 0056, spreadsheets | Accepted, not built. Needed only if UNFI's export is a spreadsheet |
| QuickBooks read | Live (Phase 1.5). The pilot customer must have connected their company |
| Email-in | Live (ADR 0047). UNFI's emailed remittances can be forwarded today |

## The founder's steps

These come first. Nothing Claude builds against UNFI runs before steps 1–3.

### 1. Create a dedicated UNFI login

- **Who:** the founder, with the pilot customer's UNFI portal owner.
- **What:** the owner adds a separate user for this service, with the least
  role that can see deductions, payments and backup (ADR 0058, Decision §3).
  If a role exists that cannot dispute, use it. It must not be anyone's own
  login. Before creating it, read the myUNFI Terms of Use on user accounts
  (step 2 covers the full reading). On the conventional side, check first
  whether a user adds to the SVHarbor fee.
- **Done means:** the user exists and the founder holds its credentials in a
  password manager. They are **never** pasted into chat, an email, an issue
  or the repository. They go into the product only through Settings → Portals
  (step 9), once that exists.
- **Waits on:** the pilot customer's agreement.

### 2. Read UNFI's terms and record the answer

- **Who:** the founder.
- **What:** read, in a browser, the myUNFI Terms of Use, UNFI's site Terms of
  Use, the Supplier Terms, the Dispute Center's own terms and the Supplier
  Code of Conduct (and the SVHarbor terms, if the conventional side is used).
  Answer the five questions in ADR 0058, Decision §2: automated access; a
  separate user for a service provider; whether we are a "third-party" under
  the confidentiality clause; anything shown at sign-in.
- **Done means:** ADR 0058 §2's record is filled in, with the documents, their
  versions and dates, the answer and any conditions, and the founder's date.
  If the answer is "needs UNFI's written consent", the request to UNFI is
  sent and its answer recorded.
- **Waits on:** nothing.
- **Blocks:** any automated read (steps 10, 11, and the "pulled" in step 16).

### 3. Walk the portal once by hand

- **Who:** the founder, signed in as the dedicated user.
- **What:** answer the nineteen open items in ADR 0058, Decision §11. For
  each screen, record what it shows and which exports exist, in what format.
  Also record every host visited, the exact text of every control that
  writes, and what sign-in and MFA asked.
- **How it is recorded:** as labels, hosts, column headers and counts only.
  No values, no customer names, no deduction numbers, no screenshots with
  data, and no credentials, in chat or in the repository. Claude writes the
  answers into ADR 0058 §11.
- **Done means:** every open item has an answer or "not seen".
- **Waits on:** step 1. Step 2 should come first where the terms say
  anything about how the portal may be used.

### 4. Gather 3–5 real deductions with their backup

- **Who:** the founder, with the pilot customer.
- **What:** choose three to five real UNFI deductions, if possible of
  different kinds (a `-111`, an MCB, a compliance fee), each with its backup.
  Each one's short-pay must be visible in the customer's connected
  QuickBooks. Upload them into the pilot customer's workspace through the
  product, never into the repository or chat. Keep one deduction back for the
  demo (see *The first demo*).
- **Also decide:** whether the customer permits these documents, redacted, to
  become eval fixtures (step 15), or only synthetic copies of their structure.
  Record the answer in writing.
- **Done means:** the cases exist in the pilot workspace with their backup
  attached; the demo deduction is identified by the founder, off the
  repository; and the fixture permission is recorded.
- **Waits on:** the pilot customer having connected QuickBooks.

### 5. Decide ADR 0057, Draft D and ADR 0058

- **Who:** the founder.
- **What:** accept or amend ADR 0057, including each choice in its §17.
  Accept Draft D, or the part of it the code map needs. Accept ADR 0058 once
  step 2's answer is recorded.
- **Done means:** each is marked accepted (or amended) with a date, and
  `CLAUDE.md`'s build order is amended in the same change as ADR 0057
  (ADR 0057 §14).
- **Waits on:** step 2 for ADR 0058; nothing for the other two.

**Meanwhile, with no build:** the customer can forward UNFI's remittance and
backup emails to their workspace's issued address. Each is held by email for
a person to open (ADR 0047).

## Claude's steps

Each ends in a PR with `pnpm verify` green. Migration, ADR and suite numbers
are taken after a `git fetch`, when the step starts.

### 6. The recipe schema and the runner's refusals

- **What:** the recipe as a typed, versioned data shape: ADR 0057 §3's step
  kinds, host allowlist, never-click names, POST-as-read paths, caps and
  provenance. Also the runner's own refusals, as code: file inputs, the
  never-click floor, off-allowlist hosts, non-GET outside `sign_in`,
  `answer_mfa` and `search`, terms prompts and challenges. All of it tested
  against a fixture portal: a static site in the repository with a sign-in, a
  list, a detail page, a download, and decoy "Dispute", "Upload" and
  "Accept terms" controls.
- **Done means:** every refusal has a test that fails when the refusal is
  removed, and no step kind can express a write.
- **Waits on:** ADR 0057 accepted (step 5), and step 3 for any step kind UNFI
  turns out to need.

### 7. The worker

- **What:** `services/portal-read`, deployed like `services/clamav-scan`: a
  headless browser running the runner from step 6; a bearer token compared in
  constant time; `/health`; an egress allowlist; an empty browser profile per
  run; no database credential and no model key. It decrypts a sealed
  credential with its own KMS permission (ADR 0057 §6, §7), and nothing
  credential-shaped reaches a log.
- **Done means:** its tests run the fixture portal end to end, and assert
  that no credential, code or cookie appears in any log line or response.
  The founder sets its secrets and turns billing on, as for the scanner.
- **Waits on:** step 6, and the founder choosing our own worker over a
  hosted browser provider in step 5.

### 8. The migration

- **What:** the tables of ADR 0057 §15:
  - `portal_connections`;
  - `portal_credentials`;
  - `portal_recipe_versions`;
  - `portal_recipe_reviews`;
  - `portal_read_runs`;
  - `portal_captures`.

  With them come: the definer run writer and the claim-refusing fan-out
  lister; a purpose in `TokenEncryptionContext`; and the suites (01 and 24
  extended, and one new suite reading the credential table's columns
  back).
- **Done means:** `pnpm db:test` green; applied to `mozart-preview` first, then
  production, and read back on both.
- **Waits on:** ADR 0057 accepted and on the branch (the hook refuses edits to
  `supabase/migrations/**` until it is).

### 9. Sealed credential entry

- **What:** Settings → Portals, owner only. It seals before it writes, under a
  separate KMS key that the app may seal with and not open. A replacement is
  a new row. Includes a short setup note for the KMS key and its split
  permissions, written for someone who does not work in AWS (as
  `docs/qbo-credentials.md` is).
- **Done means:** the founder enters the dedicated login from step 1, and
  only ciphertext exists anywhere. The route and store tests spy on logs,
  events, redirects and audit payloads.
- **Waits on:** steps 7 and 8; the founder creating the KMS key.

### 10. UNFI recipe, version 1

- **What:** Claude writes the first recipe as data, from step 3's answers:
  hosts, controls by their accessible names, the export if one exists,
  otherwise detail pages and backup downloads. It is run once, supervised by
  the founder, in a mode that records only a step log (step names, pass or
  fail, no values). The founder then promotes it.
- **Done means:** a promoted UNFI recipe version exists, citing ADR 0058.
- **Waits on:** steps 2, 3 and 9; ADR 0058 accepted.

### 11. The scheduled read

- **What:** the fan-out and the per-connection job, following the ledger sync:
  - acts as the connection's member and asks `memberMayWrite` first;
  - one serial read per connection per day, off-hours;
  - a run row with outcome and counts;
  - the portal job added to failure alerts;
  - the "needs attention" notice in Settings.

  The job steps return ids only, never ciphertext or bytes.
- **Done means:** tests on the fixture portal cover every outcome. In
  production the schedule is enabled for the pilot connection only after step
  2's answer allows it.
- **Waits on:** step 10.

### 12. Capture to ingest

- **What:**
  - widen `IngestSource` to `portal_fetch`;
  - accept a page snapshot at the door for that source only;
  - send each capture through `ingestDocument` inside one job step;
  - write `portal_captures`;
  - hold anything that would open a case as `by_portal` (ADR 0057 §10), and
    record a refused capture on the run.
- **Done means:** a capture from the fixture portal becomes a scanned,
  read, held document whose quotes verify against the stored snapshot. An
  HTML file uploaded or emailed is still refused.
- **Waits on:** steps 8 and 11.

### 13. The UNFI code map, as playbook data

- **What:** UNFI code-map rows in Draft D's tables, each with provenance,
  drafted from step 4's real deductions and from the Supplier Deduction Key
  if step 2's answer lets the customer share it. `research.md`'s seed list is
  a starting point only. `-111` maps to nothing by code. Gaps go to Draft D's
  taxonomy edit, never to a nearest match. The founder reviews and promotes
  the version.
- **Done means:** each of step 4's deductions shows a canonical code, or an
  "unmapped" finding a person resolves.
- **Waits on:** Draft D accepted and its tables built (Phase 2 task 04), and
  step 4.

### 14. Identity match to QuickBooks

- **What:** a portal claim records its `portal_claim_id` and, where printed as
  its own field, its `invoice_number`. It is never matched on the invoice as
  an exact key. The pair with the ledger case reaches the possible-duplicate
  list, and confirming it merges the two (ADR 0057 §11; ADRs 0032, 0042).
  Includes tests for both orders of arrival and for one ledger gap that is
  several UNFI deductions.
- **Done means:** on step 4's deductions, each portal case and its ledger case
  end as one case after a person confirms the pair, and nothing merges
  without a person except an exact match.
- **Waits on:** steps 4 and 12, and ADR 0058 §11 item 16 (how the customer's
  books record a UNFI deduction).

### 15. Eval fixtures and cassettes from real documents

- **What:** a `unfi` eval suite, scored separately and never blended:
  - redacted real documents if step 4 recorded permission, otherwise
    synthetic copies built from their structure;
  - cassettes for the reader, recorded with `pnpm record:cassettes`, which
    spends money and is asked first;
  - a baseline recorded for this suite alone.

  If the cold-start agent is built later, its cassettes (Claude and Jev) are
  recorded against the fixture portal.
- **Done means:** `pnpm eval` scores the suite. No other suite's baseline
  moves.
- **Waits on:** step 4, and the founder's go on the spend.

### 16. The first demo, end to end

- **Who:** Claude runs it; the founder watches and does the person's parts
  (confirming the pair, picking a `-111` code).
- **Done means:** the demo deduction from step 4 is pulled, read, matched to
  its QuickBooks short-pay and coded, as described at the top. It is
  recorded in the demo script.
- **Waits on:** steps 10–14.

## Later, not needed for the demo

- The cold-start and repair agent (ADR 0057 §5).
- The emailed-MFA-code address (ADR 0057 §8), if UNFI offers no TOTP.
- The conventional side (SVHarbor ePASS), as its own recipe.
- Lifting the `by_portal` hold, by amending ADR 0058.
- A second portal, with its own ADR (KeHE is the likely one; the founder
  decides).

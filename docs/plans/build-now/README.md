# Build now: five items (plan of 2026-09-27)

Executor: follow one task file at a time, literally. Every decision is made here. If something is not settled here, stop and ask (see "Stop and ask").

## The five items

1. **Reason code on QuickBooks cases** (`01-reason-code.md`). A case the ledger sync opens has no payer reason code. Once a person links the payer's notice or remittance to it (Attach, or confirm-and-merge), the case page, work queue and packet show the payer's reason code and deduction reference, derived at read time from the linked documents. Nothing is written to `deductions`.
2. **Evidence checklist** (`02-evidence-checklist.md`). For the reason a person chose, list the evidence types needed and whether a document of that type is on the case. Canonical, versioned data in core-domain; ADR 0059.
3. **Draft accounting entries** (`03-accounting-drafts.md`). A read-only panel showing the journal entries each stage implies (found, recovered, written off), labelled "Draft — not posted". Pure computation; nothing posted.
4. **Spreadsheets at the door** (`04-spreadsheets.md`). Build ADR 0056: accept XLSX/CSV/TSV, read rows with code (no model) through a person-confirmed, versioned column mapping, with cell-level provenance. Migration 0036.
5. **Dispute letter** (`05-dispute-letter.md`). The deterministic letter gains the reconcile findings, payer reason code/reference, checklist, and a SHA-256 per enclosure.

## Order and dependencies

```
01 ──┐
02 ──┼──> 05 (fills letter fields from 01, 02)
03   (independent)
04   (independent; largest)
```
- 03 and 04 have no dependencies; 01 and 02 have none.
- 05 may be built before 01/02: its new fields are optional and stay unset. The wiring of 01/02 values into the letter is done by whichever of 05 and (01 or 02) lands **second** (see "Shared files").
- Recommended order: **03 → 01 → 02 → 05 → 04**. 03 is smallest and warms up on the case page; 01 and 02 then 05 so the letter is wired once; 04 last (migration, biggest risk).
- Parallel-safe: 03 and 04 with anything. 01 and 02 both touch `case-review.tsx` and `page.tsx`; rebase the second.

## Shared files (who owns what)

| File | 01 | 02 | 03 | 04 | 05 |
|---|---|---|---|---|---|
| `apps/web/components/case-review.tsx` | reason-code row :395-404 fallback, prop `payerTerms` | prop `evidenceChecklist`, panel below documents list | `<DraftJournal>` after `<CaseActions>` | spreadsheet doc renders `<SheetExtract>` instead of embed | none |
| `apps/web/app/cases/[id]/page.tsx` | `store.payerTermsForCase(id)` | compute checklist | none (props from existing data) | spreadsheet detection | replace inline stub deps with `reviewPipelineDeps(store)` |
| `packages/core-domain/src/packet.ts` | none (see below) | none | none | none | owns all changes |
| `packages/store-postgres/src/workflow.ts` (`assemblePacket`) | adds payer terms into the narrative input **only if 05 has merged**; else 05 does it | adds checklist into input **only if 05 has merged**; else 05 does it | none | packet zip: text extract with `csvSafe` | findings + sha256 |

Rule: the packet's payer-terms / checklist wiring is a small follow-up commit in whichever PR merges second. The letter only ever gets these via `PacketNarrativeInput.payerReasonCode`, `.deductionReference`, `.evidenceChecklist` (defined by 05). Values are frozen into the narrative at assembly (packets are append-only and hashed).

## Global rules (from CLAUDE.md; read it for detail)

- **Invariants that apply**: 1 (no INSERT into `submissions`/`writebacks`/`writeoffs` — none of these items does), 2 (append-only; new tables in 04 get `no_update_delete` + `no_truncate`; never add UPDATE/DELETE grants), 3 (money is integer cents; use `cents`, `addCents`, `subCents`, `sumCents`, `parseMoneyToCents`, `parseUnitPrice`; never `Number()`/`parseFloat` on money text), 4 (no model reads anything in these items; code only), 6 (RLS on every new table; service role never), 7 (no threshold changes).
- **Never** call a model API, never run `pnpm record:cassettes` (spends money), never run `pnpm eval --record-pending` or move `packages/evals/baseline.json`.
- **Never edit a merged migration**; add a new one (only item 04 adds one).
- **ADR hook** (`.claude/hooks/require-adr.sh`): edits to `supabase/migrations/**` and `packages/*/src/invariants/**` are blocked unless `git status --porcelain -- docs/adr` is non-empty **or** `git diff --name-only origin/main...HEAD -- docs/adr` is non-empty. An ADR already on main does not count: the branch must itself change a file under `docs/adr/`. Only 04 needs this (it amends ADR 0056 in its first commit). 02 writes ADR 0059 for the record, not for the hook.
- **Numbers** (ADR, migration, SQL suite): before taking one, `git fetch origin` and check `origin/main` (`git ls-tree origin/main docs/adr/ supabase/migrations/ supabase/tests/`) and open PRs (GitHub MCP `list_pull_requests`, then `pull_request_read` files of each). Planned: ADR 0059 (02), migration 0036 and suite 32 (04). If taken, use the next free and say so in the PR.
- **Test database**: `pnpm db:test` and Postgres integration tests need `TEST_DATABASE_URL` (throwaway DB owned by the connecting role) and `RECOUPLE_TEST_DATABASE=1`, and no `DATABASE_URL` in the environment. Always run tests as `env -u DATABASE_URL pnpm test ...`. The guard `scripts/test-database.ts` refuses Supabase hosts and has no override; do not try to bypass it. If no test database is available: `packages/store-postgres/test/*` integration tests and `supabase/tests/*` do not run; they **skip, and skipping is not passing**. Write them anyway, say in the PR "DB tests written, not run locally: no TEST_DATABASE_URL", and rely on CI.
- Test file subset: `env -u DATABASE_URL pnpm test <path> [<path>...]` (root is a single `vitest run`; there is no `--filter`).
- **Progress dashboard** (`.claude/agents/dashboard-builder.md`): each item has >5 steps, so before starting have the `dashboard-builder` subagent set up `.dashboard/index.html` with the task's steps; send it an update after each step in the background; put questions with defaults there. Anything outward-facing or hard to undo waits for the user.
- **Fail loud**: no swallowed errors; a catch must render or rethrow a named error. No mocks/fixtures reachable from production code (`@recouple/pipeline/testing`, `@recouple/crypto/testing` never imported from `src/` of production packages or `apps/web/app|components|lib`).
- Views in `apps/web/components/` are pure functions of their props.
- Do not weaken or delete a test to pass CI; fix the code.

## Git / PR protocol

| Item | Branch |
|---|---|
| 01 | `claude/build-now-01-reason-code` |
| 02 | `claude/build-now-02-evidence-checklist` |
| 03 | `claude/build-now-03-accounting-drafts` |
| 04 | `claude/build-now-04-spreadsheets` |
| 05 | `claude/build-now-05-dispute-letter` |

- Branch from up-to-date `origin/main`. One draft PR per item (GitHub MCP `create_pull_request`, `draft: true`), base `main`.
- Commit style (see `git log`): imperative, sentence-case subject, often `area: what` (e.g. `dashboard-builder: remember the founder's style`), plain prose body saying why. End with the attribution lines from the session's system reminder.
- Before each push: `pnpm typecheck` and `env -u DATABASE_URL pnpm test <changed packages' test dirs>`; for 04 also `pnpm db:test` when a test DB exists.
- CI must be green. **Never merge**, never push to `main`, never apply a migration anywhere.
- Each PR description: what, why, tests run (and which skipped for lack of DB), the task file it implements, and the Acceptance checklist copied with boxes ticked.
- Update CLAUDE.md "Current state" only where a task file says so (01 says so; others add one short paragraph in their PR).

## Definition of done (per item)

Acceptance checklist in the task file all ticked; `pnpm typecheck` clean; new and existing tests pass (DB tests run or explicitly reported skipped); CI green; `git diff --stat origin/main` touches only files the task names; no new UPDATE/DELETE grants; `pnpm eval` unchanged (items 01–03, 05 change no extraction).

## Stop and ask

Stop (add to dashboard questions with your default, keep working on what doesn't depend on it) when:
- a change would need an ADR the plan does not already plan (e.g. a migration in 01/02/03/05, an outbound call, a threshold);
- anything conflicts with an invariant;
- a test can only pass by weakening it or moving a baseline;
- a path/line in the plan does not exist or a signature differs materially (grep first; if the thing exists nearby, use it and note it; if not, ask);
- any ambiguity the plan does not settle.
Format: "Question: … Default: …".

## Open questions (defaults in force)

| # | Question | Default |
|---|---|---|
| 1 | 01: write `reason_code_as_printed` on merge? | No; derive only |
| 2 | 01: amount match exact or within tolerance? | Exact cents |
| 3 | 02: show checklist before a decision (family guess)? | No; prompt to decide |
| 4 | 02: add evidence types timesheet/ELD/receiving report? | No; `EVIDENCE_NOT_YET_TYPED` footnote |
| 5 | 02: family default lists | As written; founder reviews in ADR 0059 |
| 6 | 02: correspondence counts as buyer approval? | Status `possible` (never `have`) with its own caveat |
| 7 | 03: per-tenant account map? | Deferred (needs migration + ADR) |
| 8 | 03: declined case shows write-off draft? | Yes, full amount |
| 9 | 04: migration/suite numbers | 0036 / 32, else next free |
| 10 | 04: model mapping proposal? | No; column picker only |
| 11 | 04: where is SheetMapping zod? | `packages/core-domain/src/sheet-mapping.ts` |
| 12 | 05: include warning findings? | No; `supports_dispute` only |
| 13 | 05: page citation per finding? | No; follow-up |
| 14 | 05: findings embedding unverified page text | Excluded unless in the allowlist of `05` §Findings gate |

# 03 — Draft accounting entries per stage (not posted)

Branch `claude/build-now-03-accounting-drafts`. No migration, no ADR.

## Goal
Case page panel "Draft accounting entries" showing the balanced journal entries for found / recovered / written off, labelled "Draft — not posted". Pure; no store method, route, event or write.

## Why
Finance needs to see what a case implies for the books before any posting exists.

## What exists today
`Cents`, `cents`, `addCents`, `subCents`, `sumCents`, `formatCents` in `packages/core-domain/src/money.ts` (:9, :16, :35-43, :439). `REASON_FAMILIES`, `familyOf` reason-codes.ts:10-21, :93. `CaseOutcome`, `OutcomeRecord.recoveredCents: number` `packages/pipeline/src/ports.ts:908, :958-966`. `recordOutcome` already refuses won with R≠A and lost with R>0 (`packages/pipeline/src/testing/memory-store.ts:1631-1646`; Postgres store mirrors it). `CaseReview` `apps/web/components/case-review.tsx:278`, `declined` :347, `<CaseActions>` :613. fast-check style: `packages/core-domain/test/short-pay.test.ts:1-11`.

## What to build
1. Create `packages/core-domain/src/journal.ts` (imports only `./money`, `./reason-codes`):
```ts
export type JournalStage = 'found' | 'recovered' | 'written_off';
export type AccountRole = 'accounts_receivable' | 'deductions_receivable' | 'cash' | 'writeoff_expense';
export interface JournalLine { account: string; role: AccountRole; debit: Cents; credit: Cents; memo: string }
export interface DraftEntry { stage: JournalStage; lines: readonly JournalLine[]; tag: ReasonFamily | undefined }
export interface AccountMap { accountsReceivable: string; deductionsReceivable: string; cash: string;
  writeoffByFamily: Readonly<Record<ReasonFamily, string>>; unclassifiedWriteoff: string }
export const DEFAULT_ACCOUNT_MAP: AccountMap; // doc comment: suggested defaults, not a chart of accounts
export class JournalInputError extends Error { readonly name = 'JournalInputError' }
export function draftEntries(input: { amountCents: Cents; recoveredCents?: Cents;
  outcome?: 'won' | 'partial' | 'lost' | 'declined'; family?: ReasonFamily; printedReasonCode?: string; map?: AccountMap }): readonly DraftEntry[];
export function projectedEntries(amountCents: Cents, family?: ReasonFamily, map?: AccountMap): { won: readonly DraftEntry[]; lost: readonly DraftEntry[] };
export function isBalanced(entry: DraftEntry): boolean;
export function writeoffAccountFor(family: ReasonFamily | undefined, map?: AccountMap): string;
```
   DEFAULT_ACCOUNT_MAP: 'Accounts Receivable', 'Deductions Receivable', cash 'Undeposited Funds'; promotion 'Trade Promotion Expense', freight 'Freight Deductions Expense', shortage 'Shortage Deductions Expense', pricing 'Pricing Deductions Expense', compliance 'Compliance Fines Expense', returns 'Returns & Allowances', quality 'Quality Deductions Expense', duplicate/post_audit/other 'Deductions Write-off Expense'; unclassified 'Deductions Write-off Expense (unclassified)'.
   Entries (A amount, R recovered):
   - found (always): Dr Deductions Receivable A / Cr Accounts Receivable A. Memo: family words if `family`, else `Payer reason as printed: <printedReasonCode>` if given, else `Reason not chosen yet`.
   - recovered (R>0): Dr Cash R / Cr Deductions Receivable R.
   - written_off (A−R>0, outcome set): Dr writeoffAccountFor(family) (A−R) / Cr Deductions Receivable (A−R).
   - `declined` ⇒ R=0, write-off A. `won` ⇒ R must equal A. `lost`/`declined` ⇒ R must be 0/undefined. Refuse (JournalInputError): A ≤ 0, non-integer or negative R, R > A, the two rules above. Omit zero-amount lines/entries. No clock.
   Export `export * from './journal';` in core-domain index.
2. Create `apps/web/components/draft-journal.tsx`: `export function DraftJournal(props: { amountCents: number; outcome?: 'won'|'partial'|'lost'; recoveredCents?: number; declined: boolean; family?: ReasonFamily; printedReasonCode?: string })`. Inside: `const outcome = props.declined ? 'declined' : props.outcome` (declined wins if both set); `try { const r = props.recoveredCents === undefined ? undefined : cents(props.recoveredCents); draftEntries({ ..., outcome, recoveredCents: r }) ; draftEntries(...) } catch (e) { if (e instanceof JournalInputError || e instanceof RangeError) render <p role="alert">Cannot draft entries: {e.message}</p>; else throw e; }`. Renders heading "Draft accounting entries", badge "Draft — not posted", note "Nothing is posted to your books. Posting needs its own decision record. Accounts are suggested defaults." Tables Account | Debit | Credit (formatCents). If no outcome and not declined: "If won" and "If lost" preview sections from `projectedEntries`, plus text "A partial recovery splits between the two." If no family: line "The expense account is chosen once a reason is decided." No form, button or link.
3. `case-review.tsx`: after `<CaseActions … />` (~:613) render `<DraftJournal amountCents={summary.deductionAmountCents} outcome={workflow?.outcome?.outcome} recoveredCents={workflow?.outcome?.recoveredCents} declined={declined} family={workflow?.decision ? familyOf(workflow.decision.reason) : undefined} printedReasonCode={summary.reasonCodeAsPrinted ?? undefined} />`. Field names verified: `OutcomeRecord.outcome`, `OutcomeRecord.recoveredCents` (`packages/pipeline/src/ports.ts:958-966`), `decision.reason`.

## Tests first (no DB)
- `packages/core-domain/test/journal.test.ts`: property A∈[1,1e12], R∈[0,A] every entry balanced; each line exactly one of debit/credit >0, integers; partial: recovered + write-off credits to Deductions Receivable == A; net Deductions Receivable 0 after all stages; won → no written_off; lost/declined → no recovered; refusals (R>A, negative, non-integer, won R<A, lost R>0, A=0); family → expected account, undefined → unclassified; found memo uses printed code when no family.
- `apps/web/test/draft-journal.test.tsx`: always shows "Draft — not posted"; open case shows found + If won / If lost; partial shows three entries with R and A−R; no form/button; invalid input (won, R<A) shows "Cannot draft entries" alert and does not throw.

## Verification
`pnpm typecheck`; `env -u DATABASE_URL pnpm test packages/core-domain/test/journal.test.ts apps/web/test/draft-journal.test.tsx`; full `env -u DATABASE_URL pnpm test`; `grep -n "writebacks\|writeoffs\|@recouple/qbo\|@recouple/pipeline" packages/core-domain/src/journal.ts apps/web/components/draft-journal.tsx` → nothing (draft-journal may import only `@recouple/core-domain` and React).

## Acceptance
- [ ] journal.ts + property tests
- [ ] panel with badge, previews, visible error
- [ ] wired after CaseActions
- [ ] no store/route/event/migration

## Pitfalls
No floats; use sumCents. Don't swallow unknown errors. Don't call it "posted" anywhere.

## Out of scope
Posting, per-tenant map, writebacks/writeoffs, fee entries.

## Open questions
Per-tenant map → deferred. Declined → full write-off draft.

## Depends on
Nothing.

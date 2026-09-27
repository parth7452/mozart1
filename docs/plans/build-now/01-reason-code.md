# 01 — Carry the payer's reason code onto QuickBooks cases

Branch `claude/build-now-01-reason-code`. No migration, no ADR.

## Goal
When a payer's notice or remittance is linked to a case (own `deduction_documents` link, or a link on a case merged into it), show the payer's reason code and deduction reference on the case page, work queue and packet — derived at read time, never stored.

## Why
Ledger cases (`syncLedger`) carry no reason code, even after a person links the payer's document. Reviewers and the letter need it.

## What exists today
- Column `deductions.reason_code_as_printed`: migration 0022 :101. Written only at open: `packages/pipeline/src/steps.ts:2153, :2236, :2276`. Read into `CaseSummary.reasonCodeAsPrinted` (`packages/store-postgres/src/store.ts:344`, reads :807, :825, :893-894). Rendered `apps/web/components/case-review.tsx:395-404`.
- `deduction_reference`: extraction schema only, **notices only** (`packages/extraction/src/schemas.ts:46`); remittance lines have none (:65-72).
- `fieldsForCase` store.ts:4038 (CTE over `deduction_documents`), `caseSummary` :3784, `reviewQueue` :4567.
- View `deduction_merges_current` (migration 0032:209): columns `org_id, merged_deduction_id, surviving_deduction_id, merge_id, state_before, merged_at, recorded_by`; it already contains only live `action='merge'` rows without an unmerge. Use `surviving_deduction_id = $case` to find absorbees (`merged_deduction_id`).
- Attach: `packages/pipeline/src/attach.ts:69-102`. Roles `'notice'|'evidence'|'remittance'|'context'` (store.ts:686-687).
- `deductions.updated_at` exists (migration 0003:62).

## What to build
1. **Create `packages/core-domain/src/payer-terms.ts`**:
```ts
import { type Cents, subCents } from './money';
export interface PayerTerms {
  reasonCode?: string;
  deductionReference?: string; // from deduction_notice lines only
  documentId: string;
  fieldPath: string;           // e.g. 'lines[2].reason_code' (or deduction_reference if no code)
  quoteVerified: boolean | null;
}
export type PayerTermsAnswer =
  | { kind: 'own' }
  | { kind: 'derived'; terms: PayerTerms }
  | { kind: 'none' }
  | { kind: 'conflicting'; candidates: PayerTerms[] };
export interface PayerTermsLine {
  documentId: string;
  docType: 'deduction_notice' | 'remittance_advice';
  index: number;
  reasonCode?: string;
  deductionReference?: string;
  amountCents?: Cents;   // notice: deduction_amount; remittance: deduction_amount else gross − net (caller computes via subCents)
  invoiceNumber?: string;
  quoteVerified: boolean | null; // of the reason_code field (else of deduction_reference)
}
export function payerTermsFor(input: {
  amountCents: Cents; invoiceKeys: readonly string[]; lines: readonly PayerTermsLine[];
}): Exclude<PayerTermsAnswer, { kind: 'own' }>;
```
   Rule: a line qualifies iff `amountCents` defined and equal to case amount, and it has a reasonCode or deductionReference; for `remittance_advice` also `identifierMatchKey(invoiceNumber)` ∈ `invoiceKeys` (import `identifierMatchKey` from `./identity`; grep to confirm name/export; if it is elsewhere, import from there). Ignore `deductionReference` on remittance lines. 0 → `none`; ≥1 all with identical `(reasonCode, deductionReference)` → `derived` with the first by (documentId, index) sort; else `conflicting` with one candidate per distinct pair, sorted by (documentId, index). Sort inputs first so output is order-independent. Export from `packages/core-domain/src/index.ts` (`export * from './payer-terms';`, extensionless).
2. **Store: `payerTermsForCase(deductionId: string): Promise<PayerTermsAnswer>`** in `packages/store-postgres/src/store.ts`, next to `fieldsForCase`. One `withTenant` transaction as `app_rw`:
   - select `reason_code_as_printed, amount_cents` from the case; no row → `{kind:'none'}`; column non-null → `{kind:'own'}`.
   - case set = `$id` ∪ `select merged_deduction_id from deduction_merges_current where surviving_deduction_id = $id`.
   - invoice keys: `deduction_identifiers` with `identifier_kind = 'invoice_number'` for the case set (identifiers are mapped to survivor through `deduction_merges_current`, as every reader does); apply `identifierMatchKey`.
   - documents: `deduction_documents` for the case set, joined to the document's doc type; keep `deduction_notice`/`remittance_advice`.
   - fields: `extraction_results` for those documents with paths matching `^lines\[\d+\]\.(reason_code|deduction_reference|deduction_amount|gross_amount|net_amount|invoice_number)$`, reusing the fieldsForCase CTE shape. Group by (document, n); money via `parseMoneyToCents` on the stored value text exactly as `reconcile` does (grep how fieldsForCase values are typed; if already cents, use them).
   - call `payerTermsFor`.
   Also add `payerTermsForCases(ids: readonly string[]): Promise<Map<string, PayerTermsAnswer>>` — same queries batched with `= any($1)`; `payerTermsForCase` calls it with `[id]`. One matcher only.
3. **Case page** `apps/web/app/cases/[id]/page.tsx`: add `store.payerTermsForCase(id)` to the existing `Promise.all`; pass `payerTerms` to `CaseReview`.
4. **`case-review.tsx` :395-404**: new optional prop `payerTerms?: PayerTermsAnswer`. `own`/undefined → render exactly as today. `derived` → "Reason code: X (from <a href=/api/document/{documentId}>filename</a>)" (filename from `documents` prop by id), a "Deduction ref: Y" row when present, and the existing quote badge by `quoteVerified`. `conflicting` → "Payer documents disagree" then a list of each candidate's code/ref/filename. `none` → as today.
5. **Work queue**: after `reviewQueue` returns its page, the page/loader calls `payerTermsForCases(ids)`; add optional `reasonCode?: string` to the rendered row (own column else derived `reasonCode`; conflicting/none → absent). Render a small tag in `apps/web/components/work-queue.tsx`. Sort order unchanged. (Grep where reviewQueue is called in `apps/web/app`; do the batch call there, not inside reviewQueue's SQL.)
6. **Packet**: see README "Shared files". Freeze at assembly: in `assemblePacket` (`packages/store-postgres/src/workflow.ts:655`) read `payerTermsForCases([deductionId])` inside the assemble transaction's tenant (or right before, same store) and, when `derived`, pass `payerReasonCode`/`deductionReference` into `buildPacketNarrative`. If 05 has not merged, **skip this step** and note in PR; 05 does it. Test: `packages/store-postgres/test/workflow.test.ts` case "assembled narrative names the payer's reason code as printed".
7. CLAUDE.md "Current state": add one paragraph "**A ledger case shows the payer's terms once a person links them** (no ADR, no migration)" summarising the rule.

## Tests first
- `packages/core-domain/test/payer-terms.test.ts` (no DB), `describe('payerTermsFor')`: notice line equal amount → derived with both fields; remittance two lines same invoice different amounts → equal-amount line; remittance invoice match, amount mismatch → none; two qualifying different codes → conflicting; line with only deductionReference → derived; remittance deductionReference ignored; fast-check: shuffled lines give same answer.
- `packages/store-postgres/test/payer-terms.test.ts` (DB), follow `pipeline-on-postgres.test.ts` setup: ledger case + notice attached via `attachEvidence` → derived; ledger case survivor of a merge of a notice case → derived; after unmerge → none; case with column set → own and row snapshot unchanged (`select * from deductions where id=$1` before/after equal, incl. `updated_at`); other tenant's case → none.
- `apps/web/test/case-review-payer-terms.test.tsx` (no DB): derived shows code + link; conflicting shows "Payer documents disagree"; own renders as before.
- `apps/web/test/work-queue-reason-tag.test.tsx`: tag rendered when `reasonCode` set, absent otherwise.
- Agreement: in the store test, `payerTermsForCases([id]).get(id)` deep-equals `payerTermsForCase(id)`.

## Verification
`pnpm typecheck`; `pnpm db:test` (if DB); `env -u DATABASE_URL pnpm test packages/core-domain/test/payer-terms.test.ts packages/store-postgres/test/payer-terms.test.ts apps/web/test`; then full `env -u DATABASE_URL pnpm test` — `review-queue.test.ts` still green. `git diff --stat origin/main -- supabase` empty.

## Acceptance
- [ ] payer-terms.ts + tests, exported
- [ ] payerTermsForCase / payerTermsForCases, no UPDATE issued
- [ ] case page fallback + conflicting view
- [ ] work-queue tag, same order
- [ ] packet wiring done here or deferred to 05 (stated in PR)
- [ ] CLAUDE.md paragraph
- [ ] no migration

## Pitfalls
- Never use the invoice number as identity; only to pick a line inside an already-linked document.
- Read documents only via `deduction_documents`, never `extraction_results.deduction_id`.
- Do not write SQL that reimplements the rule for the queue.
- Money compare as `Cents` equality; no floats.

## Out of scope
Auto identity match; any column or migration; QBO write-back; remittance deduction_reference.

## Open questions
Write the column on merge? → No. Tolerance? → Exact cents.

## Depends on
ADR 0042 merges, attachEvidence (exist). Coordinates with 05 on packet.

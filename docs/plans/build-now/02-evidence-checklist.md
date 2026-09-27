# 02 — Evidence checklist per reason code

Branch `claude/build-now-02-evidence-checklist`. No migration. ADR 0059 (record only).

## Goal
On a decided case, show each evidence type the chosen canonical reason needs, Required/Helpful, and whether a document of that type is on the case.

## Why
Reviewers cannot see what is missing before assembling a packet.

## What exists today
- `EVIDENCE_TYPES` (11) `packages/adapters/src/evidence.ts:9-21`; `EvidenceChecklistItem` :51-56 (unused; leave).
- `REASON_FAMILIES` `packages/core-domain/src/reason-codes.ts:10-21`, `CANONICAL_REASON_CODES` :25-84, `familyOf` :93.
- `DOC_TYPES` `packages/extraction/src/ports.ts:8-24`.
- `caseDocuments` store.ts:3972 → `CaseDocument {documentId, filename, mimeType, docType|null}` :694-703; used at `apps/web/app/cases/[id]/page.tsx:67`, passed :110-113.
- Decision: `HumanDecisionRecord.reason`, `decidedAt` (`packages/pipeline/src/ports.ts:911-921`), via `store.getWorkflow(id)` page.tsx:91.
- `MISSING_EVIDENCE_TYPES` store.ts:548-557 (decline form; strings must not change).

## What to build
1. `git fetch origin`; check origin/main and open PRs (GitHub MCP `list_pull_requests`) for ADR 0059. Write `docs/adr/0059-canonical-evidence-checklist-is-data.md` (Context/Decision/Consequences/Invariants): canonical default in core-domain, payer overrides later as draft D's `playbook_evidence_requirements`; "have" = a document of that type is linked, content not checked; correspondence is only "possible"; family lists are **placeholders for founder review**; listed untyped evidence.
2. Create `packages/core-domain/src/evidence.ts`: move `EVIDENCE_TYPES` and `type EvidenceType` verbatim from adapters :9-23. `packages/adapters/src/evidence.ts`: replace with `export { EVIDENCE_TYPES, type EvidenceType } from '@recouple/core-domain';` keep other interfaces. Run `pnpm typecheck`.
3. Create `packages/core-domain/src/evidence-requirements.ts`:
```ts
export interface EvidenceRequirementProvenance { readonly kind: 'named_human'; readonly source: string; readonly note?: string }
export interface EvidenceRequirement { readonly evidenceType: EvidenceType; readonly required: boolean; readonly why: string }
export interface EvidenceRequirementSet {
  readonly version: string; readonly effectiveFrom: string; // YYYY-MM-DD
  readonly provenance: EvidenceRequirementProvenance;
  readonly byFamily: Readonly<Record<ReasonFamily, readonly EvidenceRequirement[]>>;
  readonly byCode: Readonly<Partial<Record<CanonicalReasonCode, readonly EvidenceRequirement[]>>>;
}
export const CANONICAL_EVIDENCE_REQUIREMENTS: readonly EvidenceRequirementSet[] = [
  { version: '2026-09-27.1', effectiveFrom: '2000-01-01', provenance: { kind: 'named_human', source: 'ADR 0059' }, byFamily: {/*…*/}, byCode: {/*…*/} },
];
export const EVIDENCE_NOT_YET_TYPED: readonly string[] = ['carrier ELD/telematics log','timesheet / time register','receiving report','temperature / shelf-life record'];
export class NoEvidenceRequirementsError extends Error { readonly name = 'NoEvidenceRequirementsError' }
export function requirementSetOn(date: string, sets?: readonly EvidenceRequirementSet[]): EvidenceRequirementSet; // latest effectiveFrom <= date; bad format → RangeError; none → NoEvidenceRequirementsError
export function requirementsFor(code: CanonicalReasonCode, set: EvidenceRequirementSet): readonly EvidenceRequirement[]; // byCode[code] ?? byFamily[familyOf(code)]
export type ChecklistStatus = 'have' | 'possible' | 'missing';
export interface ChecklistRow { readonly evidenceType: EvidenceType; readonly required: boolean; readonly why: string; readonly status: ChecklistStatus; readonly documentIds: readonly string[] }
export interface EvidenceChecklist { readonly reason: CanonicalReasonCode; readonly version: string; readonly rows: readonly ChecklistRow[]; readonly missingRequired: number }
export function evidenceChecklist(input: { reason: CanonicalReasonCode; onDate: string;
  present: readonly { documentId: string; evidenceType: EvidenceType; strength: 'have' | 'possible' }[] }): EvidenceChecklist;
```
   `effectiveFrom: '2000-01-01'` (before any decision; fixes the old-case throw). Row status: `have` if any present item of that type has strength `have`; else `possible` if any `possible`; else `missing`. `documentIds` = all matching. `missingRequired` counts required rows with status ≠ `have`. Extra types ignored. Rows in data order.
   Data (required=true unless `(false)`); `why` one plain sentence each:
   - shortage: signed_pod, carrier_signed_bol, invoice, po(false), asn(false), packing_list(false)
   - pricing: invoice, price_agreement, po
   - compliance: routing_guide, asn, carrier_signed_bol(false), buyer_approval_email(false)
   - duplicate: invoice, remittance_advice
   - returns: invoice, buyer_approval_email(false)
   - promotion: promo_deal_sheet, invoice, buyer_approval_email(false)
   - freight: carrier_signed_bol, invoice, routing_guide(false)
   - quality: signed_pod, carrier_signed_bol(false), invoice
   - post_audit: invoice, price_agreement(false), promo_deal_sheet(false), remittance_advice(false)
   - other: invoice
   - byCode: `compliance_asn_missing`, `compliance_asn_inaccurate` → asn, invoice; `compliance_appointment_missed`, `compliance_late_delivery`, `compliance_early_delivery` → carrier_signed_bol, signed_pod, buyer_approval_email(false); `promo_not_agreed` → promo_deal_sheet(false), buyer_approval_email(false), invoice. (Grep reason-codes.ts to confirm each key exists; if one does not, stop and ask.)
   Export both modules from `packages/core-domain/src/index.ts` (`export * from './evidence';` `export * from './evidence-requirements';`).
4. Create `packages/extraction/src/evidence-map.ts`:
```ts
export const EVIDENCE_FOR_DOC_TYPE: Readonly<Record<DocType, { evidenceType: EvidenceType; strength: 'have' | 'possible' } | null>>;
// deduction_notice:null, remittance_advice:have, invoice:have, po:have, bol→carrier_signed_bol have,
// pod→signed_pod have, asn:have, correspondence→buyer_approval_email **possible**,
// promo_agreement→promo_deal_sheet have, price_agreement:have, routing_guide:have, other:null
export function evidenceOfDocuments(docs: readonly { documentId: string; docType: DocType | null }[]):
  { documentId: string; evidenceType: EvidenceType; strength: 'have' | 'possible' }[]; // drops null docType and null-mapped
```
   Comment: bol/pod mean "on file", signature not checked; `packing_list` has no doc type. Export from extraction index.
5. `packages/store-postgres/src/store.ts` after :559: `export const EVIDENCE_FOR_MISSING: Readonly<Record<MissingEvidenceType, EvidenceType | null>>` — proof_of_delivery→signed_pod, bill_of_lading→carrier_signed_bol, invoice→invoice, purchase_order→po, receiving_report→null, timesheet→null, rate_agreement→price_agreement, correspondence→buyer_approval_email. (Use the existing type name for the list's element; grep.) `MISSING_EVIDENCE_TYPES` unchanged.
6. Create `apps/web/components/evidence-checklist.tsx`: `export function EvidenceChecklistPanel(props: { checklist?: EvidenceChecklist; documents: readonly CaseDocument[] })`. Undefined → "No reason chosen yet. Choose a reason under Decide to see the evidence it needs." Else heading "Evidence for <reasonInWords(reason)>", table: label, Required/Helpful, Have (filename links) / "Possible — check content" (links) / Missing, why. `possible` row caption: "A message is on the case; whether it is the buyer's approval is not checked." Footer: "Checklist version <v>. 'Have' means a document of that type is on the case; its content is not checked." plus footnote listing `EVIDENCE_NOT_YET_TYPED`.
7. `page.tsx`: after the `Promise.all`, `const evidence = workflow?.decision ? evidenceChecklist({ reason: workflow.decision.reason, onDate: workflow.decision.decidedAt.toISOString().slice(0,10), present: evidenceOfDocuments(documents) }) : undefined;` (check `decidedAt` type; if string, slice it). Do not catch; set starts 2000-01-01 so it cannot throw for a valid date. Pass `evidenceChecklist={evidence}`; `case-review.tsx` renders the panel directly below the documents list for every role.
8. Packet wiring: see README. If 05 merged, in `assemblePacket` pass `evidenceChecklist: rows.map(r => ({ label: <evidence label>, satisfied: r.status === 'have' }))`; else leave to 05.

## Tests first (no DB)
- `packages/core-domain/test/evidence-requirements.test.ts`: every family non-empty with ≥1 required; **every CANONICAL_REASON_CODES key** resolves to non-empty with ≥1 required; byCode keys valid; types ∈ EVIDENCE_TYPES; no duplicate type per list; fallback vs override; `requirementSetOn` latest, throws before first, RangeError on bad date; decision dated 2026-09-21 resolves; have/possible/missing, documentIds, missingRequired, extras ignored, empty present → all missing; effectiveFrom strictly increasing.
- `packages/extraction/test/evidence-map.test.ts`: keys == DOC_TYPES both ways; values ∈ EVIDENCE_TYPES; evidence types with no doc type == `['packing_list']`; correspondence strength `possible`; drops null docType, deduction_notice, other.
- `packages/store-postgres/test/missing-evidence-map.test.ts`: keys == MISSING_EVIDENCE_TYPES; literal of the 8 strings unchanged; receiving_report, timesheet → null.
- `apps/web/test/evidence-checklist.test.tsx`: undefined → prompt text; Have with link, Possible caption, Missing, Required/Helpful, version footer, untyped footnote.

## Verification
`pnpm typecheck`; `env -u DATABASE_URL pnpm test packages/core-domain/test/evidence-requirements.test.ts packages/extraction/test/evidence-map.test.ts packages/store-postgres/test/missing-evidence-map.test.ts apps/web/test/evidence-checklist.test.tsx`; full `env -u DATABASE_URL pnpm test` (decline-form tests unchanged); `git diff --stat origin/main -- supabase` empty.

## Acceptance
- [ ] ADR 0059 (number checked incl. open PRs)
- [ ] EVIDENCE_TYPES moved, adapters re-exports
- [ ] requirements data + functions, first set 2000-01-01
- [ ] doc-type map with correspondence `possible`
- [ ] EVIDENCE_FOR_MISSING, strings unchanged
- [ ] panel wired below documents
- [ ] no migration

## Pitfalls
Imports extensionless. Do not invent evidence or doc types. Do not persist anything. No model.

## Out of scope
Per-payer tables, checklist persistence, content/signature verification, Schema B map.

## Open questions
Pre-decision guess → No. New evidence types → No. Lists → as written, founder reviews.

## Depends on
Nothing new. 05 consumes `evidenceChecklist`.

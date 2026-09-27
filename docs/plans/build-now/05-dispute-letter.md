# 05 — Dispute letter from reason wording, findings and enclosures

Branch `claude/build-now-05-dispute-letter`. No migration, no ADR (note under ADR 0020 §2 in PR description).

## Goal
The deterministic letter (`buildPacketNarrative`) gains: supports_dispute findings, payer reason code and deduction reference (from 01), evidence checklist (from 02), and each enclosure's SHA-256.

## Why
The approver and the payer should see why the deduction is invalid and exactly which files are enclosed.

## What exists today
`packages/core-domain/src/packet.ts`: no model (:5), `MAX_NARRATIVE_LENGTH` :39; reason in words already emitted `Reason for dispute: ${reasonInWords(input.reason)}` :230, input type :122-144, `buildPacketNarrative` :177 (refusals :178-196, enclosures :208-211, cap :242). Caller `assemblePacket` `packages/store-postgres/src/workflow.ts:655-712` (`packetDocuments` :432-445, `buildNarrativeOrRefuse` :491, `packetContentHash` :393, idempotent return :713-723, insert :760). Port `packages/pipeline/src/ports.ts:1069`. Route `apps/web/app/cases/[id]/packet/route.ts:63`. In-memory `packages/pipeline/src/testing/memory-store.ts:1112`; web fake `apps/web/test/fake-workflow-store.ts:278`. `documents.sha256` is `bytea not null` (migration 0003:38). `reconcileCase` steps.ts:2318; findings `{code, severity, message, fieldPath?}` (`packages/extraction/src/reconcile.ts:43-48`); page stub deps page.tsx:70-85.

## What to build
1. `packet.ts` — extend (all optional; absent ⇒ today's bytes for those sections):
```ts
export interface PacketDocument { /* existing */ sha256?: string; docType?: string }
export interface PacketNarrativeInput { /* existing */
  findings?: readonly { code: string; message: string }[];
  payerReasonCode?: string; deductionReference?: string;
  evidenceChecklist?: readonly { label: string; satisfied: boolean }[];
}
```
   - `assertPlainText(label, value)`: trim; any char < 0x20 or 0x7f → `PacketError`. Apply to every new value and finding message.
   - sha256 must match `/^[0-9a-f]{64}$/` else PacketError.
   - Sections, in order: after "Reason for dispute:" add `line("Payer's reason code", x)` and `line('Deduction reference', y)` when present; then "Findings:" with `  1. <message>` (given order) when non-empty, before "Explanation:"; then "Evidence checklist:" `  [x] label` / `  [ ] label` when non-empty; enclosures become `  1. <Role>: <filename> (SHA-256 <64hex>)` when sha256 present, else today's `role: filename`.
   - Cap: keep `MAX_NARRATIVE_LENGTH` (20,000). Include findings in order while the narrative stays within the cap; if any are left out, add `  (N further findings omitted; see the case page.)` after the last one. Evidence checklist and enclosures are never trimmed; if the narrative still exceeds the cap, refuse with `PacketError` as today (:242). Tests: a 500-finding case assembles with the omission line and length ≤ cap; the golden test asserts the `Reason for dispute: <reasonInWords>` line (completeness item 5 — already emitted at :230, not re-added).
2. **Findings gate** (blocking correction): only findings whose message embeds no raw page text. Add `export const LETTER_SAFE_FINDING_CODES: readonly string[]` in `packages/extraction/src/reconcile.ts` next to the Finding type. Build it by auditing every `supports_dispute` finding constructor in reconcile.ts: include a code only if its message is built from our own words plus quote-verified field values/cents. Codes whose message quotes a sentence off the page (e.g. `charge_waived_in_writing`, which quotes the waiver — log-001.test.ts:165-205) are **excluded**. Test pins the list. If the audit is unclear for a code, exclude it and list it in the PR.
3. Port (`ports.ts:1069`): input gains `readonly findings?: readonly { code: string; message: string }[]`. Findings are **caller-supplied and advisory**: the web route is the only caller; documented in the port's comment.
4. `workflow.ts`: `packetDocuments` selects `encode(d.sha256,'hex') as sha256` (and doc type if on the same join) and passes it on each PacketDocument; `assemblePacket` passes `findings`. If 01/02 merged, also pass `payerReasonCode`/`deductionReference`/`evidenceChecklist` (see README "Shared files"); else leave unset.
5. `memory-store.ts:1112` and `fake-workflow-store.ts:278`: accept `findings` and per-document sha256 and pass to `buildPacketNarrative`; the fake records `findings` for assertions.
6. Create `apps/web/lib/review-deps.ts`: `export function reviewPipelineDeps(store: PipelineStore): PipelineDeps` — moved stubs (scanner, classifier, extractor throw). Use in page.tsx (replace :70-85) and packet route.
7. `packet/route.ts`: before `store.assemblePacket` (:63): `const { findings } = await reconcileCase(id, reviewPipelineDeps(store));` pass `findings.filter(f => f.severity === 'supports_dispute' && LETTER_SAFE_FINDING_CODES.includes(f.code)).map(({code, message}) => ({code, message}))`.

## Tests first
- `packages/core-domain/test/packet.test.ts` (no DB): no new fields and no sha256 ⇒ equals current golden byte for byte; findings numbered verbatim; payer lines only when set; sha256 full; uppercase/short → PacketError; `\n`/`\r` in any new value → PacketError; deterministic.
- `packages/extraction/test/letter-safe-findings.test.ts`: list snapshot; `charge_waived_in_writing` not in it.
- `packages/pipeline/test/log-001-letter.test.ts` (no DB): reuse log-001.test.ts's walk; filter as the route does; build with fixed supplier/documents; compare to an inline golden containing $600.00 and not containing the waiver sentence.
- `packages/store-postgres/test/workflow.test.ts` (DB): narrative has the finding and each sha256 hex; same findings ⇒ same packet; different findings ⇒ new row, old unchanged; **re-assembling a case assembled before this change yields a new packet row (new hash) and the old approval does not carry over** (build the old row with the pre-change narrative input shape).
- `apps/web/test/workflow-routes.test.tsx`: assemble route passes only safe supports_dispute findings.

## Verification
`pnpm typecheck`; `env -u DATABASE_URL pnpm test packages/core-domain/test/packet.test.ts packages/extraction/test/letter-safe-findings.test.ts packages/pipeline/test/log-001-letter.test.ts apps/web/test/workflow-routes.test.tsx`; with DB `pnpm db:test` then `env -u DATABASE_URL pnpm test packages/store-postgres/test/workflow.test.ts`; full suite.

## Acceptance
- [ ] composer sections + validation, golden unchanged when absent
- [ ] findings gate list + test
- [ ] sha256 hex from SQL
- [ ] memory store + fake parity
- [ ] reviewPipelineDeps shared
- [ ] re-assemble-after-deploy test
- [ ] PR notes: new packets change bytes; old rows never recomputed

## Pitfalls
Never recompute stored packets. No clock/locale. Money only via formatCents(cents()). Letter renders as text.

## Out of scope
Model narrative, changing old packets, submission channels, finding page citations.

## Open questions
Warnings → no. Page citation → no.

## Depends on
Optional: 01 (payer terms), 02 (checklist).

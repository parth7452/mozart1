# 04 — Playbook tables and the payer-code map

*Phase 2 plan task. Not started; waits for approval.*

**Starts when:** Draft D accepted.

## Steps
- Migration: `playbooks`, `playbook_versions`, `playbook_code_maps`, `playbook_deadline_rules`, `playbook_evidence_requirements`, `playbook_channels`; append-only, RLS, shared (org null) and tenant rows.
- `mapPayerCode` (pure, exact normalised match or `unmapped`), reason-code taxonomy additions for staffing and foodservice (ADR-tracked, under the 60 ceiling).
- A case-page finding for an unmapped payer code; `/new-playbook` writes `draft` rows; promotion to `reviewed` by a person.

## Done when
- `stf-203`'s `CB-203` maps to the canonical code once its payer's playbook says so; an unmapped code is a finding, never a guess.
- The extraction eval is unchanged (the field stays as printed); mapping has its own test.
- `pnpm verify` green; any migration applied to `mozart-preview` first, then production, read back on both.

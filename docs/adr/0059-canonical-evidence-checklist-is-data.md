# 0059 — The canonical evidence checklist is data

- Status: accepted (2026-09-27), record only. No migration. **The family lists
  are placeholders for founder review.**
- Date: 2026-09-27

## Context

A reviewer deciding a case cannot see which evidence the chosen reason needs,
or which of it is already on the case, until they assemble a packet and read
it. `EVIDENCE_TYPES` (eleven) existed in `adapters` and nothing said which of
them a reason code needs.

## Decision

1. A canonical, versioned, effective-dated default lives in core-domain
   (`CANONICAL_EVIDENCE_REQUIREMENTS`): per reason family, with overrides per
   canonical code. Each set carries a version, an `effectiveFrom` date and
   named-human provenance (this ADR). The first set is effective from
   2000-01-01 so a decision of any date resolves one.
2. Payer-specific overrides come later, as Draft D's
   `playbook_evidence_requirements` — data, never code.
3. "Have" means a document of that type is linked to the case. Its content is
   not checked: a `bol` or `pod` is on file, its signature is not verified.
4. A `correspondence` document is only ever "possible" buyer approval, never
   "have": whether a message is the buyer's approval is not checked.
5. The checklist is shown only once a person has chosen a reason; nothing
   guesses a reason before a decision.
6. Evidence the product has no type for yet (carrier ELD/telematics log,
   timesheet, receiving report, temperature/shelf-life record) is listed as a
   footnote rather than invented as a type.

## Consequences

- The case page shows, for a decided case, each evidence type, Required or
  Helpful, and Have / Possible / Missing with the documents that satisfy it.
- The lists are the founder's to correct; a correction is a new set with a
  later `effectiveFrom`, never an edit of a set a decision was shown against.
- Nothing is persisted; the checklist is computed at read time.

## Invariants

No table, grant or threshold changes (invariants 2 and 7 untouched). No model
reads anything (invariant 4). No money is computed.

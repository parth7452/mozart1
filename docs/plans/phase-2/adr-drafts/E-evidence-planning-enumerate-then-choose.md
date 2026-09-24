# Draft E — Evidence planning is enumerate-then-choose, over one vocabulary

- Status: **proposed**
- Date: 2026-09-24
- Builds on: STRATEGY ADD-8 and §6.8, `EvidenceSource` and
  `EvidenceChecklistItem` (`packages/adapters`), the state machine's
  `classified → evidence_pending → evidence_complete` edges (declared, no
  evaluator)

## Context

CLAUDE.md reserves an agentic loop for evidence planning. STRATEGY ADD-8
argues it need not be a loop. Code can list which evidence is missing and
which source can supply it, and a decider only picks from that list. It
cannot invent a step that does not exist.

Two things block any version of it:

1. **Four evidence vocabularies disagree:**
   - `EVIDENCE_TYPES` (adapters), 11 values, which Schema A uses;
   - Schema B's `missing_evidence`, 11 values, a different list;
   - the decline form's `MISSING_EVIDENCE_TYPES` (store), 8 values;
   - `DOC_TYPES` (extraction), 12 values.

   The same proof of delivery is `signed_pod`, `proof_of_delivery` and `pod`
   depending on who asks.
2. **No evidence source exists.** Not even "the documents already on this
   case".

## Decision

1. **One vocabulary: `EVIDENCE_TYPES`**, which is canonical in
   `core-domain`, with explicit, tested maps:
   - `DOC_TYPES` → evidence type, for what a read document satisfies;
   - the decline form's list → evidence type, whose rows keep their stored
     strings, because the table is append-only;
   - Schema B's `missing_evidence` bumps its schema version to use the same
     list.
2. **The checklist is derived, not decided.** For a case, the required
   evidence comes from the playbook's requirements for its canonical reason
   code (draft D), else from a default per reason family. `satisfiedBy` comes
   from the documents linked to the case and their doc types. It is written
   as `evidence_checklist` rows: append-only, one row per (case, evidence
   type, version), recomputed on every new document. That is the
   `evidence.planned` event the state machine names.
3. **The move `classified → evidence_pending`** gets its evaluator: the
   classification floor (ADR 0044's `classificationIsActionable`), and a
   checklist exists. `evidence_pending → evidence_complete` is "every required
   item satisfied". Both are deterministic.
4. **Enumerate, then choose.** The legal next actions are (unsatisfied
   evidence type × a source that can supply it):
   - `case_documents`: already on the case, so free;
   - `accounting`: the QuickBooks invoice and payments, already read, so
     free;
   - `request_from_customer`: a task for a person;
   - `portal`: draft H, later.

   **v1 chooses by rule** (cheapest source first, then the earliest deadline).
   A model choice over the same enumeration (Jev, via draft B) is shadow-only,
   through draft A, until it beats the rule on recorded cases.
5. **Fetching is not deciding.** An evidence source that reaches outside
   (portal, carrier) is an outbound read, with its own ADR (draft H). Nothing
   here sends anything to a payer.

## Options not taken

- **A free-form agent loop with tools.** It is unbounded, hard to replay,
  and a money path.
- **Keeping four vocabularies and mapping at every boundary.** It is how
  they drifted in the first place.

## Consequences

- The agentic surface CLAUDE.md reserves shrinks from two steps to one
  (unknown-payer cold start), as STRATEGY ADD-8 intended. CLAUDE.md is
  amended when this is accepted.
- A case page can say "missing: signed POD; the customer has to supply it".

## Invariants touched

- Invariant 2 (a new append-only table).
- Invariant 4: the checklist is our data, and a model sees it as a closed
  set.

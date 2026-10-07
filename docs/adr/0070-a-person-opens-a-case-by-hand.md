# 0070 — A person opens a case by hand

- Status: **Accepted** by the founder 2026-10-07. Migration 0042 applied on the
  founder's go the same day, to `mozart-preview` and then production, and read
  back on both: the stored statement's md5 equals the file's
  (`488cd01d…`); the four checks name the new values; `deduction_identifiers`
  still has three checks; `app_rw` still holds no UPDATE or DELETE on
  `uploads`, `deduction_identifiers` or `declined_candidates`. The security
  advisor shows nothing new.
- Date: 2026-10-07
- Builds on: ADR 0019 (a debtor is master data a person made), ADR 0024 (an
  arrival is a fact), ADR 0025 (identity), ADR 0029 (a ledger extract is a
  document), ADR 0043 §2 (a case whose type is known by construction opens
  `classified`), ADR 0067 (payer code maps)
- Adds, if accepted: one `uploads.source` value (`manual_entry`), one
  `deductions.discovered_via` value (`manual`). No table, no column, no grant.

## The decisions that are the founder's

1. **Accept this ADR**, and apply migration 0042 (preview first). Done
   2026-10-07; the app code reads the new values, so it was deployed after.
2. **A case with no documents** (asked 2026-10-07; answered "allow it and flag
   it"). Built: it opens, and the case page says *Incomplete — no documents
   attached* until a document other than the entry itself is on the case. A
   packet cannot be assembled for it until then (`NothingToSendError`), because
   the entry record is never enclosed (§4).
3. **One case per deduction, or one case for several invoices** (asked). Built:
   one case per deduction reference, which may name several invoices. The
   invoices are identifiers of the one case (ADR 0025's `invoice_number` kind,
   never matched as an exact key); two deduction references are two cases.
4. **An unmapped payer reason code** (asked; answered "open it"). Built: the
   case opens with the code as typed; the case page already says "no mapping
   yet" and Settings → Reason codes lists it among unmapped codes.
5. **Who may open a case or add a payer.** Built: any member who may write
   (owner, approver, analyst), by `app.member_may_write()` as for every other
   insert. `read_only` sees no button and the database refuses the insert.

## Context

A case enters only through a document a model read (a notice, a remittance line,
a sheet row) or a ledger sync. An accountant who already knows a deduction —
from a payer's portal, a phone call, a remittance they have not got as a file
yet — has no way in. The form must ask only what identifies the deduction and
derive the rest.

## Decision

### 1. The entry is a document, as a ledger extract is (ADR 0029 §1)

What the accountant typed is serialised to canonical JSON
(`manual-entry.json`, `application/json`, built by `buildManualEntryDocument`
in `core-domain`) and stored as the case's `notice`, arriving through
`uploads.source = 'manual_entry'` with `created_by` the member. That one choice
makes the rest of the system work unchanged:

- `declineCase` derives `discovered_from = 'manual_entry'` from the notice's
  own `uploads` row (`provenance_kind = 'observed'`), never from a caller.
- `coverage_by_period_by_source` counts the case under `manual_entry`, its own
  channel, never blended with an observed one.
- The entry is append-only like every document: what was typed on the day is
  what the post-audit defence can show.

`manual_entry` is added to `uploads.source`, `deduction_identifiers.source` and
`declined_candidates.discovered_from` together (migration 0014's rule: one list
in three places). It is **not** added to `document_arrivals` — that table is for
documents stored before provenance existed, and a manual entry always records
its arrival.

`servingRefusal` exempts a `manual_entry` document with no scan verdict, as it
does `erp_sync`: our code wrote every byte, from fields a member typed, and no
file came through a door. A verdict, if one ever exists, still decides.

### 2. `discovered_via = 'manual'`

The case was named by a person, not a notice, a remittance line or a report
row. Coverage slices by it.

### 3. What is asked, and where it goes

| Field | Required | Stored |
| --- | --- | --- |
| Payer (a debtor of this tenant) | yes | `deductions.debtor_id` |
| Deduction reference | yes | `deductions.claim_id` + a `claim_id` identifier (`source = manual_entry`) |
| Deduction amount | yes | `deductions.deduction_amount_cents`, through `parseMoneyToCents` |
| Deduction date | yes | `deductions.deduction_date` |
| Payer reason code | yes | `deductions.reason_code_as_printed`, verbatim |
| Invoice number(s), 1–20 | yes | `invoice_number` identifiers (`source = manual_entry`) |
| PO number, check/remittance number | no | the entry and `case.discovered` only |
| Amount to dispute (default: full; partial allowed) | no | the entry and `case.discovered` |
| Via distributor: the end retailer (a debtor) | no | the entry and `case.discovered` |
| Notes | no | the entry and one `case.note_added` event |
| Assignee (a member; default the person entering) | no | one `case.assigned` event |
| Documents | no | uploaded on the case page after it opens (the existing "Add evidence") |

Every text field is bounded (identifiers and the code 200 characters, notes
2,000) and refused, never cut, past the bound.

**Derived, never asked**: the case id; the state (`classified`, §5); the
source (`manual_entry`) and `discovered_via` (`manual`); the canonical reason,
from `payer_code_maps` at read time as for any case (ADR 0067); the evidence
checklist, from the canonical reason once decided (ADR 0059); the duplicate
check (§6).

**Not derivable yet, and said so rather than guessed**: the dispute deadline
(no payer window is held as data yet — the case page's existing deadline form
is how a person sets one, and `case.discovered` records
`deadline: 'no_payer_window_on_record'`); the filing channel (no payer's portal
or address is held as data); the QuickBooks invoice and GL account (resolved
when a settlement is prepared, ADR 0069; matching at open is a follow-up).

### 4. The entry is never enclosed in a packet

`packetDocuments` leaves out any document whose `uploads.source` is
`manual_entry`. It is our record of what a person typed, not evidence, and a
payer is not sent it. A manual case with nothing else on it therefore cannot be
assembled, which is the "incomplete" of decision 2 enforced where it matters.

### 5. It opens `classified`

The entry's type is known by construction, as a ledger extract's is, so the
case crosses `discovered → classified` (`document.classified`,
`doc_type_known`) in the same transaction it is opened in, with a
`case.classified` event naming `manual_entry`. Without it the case could be
neither decided nor declined (ADR 0043 §2).

### 6. Duplicates

`openCase`'s own rules, unchanged: an exact `claim_id` match is
`DuplicateCaseError` naming the existing case (the form sends the person
there), `unique (org_id, debtor_id, claim_id)` stays the last line, an
ambiguous match is refused for a person, and a probable one opens with
`case.possible_duplicate`. Payer plus deduction reference is therefore the
duplicate check the brief asked for.

### 7. One transaction

The `uploads` row, the `documents` row, the case, its identifiers, the notice
link, the events and the `classified` move are one transaction, so a refused
duplicate leaves no case and no document. The entry's bytes are written to the
blob store first, as `putDocument` does; a refusal leaves bytes nothing
references, which is the lesser failure `putDocument` already accepts.

### 8. A payer is added by a person

`createDebtor` inserts `debtors (org_id, retailer_key, display_name)` with
`retailer_key = retailerMatchKey(display_name)`, and one `audit_log` row
`debtor.created` naming the member. A name that folds to an existing key is
not a second payer: the existing one is returned and the form selects it. This
is ADR 0019's rule kept — document text never mints a debtor; a person may.

## Consequences

- No UPDATE or DELETE grant is added; `uploads`, `deduction_identifiers` and
  `declined_candidates` stay append-only. Suite 38 reads the widened checks
  back and asserts `document_arrivals` still refuses `manual_entry`.
- A second manual case on the same invoice records its invoice on the entry and
  the event but not as an identifier, because `(org, source, kind, identifier)`
  is unique — the limitation every source already has (ADR 0028).
- The review queue does not yet mark an incomplete manual case; the case page
  does.

## Invariants

1 (approval gate), 2 (append-only), 6 (RLS) and 7 (thresholds) are untouched.
3: the amounts go through `parseMoneyToCents` and are bigint cents. 4: nothing
here is read by a model. 5: no decision provider is called.

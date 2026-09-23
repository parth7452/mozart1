# 0040 — A remittance-opened case reconciles against its line

- Status: accepted
- Date: 2026-09-23

## Context

The demo (`docs/DEMO.md`) walks LOG-001: a short-pay remittance, then an
invoice, a rate confirmation, the customer's approved reschedule and a proof of
delivery, attached one by one, and a case page that says together what no one
of them says. Walked against the recorded cassettes, it did not get there, for
three reasons.

1. **A remittance-opened case had nothing to reconcile against.** Since ADR
   0028 a short-paid remittance line opens a case, and in freight, staffing and
   foodservice that line *is* the notice — nobody filed a claim. But
   `reconcileCase` looked for a `deduction_notice` on the case and returned
   `undefined` without one. Every case ADR 0028 opens showed no findings,
   whatever evidence was attached to it.
2. **A waiver that superseded nothing was never read as a waiver.**
   `charge_waived_in_writing` was emitted from inside the supersession loop,
   behind `if (supersedes === undefined && establishes === undefined)
   continue`. Both recorded readings of `04` split the customer's message into
   two commitments — "revision 2 replaces revision 1" and "No carrier
   late-delivery charge applies…" — and the second waives and moves nothing. The
   one sentence that wins the case was skipped. The unit test passed only
   because its hand-written fixture put both sentences in one commitment.
3. **Uploading the remittance did not send the reviewer to the case it
   opened.** `result.case` is a notice's case; a remittance reports its cases
   under `result.remittance`, since one advice can open many. The upload route
   read only the first, so it said "read as a remittance advice; attach it to a
   case" about a document that had just opened one.

## Decision

1. **A case whose `discovered_via` is `remittance_line` reconciles against the
   line that opened it** (`reconcileRemittanceLine`, in `extraction`). The line
   is found by rebuilding each remittance line's claim id the way
   `openCasesFromRemittance` built it — `lineClaimId(payment_reference,
   invoice_number)` — and comparing it to the case's own `claim_id`. Every
   remittance on the case is searched, not only the first, because the same
   advice arriving again is filed on the case as evidence. The postgres
   `getCase` now returns `discovered_via` so that question is asked of the row,
   not guessed from which documents are attached.

   What it checks:

   - **The line against itself.** A remittance that prints a deduction *and* a
     gross and a net states the same fact twice; `gross − net` is computed in
     integer cents here (invariant 3) and a disagreement is
     `remittance_line_does_not_add_up`, blocking. The claimed amount is the
     deduction as printed, else the subtraction — ADR 0028 §2's rule, so the
     case and its reconciliation cannot disagree about what was claimed.
   - **Against the invoice it short-paid**: a different invoice number is a
     warning that the evidence may not belong to the claim; the same invoice
     with a different total than the line's gross is a warning too.
   - **Against the evidence, exactly as a notice is**: the delivery record, the
     appointment in force, and anything the customer wrote. Those checks are
     now shared helpers (`reconcileShipment`, `reconcileAppointment`,
     `reconcileWaivers`) called by both paths.

   What a remittance does not print, it does not pretend to check: there is no
   PO and no item on a remittance line, so there is no three-way match and no
   PO on the delivery record to compare.

   A remittance-opened case whose line cannot be found on any attached
   remittance gets a blocking `remittance_line_not_found` and the evidence is
   still reconciled; a remittance that will not parse is refused the way a
   notice is, and one with unreadable fields is downgraded the way a notice is
   (a money field *on this line* keeps it blocking; one on another invoice's
   line does not).

2. **A waiver is its own pass.** `reconcileWaivers` looks at every commitment
   and emits `charge_waived_in_writing` where `waives_charge` is true, whether
   or not it supersedes anything and whether or not a delivery record is
   attached. A reschedule that does not waive still produces no waiver — the
   existing "does not read a plain reschedule as a waiver" test stands.

3. **The upload route redirects on a remittance's cases.** Opened and
   merged-into cases, de-duplicated: exactly one sends the reviewer to it;
   several send them to the case list with a new notice key,
   `upload_remittance_cases`, carrying the count as a validated fragment; none
   falls through to "read as" as before. The queued path is unchanged — the
   job's result is not in the request.

4. **The case page keys a finding by code and position.** The text-PDF reading
   of `04` produces two `appointment_superseded` findings, one per commitment
   that moves the appointment. That is the reading, not a bug to collapse, so
   the list stops assuming codes are unique.

## Consequences

- LOG-001 walked from its recorded cassettes reaches `arrived_before_appointment`,
  `appointment_superseded` and `charge_waived_in_writing`, with the line's
  arithmetic `matches` and nothing blocking, from both the text-PDF and the
  scanned reading of `04`. `packages/pipeline/test/log-001.test.ts` walks it
  the way the demo does and asserts each.
- No migration, no new table, no change to an append-only table and no new
  outbound effect. `discovered_via` has been on `deductions` since ADR 0028.
- A remittance-opened case still carries no dispute deadline (ADR 0028 left it
  out deliberately) and no PO; the demo now says so rather than implying it.
- Findings are only as good as the reading: the text-PDF reading of `04`
  reports the first commitment as "August 13 … replaced August 12" rather than
  the revision identifiers, which is the `supersedes`/`establishes` miss
  already in the eval baseline. This ADR does not change extraction.
- A case opened from one remittance line and *also* holding a notice (a merge,
  ADR 0028) reconciles against the notice, as before. Reconciling both and
  comparing them is a follow-up, not built.

# 0048 — Two lines on one invoice are two deductions

- Status: accepted
- Date: 2026-09-24

## Context

ADR 0028 gave every short-paid remittance line the claim id
`payment_reference:invoice_number` and said, in §7, that it is "unique per line
within a payment". It is not. A remittance can print two deductions against one
invoice as two lines — LOG-202's advice does: invoice CF-260902, gross $5,600,
paid $4,800, then "CB-202-A / LATE: $500.00" and "CB-202-B / SHORT: $300.00".

Read as two lines, both build `ACH-WP-202:CF-260902`. The first opens a $500
case and records that claim id; the second resolves `exact` against it and is
recorded as `mergedInto` the first. The $300 then appears nowhere — no case, no
`declined_candidates` row, only a `case.merged_duplicate_line` event on a case
whose amount is still $500. That is the one failure this pipeline is built not
to have: a deduction seen and dropped with nothing that counts it.

It was found on 2026-09-24 while giving the remittance schema a
`deduction_reference` field, which made the reader split LOG-202 into its two
lines; the field was withdrawn from the remittance schema for this reason. The
recorded cassette reads the advice as one $800 line, so replay never showed it.
Any real advice laid out this way would.

Two neighbouring holes come with the same layout:

- A line that repeats its invoice's gross and net and prints no deduction of its
  own would get `gross − net` — the whole invoice's short-pay — once per line,
  counting $800 twice.
- `reconcileRemittanceLine` compares each line's printed deduction to its own
  `gross − net`. A line that repeats the invoice's $5,600 / $4,800 and prints
  only its own $500 reads as `remittance_line_does_not_add_up`, blocking, on
  both cases — a correct advice flagged as one that cannot be trusted.

## Decision

1. **Lines of one advice that name the same invoice are never an identity
   match for each other.** Each such line gets its own claim id,
   `payment_reference:invoice_number#n`, where `n` is the line's 1-based
   ordinal among the advice's lines that print that invoice number (compared
   with `identifierMatchKey`), in page order. An invoice printed on one line
   only keeps ADR 0028's key unchanged, so every case already opened from such
   a line still exact-matches when its advice arrives again. `lineClaimIds`
   in `steps.ts` is the one function that computes both, and
   `remittanceLineOfCase` uses it, so the line a case reconciles against is the
   line that opened it.

   The ordinal, not a printed per-line reference, because the remittance
   schema has no such field (see Context). When it gains one, a group whose
   every line prints a distinct reference may key on it instead; that is a
   change to `lineClaimIds` and to this ADR, and until then the ordinal is
   what the page itself makes stable.

2. **No case this advice opened is a candidate for its later lines.** Neither
   for the exact branch (1 already makes the keys differ) nor for the probable
   one: two $300 deductions on one invoice on one advice are two deductions,
   and flagging the second as a possible duplicate of the first is noise a
   reviewer would learn to ignore. Cases opened by any other document are
   candidates exactly as before.

3. **Cases opened under the old key keep it** (invariant 2: `deduction_identifiers`
   is append-only, and a case's `claim_id` is its own). Before this ADR the
   first line of such a group opened a case keyed `ref:inv` and the rest were
   dropped. When an advice with a repeated invoice arrives again, each line of
   the group also looks the old key up:

   - the case holding it belongs to the first line of the group, in page
     order, whose short-pay equals the case's amount (`legacyOwner`, computed
     over the whole group before any line is processed, so every line gets the
     same answer). That line merges into it (`matched_on: ['claim_id']`, with a
     `detail` naming the key it was opened under);
   - when some other line of the group owns it, this line opens its own case
     and does not name it — it is that line's deduction, not this one's;
   - when no line of the group owns it, every line opens its own case and names
     the old one as a probable duplicate, basis `legacy_claim_id`, on
     `case.discovered` — where every probable match on this path is named
     today. That it is not yet a `case.possible_duplicate` pair a person can
     answer is audit F1 (`docs/audits/duplicate-counting/`), and fixing F1
     fixes it here too.

   `remittanceLineOfCase` answers the same way, so an old case reconciles
   against the line that owns it.

   So the $300 the old key dropped opens on the next read of that advice, and
   the $500 case is not duplicated. A case the old key opened from a one-line
   reading ($800) and a later two-line reading ($500 + $300) disagree on
   amount, so both new lines open and both name the $800 case: three visible
   cases, rather than a guess about which dollars survive.
   Nothing is re-pointed, nothing is written to an old case, and no identifier
   row is rewritten.

4. **A line that shares its invoice's gross and net prints its own share or is
   unreadable.** When another line of the same advice names the same invoice
   with the same printed gross and net, a line with no `deduction_amount` is
   reported `unreadable` rather than given `gross − net`, because that
   subtraction is the invoice's short-pay and not this line's. A group whose
   lines carry different gross and net keeps the per-line subtraction.

5. **Reconciliation checks a shared invoice once, across its lines.**
   `reconcileRemittanceLine` finds the line's siblings — lines of the same
   advice with the same invoice, gross and net — and compares the sum of their
   printed deductions to `gross − net`. When it agrees, the line `matches` and
   an `info` finding (`remittance_invoice_shared`) names how many lines share
   the invoice; when it does not, the existing blocking
   `remittance_line_does_not_add_up` fires, stated over the sum. A line alone
   on its invoice is reconciled exactly as before.

## Consequences

- LOG-202 read as two lines opens two cases, $500 and $300, each reconciling
  clean. A remittance that prints the same line twice by mistake now opens two
  cases instead of one; that duplicate is visible and mergeable (ADR 0042),
  where the old behaviour's wrong merge was neither.
- The ordinal key depends on the reader seeing the same lines in the same order.
  A re-read that splits or joins a group differently builds different keys, and
  lands in the probable branch (same invoice, amount and date) or opens a case —
  never a silent merge.
- Lines that repeat their invoice's gross and net and print no deduction of
  their own are `unreadable`, like any other line we cannot price. When no
  other line of the advice touches a case, that is a log line and not an
  event, as it already is for every unreadable line (`reportLinesProcessed`).
- One advice now costs one extra identifier look-up per line on a repeated
  invoice, inside the invoice claim it already held.

## Invariants touched

- **2 (append-only).** Nothing old is rewritten: old cases keep their claim id
  and identifier rows, and the fallback in 3 reads them. No grant changes.
- **3 (integer cents).** The group sum is `sumCents` over printed amounts; no
  new arithmetic path.

No migration and no new outbound side effect.

## Rollback

Revert the change to `lineClaimIds` and the reconcile sibling check. Cases
opened under the `#n` keys keep them, and would be probable (not exact) matches
for a re-read under the old key — visible, never merged silently.

# 0069 — A posting that never went is said so, and can be voided

- Status: **proposed**. Built on `fix/posting-presend-failure`. No migration.
- Date: 2026-10-05
- Amends: ADR 0060 §3 (a failure before the send is now a recorded attempt; a
  journal entry left `pending` with nothing recorded can be retried by a
  person) and ADR 0068 §3 (a case whose approved settlement was voided takes a
  new one).
  Unchanged: both approval moments, `app.require_approval()`,
  `app.enforce_separation_of_duties()`, the `QBO_POSTING` gate, the
  per-connection switch, write-once `writebacks`, the request id, that the job
  sends once, and that a 5xx or a timeout is an unknown outcome only a person
  retries.
- Adds: two reads of QuickBooks at prepare time (`Invoice` by id and by
  `DocNumber`) and one at void time (`findByReference`, which already
  existed). No new write to QuickBooks, no new outbound side effect, no table,
  no grant.

## Context

The first posting this product ever attempted (production, 2026-10-05 21:48
UTC) sent nothing and said nothing.

A settlement was prepared and approved on a case opened from an uploaded
notice. The prepare form asked for a "QuickBooks invoice id" and held it to
digits; the person typed `120324`, the invoice number printed on the notice.
`prepareSettlementDecision` checked that it *looked* like an id
(`assertQboId`) and stored it as `result.invoice_id`. Nothing asked QuickBooks.

The `post-writeback` job then called `invoiceCustomer('120324')`, which ran
`queryByIds('Invoice', ['120324'])`, got no rows — QuickBooks has no invoice
with that internal id — and passed `rows[0]`, `undefined`, to `readObject`,
which threw `QboMalformedResponse`. That was before `client.post`, and outside
every `try` that records an attempt, so:

- the `writebacks` row stayed `pending` with no `writeback.attempted` event;
- the case page showed "pending" and offered nothing, because the retry button
  was drawn only for a `failed` row;
- the settlement could not be prepared again, because ADR 0068 §3 refuses a
  case whose settlement is approved.

Three separate holes: text was trusted as an id, a failure before the send
left no record, and an approved settlement that could never post had no way
out.

## Decision

### 1. The invoice is resolved against the ledger when the settlement is prepared

The form now asks for the invoice number as QuickBooks has it and accepts an
id or a printed number (`STATED_INVOICE`: one line, 21 characters, no quote or
backslash — it is spliced into a query).

`prepareSettlementDecision` takes a required `findInvoice` and calls it before
its transaction opens, as it does the chart. `QboClient.findInvoices` answers
the invoice whose `Id` is the text (when it is digits) and every invoice whose
`DocNumber` is exactly the text. `resolveStatedInvoice` (`core-domain`, pure,
property-tested) is the one rule:

- exactly one invoice across both readings → that invoice;
- none → `invoice_not_found`; several → `invoice_ambiguous`. Digits that are
  one invoice's id and another's printed number are two invoices: which was
  meant is not ours to guess;
- except that a case's own `ledger_invoice_id` — recorded by the ledger sync,
  never read off a page — is taken by id when QuickBooks still has it,
  whatever else prints those digits. A ledger-opened case works as before.

What is stored as `result.invoice_id` is **the id QuickBooks reported**, never
the text stated; `result.invoice_number` keeps the `DocNumber` QuickBooks
reported so the page can show both. A refusal is
`SettlementInvoiceRefusedError`, nothing is written, and the form says which.
A lookup that fails is its own notice; nothing QuickBooks said, and not the
text stated, reaches a log or an address.

### 2. A failure before the send is a recorded attempt

From the point the job has a client, every way it can end before
`client.post` records `writeback.attempted` with `status: 'failed'` and a
reason from `NOTHING_SENT_REASONS`: `no_invoice`, `invoice_not_found`,
`invoice_lookup_failed`, `build_failed`, `lines_changed`. The record carries
ids, the HTTP status and Intuit's fault code at most — the same `failureOf`
the post-send path uses — and never a body, a message or page text.
`invoiceCustomer` answers `undefined` for an id QuickBooks does not have, so
that case is named rather than malformed. The job throws
`WritebackNotSentError`, a `PostingRefusedError`.

The refusals that are about the deployment or the member, not the posting
(`not_configured`, `member_may_not_write`, `posting_disabled`, `no_client`,
`entry_not_verified`), still record nothing: nothing about the row failed.

`nothingWasSent` reads a row's attempts: true only when there is at least one
and every one carries a nothing-sent reason. The case page says, in fixed
wording keyed on the reason constant, **"not sent — nothing reached
QuickBooks"** for such a row and **"outcome unknown — it may have reached
QuickBooks"** for any other failure but a 4xx (**"QuickBooks refused it"**). A
reason the page does not know is never printed.

### 3. A person can retry a stuck row, and void a posting that never went

**Retry.** The route already queued a `pending` row with `retry: true`; only
the button was missing. A journal entry `pending` with nothing recorded about
it for `STUCK_PENDING_MINUTES` (5) is shown as "waiting — no result recorded"
with **Check QuickBooks and retry**. The job's retry path reads QuickBooks by
the row's reference before it sends, so a run that died after sending is found
rather than repeated.

**Void.** Retry alone cannot unstick a row whose decision names an invoice
QuickBooks does not have: the retry fails the same way every time, and the
decision cannot be replaced. So an owner or an approver, whom the database
still lets write, may void an approved settlement's posting:
`voidSettlementPosting` appends one `deduction_events` row,
`settlement.posting_voided`, naming the decision, its writebacks and who. No
row is updated or deleted; the approval and the failed `writebacks` rows stay.

It is refused unless the posting provably never reached QuickBooks:

- no row of the decision `succeeded` (`posted`);
- its journal entry is `failed`, not `pending` (`not_failed`);
- every recorded attempt on every row of the decision is a nothing-sent one
  (`maybe_sent`) — one unknown outcome, ever, and it is never voidable;
- **and QuickBooks, asked by each row's reference, holds nothing**
  (`in_ledger`). This covers the one case our own records cannot: a run that
  sent and died before recording. The read is made before the case's row is
  locked; the checks on our rows are made again under the lock that prepare,
  approve and retry take, and a row added in between is refused.

Once voided: `prepareSettlementDecision` no longer counts that decision as the
case's approved settlement, so a new one is prepared, approved by a second
person and posted under its own `writebacks` row and request id. The job
refuses a voided row (`voided`), `requeueWriteback` refuses it, and the page
shows it as "voided — never sent" with no button.

## Invariants touched

1. **Approval gate** — unchanged. The new settlement's `writebacks` row needs
   its own approval; the voided one's approval authorises nothing further,
   because its rows are never sent.
2. **Append-only** — a void is a new event. Nothing is corrected in place.
3. **Integer cents** — untouched.
4. **Untrusted content** — strengthened: a number off a document is no longer
   usable as a ledger id.
6. **RLS / no service role** — every read and write is `app_rw` with the
   member's claims.

## Options not taken

- **A `voided` status on `writebacks`, enforced by trigger.** The database
  would then refuse to send a voided row whatever the code did, which is this
  repository's usual standard. It needs a migration on a gated table, and the
  production row stays stuck until that is applied. The event-only design is
  enforced in the store and the job, at the same level as
  `writeback.attempted` and the `status` projection already are. Proposed as a
  follow-up if the founder wants the database to hold it.
- **Re-pointing the approved decision at the right invoice.** A decision is
  what was approved; editing it after approval is what ADR 0068 exists to
  prevent.
- **Voiding after a 4xx (`send_failed`).** QuickBooks answered and refused, so
  nothing was created — but that rests on Intuit's behaviour rather than on
  our not having sent. Left out; retry covers it.
- **Resolving at posting time instead.** The approver would approve an invoice
  nobody had checked.

## Consequences

- Preparing a settlement now needs QuickBooks reachable for one more read.
- A voided settlement's `writeoffs` row, when its outcome wrote something
  off, stays, and the settlement that replaces it writes its own. Nothing
  reads `writeoffs` for a figure today (only the merge refusal asks whether
  one exists). **Any future reader must leave out a decision with a
  `settlement.posting_voided` event**, or the write-off is counted twice.
- A settlement prepared before this change keeps whatever `invoice_id` it was
  given. An unapproved one is fixed by preparing it again; an approved one by
  retry, then void.
- The existing production row (`writebacks` 5be2d862-…) is `pending` with no
  attempt. After deploy: **Check QuickBooks and retry** makes the job run
  again, find nothing under its reference, fail at the invoice and record
  `invoice_not_found`; **Void this posting** then sets it aside; the case is
  prepared again with the real invoice number and approved by a second person.

## What the founder decides

1. Whether void should be the database's rule too (a migration: a `voided`
   status or a trigger refusing a send), rather than the store's and the job's.
2. Who may void: an owner or an approver as built, or an owner only.
3. Whether a posting QuickBooks refused with a 4xx may be voided.
4. `STUCK_PENDING_MINUTES` (5).
5. What a future reader of `writeoffs` does with a voided settlement's row.

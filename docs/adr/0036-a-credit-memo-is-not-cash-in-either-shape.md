# 0036 — A credit memo is not cash, in either shape QuickBooks writes it

- Status: accepted
- Date: 2026-09-22

## Context

ADR 0026 mapped QuickBooks into the accounting port and got one thing right in
principle: applying a credit memo to an invoice is not money arriving, and
counting it as money arriving would hide a write-off. QBO records the
application on a **Payment**, not on the `CreditMemo`, so `toLedgerPayment`
skips a line that names a credit memo and `resolveCreditApplications` reads the
credit's `appliedTo` back off those same lines.

Both functions assumed one line shape: a single Payment line whose `LinkedTxn`
names an Invoice *and* a CreditMemo. That is the shape the hand-written fixture
`packages/qbo/test/fixtures/payment-query.json` was written to — by us, from
Intuit's documented response, without a sandbox to check it against.

The sandbox recording holds a different shape, and holds it for the ordinary
case. In `recorded-payment-query.json`, payment 74 is `TotalAmt: 0` with **two**
lines:

| Line | Amount | `LinkedTxn` |
| --- | --- | --- |
| 0 | 100 | Invoice 71 |
| 1 | 100 | CreditMemo 73 |

Read line by line, line 0 has no credit memo on it, so it is cash — $100 of cash
on a payment that carried none. Line 1 names no invoice, so
`resolveCreditApplications` skips it and credit memo 73 resolves to nothing at
all.

The consequence is the one this product exists to prevent. Invoice 71 totals
$205.00. $105.00 of cash arrived on payment 72; the remaining $100.00 was
settled with credit memo 73. The ledger's own balance is zero. The mapper
reported $205.00 of cash applied, so `detectShortPays` saw an invoice paid in
full and produced nothing — where the truth is a $100.00 gap with
`gapStatus: 'credited'`: a deduction the business already wrote off without
disputing it. That is the exact case ADR 0026 and `short-pay.ts` both argue at
length must never be netted away, arriving through the mapper instead of through
the detector.

It is not a rare shape. Which of the two QBO writes depends on how the credit
was applied in the UI, and the recording says the sandbox company's own data is
the two-line one.

There is a second, more general hole underneath it. Nothing checked the cash a
Payment's lines added up to against `TotalAmt`, the field that says what the
payment actually carried. Payment 74 carried $0.00 and the mapper reported
$100.00 of cash from it, and no assertion anywhere had an opinion about that.

## Decision

### 1. A payment's cash applications are bounded by what the payment carried

`readPaymentApplications` reads one Payment once into two answers — the cash it
applied, and the credits it applied — and then asserts the bound: cash
applications summing to more than `TotalAmt` is `QboMalformedResponse`, naming
the payment. A shape we have read wrongly says so rather than publishing a
number.

This is the invariant the old code lacked. Both known line shapes satisfy it,
and a third shape that does not fails loudly at the mapper rather than quietly
in a recovery rate.

### 2. Both line shapes are read, and the pairing is forced, never apportioned

- **Both on one line** — Invoice and CreditMemo on the same line. Unchanged: the
  line is the credit's application and never cash.
- **A line each** — an invoice line for the amount settled, beside a credit-memo
  line for the credit funding it. The invoice line's amount is split between
  cash and credit.

The split is only ever taken where arithmetic forces it:

| Payment | Rule |
| --- | --- |
| No credit-memo line | Every invoice line is cash. Unchanged. |
| One invoice line | The split is forced: that invoice takes each credit line's amount as a credit, and the cash is the invoice line less the credit funding it. |
| Several invoice lines | Each credit line must match exactly one unclaimed invoice line **of the same amount**. |

Everything else raises `QboMalformedResponse`: a credit line matching no invoice
line, a credit line matching two of them, more credit than the invoice line it
is said to have settled. A $100 credit against a $500 line and a $300 line is
genuinely ambiguous — apportioning it is the guess this package refuses to make
on a money field, the same refusal `readPaymentLines` already made for two
invoices on one line. That refusal now also covers two credit memos on one line,
which used to credit each of them the whole amount and so double the credit.

All of it is integer cents through `core-domain`'s `sumCents` / `subCents`
(invariant 3). There is no float arithmetic and no rounding.

### 3. The detector, the thresholds and the port are untouched

`detectShortPays` is not modified. `DEFAULT_MIN_DISPUTE_CENTS` and every
tolerance are not modified. `AccountingSource` gains no method and loses none.
The only thing that changed is which numbers reach the detector, which is why
this is a mapper ADR and not a detection one.

### 4. Invoice 71 becomes a fourth candidate, deliberately

`packages/qbo/test/settlement-window.test.ts` (ADR 0035) asserted three
short-pays over the full recording — invoices 67, 13 and 16. It now asserts
four, with invoice 71 named and its numbers spelled out: $205.00 total, $105.00
of cash, $100.00 of credit, a $100.00 gap, `gapStatus: 'credited'`.

The expectation was moved because it was **wrong**, not because it was in the
way. Invoice 71 was a written-off deduction in that ledger the whole time; the
mapper was hiding it. A fourth candidate appearing is the evidence the fix
works, and the test now says so in the numbers rather than in a count.

Under ADR 0035's production window (2026-08-19..2026-09-22) the count stays
three: payments 72 and 74 are dated 2026-08-04 and 2026-08-10, so neither is in
that window and invoice 71 is named by neither half of the composition. A
separate test widens the window to 2026-08-01 and asserts the fourth candidate
there, so the two facts are not confused with each other.

## Consequences

- A written-off short-pay settled by credit memo is now visible, which is the
  coverage thesis's own case (STRATEGY §5.4).
- A ledger holding a Payment shape neither rule covers now fails the sync loudly
  instead of under-reporting cash. That is the intended trade: a refused run is
  visible and a wrong recovery rate is not.
- The recorded fixtures keep their authority. `recorded-payment-query.json` is
  what Intuit actually sent and it is what the new tests are driven by;
  `payment-query.json` stays exactly as it was, and its shape stays covered, so
  the two can still be seen to disagree.
- No migration, no schema change, no new outbound side effect. Ledger sync runs
  recorded before this lands are not re-read; the next run reads the ledger
  correctly.

## Alternatives rejected

**Net the credit against the gap.** Would make invoice 71 vanish again, and is
the exact "correction" `short-pay.ts` warns about in prose. A credit memo
explains a gap; it does not close one.

**Apportion a credit across the invoice lines it might have settled.** A split
nobody can check, on a money path, in a packet that has to survive a post-audit
claim two years later. Refused for the same reason two invoices on one line are
refused.

**Trust `TotalAmt` alone and derive the applications from it.** It says what the
payment carried, not which invoice got it. On a multi-line payment that is the
whole question.

**Treat the two-line shape as malformed and refuse it.** It is what the sandbox
returns for a routine operation, so this would refuse most real ledgers.

# 0026 — QuickBooks is a read, behind the accounting port

- Status: accepted
- Date: 2026-09-21

## Context

`uploads.source` is constrained to `('web_upload', 'email_in')`. A deduction can
only enter the system if the supplier already knew about it and sent it to us,
and the whole coverage thesis is the ~70% they never surface (STRATEGY §5). The
customer's ledger is the first source that does not wait for the customer to
notice: *invoiced $100,000, received $92,000* is a discovery event we can
compute, and the same ledger is the coverage denominator — without it "recovery
rate" is a number with nothing underneath it.

The build order already moved for this. ERP **read** is Phase 1.5; ERP
write-back stays in Phase 4 behind the approval gate (STRATEGY §5.4). This ADR
covers the read half and deliberately nothing else.

Three facts about QuickBooks Online force the shape of the adapter.

**It is a new outbound call on a money path.** Every figure we read becomes a
dollar amount on a reviewer's screen and eventually an amount a contingency fee
is computed against. Invariant 3 does not stop applying because the number
arrived over HTTPS instead of off a page.

**QBO returns money as a JSON number.** `TotalAmt: 1234.5` has already been
through an IEEE-754 double before our code sees it. `Math.round(amount * 100)`
is the obvious conversion and it is the one that eventually bills someone the
wrong amount; `1234.565 * 100` is `123456.49999999999`.

**Intuit rotates the refresh token.** Access tokens last an hour. Refresh
tokens last about 100 days and are *replaced on every refresh* — the old one
dies the moment the new one is issued. A process that refreshes, uses the new
access token, crashes, and never persisted the new refresh token has stranded
the connection, and the only repair is going back to the customer for consent
again. That makes the order of two lines of code a customer-visible fact.

## Decision

### Read only, by construction

`packages/qbo` exposes exactly one class, `QboAccountingSource`, implementing
`AccountingSource` from `packages/adapters/src/accounting.ts`: `listInvoices`,
`listPayments`, `listCredits`. There is no write method, no "just for the
sandbox" write helper, and no method that takes a body. Write-back is Phase 4
and will arrive as a *different* port with the approval trigger between it and
QBO — not as a fourth method on this one. The port having no writer is the
enforcement; a reviewer can check it by reading the interface.

### The adapter maps; nothing above it learns the word "QBO"

`CustomerRef.value`, `DocNumber`, `TxnDate`, `LinkedTxn`, `Fault` and
`STARTPOSITION` stop at the package boundary. What leaves is `LedgerInvoice`,
`LedgerPayment`, `LedgerCredit` and `LedgerApplication`, each carrying
`sourceKind: 'qbo'` so a later NetSuite or Xero adapter is additive and
identity resolution (STRATEGY §5.2) can tell the sources apart. The port types
are the whole vocabulary: if a consumer needs a QBO field we do not map, the
fix is a new field on the port, not a cast.

A field the port declares required is required. `DocNumber`, `CustomerRef.name`
and `CurrencyRef.value` can in principle be absent from a QBO payload, and the
adapter then fails loudly naming the row rather than emitting
`invoiceNumber: ''` or `currency: ''` — a blank there reconciles against nothing
and nobody notices for a quarter. The same rule covers a payment line that links
two invoices to a single `Amount`: nothing in the response says how it split, so
it is refused rather than halved.

### Money is parsed, never multiplied

The JSON number is converted through a deterministic string path and then
through `core-domain`'s `parseMoneyToCents`, the same function that turns
`"$3,120.00"` off a scanned page into cents. The rule for a QBO amount is the
rule for a document amount: **we copy the value and our code does the
arithmetic**, and the only arithmetic here is base-10 digit shuffling.

An amount is accepted only if it round-trips: `Number(value.toFixed(2)) ===
value`. `1234.5` becomes `"1234.50"` becomes `123450` cents. `1234.567` does not
round-trip, so it is a `QboMalformedResponse` naming the field path — never a
rounded guess. A currency with other than two minor units would fail this check
loudly, which is the correct behaviour until someone decides what it should do.

### A fresh `Request-Id` on every request

Every call to QBO carries `Request-Id: <crypto.randomUUID()>`, generated per
request, never reused across a retry of a different call and never shared
between pages. Intuit treats `Request-Id` as the idempotency key; two different
reads sharing one may be answered from the first one's cached response. Reads
are the cheap place to get this habit right, because Phase 4's write-back is
where getting it wrong duplicates a credit memo in a customer's books.

### Tokens: refresh early, persist the rotation *before* using it

A `QboTokenStore` port (`load(realmId)` / `save(realmId, tokens)`) holds the
access token, the refresh token and both expiries. The adapter refreshes when
the access token is within **five minutes** of expiry rather than waiting for a
401, and the sequence is fixed:

1. POST the refresh to Intuit's token endpoint (HTTP Basic, client id/secret
   from constructor config).
2. `save()` the whole rotated set — **await it** — including the new refresh
   token.
3. Only then use the new access token for an API call.

Step 3 after step 2, always. Persisting after the call would open a window where
Intuit has rotated the token and we still hold the dead one.

The store is a port for the same reason credentials are not in an application
table: portal and ERP credentials belong in KMS-backed storage (CLAUDE.md). This
ADR **adds no migration and no table**. `InMemoryQboTokenStore` ships under the
package's `testing` export only, the way `@recouple/pipeline/testing` does, so
it cannot be reached from a production path. Client id and secret are
constructor config; the package never reads `process.env`, so a caller cannot
accidentally pick up another tenant's application credentials from ambient
environment.

### A failure is a typed error, never an empty list

An empty ledger and an unreadable ledger are different facts and must never
render the same. A customer with no deductions and a customer whose token
expired both produce "0 invoices" if errors are swallowed — the first is good
news and the second is an outage that looks like good news. So:

| Condition | Thrown |
| --- | --- |
| 401, or a refresh that fails | `QboAuthError` |
| 429 | `QboRateLimited`, carrying `retryAfterMs` |
| unreadable shape, or an amount that will not round-trip | `QboMalformedResponse`, carrying the field path |
| anything else | `QboRequestFailed`, carrying the status and Intuit's `Fault` |
| a window that is not two calendar days in `YYYY-MM-DD` | `QboInvalidWindow` |

The last one is not an API failure; it is a caller error, and it is checked
before a request is built because `LedgerWindow.from`/`.to` are interpolated
into QBO's query language between single quotes. An unvalidated date string
there is query injection into a customer's ledger, so it gets a type of its own
rather than being reported as something QuickBooks did.

Nothing in this package catches its own error and returns `[]`. "Do NOT swallow
errors. Fail loud" (CLAUDE.md) is not advice here; a swallowed error is a
silently under-reported coverage denominator.

### Credit applications are resolved from Payments, or left empty

QBO does not record a credit memo's application to an invoice on the
`CreditMemo`. It records it on the `Payment` that links both, as a line whose
`LinkedTxn.TxnType` is `CreditMemo`. So `listCredits` queries Payments over the
same window as well and fills `appliedTo` from those lines. A credit applied by
a payment outside the window cannot be resolved from this data, and gets
`appliedTo: []` — an honest "we do not know from here", never an inferred
application. Symmetrically, a Payment line linked to a `CreditMemo` is not an
invoice application and is excluded from that payment's `appliedTo`, so a credit
is never counted as cash.

### Cassettes: hand-written fixtures until there is a sandbox to record

There is no QBO sandbox wired up, and a test that reaches the network is a test
that fails at 3am for reasons that are not ours. `fetch` is injected
(`fetchImpl`, defaulting to the global), and the tests inject a fake that serves
JSON fixtures written by hand from Intuit's documented response shapes, checked
in under `packages/qbo/test/fixtures/`. The fixtures cover every mapped field,
pagination, the money round-trip and its rejection, each typed error, and the
credit-application resolution.

When a sandbox exists, the policy is the repository's existing one: record a
real response, redact the realm id and any token, and commit it beside the
hand-written one rather than replacing it — a hand-written fixture asserts what
we think the contract is, and a recorded one asserts what Intuit actually sent.
These are HTTP fixtures, not model cassettes: `pnpm record:cassettes` does not
touch them and they do not enter the eval baseline.

## Consequences

Phase 1.5 gets its discovery source, and NetSuite and Xero become a second and
third file rather than a refactor, because `AccountingSource` is the only thing
the rest of the system sees.

Nothing consumes this yet. Reconciliation — matching a short-paid invoice to a
payment and a deduction, and the identity resolution across ERP, EDI and portal
that STRATEGY §5.2 calls the hard part — is separate work. This ADR ships the
read and stops there, which means the package is unreferenced until that lands.
That is deliberate: a port with one implementation and no consumer is reviewable
in a way that a port, an implementation and a reconciler landing together are
not.

We take on OAuth2 operationally: a customer's connection can expire, be revoked
in Intuit's UI, or be stranded by a crash between refresh and persist. The first
two surface as `QboAuthError`. The third is what the save-before-use ordering
exists to prevent, and it is untested against a real Intuit rotation — nothing
here has met the live endpoint.

Pagination is `STARTPOSITION`/`MAXRESULTS` at 1000 per page, so a year of a busy
ledger is tens of round trips. Windows are inclusive on both ends, so a caller
walking month by month will see a transaction dated on a boundary twice;
deduplication by `externalId` is the caller's job and identity resolution's
problem, not something this adapter guesses at.

## Invariants touched

**3 (money is integer cents).** Every amount crossing out of this package is
`Cents`, produced by `parseMoneyToCents` from a round-tripped 2-decimal string.
Enforced by `qboAmountToCents` in `packages/qbo/src/money.ts`, by `cents()`
rejecting non-integers in `core-domain`, and by the unit and `fast-check`
property tests in `packages/qbo/test/money.test.ts`.

**6 (RLS everywhere; the service role never in a request path).** Untouched, and
deliberately so: this package holds no database handle, imports nothing from
`@recouple/store-postgres`, and adds no table. Whatever persists ledger rows
later does it through `PostgresStore` as `app_rw` like everything else.

**1, 2, 4, 5, 7.** Not touched. Nothing here writes a submission, appends to an
append-only table, reads a document, calls a model, or moves a threshold. In
particular the credentials in play are the *application's* Intuit client id and
secret plus the tenant's tokens, and none of them go in an application table
(CLAUDE.md's portal-credentials rule) — a KMS-backed `QboTokenStore` is a later
task, and until it exists the only shipped implementation is in-memory and
test-only.

## Rollback

Delete `packages/qbo` and remove `export * from './accounting'` from
`packages/adapters/src/index.ts`. Nothing imports either — no migration, no
table, no environment variable and no deployed surface to unwind. If instead the
*port* is wrong, that is a new ADR and a change to `accounting.ts`; the adapter
follows it.

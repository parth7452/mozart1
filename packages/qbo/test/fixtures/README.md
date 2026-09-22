# QBO response fixtures

Hand-written from Intuit's documented response shapes for
`GET /v3/company/{realmId}/query` and the OAuth2 token endpoint. There is no
sandbox wired up here and no test in this package touches a network: `fetch` is
injected and these files are what it serves (ADR 0026).

The company in them is one manufacturer selling through two broadline
distributors, and the numbers are internally consistent on purpose — invoice
`145` is $3,120.00 and is closed out by $1,850.00 of cash plus a $1,270.00
credit memo — so a fixture that drifts shows up as arithmetic that no longer
adds up rather than as a test that still passes.

| File | What it is |
| --- | --- |
| `invoice-page-1.json` | Two invoices, `MAXRESULTS 2` — a full page, so a second is fetched |
| `invoice-page-2.json` | Two more, also full |
| `invoice-page-3.json` | `QueryResponse: {}` — how QBO says "nothing further" |
| `invoice-three-decimals.json` | One invoice whose `TotalAmt` is `1234.567`: the amount that must be refused, not rounded |
| `payment-query.json` | Cash applied to two invoices, a zero-dollar payment applying a credit memo **on one line with the invoice**, and a payment whose line also links a Deposit |
| `creditmemo-query.json` | One credit resolved through `payment-query.json`, one with no payment in the window |
| `token-refresh.json` | Intuit's refresh response, including the **rotated** `refresh_token` |
| `fault-authentication.json` | The 401 body |
| `fault-throttled.json` | The 429 body |
| `fault-validation.json` | A 400 body, for the "anything else" error |

When a sandbox exists, record a real response, redact the realm id and any
token, and commit it *beside* the hand-written one: a hand-written fixture
asserts what we think the contract is, a recorded one asserts what Intuit
actually sent, and it is worth being able to see the two disagree. These are
HTTP fixtures, not model cassettes — `pnpm record:cassettes` does not touch them
and they are not part of the eval baseline.

The two have already disagreed once, which is the argument for keeping both.
`payment-query.json` puts a credit memo and its invoice on **one** Payment line;
`recorded-payment-query.json` shows QuickBooks writing the same operation as
**two** lines — payment 74 is `TotalAmt: 0` with a $100 line naming Invoice 71
and a $100 line naming CreditMemo 73. The mapper read only the hand-written
shape, so it counted that $100 as cash and invoice 71 read as paid in full when
$100 of it had been written off (ADR 0036). Both shapes are covered now, and
`credit-versus-cash.test.ts` is driven by the recorded one.

`pnpm qbo:verify --record` is what does the recording, against a real sandbox
from a laptop (`packages/qbo/scripts/verify-sandbox.mts`). It writes
`recorded-<entity>-query.json` and `recorded-token-refresh.json`, so a recorded
file never lands on a hand-written one, and it replaces the realm id, the client
id and every token with `__REDACTED__` first. A response body it has already
saved under that name is not saved twice — the Payment query runs twice per run,
once for the payments and once to resolve what each credit memo was applied to —
and a genuine second page becomes `recorded-<entity>-query-2.json`. Commit a
recorded fixture only if it came from a real Intuit sandbox: one produced
against a fake serves the hand-written file's purpose while claiming the
recorded file's authority.

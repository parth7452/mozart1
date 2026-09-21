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
| `payment-query.json` | Cash applied to two invoices, a zero-dollar payment applying a credit memo, and a payment whose line also links a Deposit |
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

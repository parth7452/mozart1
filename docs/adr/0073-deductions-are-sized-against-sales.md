# 0073 — Deductions are sized against sales, read through and not stored

- Status: **proposed**
- Date: 2026-10-07
- Extends: ADR 0066 (the books are read through), whose rules this follows
  unchanged
- Adds: one read on the `AccountingSource` port (`profitAndLoss(window)`), one
  report on `QboClient.report` (`ProfitAndLoss`), one pure function in
  `core-domain` (`deductionsSizing`), one card on `/books`. No table, no
  column, no grant, no migration, no new environment variable, no outbound
  write.

## Context

At onboarding the first question a manufacturer asks of a deductions tool is
how much money is at stake. Before a single case exists, the answer is in
their own books: how much revenue was reduced by deductions, or booked as an
expense, over the last year, beside how much they sold. The Books page (ADR
0066) already reads the chart and today's balances live; it did not read the
income statement, so the one figure that sizes the recovery opportunity had to
be worked out by hand from QuickBooks.

## Decision

### 1. The read

`AccountingSource` gains `profitAndLoss(window)`, returning `ProfitAndLoss`
(`core-domain/src/sizing.ts`): one line per account the report printed, its
top-level section verbatim, and its amount in integer cents in the section's
natural sign. For QuickBooks it is `GET /reports/ProfitAndLoss` with
`start_date`, `end_date` and `summarize_column_by=Total`; `accounting_method`
is not sent, so QuickBooks answers in the company's own basis and says which.

It follows ADR 0066 §1 to the letter. A window past `SIZING_WINDOW_DAYS` (365)
is `QboInvalidWindow` before a request. The envelope is validated with zod; a
report carrying Intuit's cut-short sentence is `QboReportTooLarge`; an empty
report is returned only on its own `NoReportData`. Money goes through
`parseMoneyToCents`. The report must carry exactly an account column and one
money column keyed `total`: a multicurrency company's home-currency column or
a month-by-month split is refused by that key's name, never read as the
year's total. A refusal names a structural path and never a figure or a name
from the books.

**Every total the report prints is checked, to the cent.** The five data
sections (`Income`, `COGS`, `Expenses`, `OtherIncome`, `OtherExpenses`) and
every nested parent-account section must equal the lines read beneath them.
The four computed rows are checked against the arithmetic QuickBooks
documents: Gross Profit = Income − COGS; Net Operating Income = Gross Profit −
Expenses; Net Other Income = Other Income − Other Expenses; Net Income = Net
Operating Income + Net Other Income. None of them is ever a line. A top-level
section of a group not in those nine is refused rather than skipped, because
a skipped section is a silently missing number.

### 2. The formula

Over the trailing year ending today (UTC; `today − 364` to `today`),
`deductionsSizing` joins each line to the chart by account id and reads the
chart's `classification`:

- **Gross sales** — Revenue accounts that do not look like deductions,
  printed in the report's `Income` section only.
- **Other income (not counted as sales)** — the same accounts printed
  anywhere else, `OtherIncome` above all: interest, a gain on an asset sale.
  Shown as its own figure and never in the rate, because counting it would
  inflate the denominator and understate the deduction rate.
- **Deductions against revenue** — Revenue accounts that do, wherever they
  are printed (contra-revenue, usually negative, shown as "reduced revenue
  by").
- **Deductions as expense** — Expense accounts that do.
- **Rate** — `(|against revenue| + |as expense|) × 10,000 ÷ gross sales` in
  basis points, exact in BigInt, rounded half up once; no rate at all when
  gross sales are zero or less.

A line with no account id, an id not in the chart, or an account of another
classification is listed on the card as unmatched and counted in no figure.
Today's balances come from the chart's own `CurrentBalance`: the accounts
receivable (a total only when every one reported a balance), Undeposited
Funds, and every balance-sheet account that looks like deductions or that
the account map posts to (its Deductions Receivable). An account with no
balance reported is "not reported", never zero.

### 3. The heuristic is the page's own

Which accounts are deductions is `looksLikeDeductionsAccount`, the same guess
the chart and the ledger are marked by, written out on the page, with
`booksAccountRoles`' rule that a receivable is never one. Nothing new is
guessed.

### 4. Nothing stored

The card is a pure function of two reads made in the request. A failed
profit-and-loss read costs the card and nothing else, shown as the page's
fixed sentence for its error class and logged by class, status and path; the
profit and loss is asked only when the chart it is joined to was read. A
`read_only` member's reads go through `withoutRefresh`, as for every other
read on the page.

## What is not done

- **No fiscal year.** The window is the trailing 365 days, not the company's
  fiscal year, which QuickBooks knows (`CompanyInfo`) and this adapter does not
  read yet — ADR 0066 §5's gap, unchanged.
- **Contra accounts are identified by heuristic.** A deductions account named
  nothing the list knows is counted as sales, and a sales account whose name
  contains one of the words is counted as a deduction. The words are on the
  page; a person-confirmed map of them is a later decision.
- **A sale is decided by the section it is printed in.** A sale is a
  Revenue line under `Income`; a company that books sales under other income
  will read as smaller than it is, and the card shows that figure beside it.
- **No real company has been read.** The fixture is hand-written from
  Intuit's documented shape; the first recording should be committed beside
  it, as for the other two reports.

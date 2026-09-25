# Real documents from public records

Twenty PDFs from [ExtractBench](https://github.com/run-llama/ExtractBench)
(dataset [`llamaindex/ExtractBench`](https://huggingface.co/datasets/llamaindex/ExtractBench),
revision `f6180e917a050a84582e6366cff85b7dc1e84e58`), used under the Apache
License 2.0 (`LICENSE-ExtractBench.txt`). ExtractBench is built from publicly
available records, and its authors verified an answer for each document. These
are the only fixtures here that nobody wrote: every other suite is synthetic.

`scripts/import-extractbench.py` wrote everything in this folder: the PDFs,
`pages.json` (each page's text layer and where the document came from) and
`truth.json` (the ground truth, plus every field left out and why). Run it again
on the same revision and it writes the same files.

## Changes from the source

- Files are renamed (`eb-…`), and the two Mississippi Medicaid documents keep
  only their remittance-advice pages: 4 of 4, and 5–6 of 6. The rest of each is
  the state's provider billing handbook explaining the advice's fields — a
  manual, not a remittance. Their degraded copies keep the same pages.
- The two Hingham scans are stored without their `/OpenAction`, the
  instruction a viewer follows when the file opens. Ours points at a page, but
  the upload door refuses the key whatever it points at, so as published
  neither scan can be uploaded. The script removes the door's keys from any
  dictionary that carries them and records what it removed in `pages.json`
  (`flattened`); these two are the only files it changed.
- Nothing else is altered.

## The two suites

| Suite | Documents | Read how |
| --- | --- | --- |
| `public` | 10: two Medicaid remittance advices, four municipal invoices, two county and state purchase orders, two public rate schedules | Each PDF's own text layer, like every other text-PDF suite |
| `public_scanned` | 10: four scanned invoices, and ExtractBench's degraded capture of six documents from `public` | Through OCR, as production reads every upload, so recording needs `REDUCTO_API_KEY` |

Production OCRs every uploaded PDF through Reducto, text layer or not. `public`
instead reads each PDF's embedded text layer, as `authored`, `held_out`,
`dense` and `formats` do. That is how a text PDF has always been measured here.
It is also a difference from production, stated here rather than assumed away.

Left out, with reasons:

- ExtractBench's two California Medi-Cal documents are manual pages showing an
  image of a sample remittance advice: a manual, whatever the image shows.
- A county requisition form is an internal request to its purchasing office,
  not an order sent to a vendor, and its other pages are a bid tabulation.
- A 113-row Indian-rupee price list has no field their answer and ours share.
  Reading it would run near our 32,000-token output budget, for nothing to
  score.
- Receipts, utility bills and everything outside deductions (tax forms,
  securities filings, energy permits).

## How their answer becomes our ground truth

Each rule is mechanical, in the script, and fixed before anything was recorded.
A value is only ever theirs. On a page with its own text, it is also checked
against that text, and left out if it is not there.

| Our type | Our field ← their field |
| --- | --- |
| `invoice` | `invoice_number` ← `invoice_number`; `invoice_date` ← `date`; `po_number` ← `purchase_order_number`; `customer_name` ← `customer.name`; `invoice_total` ← `total_amount`; per line, in their order: `qty` ← `quantity`, `unit_cost` ← `unit_price`, `extended_amount` ← `amount` |
| `po` | `po_number`, `po_date`, `buyer_name` ← `buyer.name`; per line: `qty_ordered` ← `quantity`, `unit_cost` ← `unit_price` |
| `remittance_advice` | `payer_name` ← the payments' one payer; with exactly one payment, `payment_reference` ← `check_number`, `payment_date` ← `ra_date`, `payment_total` ← `check_amount`; per claim, in their order: `gross_amount` ← `total_submitted`, `net_amount` ← `total_paid`, `reason_code` ← `reason_codes` |
| `price_agreement` | `effective_from` ← the date inside `effective_period`, when it names one |

- **Dates.** ExtractBench stores dates as ISO values. Our scorer compares a date
  as printed. So the ground truth is the page's own spelling of their date,
  kept only when the page prints it in exactly one spelling. A scan with no
  text of its own gets no date. The spellings looked for are every month-first
  one: numbers with `/`, `-` or `.`, two- or four-digit years, and month names
  in full or short. The first import looked for fewer, missed Stephenville's
  `01-May-24` in the invoice's header and kept `05/01/2024`, which is the lines'
  tax date. The recording scored the model's `01-May-24` as wrong. The rule now
  drops that date, as it always said it would. That is the one change made
  after anything was recorded, and it was made to the spelling list, not to
  an answer.
- **Amounts** are their numbers in integer cents, negative where they are
  (a Medicaid credit prints `-80.00`).
- **Not mapped:**
  - an item identifier, because their `item_code` is often empty and a
    description is not an identifier;
  - a claim number as an invoice number, because which of a claim's numbers
    plays the invoice is our question, not theirs;
  - a remittance's short-pay amount, because they record the patient's share,
    not the fee reduction;
  - an agreement's counterparty and terms, because their rate items are not
    our terms.
- **Lines are matched by position.** Their order is the page's, and so is ours.
  A reader that splits or merges a line misses every line after it. That is a
  real cost, and it is measured.
- **Scale.** Stephenville's 37-line invoice carries 114 of the `public` suite's
  193 truth fields. Its line alignment therefore moves the suite's recall more
  than any other document. Read the per-document rows, not only the subtotal.

## First recording (2026-09-25)

`public`, read through each PDF's own text layer: 97.9% recall and precision,
98.9% of quotes found on the page, and 10 of 10 classified as the type we
expected. It cost $0.54. The four misses:

- **Both Medicaid advices** name the payer `DIVISION OF MEDICAID`. ExtractBench
  says `MISSISSIPPI ENVISION MMIS`, the claims system printed above it. Both are
  on the page, and the division is arguably the payer. Their answer stands.
- **Oklahoma County's purchase order** names the buyer
  `OK CO EMERGENCY MANAGEMENT`, the department that ordered, where their answer
  is the county. Their answer stands.
- **The same order's unit price** is printed `$6,721.8000`, and
  `parseMoneyToCents` refuses four decimal places. The value is right and our
  parser cannot read it. That is a product gap, not a reading error: unit
  prices on purchase orders and price lists are often printed this way.
  **Closed the same day**: the parser now reads digits past the cents when
  they are all `0`, so the price is 672,180 cents on both the clean and the
  degraded copy. `public` rose to 98.4% and `public_scanned` to 95.5%. A unit
  price that is a true fraction of a cent (`$0.0125`) is now stored rounded
  half-up to the cent and checked at the digits printed (ADR 0049).

Two quotes on the Southampton invoice were not found on the page because its
file stores `$4,191.50 Invoice Total:`, value before label, while the page
shows the label first. Both values are right. The check is right to refuse a
quote the text layer does not contain.

`public_scanned`, read through Reducto's OCR as production reads every upload,
was recorded the same morning for $0.31: 93.9% recall and precision, and 10 of
10 classified. Its misses are the same payer, buyer and unit price as the clean
twins, plus Hingham's customer: `Town of Hingham - Zoning Dept.`, where their
answer is `HINGHAM-ZONING DEPT.`

79.7% of its quotes were found on the page. This number is why the suite is
worth having. Nearly every value is right, and the gaps are in checking them:

- **Grainger's scan** cites page 2 of a one-page file for all nine fields, so
  none can be checked, though all nine values are right. Asked three more
  times, with nothing kept, its quotes failed the check twice more. A quote
  that names a page the file does not have could be looked for on the pages it
  does have.
- **Texas and Illinois** quote whole table rows (`2  EACH  $448.00 …`).
  Reducto writes a table as HTML cells, so a row is not in the text as written,
  though every cell in it is.
- **OCR misreads.** Illinois prints `Sedan – compact` with a dash that OCR read
  as a hyphen, and Oklahoma's degraded unit price came out `$6;721:8000`.
  Refusing these is right: the text layer disagrees with the page.

## What these documents are

Real, public, and mostly government. The invoices were sent to towns and
counties, the purchase orders were issued by them, and the rate schedules were
published by them. The Medicaid advices are sample pages a state printed for its
providers, with placeholder names ("NANCY BENEFICIARY").

None of it is a food manufacturer's deduction, and none is a customer's
document. Real customer documents would still be worth more than all of it.

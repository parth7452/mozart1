# Recouple ledger export, format 1

The file an ERP sends us so we can read a customer's receivables without an
API connection (ADR 0075). Any ERP can produce it with one saved query. This
document is the contract. The SAP Business One query that produces it is in
`sap-business-one.md`.

## What the file is

- One file per export: CSV (preferred) or XLSX with one sheet.
- CSV is UTF-8, comma-separated, RFC 4180 quoting (a field containing a comma,
  quote or line break is wrapped in double quotes, and a quote inside is
  doubled).
- One header row, with exactly the column names below, lowercase, in this
  order. A missing or extra column refuses the file.
- An empty field is empty. Never write `NULL`, `N/A` or `0` for "no value".

## What it must contain

The export covers a **window**, normally the 45 days ending on the day it runs.
It must contain:

1. **Every A/R invoice** that was issued in the window, or that anything in
   the window was applied to: a payment, a credit memo, a reconciliation or a
   journal entry.
2. **Everything ever applied to those invoices, whatever its date**: every
   payment, credit memo, reconciliation and journal entry, including ones
   dated years before the window.

The second rule is the important one. If an invoice was paid partly in March
and partly in May, a May export must still carry the March payment. Without
it, the invoice looks short-paid when it is not. Our reader checks this on
every invoice (see "Checks we run") and refuses the whole file if any invoice
does not add up.

Cancelled documents, and the documents that cancel them, are left out.

## Columns

Every row has all 23 columns. Which ones a row fills depends on its
`record_type`.

| # | Column | Meaning |
| --- | --- | --- |
| 1 | `format` | Always `1` |
| 2 | `source_system` | Which ERP, fixed per installation, e.g. `SAP_B1` |
| 3 | `company` | The ERP's name for the company database, fixed per installation |
| 4 | `window_from` | First day of the window, `YYYY-MM-DD` |
| 5 | `window_to` | Last day of the window, `YYYY-MM-DD` |
| 6 | `record_type` | One of the record types below |
| 7 | `id` | The ERP's internal key for this record, unique within its record type |
| 8 | `number` | The document number people see |
| 9 | `date` | The document's date, `YYYY-MM-DD` |
| 10 | `due_date` | Invoices only |
| 11 | `customer_id` | The ERP's customer code |
| 12 | `customer_name` | The customer's name as the ERP has it |
| 13 | `currency` | ISO 4217, e.g. `USD` |
| 14 | `amount` | See each record type |
| 15 | `paid_to_date` | Invoices only: everything applied so far, cash and credits |
| 16 | `on_account` | Payments only: cash received that was not applied to any document |
| 17 | `discount` | Payment lines only: cash discount taken on that line |
| 18 | `parent_id` | Lines only: the `id` of the payment or reconciliation the line belongs to |
| 19 | `target_kind` | Lines only: `INVOICE`, `CREDIT_MEMO` or `JOURNAL_ENTRY` |
| 20 | `target_id` | Lines only: the `id` of the document the line applies to |
| 21 | `kind` | Reconciliation lines only: `D` or `C`, the side of the reconciliation |
| 22 | `reference` | Free text: customer PO, check or remittance number, reconciliation type |
| 23 | `memo` | Free text, as the ERP has it |

### Record types

| `record_type` | One row per | Fills | `amount` is |
| --- | --- | --- | --- |
| `INVOICE` | A/R invoice | `id`, `number`, `date`, `due_date`, customer, `currency`, `amount`, `paid_to_date`, `reference` | the invoice total |
| `PAYMENT` | incoming payment | `id`, `number`, `date`, customer, `currency`, `amount`, `on_account`, `reference`, `memo` | the cash received |
| `PAYMENT_LINE` | document a payment was applied to | `id`, `parent_id`, `target_kind`, `target_id`, `amount`, `discount` | the cash applied to that document, not counting `discount`; always positive |
| `CREDIT_MEMO` | A/R credit memo | `id`, `number`, `date`, customer, `currency`, `amount`, `reference`, `memo` | the credit memo total |
| `JOURNAL_ENTRY` | journal entry reconciled to an invoice | `id`, `number`, `date`, `reference`, `memo` | empty |
| `RECON_LINE` | row of a reconciliation that is not a payment's own | `id`, `parent_id`, `date`, `customer_id`, `target_kind`, `target_id`, `amount`, `kind`, `reference` | the amount reconciled on that row; always positive |
| `CONTROL` | the whole file, exactly one row, anywhere | `number`, `amount` | the sum of `amount` over every other row; `number` is the count of every other row |

A credit memo netted inside a payment is a `PAYMENT_LINE` with `target_kind`
`CREDIT_MEMO` and a positive `amount`; the kind says it reduces the cash. A
payment's own reconciliation is not exported as `RECON_LINE`s, because its
`PAYMENT_LINE`s already say the same thing.

## Values

- **Amounts** are digits with an optional leading `-` and an optional decimal
  point: `1500.00`, `1500`, `1500.000000`, `-80.00`. No currency symbol, no
  thousands separator, no parentheses for negatives. Digits past the cents are
  fine when they are all zero. A fraction of a cent (`0.0125`) refuses the
  file, because we never round money.
- **Dates** are `YYYY-MM-DD` and nothing else.
- **Ids** are stable: the same invoice has the same `id` in every export.

## Checks we run on every file

The file is refused whole, and a person is told which rows and ids, if any of
these fails:

1. Exactly one `CONTROL` row, and its count and sum equal the other rows'.
2. Every amount and date reads as above, and there is one currency.
3. Every line's `parent_id` names a payment or reconciliation in the file.
   Every `CREDIT_MEMO` or `JOURNAL_ENTRY` a line targets is in the file. (An
   `INVOICE` a payment line targets may be absent: a payment can pay invoices
   outside the window.) A `target_kind` other than the three above refuses
   the file.
4. **Each payment balances:** `amount` = its lines to `INVOICE` − its lines to
   `CREDIT_MEMO` + `on_account`.
5. **Each invoice ties:** its `paid_to_date` = the `amount` plus `discount` of
   every payment line to it + the `amount` of every invoice-side `RECON_LINE`
   on it.

The first file is also shown to an owner, who confirms it is their company's
ledger before anything is read automatically (ADR 0075 §4).

## Changes to this format

A new column or record type is a new format number, and the old one keeps
working until every sender has moved.

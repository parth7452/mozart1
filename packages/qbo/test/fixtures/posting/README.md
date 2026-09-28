# Posting fixtures (synthetic)

Hand-written for ADR 0060's write methods and ADR 0063's account create,
**not recorded**: no sandbox call made them. Each is the shape Intuit documents
for a create or read response. The sandbox run is what will settle whether the
real responses match.

| File | What it is |
| --- | --- |
| `journalentry-created.json` | A JournalEntry echoed back: Dr 4001 / Cr 1100, $1,270.00, customer 58 |
| `payment-zero.json` | Our zero Payment read back: $1,270.00 to Invoice 145 and to JournalEntry 901 |
| `account-created.json` | Setup's Deductions Receivable as `POST /account` echoes it and `GET /account/4001` reads it: Other Current Asset, active, top-level — the 4001 the entry above debits |

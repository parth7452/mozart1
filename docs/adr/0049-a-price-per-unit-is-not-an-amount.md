# 0049 — A price per unit is not an amount

- Status: accepted (the founder, 2026-09-25). Proposed the same morning with
  micro-dollar storage (option C below). The founder chose cents instead, and
  that choice is what was built.
- Date: 2026-09-25

## Context

`parseMoneyToCents` is the one money parser (invariant 3). Until 2026-09-25 it
read two decimal places or none. The `public` suite found the first real
document it could not read: Oklahoma County's purchase order prints a unit price
of `$6,721.8000`. That one is now read. Digits past the cents are accepted when
every one of them is `0`, so the amount is exactly what the first two digits
say and nothing is rounded (`centsOfFraction` in
`packages/core-domain/src/money.ts`).

That still refused any price that really is a fraction of a cent: `$0.0125` per
pound, `$3.4590` per gallon, `$1.2345` per case. Integer cents cannot hold
those without rounding, and rounding is a money decision.

### Where a unit price is read

Only `reconcile.ts` reads one, from the `unit_cost` of a deduction notice's
lines and of a PO's lines. It is read in three checks:

1. **The shortage arithmetic**: `(invoiced − received) × unit_cost`, compared
   with the amount deducted (`line_arithmetic_differs`).
2. **The quantities check**: the amount ÷ the unit cost as a count of units,
   compared with the quantity gap (`quantities_contradict_the_amount`).
3. **Notice against PO**: the price the deduction used, compared with the price
   the PO agreed (`unit_cost_differs_from_po`).

A price the parser refused became a **blocking** `unparseable_amount` finding on
its line, and none of the three checks ran. No table stores a unit price in
cents: extraction stores the text as printed, with its quote.

### Why it matters for the beachhead

Deviated-pricing billbacks are decided by unit prices: list price minus deal
price, times cases. This is the foodservice beachhead in `CLAUDE.md`, and those
prices are routinely printed to three or four places.

## Options

**A. Keep refusing.** Every sub-cent line blocks and waits for a person.

**B. Round the unit price to the cent and use the rounded price everywhere.**
Rejected. It multiplies the rounding by every unit. At 10,000 lb, `$0.0125` is
$125.00, but $100.00 at `$0.01`. A correct line would then read as a $25
over-deduction and a blocking contradiction of its own quantities.

**C. Hold a unit price as integer micro-dollars.** This was the proposal. The
founder declined it: a price is stored to the cent.

**D. Store the price rounded to the cent, but do every check at the printed
price.** The founder's decision.

## Decision

1. **A unit price is stored to the cent, rounded half up.** `$0.0125` is stored
   as $0.01, `$0.0150` as $0.02 and `$0.0199` as $0.02. Half up is the
   founder's choice, and it is the rule `applyBps` already uses (away from
   zero). `parseUnitPrice` returns `cents`, and `rounded` says whether rounding
   changed it.

2. **Every check uses the printed price, rounded once.** `parseUnitPrice` also
   keeps the page's own digits (`units`, `places`) while a line is checked; they
   are never stored.
   - `shortageCentsAt` multiplies at the printed price in `BigInt` and rounds
     only the total, once, half up (`extendedCents`). So 10,000 lb at `$0.0125`
     is $125.00, identical to the page. 3 lb is $0.0375 exactly, so $0.04.
   - The quantities check divides at the printed price (`unitsAtPrice`). A line
     whose amount is exactly the gap, priced and rounded once, is never a
     contradiction, even when the rounded amount also divides into a different
     count: one unit at `$0.0050` rounds to 1 cent, and 1 cent is also two
     units.
   - Notice against PO compares the two printed prices exactly
     (`compareUnitPrices`). `$0.0125` against `$0.0130` is a difference, though
     both are stored as $0.01, and that difference is what a billback turns on.
   - Every message prints the price as the page did (`formatUnitPrice`):
     `$0.0125`, never `$0.01`.

3. **Identical to the cent, strictly.** A payer's printed amount matches when it
   equals our half-up total to the cent. A payer who truncates reads one cent
   under, which is a warning. One who rounds up reads one cent over, which is a
   one-cent `supports_dispute`. That is a true statement about the page, and a
   reviewer decides whether a cent is worth disputing.

4. **Amounts stay strict.** Only `unit_cost` is read this way. A deduction, a
   total, a gross or a net printed with a digit past the cent that is not `0`
   is still refused, because rounding an amount changes money that moves.
   `parseMoneyToCents` and `parseUnitPrice` share `readPrinted`, so the two
   agree on every other rule.

5. **What is still refused.** A unit price printed to one place (`$6,721.8`),
   because a quote cut short of two places reads that way. Three places, with
   or without a comma before them (`$1.250`, `$3.459`, `$1,500.000`), exactly
   as for an amount: three digits after a point could be a thousands group, so
   `$1.250` could be a price of $1,250, and `$1,500.000` is likelier
   `$1,500,000` with its last comma misread. Four places (`$1.2500`,
   `$3.4590`) are read. A refused price
   is a blocking finding for a person, as before.

6. **Nothing billable changes.** The contingency fee is computed on recovered
   cents (`feeCents`), which is money that moved, never on a unit price.

## Consequences

- No migration, no schema change, no stored value changes: extraction still
  stores the price as printed.
- The eval's `money_cents` scoring of `unit_cost` stays exact: a `$0.01` read off
  a `$0.0125` page is still wrong. No recorded document prints a sub-cent price,
  so no expectation moved. A sub-cent fixture, and an expectation kind that
  states the printed price, come with the first real document that has one.
  `scripts/import-extractbench.py` rounds half to even on floats (`cents()`); it
  must not be used for a sub-cent price until it reads prices exactly.
- ADR 0050 checks that the price a field reports is the one the page printed,
  digit for digit, before any of this arithmetic trusts it.

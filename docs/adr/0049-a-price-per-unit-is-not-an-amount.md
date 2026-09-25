# 0049 — A price per unit is not an amount

- Status: **proposed** — a draft for the founder, nothing built
- Date: 2026-09-25

## Context

`parseMoneyToCents` is the one money parser (invariant 3). Until 2026-09-25 it
read two decimal places or none. The `public` suite found the first real
document it could not read: Oklahoma County's purchase order prints a unit price
of `$6,721.8000`. That case is now read — digits past the cents are accepted when
every one of them is `0`, so the amount is exactly what the first two say, and
nothing is rounded (see `centsOfFraction` in `packages/core-domain/src/money.ts`).

What is still refused is a price that really is a fraction of a cent:
`$0.0125` per pound, `$3.4590` per gallon, `$1.2345` per case. Integer cents
cannot hold those without rounding, and rounding is a money decision, so the
parser refuses them. This ADR is about whether to keep refusing.

### Where a unit price is read today

Only `reconcile.ts` reads one, from three schemas (`unit_cost` on a deduction
notice's lines, a PO's lines and a price agreement's terms), and only in three
checks:

1. **The shortage arithmetic**: `(invoiced − received) × unit_cost` against the
   amount deducted (`line_arithmetic_differs`).
2. **The quantities check**: the amount ÷ the unit cost as a unit count against
   the quantity gap (`quantities_contradict_the_amount`).
3. **Notice against PO**: the price the deduction used against the price the PO
   agreed (`unit_cost_differs_from_po`).

A price the parser refuses becomes a **blocking** `unparseable_amount` finding
on that line, and none of the three checks runs. Nothing is lost or guessed: a
person sees the line and reads the price. No table stores a unit price in cents;
extraction stores the text as printed, with its quote.

### Why it matters for the beachhead

Deviated-pricing billbacks — the foodservice beachhead in `CLAUDE.md` — are
decided by unit prices: the billback per case is list price minus deal price,
times cases. Deal and list prices are routinely printed to three or four
places. Under the current rule, every such line is a blocking finding, and
check 3 (the one that says "the distributor billed back at the wrong deal
rate") can never run on them. That is manual work on exactly the claims we
want to automate. The corpus has no sub-cent price yet, so this has not been
measured.

## Options

**A. Keep refusing (the status quo).** No new code on a money path. The cost is
the one above: every sub-cent line blocks and waits for a person.

**B. Round the unit price to cents when it is parsed.** Rejected. At 10,000 lb,
`$0.0125` is $125.00. Rounded down to `$0.01` it is $100.00, and rounded up to
`$0.02` it is $200.00. A parser that rounds a rate multiplies its error by
every unit.

**C. Read a unit price as its own type: integer micro-dollars.** Recommended if
we do anything.

## Proposal (option C)

1. **A rate is not an amount.** Invariant 3 governs amounts: money that moves or
   is claimed (a deduction, a total, a recovery, a fee). All of those stay
   integer cents, unchanged. A price *per unit* is a rate, like a fee's basis
   points, and gets its own integer type: `UnitPriceMicros`, millionths of a
   dollar (`$0.0125` = 12,500). This is the clause the founder has to agree
   with. If it is agreed, the invariant's text in
   `packages/core-domain/src/invariants/` says so, which is the edit the hook
   guards until this ADR is accepted.

2. **Six places, then refuse.** `parseUnitPriceToMicros` accepts up to six
   decimal places, and more only when every extra digit is `0`, the same rule
   the cents parser now uses. It uses the same thousands-separator and sign
   rules and the same "three places could be a thousands group" refusal. Six
   covers every price we expect to see printed. A seventh non-zero digit is
   refused exactly as a third one is today.

3. **Only `unit_cost` fields.** The extraction schemas and the wire format do
   not change: a unit price is still the text as printed, with its quote.
   Only the three checks above change, to read `unit_cost` with the new parser.
   Every other money field keeps `parseMoneyToCents`.

4. **We check their rounding; we never do our own.** A unit price is only ever
   multiplied into an amount to *check* an amount printed on the page. The
   check computes `qty × price` exactly, in `BigInt` micro-dollars, and accepts
   the printed cents if they are that value rounded **either** down or up to
   the cent. It never produces a rounded amount that anything stores, bills or
   files. A payer that rounds half-up, half-even or truncates passes. One that
   is off by more than a cent does not. Check 3 compares two prices exactly,
   in micros, with no rounding at all.

5. **Nothing billable changes.** The contingency fee is computed on recovered
   cents (`feeCents`), which is money that moved, never on a unit price.
   `UnitPriceMicros` cannot be passed to `feeCents`, `shortageCents` or any
   `Cents` function: it is a different branded type, so the compiler refuses
   it.

6. **Tested like money.** Property tests: parse and format round-trip, exact
   multiplication against a `BigInt` reference, the floor-or-ceiling rule
   accepting exactly two candidates (one when the product is whole cents), and
   refusing everything `parseMoneyToCents` refuses except the sub-cent digits
   themselves. Eval scoring gets a `unit_price_micros` expectation kind, and a
   fixture — a deviated-pricing billback with a `$0.0125`-per-pound line —
   goes into the authored suite. It is recorded with `pnpm record:cassettes`,
   which costs money.

## What it does not do

- No migration and no append-only table change: no column stores a unit price.
- No new outbound side effect, and no threshold change.
- It does not round anything that is stored, billed or filed.

## Decision needed

Whether a price per unit may be held as integer micro-dollars rather than
integer cents (§1). If not, option A stands and sub-cent lines stay with a
person, which is safe and costs review time on billbacks. If yes, the rest of
this document is the build plan, with its own PR, tests and fixture.

# 0050 — An amount is verified only when the page prints it whole, to the cent

- Status: accepted (the founder, 2026-09-25: "make sure that all numbers are
  identical to the cent")
- Date: 2026-09-25

## Context

`checkQuote` answers one question: is the text the model quoted on the page it
cited? It never looked at the value the field reports. For a money field that
left three holes.

1. **A quote cut short verifies.** The match is a substring, so `$6,721` is found
   on a page that prints `$6,721.85`. The field's value, `$6,721`, reads as
   $6,721.00.
2. **A label verifies.** A quote of `Net payment` is on the page whatever amount
   sits beside it. Two recorded fields quote exactly that:
   `hl-case-02-remittance` `payment_total` ($17,100.00, quoted as "Net
   payment") and `eb-hingham-wbmason-invoice-scan` `invoice_total` (47.29,
   quoted as "Total Due:").
3. **A value the quote does not contain verifies.** Nothing compared them.

Before building, all 542 money fields in the 77 recorded cassettes were
measured. None truncates a longer number today, and no quote holds a different
number without also holding the value. The two label quotes are the only real
holes. Another 60 fields are a printed `-`, meaning a line with no deduction,
which is not an amount at all.

## Decision

A **money field** is one whose path ends in `unit_cost`, or whose leaf names an
`_amount` or a `_total`. `moneyKindOf` in `packages/extraction/src/amounts.ts`
defines it, and the pipeline's `isMoneyField` now reads the same rule. For a
money field, `checkQuote` also requires the amount itself:

1. **The quote prints it.** The quoted text contains a number equal to the value.
   A label with no number fails.
2. **The page prints it whole, where it was quoted.** A number on the page must
   overlap the quoted span and equal the value, read to its own ends: the
   longest run of digits, with a `.` or `,` counted only between two digits.
   `$6,721` is never read out of `$6,721.85`. The full stop in `$1,275.00.` is
   not part of the number, and neither is the last point of a dot leader:
   `Net payment....1,275.00` prints $1,275.00, not $275.00.
3. **It is identical to the cent.** An amount is compared as cents, so
   `$6,721.80` equals a printed `$6,721.8000` and nothing else. The sign counts:
   - a minus that touches the number, whether ASCII, `−` or a dash (`-$6.70`,
     `–6.70`);
   - a minus after the number that starts no other number (`6.70-`);
   - accounting parentheses in a pair;
   - `CR`/`DR`.

   The hyphen in `CB-203`, a range like `6.70-7.00` and a leader of dashes are
   not signs. A dash set apart from the number by a space (`Deduction - $500.00`,
   or an empty cell printed `-` beside an amount) is read both ways, because it
   is a separator as often as a minus: a value of either sign is on the page,
   as the quote check's own `LEADING_SIGN` reads it. *Amended 2026-09-25: this
   first read a spaced dash as a minus only, which marked a correctly read
   `$500.00` "amount not on page".* A page's sign is never dropped: a value without it is a different
   number. A unit price is
   compared at its printed digits (ADR 0049): `$0.01` read off a page printing
   `$0.0125` is refused, though both are stored as 1 cent.
4. **A number that cannot be read to the cent fails.** A value such as
   `$1,234.5` is refused, because nothing can show it is identical to what the
   page prints. A value with no digit at all (`-`) is not a number, and its text
   verdict stands.
5. **Matching after loosening.** When a quote matched only after punctuation was
   ignored or OCR glyphs were folded, its position in the page's own text is
   lost. The amount may then be anywhere on the cited page, but still printed
   whole and to the cent. At the OCR tier, a letter OCR confuses with a digit is
   read as that digit only where it touches a digit (`$6OO.OO` is $600.00), which
   is the same set of pairs the tier already folds.
6. **Unverifiable stays unverifiable.** With no text layer the answer is `null`,
   as before, and not `false`.

A field that fails any of these is `quoteVerified: false`, with
`amountPrintedWhole: false` and a reason naming the value. On the case page, a
refused money field's badge reads **amount not on page**, not "quote not
found", because the quote can be on the page while the amount is not. A pass
still reads "quote found". Only the verdict is stored, and a row read before
this decision passed without anyone looking for its amount, so the page cannot
claim an amount check it cannot see.

## Consequences

- **The eval.** It re-grades every recorded quote on replay, with no
  re-recording and no spend. Exactly the two label quotes change:
  - `held_out` grounding falls from 100% to 99.1%.
  - `public_scanned` grounding falls from 98.5% to 97.4%. It was 79.7% to
    78.6% when first measured; the quote checker's page and table fixes,
    merged the same afternoon, raised both figures and moved nothing else.
  - Nothing else moves: recall, precision and classification are unchanged,
    because they score values, not quotes.

  The baseline is re-recorded for those two numbers. The run passed without it,
  since both falls are inside the 2-point tolerance. It is recorded because a
  baseline that still reads 100% would be measuring the old definition.
- **Stored rows.** A new read writes the stricter verdict to
  `extraction_results.quote_verified`. Rows already stored keep theirs, because
  the table is append-only. No migration: `amountPrintedWhole` and its reason
  are not stored, only the verdict is. Storing the flag, so that a pass could
  say "amount found", would take a column and so a migration. That is a
  follow-up.
- **What it does not do.** Nothing in the product gated on `quoteVerified`
  before this, and nothing does now. A case still opens with the amount the
  notice or the remittance line printed. What changes is what the reviewer is
  told about that amount before approving, which invariant 1 requires of every
  filing. Holding a document for a person when the amount that would open its
  case is not printed whole is a further decision, not taken here.
- **Known limits.**
  - A quote spanning a whole row cannot say which column its number came from:
    in `2 EACH $448.00 … $896.00`, either amount would pass. It still has to be
    printed whole and to the cent.
  - An EDI 812 amount printed with its decimal point implied (`184250`) reads as
    $184,250.00. It verifies only a value of $184,250.00, never the $1,842.50 it
    stands for.
  - `locateQuote` still boxes a quote by substring, so a cut-short quote gets a
    box on the block that holds the longer number.

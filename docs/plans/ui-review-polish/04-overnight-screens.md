# Visual pass on the overnight screens (2026-10-04)

The retailer board (#142), document suggestions (#143) and Books (#145) merged
overnight without anyone seeing them in a browser. This is that look, at
1440 × 900 and 390 × 844, and the layout and wording fixes that came out of it.

Scope: `apps/web/app/globals.css` and component markup only. No number, order,
store read, route or behaviour changed; no client script was added.

## How it was rendered

No production, no preview project, no sign-in bypass.

- A scratch Postgres database migrated by `pnpm db:test`, with a workspace made
  by `docs/onboarding/create-workspace.sql` ("Harborline Foods LLC": an owner,
  an approver, an analyst; payers Sysco and US Foods).
- Fourteen cases and five documents on no case, every one written through the
  pipeline (`processUpload`, `openHeldDocument`) and `PostgresStore` as
  `app_rw` under a member's claims: synthetic text PDFs read by a table-driven
  classifier and extractor, then decided, assembled, approved, filed, closed or
  declined through the workflow store. No model, scanner, QuickBooks or email
  call was made.
- The views rendered to standalone HTML the way `scripts/render-web.sh` does
  (the components are pure functions of what the store returned), reading as
  the approver through RLS. `DATABASE_URL` was set for that one process only;
  the test-database guard applies to Vitest and `db:test`, not to the renderer.
- Books has no QuickBooks connection in that database, so it was rendered
  twice: its "no connection" state from the store, and populated through
  `booksFor` over `InMemoryAccountingSource` (the tests' source) with the
  workspace's real cases from `PostgresBooksStore.casesInWindow`.
- Chromium (Playwright) took the screenshots and checked every element for
  page-level horizontal overflow at both widths. None was found before or
  after.

All data is fictional. Screenshots are in
[`screenshots/2026-10-04/`](screenshots/2026-10-04/).

## Defects found and fixed

| # | Screen | Defect | Fix | Before | After |
| --- | --- | --- | --- | --- | --- |
| 1 | Board | "Due in 14 days or overdue" wraps to two lines, so that column's figure sat a line lower than the other five | Labels on one top line, figures on one bottom line, at every column count; a figure never breaks mid-amount | [desktop](screenshots/2026-10-04/board-collapsed-desktop-before.png) · [phone](screenshots/2026-10-04/board-collapsed-mobile-before.png) | [desktop](screenshots/2026-10-04/board-collapsed-desktop-after.png) · [phone](screenshots/2026-10-04/board-collapsed-mobile-after.png) |
| 2 | Board, a group open | "Oldest open case opened 0 days ago." | "Oldest open case opened today." (one day and more read as before) | [desktop](screenshots/2026-10-04/board-expanded-desktop-before.png) · [phone](screenshots/2026-10-04/board-expanded-mobile-before.png) | [desktop](screenshots/2026-10-04/board-expanded-desktop-after.png) · [phone](screenshots/2026-10-04/board-expanded-mobile-after.png) |
| 3 | Read, not on a case (phone) | Beside "or pick another case" the picker was squeezed until its own text was cut ("Choose a cas") | On a narrow card that line stands alone; picker and Attach share the next | [phone](screenshots/2026-10-04/unattached-suggestions-mobile-before.png) | [phone](screenshots/2026-10-04/unattached-suggestions-mobile-after.png) |
| 4 | Read, not on a case | "No open case was suggested for these." floated between its heading and the first row with uneven space (a more specific rule overrode the group's padding) | Padding set at the specificity that wins | [desktop](screenshots/2026-10-04/unattached-suggestions-desktop-before.png) | [desktop](screenshots/2026-10-04/unattached-suggestions-desktop-after.png) |
| 5 | Case page, "Or file a document that was already read" | Unstyled browser buttons; filename, type and date wrapped unpredictably; the suggestion began a line with a stray "·" | Name, then type and date, then what agreed, stacked on the left; the card's own button on the right; the suggested document's button slightly stronger | [desktop](screenshots/2026-10-04/case-suggestion-desktop-before.png) · [phone](screenshots/2026-10-04/case-suggestion-mobile-before.png) | [desktop](screenshots/2026-10-04/case-suggestion-desktop-after.png) · [phone](screenshots/2026-10-04/case-suggestion-mobile-after.png) |
| 6 | Books, window | From and To each a full-width row above the button | Two dates and the button on one row; they wrap on a phone | [desktop](screenshots/2026-10-04/books-desktop-before.png) | [desktop](screenshots/2026-10-04/books-desktop-after.png) |
| 7 | Books, trial balance (phone) | The case table's 720px minimum pushed Debit, Credit and both totals off the screen | Three columns fit a phone: no minimum width, tighter cells, account names wrap | [phone](screenshots/2026-10-04/books-mobile-before.png) | [phone](screenshots/2026-10-04/books-mobile-after.png) |
| 8 | Books, general ledger | Each account's table sized its own columns, so Date, No. and Debit did not line up from one account to the next; dates broke as "2026-09-" / "13" on a phone | Fixed column widths shared by every account's table; dates never break; scrolls sideways in its own region on a phone | [desktop](screenshots/2026-10-04/books-desktop-before.png) · [phone](screenshots/2026-10-04/books-mobile-before.png) | [desktop](screenshots/2026-10-04/books-desktop-after.png) · [phone](screenshots/2026-10-04/books-mobile-after.png) |
| 9 | Books, reconciliation | Nine columns squeezed: claim ids broke as "SY-CB-" / "88121", dates in two lines, "In QuickBooks" a five-line sliver | Case links, dates and money never break; Result and In QuickBooks have a minimum width; fits at 1440 and scrolls in its own region below that | same | same |
| 10 | Books, every table | Rows twice as tall as the case list's; tables inset from the card edge unlike the board's and the ledger's; scroll regions unnamed and not reachable by keyboard | Case-list row density; tables run to the card edge; each scroll region has a name and a tab stop, as the board's do | same | same |
| 11 | Books, general ledger | An account's heading was an `h2` under the card's own `h2` | `h3`, drawn as it was | same | same |
| 12 | Books, chart | "Posting account" and "Looks like deductions" tags ran together and could break mid-tag | Spaced, and each tag stays whole | same | same |

Unchanged and shown for reference: the review queue
([desktop](screenshots/2026-10-04/case-list-queue-desktop.png),
[phone](screenshots/2026-10-04/case-list-queue-mobile.png)), the ledger below
the board ([desktop](screenshots/2026-10-04/case-list-ledger-desktop.png),
[phone](screenshots/2026-10-04/case-list-ledger-mobile.png)) and Books with no
connection ([desktop](screenshots/2026-10-04/books-no-connection-desktop.png),
[phone](screenshots/2026-10-04/books-no-connection-mobile.png)).

## Seen and left alone

These are not layout, or are somebody's decision:

- **A declined case is listed under its payer** with a deadline badge
  (`SY-CB-88300`, "48d left") while the figures say it is "not counted as
  open". The list is the store's; whether a declined case belongs in it is a
  product question.
- **On a phone the board's case table scrolls sideways**, and State, Evidence
  and Deadline start off-screen. It is the same table and wrapper as the
  ledger's, so it is consistent; stacking a row the way the review queue does
  would be a markup change to `CaseRow`, shared with the ledger.
- **"Unmatched" means two things**: on the board, a payer name no customer
  record answers to ("not matched"); under "Read, not on a case", documents no
  case was suggested for. The second could read "No case suggested".
- **"(exact)"** after a suggestion is the rule's own word for its strength. A
  reviewer may want "one open case has this number" instead.
- **Dates are ISO** (`2026-10-04`) on Books and in the documents list, and
  written out elsewhere.
- **Books' heading** ("The chart, the trial balance, the ledger.") is a
  sentence where every other page's is a noun ("Deductions").
- **Every card on Books repeats "— QuickBooks company 4620816365"**, a number
  and not the company's name; the page has no name to show.

## Not rendered

- The pages behind a real session (`next dev`): signing in needs a Supabase
  project, and bypassing it was out of bounds. The components were rendered
  directly from the same store reads the routes make.
- Books against a real QuickBooks company: there is no connection, token key
  or Intuit app in the scratch environment. The populated tables are the
  in-memory source's.
- The embedded document on the case page (a file on disk cannot load the
  authenticated document route), an ambiguous suggestion (the second case on
  the shared invoice was closed, so the match was exact), and Books' failure
  states.

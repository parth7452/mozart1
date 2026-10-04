# The pre-sell onboarding call

*2026-09-30. A 30-minute screen-share, not a pitch deck. The answer to "is it
a pitch or a demo" is: a demo that pitches. The lead watches its own kind of
deduction become a dispute, and finishes signed into a workspace of its own.
Slides are for the two minutes before the screen-share and the one page they
keep afterwards. The build that makes this possible is
`docs/plans/mvp/EXECUTION.md` (P1–P9); until it lands, run the same script
on the freight demo (`docs/DEMO.md`) and say so.*

## Why a demo and not a pitch

The product's differentiator is that every number traces to a quote on the
page and that nothing files without a second person. Neither survives a
slide. A controller who watches a `-111` line become a case with the
remittance's own sentence highlighted, and then sees the approve button
refuse the person who prepared it, has understood the product. A slide
saying "verifiable" has told them nothing.

The cost is preparation: a populated demo workspace, a rehearsed 20 minutes,
and a workspace for the lead made that morning. That preparation is the
pre-sell build.

## Materials, and what each is for

| Material | Where | When shown |
| --- | --- | --- |
| **The one-pager** (below) | PDF sent after the call | Minute 28; attached to the follow-up |
| **The demo workspace** `Harborline Foods` on `app.mozart.financial` | Production, EXECUTION P5 | Minutes 4–22 |
| **One UNFI-style remittance PDF** not yet uploaded, on the founder's desktop | EXECUTION P1 | Minute 5, uploaded live |
| **The lead's own workspace**, empty, founder owner, their contact approver | EXECUTION P8 | Minutes 22–28 |
| **The data-handling note** (below): what we store, where, and the sub-processors | PDF | Attached to the follow-up; answered on the call if asked |
| **The limits, said out loud** (below) | This page | Minute 26 |
| **The LOI and pilot terms** | Founder's document, not in the repo | Follow-up email |

No deck beyond a title slide and the one-pager. If the lead's contact is a
controller, have the case page's "quote found" badge and the approval refusal
ready as the two moments to slow down on.

## The 30 minutes

Timings are targets; the demo is 18 minutes and the rest is conversation.

### 0–3 · Their world, not ours (3 min)

Ask, and write the answers down; each one turns a door on or off:

- "When UNFI or KeHE short-pays you, what lands where? An email with a
  stub? Something you pull from myUNFI or CONNECT? Your bookkeeper
  noticing the deposit is light?"
- "Who submits your promotions today, you or the broker, and into what?"
  (This is the "planner". UNFI calls it Promotional Planning in the Supplier
  Portal; KeHE calls it Promotions in CONNECT; brokers keep their own
  calendar.)
- "Where do your books live?" (QuickBooks Online is a door; anything else is
  upload and email for the pilot.)
- "When a deduction is wrong, what happens today?" Most say "nothing under a
  few hundred dollars". That is the pitch, and they just made it.

### 3–5 · The one sentence (2 min)

> Every short-pay from every distributor lands in one queue. We read the
> stub and the backup and show you the line it came from. You decide what to
> fight; a second person approves; you file with our packet; you pay us only
> on what comes back.

Then: "Let me show you rather than tell you." Share the screen on the demo
workspace's case list.

### 5–9 · A stub arrives (4 min)

Upload the held-back UNFI-style remittance from the case list. While it
reads (20–40 seconds), say what is happening: scanned before read, read by a
model with no tools, every field with its quote. Then:

- The review queue now shows three new cases from one advice: a `-111`
  shortage, an `MCB` billback, an `AVL` late fee. "One stub, three
  deductions, three cases. You never typed anything."
- Open the `-111` case. Point at the amount and click its quote. The advice
  is beside it with the line highlighted. **Slow down here.** "The model
  copied the page; our code did the arithmetic. If it misread, you would see
  an unparseable amount, not a plausible wrong one."

If they email their stubs: "Forward that email to this address and the same
thing happens, except it waits for you to press one button, because email
is unauthenticated and we do not open cases on a stranger's say-so."

### 9–13 · What the documents say together (4 min)

On the `MCB` case, already populated before the call: the deal confirmation
is attached, and the findings panel says the billed rate does not match the
signed deal (or, on the `-111`, the signed POD says the count was full). The
evidence checklist for the reason chosen lists what a dispute needs and
which of it is on the case.

> "None of this is a model's opinion. It is arithmetic and comparison over
> the fields, and you can audit every line of it."

Show the payer's reason code and reference on the case, and the coverage
page for ten seconds: found against filed, per channel, never blended.

### 13–18 · Where it stops (5 min)

On the `MCB` case: **Dispute this deduction** with a reason and a one-line
rationale. **Assemble the packet**: the letter and the zip, every enclosure
with its hash. Then **Approve for submission**, and the button is not there:

> "You prepared this decision, so approving it is not yours to do."

> "That is not a UI rule. It is a database trigger. No bug of ours and no
> agent can record a filing without a second person's approval, and the
> database refuses an approval in the preparer's name."

Then the two cards that follow, both a person's: record the filing with the
confirmation number from the Dispute Center or K-Solve, and record the
outcome in cents. "That last number is what our fee is read from."

If QuickBooks came up in minute 1, show Settings → QuickBooks and the three
ledger cases the daily sync opened from short-paid invoices nobody sent us.
"This is the pile you did not know about. It is the whole reason the product
exists."

### 18–22 · Their workspace (4 min)

Stop sharing the demo. Send the lead's contact to `app.mozart.financial/login`
on their own screen. They enter their work email; the link arrives (EXECUTION
P7 must be done); they are in an empty workspace with their name on it.

"Forward one stub to this address now, if you have one open." If they do, it
is held under Read, not on a case, and they press **Open a case from it**
themselves. If they do not, upload one of ours into their workspace and let
them click the quote.

### 22–26 · The pilot, in their words (4 min)

- **Done-with-you.** "For the first weeks our analyst sits in your
  workspace every morning: opens what came in, attaches backup, prepares the
  dispute. Your controller approves. You file, or we walk you through it."
- **What we need from them:** the last 90 days of stubs and backup (email
  forward or a folder), the broker's promo calendar for the same period,
  QuickBooks Online connect if they have it, and two people: one who
  prepares, one who approves.
- **Money.** Contingency on recovered cash, invoiced by hand after the payer
  pays. No platform fee for the pilot. (The percentage is the founder's;
  `fee_pct_bps` defaults to 25%.)
- **The LOI.** "A one-page letter of intent for a 90-day pilot on those
  terms. I will send it tonight with the data note."

### 26–28 · The limits, said before they are asked (2 min)

- We file nothing. You paste the confirmation number.
- PDF, images, phone photos, CSV and XLSX. Four megabytes a file in the app;
  a bigger backlog you send us and we load it.
- A remittance past about 120 rows needs splitting for now.
- QuickBooks Online only. No NetSuite, Sage or Dynamics yet.
- We do not read myUNFI or KeHE CONNECT directly yet. We read what they send
  you. Portal reading is next, after their terms are read.
- Two people per case: the preparer cannot approve.
- No customer has been through this yet. You would be first, and the numbers
  in the one-pager are on synthetic and public documents, not customers'.

### 28–30 · Close (2 min)

"Two things from you by Friday: the LOI signed if this is worth 90 days, and
the last month of stubs into the address you now have. From us: the data note
tonight and a calendar hold for the onboarding morning."

## Rehearsal checklist

Run this the day before, timed:

- [ ] Demo workspace opens on a populated queue; one remittance held back.
- [ ] The held-back remittance uploads and opens three cases in under a
      minute (Fly scanner warm; no cold start).
- [ ] The `MCB` case shows a finding and a checklist; its packet assembles.
- [ ] The approve card refuses the preparer.
- [ ] Settings → QuickBooks shows a completed sync (P6).
- [ ] A magic link reaches an address outside the team in under a minute.
- [ ] The lead's workspace exists with their contact as approver.
- [ ] The one-pager and data note PDFs are in the follow-up draft.

## The one-pager (text)

**Mozart: deductions recovered, every number traceable.**

Distributors and retailers short-pay your invoices and attach a code.
Industry estimates put a tenth to a third of those deductions as invalid and
about seventy percent as never disputed, because finding, documenting and
filing each one costs more attention than it returns.

Mozart puts every deduction in one queue, from the stubs you forward, the
files you upload and the invoices QuickBooks says were short-paid. It reads
the stub and the backup and shows you the exact line each number came from.
It checks the documents against each other and against your deals. You decide
what to fight. A second person approves. You file with our packet. You pay a
share of what comes back, and nothing else.

What it never does: file without your approval, do arithmetic in a model, or
put your books at risk. The approval gate is a database rule, not a setting.

Pilot: 90 days, done-with-you, contingency on recovered cash.

## The data-handling note (text)

What we store: the documents you send or upload, the fields read from them
with the page and quote each came from, your cases and decisions, and, if you
connect QuickBooks, invoices, payments and credits for the trailing 35 days.
Every row is tied to your workspace and isolated by row-level security. Money
is stored as whole cents. Records are append-only: a correction is a new row,
never an edit.

Sub-processors: Supabase (database and sign-in), Vercel (the app), Inngest
(background jobs), Anthropic (reading documents; no tools, no training on
your data under our agreement), Reducto (OCR of scans), Fly.io (virus
scanning), Postmark (inbound email), Resend (our own failure alerts), AWS KMS
(sealing QuickBooks credentials), Intuit (QuickBooks, if connected).

Access: your team, by invitation and magic link only; our analyst inside your
workspace for the pilot, as a named member you can remove. Credentials for
QuickBooks are encrypted with a key we do not hold in the application.

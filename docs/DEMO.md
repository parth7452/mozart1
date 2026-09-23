# Demo: one freight dispute, end to end

Thirteen minutes. It takes a $600 deduction from a PDF nobody has read to an
argument a human can check line by line, and on to a dispute packet — and stops
exactly where a second person has to take over, which is the point rather than a
limitation.

The case is **LOG-001**, in `packages/fixtures/logistics/`. Five documents:

| | Document | What it contributes |
| --- | --- | --- |
| 01 | Short-pay remittance | The customer withheld $600, citing appointment revision 1 |
| 02 | Carrier invoice | $4,800 billed, referencing revision **2** |
| 03 | Rate confirmation | The fee applies only if check-in is >30 min late **and** carrier-caused |
| 04 | Appointment change | The customer approved revision 2 and wrote that no late charge applies |
| 05 | Proof of delivery | Gate check-in **13:42** against a **14:00** appointment |

No single document refutes the charge. Together they refute it completely, and
that is the thing worth showing.

## Before you start

You need a signed-in session on a deployment with all four variables set
(`CLAMAV_SCAN_URL`, `CLAMAV_SCAN_TOKEN`, `ANTHROPIC_API_KEY`, `REDUCTO_API_KEY`
— see [`apps/web/DEPLOY.md`](../apps/web/DEPLOY.md)), or a local `pnpm dev` with
`docker compose up -d clamd`.

Have the five PDFs on the machine you are demoing from.

---

## 1 · The deduction arrives (2 min)

Upload **`01_short_pay_remittance.pdf`** from the case list.

What happens, and why each step is worth naming out loud:

- **It is scanned before it is read.** ClamAV runs first, and the gate refuses to
  produce model input without a clean verdict. A document from a customer is a
  file from a stranger.
- **It is classified**, then **extracted** into typed fields, each carrying the
  page and the verbatim quote it came from.
- **A case opens**, because it is a notice.

You land on the review page. Every field shows its value, a `quote found`
badge, and the line it was read from. **Click one.** The point of this screen is
that a reviewer checks the reading rather than trusting it.

> **Say this:** the model never does arithmetic. It reports `"$600.00"` as
> printed, and our code turns that into cents. A misread shows up as an
> unparseable amount, not as a plausible wrong number.

## 2 · The evidence goes on (4 min)

From the case page, **Add evidence** — attach `02`, `03`, `04` and `05` one at a
time. Each runs the same pipeline and attaches to this case.

Watch **04, the appointment change**, in particular. It is a customer email
export, and until recently the system had no type for it: it fell to `other` and
the sentence that wins this case was read as prose. It now types as
`correspondence` and comes back as *commitments* — what it supersedes, what it
establishes, and whether it waives a charge.

## 3 · The argument assembles itself (3 min)

Reload the case. Under **What the documents say together**:

```
arrived_before_appointment   gate check-in was 18 minutes before the confirmed
                             appointment (1:42 PM against 2:00 PM Eastern)

appointment_superseded       Brookfield Supply Co. confirmed in writing
                             (MSG-BSC-0811-338) that AP-BSC-771 revision 2
                             replaced revision 1

charge_waived_in_writing     "No carrier late-delivery charge applies for moving
                             delivery to this revised appointment."
```

> **Say this:** none of that came from a model. It is deterministic code over
> extracted fields. The model read the page; the argument is arithmetic and
> comparison, which is the part you want to be able to audit.

Three things worth pointing at while it is on screen:

1. **It quotes rather than paraphrases.** A packet argues with the customer's
   own sentence; a summary of it is worth less and cannot be checked.
2. **A reschedule is not a waiver.** The waiver finding appears only because the
   message says a charge does not apply. Moving an appointment alone would
   produce the supersession finding and nothing more.
3. **It refuses to compare timestamps in different zones.** If the POD said UTC
   and the appointment said Eastern, the system says it could not check rather
   than reporting a confident four-hour-late arrival.

## 4 · Where it stops (3 min)

Scroll down past **Add evidence**. From here the page is one card per step, as
the case gets there, and you only ever get a button your role lets you press.

**Point at the two cards, one above the other, first** — deciding takes both
away:

- **Dispute this deduction** — a reason from the taxonomy, and one line for
  whoever approves it.
- **Not worth fighting?** — record a decline, which writes what the case was
  worth and what was missing rather than deleting it. Coverage is a ratio of
  dollars, and discarding the ones you gave up on flatters it every time.

Once you decide, the page stops offering a decline, and a case already declined
cannot be decided.

**Decide.** Pick *A late-delivery fine we can disprove* and write one line:
"Checked in 18 min before the revised appointment; the customer waived the
charge in writing." It is recorded with your name on it. Nothing is sent.

**Assemble the packet.** One click. The notice, the four documents, and a cover
sheet our code writes from the fields already read — no model writes it, so the
same case always assembles to the same contents. The card shows the packet's
hash, and every file links to the stored bytes. The cover sheet carries what the
case holds, not everything the page printed: a case opened from a remittance
line does not keep the printed dispute deadline yet, so it reads *not recorded*
here while the remittance itself, enclosed, still shows it.

**Stop at Approve for submission.** The card is there; the button is not:

> You prepared this decision, so approving it is not yours to do.

That is the page being polite. The database says the same thing harder: it
refuses an approval in the preparer's name, or in the name of anyone who is not
an owner or an approver, and the hash an approval names is a foreign key to the
packet that was assembled — so nobody can approve a packet nobody built.

> **Say this:** the approval gate is a database trigger, not a code path. No app
> bug and no agent can record a filing without an approval on record, and the
> database will not take one in the preparer's name.

If they ask what comes next, it is two more cards, both a person's: **record
the filing** — someone files on the retailer's portal and pastes the
confirmation number back, because the app files nothing — and **record the
outcome**, won, partial or lost, with the amount stored as whole cents. That is
the number the contingency fee will be read from.

## 5 · The honest part (1 min)

Worth saying before you are asked:

- **These documents are synthetic.** So is every fixture. The numbers in
  `packages/evals/baseline.json` measure synthetic documents — some we wrote,
  some handed to us as labelled test packs — and they will move when real
  customer scans arrive.
- **Nothing has been recovered yet.** One production case has been through all
  five steps on 2026-09-21 — decided, assembled, approved by a second member,
  with a filing and a `partial` outcome recorded. It was our own run on a
  synthetic document: nothing went to a payer and nothing came back. That
  proves the path, not a recovery rate, and no fee has been invoiced; billing is
  Phase 4.
- **The decision is a person's, for now.** The model reads the documents; a
  reviewer decides whether to fight. A model's call lands later, in the same
  slot, behind the same gate.
- **Submission is manual.** The app files nothing, and it will not record a
  filing until a second person has approved it. Which portal, and what that
  retailer wants attached, is not in the app yet — the filing card tells the
  reviewer to follow the routing guide they already use.

---

## If something does not work

| What you see | What it means |
| --- | --- |
| `not scanned clean: error (none)` | No scanner configured — `CLAMAV_SCAN_URL` and `CLAMAV_SCAN_TOKEN` are not both set |
| `not scanned clean: error (clamav-http) — …401` | The token on Vercel and the one on the scan service disagree |
| `carries active content (/AA)` | The upload gate refusing a PDF with embedded JavaScript. Working as intended — use the fixture documents |
| An error naming Anthropic | Scan passed, reader failed: `ANTHROPIC_API_KEY` missing |
| Case opens, no findings | Only the notice is attached. The argument needs `04` and `05` |

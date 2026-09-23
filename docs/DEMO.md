# Demo: one freight dispute, end to end

Twelve minutes. It takes a $600 deduction from a PDF nobody has read to an
argument a human can check line by line — and stops exactly where a human has to
take over, which is the point rather than a limitation.

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

## 4 · Where it stops (2 min)

Scroll to the bottom. There is no approve button, and that is deliberate:

> Nothing has been sent anywhere. Approving a case is a separate, recorded act
> by a second person, and the database refuses a submission that has no approval
> row.

Two actions a reviewer *does* have: attach more evidence, or **record a
decline** — which writes what the case was worth and what was missing, rather
than deleting it. Coverage is a ratio of dollars, and discarding the ones you
gave up on flatters it every time.

> **Say this:** the approval gate is a database trigger, not a code path. It
> cannot be worked around by an app bug or by an agent having a bad day.

## 5 · The honest part (1 min)

Worth saying before you are asked:

- **These documents are synthetic.** So is every fixture. The numbers in
  `packages/evals/baseline.json` measure documents we generated, and they will
  move when real customer scans arrive.
- **The packet is not built.** Today a reviewer gets an argument on screen; the
  assembled, sendable dispute packet is the next piece.
- **Submission is manual and stays that way** until a human has approved it.

## 6 · The deductions nobody sent (3 min, optional)

Everything above started with somebody uploading a notice. Most short-pays never
arrive that way — they are only in the ledger. Signed in as the workspace's
**owner**, open **Settings → QuickBooks** and press **Connect QuickBooks**.
Intuit asks you to sign in and pick the sandbox company; you come back to the
same page.

- **It reads, and never writes.** The accounting scope Intuit grants would
  allow writing; nothing in the product does. Write-back is Phase 4, behind the
  approval gate.
- **The first sync is already queued.** Within a few minutes the case list has a
  case for each invoice that was paid short — deductions found without anyone
  sending a document.
- **Only an owner sees the button**, and the database refuses anybody else. The
  connection syncs as the owner who made it, and re-checks every night that
  they still may.

> **Say this:** we never store a QuickBooks sign-in we can read. The token is
> sealed with a key held in AWS before it reaches the database, and Disconnect
> both stops the sync and revokes our access at Intuit.

---

## If something does not work

| What you see | What it means |
| --- | --- |
| `not scanned clean: error (none)` | No scanner configured — `CLAMAV_SCAN_URL` and `CLAMAV_SCAN_TOKEN` are not both set |
| `not scanned clean: error (clamav-http) — …401` | The token on Vercel and the one on the scan service disagree |
| `carries active content (/AA)` | The upload gate refusing a PDF with embedded JavaScript. Working as intended — use the fixture documents |
| An error naming Anthropic | Scan passed, reader failed: `ANTHROPIC_API_KEY` missing |
| Case opens, no findings | Only the notice is attached. The argument needs `04` and `05` |
| Settings → QuickBooks says it is not set up | The Intuit app or the KMS key is missing on this deployment — previews never have them. See [`docs/qbo-credentials.md`](qbo-credentials.md) |
| "…could not be matched to this session" after Intuit | Connect was pressed more than ten minutes earlier, in another browser, or on an address other than `app.mozart.financial` |

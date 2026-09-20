# State of play

*2026-09-20*

A supplier can sign in, upload a deduction notice, and get back a case where
every extracted field traces to the quote it came from. As of today they can
also attach evidence to that case and record a decision not to fight it. What
they cannot yet do is produce a packet and send it — that is the next piece, and
the one that turns this from a very good reader into a product.

## Live in production

Verified on the deployed app, not only in tests:

- **Sign-in** by magic link, resolving a tenant rather than creating one
- **Case list and review**, through the same RLS policies as everything else
- **Upload → case.** A scanned Walmart notice went in as a JPEG and came back
  with every field quote-verified against the OCR text layer — the whole chain
  against real vendors: ClamAV, Claude to classify and extract, Reducto for the
  text layer a scan has no other way to get

The scanner runs as its own container on Fly, with clamd bound to loopback
behind a token-checked HTTPS endpoint (ADR 0018). Verified directly: a clean
file passes, the EICAR test file is flagged by name, unauthenticated callers get
401.

## Built, not yet exercised

The gap between *it worked once* and *it works*. Each of these is implemented
and tested in isolation and has never been run through the deployed app:

| | What would prove it |
| --- | --- |
| **Roles** | A `read_only` member is refused an upload and a decline in the UI. The DB policy enforces it and a Postgres test proves it refuses; nobody has watched it happen |
| **A second tenant** | Two orgs, each seeing only their own cases, through the app rather than through SQL |
| **Email-in** | Postmark is built. Has a real email ever opened a case? |
| **The dense path** | A 42-row remittance is 63s of model time in the recorded cassettes, and the pipeline runs inside the HTTP request with no `maxDuration` set. Simple notices fit; a real remittance may not |
| **Decline and attach** | Shipped today, tested against a real database, not yet clicked in production |

## Blocked, and on whom

| Blocker | Who | Why it matters |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` for cassette recording | **you** | LOG-001 is wired and self-consistent but not scored by `pnpm eval` until its cassettes exist. One local command |
| Positioning line | **you** | `CLAUDE.md` still opens "Deductions recovery for CPG suppliers". The stated market is staffing and logistics, CPG as upside |
| Real customer documents | **you** | Every fixture is synthetic. See *What not to claim* |
| Provenance at ingest | **next change** | Nothing writes the `uploads` table, so `declined_candidates.discovered_from` cannot be filled honestly and coverage cannot be attributed by channel |

## Where the phases stand

Against the build order in `CLAUDE.md`:

- **Phase 0 — foundations.** Done. Approval trigger, append-only tables, hash
  chains, RLS, the SQL invariant suite, money maths, the case state machine.
- **Phase 1 — ingest + classify.** Substantially done and live. Remaining: the
  Inngest binding, and fixtures for formats still missing.
- **Phase 1.5 — ERP read + triage.** Not started.
- **Phase 2 — evidence + decision.** Not started, though today's appointment
  reconciliation is the shape of what belongs in it.
- **Phase 3 — packet, approval, submission, outcomes.** Not started. This is
  where the approve button finally appears and where money first moves.

The case state machine has 14 states. Cases reach state 2.

## What not to claim yet

- **Every fixture is synthetic**, including the two packs added this week. The
  eval numbers — 100% recall, 100% precision, 99.8% grounding — measure
  documents we generated or were given as labelled test data. They are a floor,
  not a result, and they will move when real scans arrive.
- **The OCR starter pack stamps every page `SYNTHETIC TRAINING SAMPLE`**, and
  its own README warns that marker can become a shortcut feature. A classifier
  scoring 100% on it may have learned the watermark. LOG-001 carries no such
  banner and a test keeps it that way.
- **Nothing has ever been submitted or recovered.** No dispute has been sent, no
  money has come back, and the approve button does not exist.

## Next

1. **Packet assembly** — the notice, the attached evidence and a cover sheet,
   downloadable. The remaining piece that makes this a product.
2. **Cassettes for LOG-001**, once the key is in place, so the case is scored.
3. **Provenance at ingest**, so coverage can be attributed by channel.
4. **A verification pass** over the "built, not yet exercised" table.

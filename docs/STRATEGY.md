<!--
  This is the strategy addendum as received, kept verbatim below the note.

  One correction to its §7 numbering: it proposes ADRs 0016–0020, but 0016 was
  already taken by "an email body is a document" before this arrived. An ADR is a
  record of a decision at a point in time, so renumbering a committed one would
  falsify the record. The mapping used here is:

    CH-3 / CH-4  deduction identity and sources   → ADR 0017
    ADD-1        the counterfactual log           → ADR 0018
    CH-1         expected-value gating            → ADR 0019
    CH-2         owned, outcome-conditioned calibration → ADR 0020
    ADR 0020 (agent-facing decision tool)         → ADR 0021

  Where this document and CLAUDE.md disagree about build order, this document
  wins and CLAUDE.md is updated to match; where they disagree about an invariant,
  neither does — §0 and §8 are explicit that the seven invariants stand.
-->

# recouple — Strategy Addendum & Build Revision

**Status:** addendum to the existing build. Not a replacement plan.
**Applies to:** `recouple/` on `claude/getting-started-p34lno` (Phase 0 done, Phase 1 pipeline done and measured)
**Date:** 2026-09-18 (rev. 3 — §6 decision layer, incl. §6.8 on the Jev+LLM pairing pattern)
**Suggested home:** `recouple/docs/STRATEGY.md`, with the migration-bearing items promoted to ADRs 0016–0020

---

## 0. How to read this

This does **not** ask for a rewrite. The foundations are sound and several things flagged as risks in earlier strategy work turn out to be already built. What follows is:

- **§1–4** — the strategic frame: the metric, why a customer picks us over Glimpse, and what Glimpse's unbundled suite implies for our packaging.
- **§5** — ERP **and** retailer-portal integration, elevated to a first-class requirement. This is the largest change to the build order.
- **§6** — where Jev belongs, and where it doesn't. Includes an honest cost correction.
- **§7** — a revision register against real files, marked KEEP / CHANGE / ADD, with proposed ADR numbers.
- **§8** — the one genuine architectural tension (the approval gate vs. long-tail economics), presented as a decision, not a recommendation to weaken an invariant.

Everything in `CLAUDE.md`'s seven invariants stands. Nothing here asks to relax the approval trigger, the append-only grants, or the no-tools reader.

---

## 1. What's already right (do not re-litigate)

Prior strategy work flagged several generic risks for a build in this category. Checking them against the code:

| Earlier concern | Actual state | Verdict |
|---|---|---|
| Reason codes will be retailer-specific and won't generalise | `core-domain/src/reason-codes.ts` is a canonical 10-family / ~50-code taxonomy; retailer codes map in via `retailer_code_maps` playbook data | **Already solved.** This is the single most important thing to have got right early |
| No multi-tenancy; retrofitting is expensive | `org_id` on every table, RLS on every table, `app_rw` with transaction-local claims, separation-of-duties tests | **Already solved** |
| Outcome data won't be trainable | Append-only events + hash chains; `decisions` persists provider, model version, `input_state_hash`, `raw_probabilities`, latency, `cost_micros` | **Already solved** |
| Cost per case won't be measured | `cost_micros` on decisions; `model_calls` with tokens/cost/latency; evals report $/document | **Mostly solved** — needs a per-case and per-filed-dispute rollup (§7) |
| Black-box AI won't earn finance-team trust | Per-field provenance, verbatim quote verification, "models copy, we compute", no-tools reader, review UI that traces every field to its quote | **Already solved, and it is a differentiator.** See §3 |
| Deadlines will be missed | `deductions.dispute_deadline` with a partial index | **Already solved** |
| ERP/portal will require a refactor later | `EvidenceSource.sourceKind` already includes `'accounting'` and `'portal'`; `SubmissionChannel` covers manual/email/agent | **Seams exist.** But see §5 — the seams are for *evidence*, not *discovery* |

The rest of this document is about what isn't covered.

---

## 2. The metric — recovery rate, not win rate

**This is the most important correction, and it has direct schema consequences.**

Glimpse markets a 91% dispute win rate (company-reported, unaudited; independent estimates for well-documented disputes run 40–70%). Win rate is trivially gamed: you reach 91% by only filing what you're already sure of.

```
Recovery Rate  =  Coverage Rate  ×  Win Rate  ×  Collection Rate

  Coverage   = disputable dollars filed / disputable dollars existing
  Win        = dollars approved / dollars filed
  Collection = dollars received / dollars approved
```

| | Coverage | Win | Recovery |
|---|---|---|---|
| Optimising win rate | 30% | 91% | **27%** |
| Optimising recovery | 85% | 70% | **60%** |

Industry sources put roughly **70% of disputable deductions as never challenged at all**. The unfiled pile is the prize.

**Consequences for this build:**

1. The denominator of coverage is *disputable dollars existing* — which we cannot currently see, because a deduction only enters the system when a supplier uploads or emails it (§5).
2. There is no counterfactual record. `written_off` is a terminal state, but nothing captures *why* we declined and *what it was worth*. Without that, coverage is unmeasurable and the tail is untrainable (§7, ADR 0017).
3. `DEFAULT_MIN_DECISION_CONFIDENCE = 0.95` is a win-rate optimiser wearing a safety hat. See §7, ADR 0018.

**Headline metric: recovery rate.** Secondary: **cost per dispute filed** and **per-tenant calibration error (ECE)**.

---

## 3. Why a customer picks us over Glimpse

Three honest answers, in order of strength.

### 3.1 We fight the long tail they write off
Every incumbent has an economic floor — below roughly $250–500 a dispute costs more in human attention than it returns, so it gets written off. For a $10–50M supplier that tail is the *majority of the deduction count*. If marginal cost per dispute approaches zero, the floor disappears and coverage jumps. Current measured extraction cost is $0.015–0.128/document and ~$0.06–0.17/case — the model economics already work. **The binding constraint is human approval time, not compute** (§8).

### 3.2 Verifiability — the packet defends itself
This is already built and it is genuinely differentiated. Every extracted field carries the page and the verbatim quote it came from, and the quote is checked against the page text before a human sees it. A dispute packet whose every number traces to a highlighted line on the retailer's own document is a different artifact than an LLM-written narrative. Two consequences:

- **Sales:** a controller can audit any case in 30 seconds. "Show me why you claim $3,120" has an answer that isn't "the model said so."
- **Autonomy:** grounded provenance plus per-tenant calibration is the only credible path to raising the automation ceiling. Competitors selling black-box agents have no story for how a finance team gets comfortable.

Say this plainly in positioning: **we do not ask you to trust the AI; we show you the page.**

### 3.3 Outcome-conditioned win probability, owned by us
`decisions.confidence` is currently the provider's self-reported number. A provider's confidence is not a win probability. What compounds is a calibrated estimate of *P(this dispute is won | retailer, reason code, evidence set)*, learned from our own `won/lost/partial` outcomes. That is the asset, and it must be ours rather than the decision vendor's (§7, ADR 0019).

**What is not a sufficient answer:** "we serve smaller brands." Glimpse is sales-led with no self-serve tier today, which leaves the bottom of the market open — but that is a temporary GTM gap, not a moat.

---

## 4. Glimpse's suite, and our packaging

Glimpse presents one workflow as several modules. That is deliberate: modular SKUs let a sales-led vendor land narrow and expand ACV. It is right for them and wrong for a $10–50M supplier, who has one problem.

The full category loop, mapped to our phases:

| Layer | Our state |
|---|---|
| Connectivity (portal, EDI, remittance email, ERP) | **Gap — §5** |
| Deduction ledger | Built (`deductions`, event stream) |
| Evidence graph | Built (`documents`, evidence types, provenance) |
| Classification | Built and measured |
| Validity + win probability | Phase 2 — **change the gating, §7** |
| Packet assembly + filing | Phase 3 |
| Tracking / escalation / **re-file after denial** | **Gap — §7, ADD-5** |
| Cash application / recovery detection | Phase 4 |
| Root-cause / prevention | Phase 5 |
| Financing on dilution data | Deferred — instrument now (§7, ADD-4) |

**Our position: do not unbundle.** One product, one price, the whole loop. Contingency pricing on recovered dollars is both the commercial model and the data-capture mechanism — the customer hands over everything because they only pay on recovery.

---

## 5. ERP **and** retailer portal — both, as first-class sources

**This is the largest change to the current build order.** `CLAUDE.md` says *"Do not build yet: portal credentialed fetch … EDI/carrier/3PL connectors, NetSuite/Xero"*, and QBO appears only in Phase 4 as write-back. That ordering was right for proving extraction. It is wrong for the coverage thesis, for one reason:

> **`uploads.source` is constrained to `('web_upload', 'email_in')`. A deduction can only enter the system if the supplier already knows about it and sends it to us. That caps coverage at what the customer surfaces — and the entire thesis is the 70% they never surface.**

The existing seams are for **evidence retrieval**, not **deduction discovery**. `EvidenceSource.fetch(evidenceType, ctx)` presumes a case already exists. Nothing creates the case.

### 5.1 The two legs do different jobs

Neither is sufficient alone.

| | **ERP / accounting** (QBO, NetSuite, Xero) | **Retailer portal / EDI** (Walmart APDP, Vendor Central, Target, KeHE, UNFI) |
|---|---|---|
| Tells us | Money is missing: invoiced $100,000, received $92,000 | *Why* it's missing: the reason code and the retailer's backup |
| Gives us | Invoice ledger, open AR aging, customer + item master, cash receipts, credit memos | Claim ID, reason code, line detail, retailer documents, dispute deadline, filing mechanism, status |
| Required for | **Discovery** of the deduction in dollar terms; recovery detection; the dilution profile; the coverage denominator | Classification, evidence, **filing**, outcome detection |
| Without it | You can't compute recovery rate or coverage; you miss deductions netted at remittance that never appear in a portal | You know money is missing but can't classify or fight it |

EDI is the third leg and often the cleanest: the **812** is literally the deduction document, the **820** the remittance, **810/850/856** the invoice, PO and ASN. Many mid-size suppliers already have EDI through a VAN or SPS.

### 5.2 Identity resolution is the hard part

The same deduction appears in up to three places with different identifiers: an ERP credit memo, an EDI 812 adjustment line, and a portal claim ID. Naive ingestion double-counts or silently drops. `deductions` currently has `unique (org_id, debtor_id, claim_id)` with `claim_id` nullable — which is not enough once a second source arrives.

**Required:** a deduction identity-resolution layer that dedupes across sources and records which source(s) contributed, with `claim_id` promoted to a set of source-qualified external identifiers rather than one nullable column.

### 5.3 Why ERP-first is also the GTM wedge

A $10–50M supplier lives in QuickBooks. If onboarding is *"connect QBO and we'll show you the deductions you're sitting on"*, that is self-serve, it produces the free-diagnostic top of funnel, and it is exactly what a sales-led competitor with no self-serve tier cannot match. The ERP connection is simultaneously the discovery source, the coverage denominator, and the acquisition motion.

### 5.4 Revised ordering

Portal **read** (discovery + backup retrieval) moves early. Portal **write** (auto-submission) stays late, behind the approval gate, exactly as designed. That split preserves every invariant while unblocking coverage.

| | Was | Now |
|---|---|---|
| ERP read (QBO) | Phase 4, write-back only | **Phase 1.5 — discovery + reconciliation** |
| ERP write-back | Phase 4 | Phase 4 (unchanged) |
| Portal credentialed **read** | "do not build yet" | **Phase 2 — discovery + retailer backup docs** |
| Portal **write** / browser agent | Phase 6 | Phase 6 (unchanged) |
| EDI 812/820 ingestion | "do not build yet" | **Phase 2.5** — cleanest discovery source where available |
| NetSuite / Xero | "do not build yet" | After QBO; same `AccountingSource` interface |

Portal credentials bring real operational load: MFA, session expiry, rotation, and per-retailer ToS. Credentials belong in KMS-backed storage, never in application tables, and a credential failure must degrade to upload/email rather than failing the case.

---

## 6. The decision layer: where Jev belongs

Jev is already invariant 5's designated provider behind `DecisionProvider`, with schemas A–D defined and `MAX_CHOICE_CARDINALITY = 255` encoded. The question is whether to widen its role. **Yes — but not primarily for the reason it's usually reached for.**

### 6.1 What Jev actually is

Per TypeSafe's own numbers: 70–500ms end-to-end (40–200× faster than frontier LLMs on equivalent tasks), input at **$0.042/MTok with output free**, calibrated probabilities on every answer, structurally incapable of producing an invalid type, cardinality ceiling of 255, and trained on *structured program state* rather than conversation. Marketed use cases: "smart if-statements," map-reduce over large inputs, real-time paths, and "score, judge, verify, guardrail."

That profile matches this build unusually well — the existing `Question`/`Answer` types with a `distribution` field were clearly designed against it.

### 6.2 The cost correction — read this before optimising

**Moving decisions to Jev saves almost nothing on current per-case cost, because decisions are not where the money goes.**

| | Current cost | Driver |
|---|---|---|
| Extraction, simple notice | ~$0.015 | ~900 output tokens |
| Extraction, 42-row remittance | **$0.128** | 10,702 output tokens (~250/row) |
| Case (4 simple docs) | ~$0.06 | extraction |
| Case (with dense remittance) | ~$0.17 | extraction |
| A Jev decision over ~2k tokens of structured state | **~$0.0001** | input only; output free |

Extraction output tokens dominate by three orders of magnitude over decisions. Swapping the decision layer to save money is optimising the wrong line.

**The real value of Jev here is that it changes the achievable funnel shape, not the unit cost of the current path.** Which is worth more, because the funnel is the coverage thesis.

### 6.3 The high-value use: triage at the top of the ERP funnel

Once ERP sync lands (§5), the system sees *every* short-pay — thousands of candidate lines per tenant per month, most of which should never reach extraction. That volume is exactly the regime where a ~$0.0001, ~100ms decision changes what is economically possible:

```
ERP / remittance sync  →  N thousand candidate short-pay lines
        ↓  Jev triage over structured rows  (~$0.0001 each, ~100ms)
        ↓  is this a deduction? disputable? worth pulling evidence for?
   hundreds of cases worth opening
        ↓  Sonnet extraction with provenance  (~$0.015–0.128 each)
        ↓
   filed disputes
```

Without cheap triage, you either extract everything (economically impossible at tail volumes) or you only process what the supplier hands you (which is the coverage ceiling we're trying to break). **Jev triage is what makes §3.1 — fighting the long tail — actually affordable.** This is the single strongest argument for widening its role, and it doesn't exist in the current build because the ERP funnel doesn't exist yet.

### 6.4 Where else Jev fits

| Use | Fit | Note |
|---|---|---|
| Schemas A–D | Already designed | Keep |
| **ERP/remittance triage** (§6.3) | **Strongest new use** | New — gates extraction spend |
| **EV gate input** (CH-1) | Strong | Calibrated `distribution` is a far better P(win) input than a 5-level ordinal. See CH-1 |
| **Deduction identity resolution** (CH-3) | Strong | "Same deduction or not?" across ERP credit memo / EDI 812 / portal claim is a binary over structured fields |
| **Denial classification** (ADD-5) | Strong | Denial reason → taxonomy is a Choice, same shape as reason codes |
| Schema C verifier / guardrail | Already designed | Exactly TypeSafe's stated use case; keep the two-provider cross-check |
| Doc-type classification (currently Haiku 4.5) | Possible | Runs on page text, so it sits closer to the untrusted boundary. Needs an eval bake-off, not a swap — and at 25/25 classification for ~$0.015 total it isn't a bottleneck. Low priority |

### 6.5 Where Jev is the wrong tool — do not move these

- **Extraction.** The entire grounding discipline depends on the model emitting *verbatim quotes* it copied off the page. That is generative work with an open output space. Keep Sonnet.
- **Narrative drafting** for the dispute packet. Generative. Keep Claude.
- **Evidence planning and unknown-retailer cold start.** `CLAUDE.md` reserves agentic loops for exactly these two, correctly — they are open-ended planning, not bounded choices.
- **Policy scope matching** (§8). Whether a case falls inside an approved policy's scope must be *deterministic code*, never a model. A probabilistic answer to "may this be auto-filed?" reintroduces exactly the risk the approval gate exists to remove.

### 6.6 The boundary that must not move

`DecisionState.facts` is extracted fields with `MAX_FACT_CHARS = 1_000`, explicitly never raw document text. That is invariant 4 expressed in the decision contract.

Jev cannot hallucinate and cannot return an invalid type, which makes it tempting to relax this and feed it document text directly to skip an extraction hop. **Don't.** Type safety prevents a malformed *output*; it does not prevent a document from steering a *decision*. A poisoned PDF that flips `validity` to `valid` or `submission_safe` to true costs real money, and it does so through a perfectly well-typed answer. Jev stays on the structured side of the quarantine line.

The one defensible exception is doc-type classification (§6.4), where the output space is a handful of document types and a wrong answer is caught by the confidence floor and routed to review. If that moves, it moves with an ADR saying why the blast radius is bounded.

### 6.7 "The agent prompts Jev itself"

The instinct — let the agentic steps make fast cheap decisions and reserve expensive model compute for execution — is right, but the naive version breaks invariant 5 ("never call the Jev or Claude API directly from app code"). An agent with a raw Jev client loses the recorded `decisions` row, the `input_state_hash`, schema versioning, cassette/eval coverage, and cost accounting. `CLAUDE.md` already requires a recorded fixture for every new agent decision path; a free-form caller makes that unenforceable.

**Resolution:** expose Jev to the agentic steps as a *tool over the same `DecisionProvider` port, restricted to registered, versioned question sets.* The agent may ask, but only questions that exist in a schema, and every call still writes a decision row and is replayable in evals. Adding a question means bumping a schema version and re-running the suite — the same discipline that governs A–D today. → **ADR 0020**

This gets the user-facing benefit (fast bounded decisions inside a loop, expensive compute reserved for execution) without an unlogged decision path.

### 6.8 The pairing pattern — and the one idea worth stealing

The WindTunnel/WebMCP benchmark is the clearest public demonstration of Jev paired with a generative model, and the pattern generalises well beyond browsers.

**The result** (49 tasks, 8 self-hosted sites, three attempts each): Jev + Mercury 2.5 scored **96.5, solving 49/49 tasks at 95.9% attempt success, $0.0011 and 3.2s per task**. Next best was GPT-5.6 Luna native at 91.5, $0.0024, 5.7s; Sonnet 5 native at 86.0, $0.0091, 6.8s. So roughly **2× cheaper and 1.8× faster than the runner-up, ~8× cheaper than Sonnet 5**.

**The architecture is the interesting part, not the score.** In the Jev Ultrafast runner the work splits four ways:

| Tier | Job |
|---|---|
| **Deterministic code** | Parse the DOM into an indexed element snapshot; enumerate which operations are legal on which elements; execute the chosen action; verify document state afterwards |
| **Jev** | Two probability distributions *in parallel* — one over the operation (`CLICK`, `TYPE_TEXT`, `SELECT`, `SCROLL`, `WAIT`, `DONE`, `BLOCKED`), one over which indexed element to target. **Only elements compatible with the chosen operation appear in the target distribution** |
| **Small fast LLM** | The narrow generative slice — producing the actual keystrokes for a text field |
| **Frontier LLM** | Not in the loop at all |

Reported side effects: browser protocol calls fell from 1,092 to 101 (91% reduction) and a Google Flights task from 9.45s to 7.1s.

**The transferable idea:**

> Never ask a model *"what should I do?"* in open prose. Have deterministic code enumerate the legal actions, then ask a calibrated classifier to pick one from that enumeration.

The model cannot choose an action that doesn't exist — not because the prompt discourages it, but because it was never in the option set. That is the same move `reason-codes.ts` already makes for classification, applied to *control flow*. It fits this codebase's stated philosophy ("a deterministic, human-gated workflow, not an autonomous agent") considerably better than an agentic loop does.

**Where it applies here, in order of value:**

1. **Evidence planning** — currently one of the two places `CLAUDE.md` reserves for a genuine agentic loop. But the pieces for the enumerate-then-choose form already exist: `EvidenceChecklistItem` knows what's required and what's satisfied, `EVIDENCE_TYPES` is a closed set, and the `EvidenceSource` registry knows which sources can supply which type. Code can enumerate *(unsatisfied evidence type × available source)* and Jev picks the next action with a calibrated probability. That converts an unbounded loop into a bounded, logged, replayable decision — and would take the reserved agentic surface from two steps down to one.
2. **Portal filing** (`portal_agent`, Phase 6) — this is literally the benchmarked task. Two cautions below.
3. **Packet field mapping** — `PlaybookChannelSpec` already carries granularity, file types, size and character limits. Mapping facts into a retailer's form fields is enumerate-then-choose, not generation.
4. **Narrative drafting** — the Mercury lesson. A dispute narrative is short, templated, bounded by `descriptionCharLimit`, and built from facts we already hold as structured state. That does not need a frontier model. Worth an eval bake-off against a small fast one, scored on the Schema C verifier rather than on vibes.

**Two cautions before this gets over-read:**

- **WebMCP is not available to us.** Its advantage comes from *the site exposing tools to the agent*. Walmart APDP, Vendor Central and KeHE Connect will never do that. What transfers is the Jev Ultrafast half — typed action space over a code-built element index — not the WebMCP half, and the headline 96.5 is a WebMCP number. Expect the DOM-snapshot approach to land somewhere between the WebMCP and page-structure rows, not at the top. It is still the right way to build that channel when Phase 6 arrives, and it is a better default than screenshot-driven automation.
- **The benchmark is vendor-adjacent.** The Jev + Mercury entry was contributed by PR to a benchmark published by a party with an interest in the outcome, over 49 tasks on 8 self-hosted sites. The architecture is sound and worth adopting on its merits; the specific margins are directional, not audited.

And one dependency note: Mercury is a third vendor on a money path. If a small fast generative model earns a place here, it goes behind a port with a fallback, exactly as Jev does — see the risk in §10.

---

## 7. Revision register

Against real files. **KEEP** = confirmed correct. **CHANGE** = modify existing. **ADD** = new work.

### KEEP (explicitly)

| Item | Why it matters now |
|---|---|
| Seven invariants in `CLAUDE.md` | The approval trigger and append-only truth are what make autonomy *sellable* later. Do not trade them for speed |
| No-tools reader + `<untrusted_document>` quarantine | Document content is attacker-controlled. This is correct and rare |
| "Models copy, we compute" + `parseMoneyToCents` | Makes every number checkable |
| Flat wire format + `reassemble` (ADR 0008) | Correct workaround for the grammar limit; keeps field addition one-line |
| Canonical reason codes + playbook mapping | The thing that makes non-CPG verticals config rather than a rewrite |
| Four eval suites gated separately | Never blend them. The instinct behind this is right |
| Integer cents everywhere | — |
| Provenance + quote verification | Now a **positioning asset**, not just hygiene (§3.2) |

### CHANGE

**CH-1 — Gate on expected value, not confidence.** `packages/core-domain/src/thresholds.ts`, guard `confidence_within_tenant_dispute_ceiling`.
`DEFAULT_MIN_DECISION_CONFIDENCE = 0.95` means anything under 95% goes to a human. At realistic calibration that routes most of the tail to analyst review, which reintroduces the human cost floor and caps coverage — the exact incumbent failure mode. The filing decision is an EV calculation:

```
EV(file) = P(win | retailer, reason_code, evidence_set) × amount − cost_to_file
```

File when EV > 0 and the downside is bounded. A 55%-confidence $8,000 dispute is worth filing; a 97%-confidence $40 one may not be. Keep a confidence floor for *classification* (a misread document is a different failure), but decision routing should be EV-driven. **Phase 2 is unbuilt — this is the moment.** → **ADR 0018**

Related schema change: `SCHEMA_B_VALIDITY.estimated_win_probability` is currently a `score` over five ordinal risk levels. An ordinal is not a probability and cannot be multiplied by a dollar amount. Reframe it as a binary question and take the **calibrated probability off the answer's `distribution`** — which is precisely what Jev returns and what `Answer.probability` already carries. That single change turns the EV formula from an approximation into an arithmetic identity.

**CH-2 — Calibration must be ours and outcome-conditioned.** `decisions.confidence` is provider-reported. Add an owned calibration layer that maps provider output → calibrated P(win) using our own `won/lost/partial` outcomes, per tenant and per (retailer × reason family), with isotonic or Platt scaling and a stored reliability curve. `raw_probabilities` is already persisted, which is exactly what this needs. Track ECE per tenant — Phase 6's autonomy gate already references it, so it needs to exist from Phase 2. Keep `DecisionProvider` as the port; own the calibrator. → **ADR 0019**

**Jev does not remove this requirement, and it's worth being precise about why.** Jev's probabilities are calibrated *on its training distribution* — "higher confidence means higher accuracy" for the question as posed. They are not calibrated on whether **Walmart's APDP team accepts a shortage dispute backed by an unsigned carrier BOL in March**. That is a fact about a retailer's behaviour, and no general-purpose model has ever seen our outcome labels.

So the architecture is two-stage and the distinction matters:

```
Jev calibrated probability  →  feature
     + retailer, reason family, evidence set, amount band, tenant, days-to-deadline
     → our calibrator, fit on our won/lost/partial outcomes
     → P(win) used in the EV gate
```

Jev's probability is the **best single input** to that calibrator — well-formed, consistent, and free of the overconfidence that makes LLM self-reports unusable as features. It is not the output. Treating the vendor's number as the final win probability hands the one compounding asset in the business (§3.3) to a vendor, and it would silently mis-price every dispute for any retailer whose behaviour differs from the training prior.

**CH-3 — Deduction identity across sources.** Promote `claim_id` to source-qualified external identifiers; add a resolution step so ERP, EDI and portal views of the same deduction converge on one row. Required before the second source ships. Deterministic matching first (claim id, invoice + amount + date); a Jev binary over the structured candidate pair for the residue, with low-confidence pairs held for review rather than merged — a wrong merge silently destroys a disputable deduction, so this gate should be asymmetric. → **ADR 0016** (migration)

**CH-4 — `uploads.source` check constraint.** Extend beyond `('web_upload','email_in')` to cover `erp_sync`, `portal_fetch`, `edi_812`. Part of ADR 0016.

**CH-5 — Build order.** Per §5.4. Update the "Do not build yet" list in `CLAUDE.md` and the phase table in `README.md` so the two don't drift from this document.

### ADD

**ADD-1 — The counterfactual log. (Highest priority.)**
Every deduction we decline to file gets a row: reason, estimated recoverable value, the policy/model version that decided, and the evidence that was missing. Today a write-off is a terminal state with no analytic residue.

Three things depend on this and only this:
- Coverage rate is otherwise unmeasurable, so recovery rate is unprovable.
- The tail is untrainable — the cases we skip are exactly the ones the model needs to learn.
- "Here is what your previous process left on the table" is the sales artifact. It is also the head-to-head proof against Glimpse.

Append-only, same as the rest. → **ADR 0017** (migration)

**ADD-2 — Coverage denominator from ERP.** Once ERP sync lands, compute *disputable dollars existing* per period per debtor, so coverage has a real denominator rather than a self-reported one. Depends on §5.

**ADD-3 — Cost per case and per filed dispute.** `cost_micros` exists on `decisions` and `model_calls` has per-call cost. Roll up to case level and to *dispute filed*, and expose it as a first-class operational metric with a per-tenant trend. This number is the moat in §3.1; unmeasured, it will not be driven down.

Track **cost per candidate triaged** separately from **cost per case opened**. Once the ERP funnel exists (§6.3) these differ by roughly three orders of magnitude, and blending them hides the only ratio that matters: what it costs to *find* a disputable dollar versus what it costs to *fight* for one.

**ADD-4 — Dilution profile view.** Per `(org_id, debtor_id, period)`: gross billed → deducted → disputed → recovered → net. Cheap now as a view over existing tables. Two uses: the customer-facing "your deduction rate and where it's going" number that drives retention past the one-time-cleanup churn risk, and the underwriting asset if the receivables-financing thesis is ever revisited. Build the view, defer the financing.

**ADD-5 — Denial classification and re-file loop.** `lost` is terminal in `TRANSITIONS`. In practice a denial has a reason, and some denials are re-filable within the retailer's window with corrected or additional evidence. The category underbuilds this and it is pure incremental recovery rate. Needs: a denial-reason taxonomy (mapped like reason codes), a re-file transition `lost → evidence_pending` guarded on `within_refile_window`, and a distinct outcome so re-file wins are attributable. → ADR when the transition table changes

**ADD-6 — Recovery detection and attribution.** Phase 4 already names attribution for billing. Note that the same mechanism is what makes *collection rate* (§2) measurable. Contingency billing and recovery-rate measurement are the same pipe — build it once.

**ADD-7 — Jev triage tier.** A `TriageProvider` step between ERP/remittance sync and case creation, over the same `DecisionProvider` port: structured short-pay rows in, a bounded decision out (not a deduction / deduction–not disputable / open a case). Cheap enough to run on every line, which is what makes coverage measurable and the tail affordable (§6.3). Every triage decision writes a row — a declined candidate is a counterfactual-log entry (ADD-1), not a discard. → depends on §5; **ADR 0020** covers the port surface

**ADD-8 — Enumerate-then-choose for evidence planning.** Restructure the evidence-planning step from an agentic loop into a typed action space (§6.8): code enumerates *(unsatisfied evidence type × capable source)* from `EvidenceChecklistItem` and the `EvidenceSource` registry, Jev picks the next action with a calibrated probability, code executes and re-scores. Removes an unbounded loop from a money path, makes the step replayable in evals, and narrows `CLAUDE.md`'s reserved agentic surface from two steps to one. Phase 2, alongside CH-1/CH-2.

---

## 8. The open question: approval granularity

**This is the deepest tension in the build and it needs a decision, not a workaround.**

Invariant 1 — nothing is submitted without an `approvals` row for that exact `decision_id`, enforced by a trigger — is correct and is a genuine asset. It is also, read literally, a per-case human action.

The long-tail thesis (§3.1) requires filing thousands of small disputes. If each needs a human approval, cost per dispute has a human floor of a minute or two, the tail stays unprofitable, and we converge on the same coverage ceiling as the incumbents. Compute is not the constraint; approval throughput is.

Phase 6 anticipates this ("careful autonomy — only where per-tenant ECE < 0.10 is sustained"). The design question is *what a human approves*:

| Option | Mechanism | Trade-off |
|---|---|---|
| **A. Per case** (today) | Human approves each `decision_id` | Maximum safety; caps coverage; human cost floor |
| **B. Batch approval** | Human reviews a set and approves it as one action; rows minted per decision | Better throughput; review quality degrades with batch size |
| **C. Scoped policy approval** | Human approves a versioned, expiring, narrowly-scoped policy ("shortage_quantity, Walmart, < $500, signed POD present, calibrated P(win) > 0.7"); the orchestrator mints approval rows under it, each carrying the policy id | Preserves audit trail and separation of duties; unlocks the tail; requires the trigger to accept policy-derived approvals — a real change to a one-way door |
| **D. Post-hoc sampling** | Auto-file below a threshold, human audits a sample | Highest throughput; weakest control; hardest to defend to a customer |

**Recommendation: design toward C, gate it on measured calibration, and write the ADR before writing the migration.** C keeps every property that makes invariant 1 valuable — an auditable human decision, separation of duties, append-only, a named accountable actor — while moving the human from *per artifact* to *per policy*. It also makes the safety story better, not worse: a scoped policy is reviewable in advance and revocable, where per-case approval at volume degrades into rubber-stamping, which is the illusion of control.

Preconditions before any policy-derived approval ships:
- Per-tenant calibration exists and ECE is measured (CH-2)
- The counterfactual log is running so coverage and precision are both observable (ADD-1)
- Policies are versioned, effective-dated, expiring, and auto-demote on a precision drop — the same discipline Phase 5 already applies to rules
- Shadow mode first: mint nothing, log what the policy *would* have approved, compare against what humans actually approved

**Do not implement C by loosening the trigger.** If it happens, it happens as a new, explicitly-modelled approval kind with its own constraints, and the existing per-case path stays the default.

---

## 9. Sequencing

| Stage | Work | Go / no-go |
|---|---|---|
| **Now** | ADD-1 counterfactual log; CH-3/CH-4 identity + sources; finish Phase 1 (upload route, Inngest binding) | Counterfactual rows accumulating on every declined case |
| **1.5** | ERP (QBO) read: discovery + reconciliation + coverage denominator; **ADD-7 Jev triage tier** (§6.3) | Deductions discovered that the customer never surfaced; triage cost per candidate under a cent |
| **2** | Phase 2 decision layer with **EV gating** (CH-1) and **owned calibration** (CH-2); ADR 0020 agent-facing decision tool; **ADD-8 enumerate-then-choose evidence planning**; portal credentialed read | ECE measurable per tenant; coverage rate computable |
| **2.5** | EDI 812/820 ingestion where available | — |
| **3** | Packet + approval + manual submission + outcomes; ADD-5 denial/re-file | Recovery rate measurable end to end |
| **4** | QBO write-back, attribution, contingency billing, ADD-4 dilution view | Collection rate closed |
| **5** | Learning loop; policy approvals in **shadow only** (§8) | Shadow policy precision ≥ human approval precision |
| **6** | Careful autonomy where calibration sustains it; `portal_agent` built as a typed action space over a DOM index, not screenshots (§6.8) | Per-tenant ECE < 0.10 sustained |

---

## 10. Risks

- **Approval throughput** is the binding constraint on the whole thesis (§8). Everything else is solvable; this one is structural.
- **One-time cleanup churn:** brands may leave once their back-deduction pile is cleared. Prevention/root-cause (Phase 5) and the dilution view (ADD-4) are the retention answers, and they need to exist before churn shows up, not after.
- **100% across four eval suites means the corpus isn't hard enough yet.** The README already says this. Real customer documents — dense retailer tables with merged cells, notices in email bodies, EDI-derived portal exports — are worth more than more synthetic ones.
- **Portal access is operationally fragile** (MFA, rotation, ToS) and is a dependency the competition also has. Degrade to upload, never fail the case.
- **Glimpse is better capitalised** (~$52M, a16z). We do not win on feature race. We win on recovery rate, verifiability, and coverage of what they decline to touch.
- **Jev is early access and a single vendor on a money path.** The `DecisionProvider` port with a Claude structured-output fallback is the right mitigation and already exists — keep the fallback genuinely exercised in CI rather than nominal, and keep cassettes recorded for both providers as `CLAUDE.md` already requires. Widening Jev's role (§6) widens this exposure, which is a reason to keep the port strict, not a reason to avoid the widening. The same applies to any small fast generative model added for narratives or keystrokes (§6.8) — port, fallback, cassettes, or not at all.

---

## 11. Caveats on external figures

- Glimpse's traction claims (200+ brands, 91% win rate, ~$1B invoices processed, 14x growth) are company-reported marketing from its funding announcement, not audited.
- Deduction load (2–15% of gross sales), invalid share (10–40%), and never-disputed (~70%) are vendor and consultant estimates. There is no public industry-wide benchmark. The README's own "5% and 15%" framing is the right level of hedging — keep it.
- Retailer-specific mechanics (KeHE's window, Walmart APDP behaviour) must be verified against current retailer documentation before being encoded as playbook data, and playbook facts should carry provenance — which the Phase 2 design already requires.

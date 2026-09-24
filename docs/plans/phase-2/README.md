# Phase 2 plan — evidence, a model's decision, and what it is scored against

*Drafted 2026-09-24. **A plan, not a build.** Nothing here is implemented. It
waits for the founder's approval, and each proposed ADR takes a number only
when it is accepted (CLAUDE.md: fetch, check `origin/main` and open PRs, then
take the number).*

## In plain language

Today a person decides every dispute. Phase 2 has three parts:

1. **A model decides alongside the person, in the background, as a "shadow".**
   A person still decides and still approves; nothing the model says moves a
   case.
2. **We score the model against what people actually decided.**
3. **Only if the score is good do we let the model's answer route cases.**
   Even then a person still approves every filing: the approval trigger does
   not move.

Alongside that, Phase 2 adds the two things a decision needs:

- **Evidence:** which documents a dispute needs, and where to get them.
- **Playbooks:** each retailer's rules, stored as versioned data rather than
  code.

It also adds reading retailer portals. **Read only, never submitting.**

**The honest constraint:** there is **one** human decision in production to
score against, made on a synthetic document. A model cannot be scored against
one decision. What Phase 2 needs most from the business side is decided cases,
and those need real customer documents. Every step below is ordered so that
the useful work, which needs no score, comes first, and the steps that need a
score wait for one.

## What exists and what does not

Checked against `origin/main` on 2026-09-24.

| Piece | State |
| --- | --- |
| The `DecisionProvider` port, schemas A–D, 255-option cap, "no document text in state" check | **Built** (`packages/decision`) |
| A Jev client | **Not built.** No endpoint, no SDK, only `TYPESAFE_API_KEY` in `.env.example` |
| The Claude structured fallback | **Not built.** STRATEGY §10 says it "already exists"; it does not |
| Decision cassettes | **None.** All 55 cassettes are extraction recordings |
| The `decisions` table, the approval trigger, separation of duties | **Built**, and exercised by humans |
| Phase 2 state-machine edges (`classified → evidence_pending → evidence_complete → decided → routed`) | **Declared, and no guard has an evaluator** |
| Expected-value routing, calibration, ECE | **Nothing** |
| Playbooks, `retailer_code_maps` | **No table, no package.** `reason-codes.ts` points at a table that does not exist |
| Evidence sources | **Interface only**, with no implementation. **Four evidence vocabularies disagree** (see draft E) |
| Portal read | **No interface.** `portal_fetch` exists as an upload source in the database |
| Triage step B (shadow model tier) | **Conditions fixed** (ADR 0043), nothing built |

Three things found while planning that any design has to fix first:

1. **A model decision and a human decision can never be matched by their
   input hash.** The two are computed by different functions over different
   inputs (`workflow.ts:374` vs `decision/src/validate.ts:26`). See draft C.
2. **A human decision is not in Schema B's shape.** It records a reason code
   and a sentence. Schema B asks for validity, basis, evidence sufficiency,
   win odds and an action. Human declines live in another table
   (`declined_candidates`). See draft C.
3. **Only a human decision can be packeted today.** `assemblePacket` reads
   `provider = 'human'` only. The packet's `submission_safe` guard is
   hard-wired to `true`, so Schema C (the verifier) never runs. That is fine
   while people decide, but it must change before any model decision can reach
   a packet. See draft G.

## The proposed decisions

In `adr-drafts/`, each marked *Proposed*.

| Draft | Decides | Migration? | Needs Jev? |
| --- | --- | --- | --- |
| **A** [Model opinions are recorded in shadow](adr-drafts/A-model-opinions-are-recorded-in-shadow.md) | One append-only table for every model opinion (triage and decision), `mode = 'shadow'` only. A model opinion never touches `decisions` until promoted | yes (0034 or next) | no |
| **B** [Two decision providers, one port](adr-drafts/B-decision-providers-jev-and-claude.md) | The Claude structured provider first, Jev when access arrives, fallback only on "unavailable", cassettes for both, cost below a micro-dollar | small (`model_calls.purpose`) | Jev half only |
| **C** [One decision state, one hash, for people and models](adr-drafts/C-one-decision-state-one-hash.md) | A single pinned case snapshot every decider sees, so a person and a model can be compared on the same case | yes (a hash column) | no |
| **D** [Playbooks are versioned data](adr-drafts/D-playbooks-are-versioned-data.md) | Retailer rules and code maps as effective-dated rows with provenance. Payer codes (e.g. `CB-203`) map to canonical codes deterministically | yes | no |
| **E** [Evidence planning is enumerate-then-choose](adr-drafts/E-evidence-planning-enumerate-then-choose.md) | One evidence vocabulary. Code lists what is missing and who can supply it; a model (or a rule) only picks from that list | yes (checklist table) | optional |
| **F** [Calibration is ours](adr-drafts/F-calibration-is-ours.md) | A calibrator fitted on our own won/lost outcomes, per tenant and retailer family. The provider's number is an input, never the answer | yes | no |
| **G** [Routing by expected value](adr-drafts/G-routing-by-expected-value.md) | `P(win) × amount − cost to file` decides queue versus analyst. Thresholds only tighten. The approval trigger is untouched | yes (guarded columns) | no |
| **H** [Portal read](adr-drafts/H-portal-read.md) | Credentialed read of retailer portals, one retailer at a time, with credentials sealed like QuickBooks tokens and a failure that degrades to upload. **No write** | yes | no |

## Order of work, and what gates each step

Task files are in `tasks/`. Each is small and ends in a PR with
`pnpm verify` green.

| # | Task | Gate before it starts | Needs money? |
| --- | --- | --- | --- |
| 01 | [Unify the evidence vocabulary](tasks/01-evidence-vocabulary.md) | draft E accepted | no |
| 02 | [The decision state builder and its hash](tasks/02-decision-state.md) | draft C accepted | no |
| 03 | [Human decisions in a comparable shape](tasks/03-human-decisions-comparable.md) | 02 | no |
| 04 | [Playbook tables and the payer-code map](tasks/04-playbooks.md) | draft D accepted | no |
| 05 | [The shadow opinions table](tasks/05-shadow-opinions.md) | draft A accepted | no |
| 06 | [Claude structured provider + cassettes + `decisions` eval suite](tasks/06-claude-provider.md) | 02, 05, draft B | **yes**, to record cassettes (≈ $1–3, asked first) |
| 07 | [Jev provider + cassettes](tasks/07-jev-provider.md) | Jev access (`jev-requirements.md`) and the DPA decision | yes (Jev pricing) |
| 08 | [Triage step B in shadow](tasks/08-triage-shadow.md) | 05, 06 or 07, ADR 0043's conditions | small |
| 09 | [Evidence planning](tasks/09-evidence-planning.md) | 01, 04 | no, for rules; yes if a model picks |
| 10 | [Decision in shadow, scored against people](tasks/10-decision-shadow.md) | 03, 06, and **≥ 30 human decisions** to score against | small |
| 11 | [Calibration](tasks/11-calibration.md) | draft F, and outcomes recorded on ≥ 50 filed cases | no |
| 12 | [Expected-value routing](tasks/12-ev-routing.md) | draft G, 10 and 11 meeting their go/no-go | no |
| 13 | [Portal read, first retailer](tasks/13-portal-read.md) | draft H, a customer with that portal, and its ToS read | no |

**The go/no-go for Phase 2 as a whole** (STRATEGY §9): calibration error
(ECE) is measurable per tenant, and coverage is computable. The model decision
is promoted from shadow only when:

- on the same cases, its agreement with human decisions reaches a threshold
  the founder sets in advance (draft G proposes a starting point);
- its decline precision is measured on the declines people actually made;
- both cassettes are recorded.

## What is not in Phase 2

Each of these is refused by name, per CLAUDE.md's build order:

- **Portal write** of any kind, browser-agent submission, auto-submission:
  Phase 6.
- **NetSuite / Xero:** after QuickBooks, on the same port.
- **Anything that sends something outward without an `approvals` row.**
  Invariant 1 and its trigger are unchanged by every draft here.
- **Loosening any threshold.** New thresholds join the tighten-only guard.
- **Giving a model document text.** Every draft keeps state to extracted
  fields and our own computed numbers.

## What is needed, and from whom

- **From TypeSafe (Jev):** see [`jev-requirements.md`](jev-requirements.md).
  Access, the API contract, data handling (a DPA), pricing confirmation,
  version pinning, and permission to commit recorded responses as test
  fixtures.
- **From the founder:**
  - approve or amend drafts A–H;
  - decide whether TypeSafe becomes a sub-processor of customers' ledger data
    (ADR 0043's condition);
  - set the agreement threshold for promotion in advance;
  - and above all, get **real customer documents**, so there are real
    decisions to score against.
- **Money:** recording decision cassettes (task 06) costs a few dollars on the
  Claude API and is asked for before it is spent. Jev's cost is to be
  confirmed.

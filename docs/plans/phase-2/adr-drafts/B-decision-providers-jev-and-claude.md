# Draft B — Two decision providers behind one port: Claude structured now, Jev when access arrives

- Status: **proposed**
- Date: 2026-09-24
- Builds on: invariant 5, `packages/decision` (port and Schemas A–D, built),
  STRATEGY §6 and §10

## Context

`DecisionProvider` exists with its question types, Schemas A–D, the
255-option cap and the "no document text" check. **Nothing implements it.**
There is no Jev client, no Claude fallback (STRATEGY §10 says it "already
exists"; it does not) and no decision cassette. CLAUDE.md requires a recorded
fixture for **both** the Jev call and the Claude call on every decision path.

Jev access is early-access and not yet granted (`jev-requirements.md`).

## Decision

1. **Two implementations of the one port:**
   - `ClaudeStructuredDecisionProvider` (`packages/decision/src/claude.ts`);
   - `JevDecisionProvider` (`packages/decision/src/jev.ts`).

   App code sees neither. It asks a `DecisionProvider` built by one factory,
   `decisionProviderFromEnv`, which has `scannerFromEnv`'s shape: one place
   decides, and a missing key is `not_configured`, never a silent default.
2. **Order: Jev first, Claude on `DecisionUnavailableError` only.** A contract
   error is a bug and is not retried on the other provider. Each answer
   records which provider gave it. Until Jev access exists, the factory
   builds the Claude provider alone.
3. **The Claude provider:**
   - calls with **no `tools` parameter**;
   - uses a structured-output schema generated from the question set.
     Choice → an enum; score → an enum of levels; noul → a boolean. The
     question count stays under the grammar limit ADR 0008 found, so a large
     schema is split into several calls.
   - The state goes in as JSON **facts**, never document text.
     `assertStateIsStructured` runs before every call.
   - It asks for a probability per answer. That is a self-report, and draft F
     is why it is never used as a win probability.
   - A new `ModelRole` `decide`, overridable with `RECOUPLE_DECIDE_MODEL`.
     Where the model accepts `temperature`, it is pinned to 0, the way the
     classifier is.
4. **The Jev provider** maps choice, score and noul onto Jev's API (to be
   confirmed) and records the full distribution, the exact model version and
   the token count. The HTTP client reads no environment variable; the
   factory does.
5. **Cost below a micro-dollar.** `RATES` holds whole micro-dollars per
   token, and Jev's reported $0.042/MTok is 0.042 of one. Rates move to
   **nano-dollars per token**. `cost_micros` is still what is stored, rounded
   up per call, so a thousand free-looking calls do not sum to zero. A price
   nobody has confirmed records 0 and is reported as unpriced, as today.
6. **Cassettes:**
   - `packages/fixtures/decision-cassettes/<schema>/<case>.json`, one per
     provider per case, recorded by `pnpm record:cassettes --decisions`, which
     spends money and asks first;
   - replayed by `CassetteDecisionProvider` under `@recouple/decision/testing`,
     never reachable from production (CLAUDE.md);
   - a `decisions` eval suite scores them (draft G).
7. **`model_calls.purpose`**: `decide` exists already; `triage` is added by
   draft A.

## Options not taken

- **Calling the Anthropic SDK from the pipeline directly for a quick
  decision.** Invariant 5.
- **Jev only, waiting for access.** It would put all of Phase 2 behind a
  vendor's calendar, with nothing to fall back to.
- **Letting the provider return free text and parsing it.** The point of the
  port is typed answers from a closed set.

## Consequences

- Triage step B and the shadow decision can run on Claude before Jev exists,
  and are compared with Jev on the same cases when it arrives.
- Recording cassettes for the fixture cases costs a few dollars on Claude;
  Jev's cost is to be confirmed.
- The fallback is exercised in CI, because both providers have cassettes, not
  just claimed.

## Open questions

The API contract, determinism and data handling: `jev-requirements.md`.

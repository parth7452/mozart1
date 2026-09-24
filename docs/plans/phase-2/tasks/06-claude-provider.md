# 06 — Claude structured provider, cassettes, and a `decisions` eval suite

*Phase 2 plan task. Not started; waits for approval.*

**Starts when:** 02, 05, draft B accepted.

## Steps
- `ClaudeStructuredDecisionProvider`: no `tools` parameter, structured output from the question set (split under ADR 0008's grammar limit), `ModelRole` `decide`, temperature pinned where accepted.
- `decisionProviderFromEnv` factory; `CassetteDecisionProvider` under `@recouple/decision/testing` only.
- Nano-dollar rates so sub-micro prices are exact (draft B §5).
- `pnpm record:cassettes --decisions` (**spends money — ask first**; estimate a few dollars for the fixture cases) and a `decisions` eval suite scored against the fixtures' author labels (`customer/case_ground_truth.json`, LOG-001) — labelled plainly as agreement with the author, not with the market.

## Done when
- Every decision path has a recorded Claude cassette; CI replays them; the fallback path is exercised by a test that makes the Jev provider unavailable.
- `pnpm verify` green; any migration applied to `mozart-preview` first, then production, read back on both.

# What we need from TypeSafe (Jev) before triage step B or Phase 2 can use it

*2026-09-24. A list to send, or to work through on a call. Every item is
something the code or the contract will depend on, not a nice-to-have. The
repo today holds only `TYPESAFE_API_KEY=` and `JEV_MODEL=jev-latest` in
`.env.example`. There is no endpoint, contract or data-handling document
anywhere.*

## 1. Access

1. **Early-access credentials:** one key for production and a **separate key
   for test and recording**, so cassettes are never recorded on the
   production key.
2. **When access starts**, and whether the early-access terms allow a
   production money path. Our decisions route real disputes, but a person
   always approves.
3. **A support and escalation contact**, and how outages are announced.

## 2. The API contract

What `JevDecisionProvider` has to implement. It sits behind our existing
`DecisionProvider` port (invariant 5); nothing else in the app calls Jev.

4. **The endpoint URL(s)**, the authentication scheme, and the request and
   response schema. In particular, how a question set is sent:
   - our three kinds are **choice** (up to 255 options, one or several
     answers), **score** (ordered levels) and **noul** (yes/no);
   - can several questions go in one call, and are they answered
     independently?
5. **Limits:**
   - confirm the **255-option** maximum for a choice;
   - the maximum input size;
   - the maximum questions per call;
   - rate limits;
   - whether requests can run concurrently.
6. **What comes back for every answer:**
   - the chosen value;
   - its probability;
   - **the full distribution over every option**, which we store as
     `raw_probabilities` for our own calibration;
   - **the exact model version that answered**, which we record per decision
     (`decisions.model_version`);
   - input token counts, so we can record cost per call (`model_calls`).
7. **Determinism:** does the same input give the same distribution? Is there a
   seed or a pinned-version parameter? Our evals replay recorded answers, so
   we need to know what a re-recording can change.
8. **Latency:** the typical and 99th-percentile latency, and the timeout you
   recommend.
9. **Errors:** the full list of error responses. We treat "unavailable" (5xx,
   timeouts, rate limits) differently from "you sent something invalid", and
   we fall back to our Claude provider only on the first.
10. **Idempotency:** can a request carry a key, so a retried delivery is not
    billed or answered twice?

## 3. Calibration — what the probabilities mean

11. What "calibrated" means here: calibrated on what data, and per question
    or globally?
12. Is a score question's distribution ordered and complete?
13. How a multiple-answer choice reports probabilities: one per option,
    independent?

We treat Jev's probability as the best **input** to our own calibrator, fitted
on our won/lost outcomes. It is never the final win probability (STRATEGY
CH-2). Nothing in the answers above changes that; they tell us how to use it.

## 4. Data handling — **a decision for the founder as well as for them**

ADR 0043 makes this a condition of turning anything on. What Jev would see:

- extracted fields and our own computed numbers: amounts, dates, reason codes,
  evidence present or missing;
- **never document text, and never the payer's own memo text**.

For ledger triage, the fields come from customers' QuickBooks data. What we
need from TypeSafe:

14. **A DPA** (data processing agreement), with TypeSafe as a sub-processor.
    Customers will need it listed in our privacy policy (see
    `docs/VERIFY-CHECKLIST.md` §1).
15. **Retention:** is request data stored? For how long? Can it be zero?
16. **Training:** is customer data used to train or improve models? We need
    **no**, in writing.
17. **Where it is processed** (region), their security attestations (for
    example SOC 2), and breach notification terms.
18. **Their sub-processors.**

## 5. Money

19. **Confirm the price:** STRATEGY records $0.042 per million input tokens
    and free output, as TypeSafe reported it. Also billing terms, and any
    minimums.
20. **How cost is reported per call,** so our `model_calls.cost_micros` is
    exact rather than estimated.

Our price table holds whole micro-dollars per token; Jev's price is 0.042 of
one. Draft B handles that on our side.

## 6. Versions and fixtures

21. **Version pinning and deprecation:** can we pin a model version? How much
    notice before a version changes or is retired? A silent model change would
    shift every decision without a record, which is exactly what our
    `model_version` column exists to catch.
22. **Permission to commit recorded responses to our private repository** as
    test fixtures ("cassettes"). CLAUDE.md requires a recording of both the Jev
    call and the Claude call for every decision path.

## What happens without Jev

Nothing waits on it except Jev itself. The plan's Claude structured provider
(task 06) implements the same port, and can run triage step B and the shadow
decision on its own. Jev is added when access, the DPA and the answers above
are in hand. Each decision row records which provider answered, so the two
can be compared on the same cases.

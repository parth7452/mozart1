# Draft F — Win probability is calibrated on our own outcomes, never taken from a provider

- Status: **proposed**
- Date: 2026-09-24
- Builds on: STRATEGY CH-2, `decisions.raw_probabilities`, the
  `outcome.recorded` events of ADR 0020 §3

## Context

A provider's probability, Jev's included, says how sure it is about the
question as posed. It does not say whether a particular payer accepts a
particular kind of dispute backed by a particular set of evidence. Only our
own won, lost and partial outcomes say that. Using a provider's number as
P(win) would:

- hand the one compounding asset of the business to a vendor (STRATEGY §3.3);
- misprice every dispute for a payer whose behaviour differs from the vendor's
  training.

**Today there are too few outcomes to fit anything.** One case has an outcome
(`partial`, 2026-09-21), and it is synthetic.

## Decision

1. **A calibrator we own:** a pure function in `core-domain`,
   `calibrate(features, model) → P(win)`. Its model is stored as versioned rows
   (`calibration_models`, append-only):
   - a monotone (isotonic) map from a provider's raw probability to an
     observed win rate;
   - per segment: tenant × payer family × reason family, pooled upward
     (payer → all payers → global) when a segment has too few outcomes;
   - with the reliability curve and the ECE it was fitted with.
2. **The features** are the provider's raw probability, if any, plus our own
   facts: amount band, evidence present/missing, days to deadline, payer and
   reason family. Never text.
3. **A win is recovered cents over filed cents,** from `outcome.recorded`. A
   `partial` counts proportionally. A case filed with no outcome after the
   payer's window is `unknown` and excluded, never counted as lost.
4. **Until a segment has at least 30 outcomes, P(win) is a conservative
   prior** (the pooled rate, shrunk towards 0.5, and never above it), and the
   case says "uncalibrated". Draft G's router refuses to auto-queue anything
   on an uncalibrated probability.
5. **ECE per tenant** is computed on every refit and shown. STRATEGY §9's
   Phase 2 go/no-go is that it is measurable. Phase 6's autonomy gate is ECE
   < 0.10, sustained.
6. **A refit is a new model version.** Every routed decision records the
   calibration version it used, so a past decision can be explained with the
   model it actually used.

## Options not taken

- **Use Jev's probability directly.** CH-2 explains why it is a feature, not
  the answer.
- **Platt scaling.** It is fine with plenty of data and fragile with little.
  Isotonic with pooling degrades more honestly. Revisit when segments are
  large.
- **Wait until there are thousands of outcomes.** The prior-plus-pooling path
  makes the gate usable, and safe, before then.

## Consequences

- Nothing routes on a probability until outcomes exist, which is correct and
  slow. **Real customer cases** are the bottleneck, as everywhere in this
  plan.
- Coverage and recovery rate become explainable per segment.

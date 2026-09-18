---
description: Run the eval suites and compare against the recorded baseline
---

Run the eval suites for the packages this change touches, then report:
extraction field precision/recall, classification accuracy, decision
calibration (ECE, Brier), and end-to-end case outcomes — each against the
recorded baseline, with the delta.

Fail the run if any metric regresses beyond tolerance, or if ECE exceeds 0.10
for any tenant. Record the run so the next comparison has a baseline. Never
adjust a baseline to make a run pass.

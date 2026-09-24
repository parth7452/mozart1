import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { classificationIsActionable, DEFAULT_MIN_CLASSIFICATION_CONFIDENCE } from '../src/index';

/**
 * The classification floor, as `readDocument` asks it (ADR 0044).
 *
 * The question is whether a notice or a remittance may open its case(s) with
 * nobody looking. The boundary is inclusive, because the recorded LOG-001
 * remittance classifies at exactly 0.95 against the default 0.950 floor and has
 * always opened its case. Everything that is not a probability fails closed:
 * the answer that holds a document for a person is the one that cannot open a
 * case on a number no classifier produced.
 */
describe('classificationIsActionable', () => {
  it('is inclusive at the floor', () => {
    expect(DEFAULT_MIN_CLASSIFICATION_CONFIDENCE).toBe(0.95);
    expect(classificationIsActionable(0.95)).toBe(true);
    expect(classificationIsActionable(0.95, 0.95)).toBe(true);
    // The number a `numeric(4,3)` floor of 0.950 arrives as, parsed.
    expect(classificationIsActionable(0.95, Number('0.950'))).toBe(true);
  });

  it('holds the readings the corpus once recorded below the floor', () => {
    // stf-203-short-payment-notice, a notice read as a remittance before the
    // classifier learned that a short payment notice is a notice.
    expect(classificationIsActionable(0.75)).toBe(false);
    // stf-201-short-pay-remittance, a remittance read correctly but unsurely —
    // as it was recorded before the classifier's temperature was pinned. Both
    // now read 0.95 and open; these are still the shape of a doubtful read.
    expect(classificationIsActionable(0.92)).toBe(false);
    expect(classificationIsActionable(0.9499999)).toBe(false);
    expect(classificationIsActionable(0.99)).toBe(true);
    expect(classificationIsActionable(1)).toBe(true);
  });

  it('honours a tenant that has raised its floor', () => {
    expect(classificationIsActionable(0.96, 0.99)).toBe(false);
    expect(classificationIsActionable(0.99, 0.99)).toBe(true);
    // A floor of 1 holds everything short of certainty; one of 0 holds nothing.
    expect(classificationIsActionable(0.999, 1)).toBe(false);
    expect(classificationIsActionable(0, 0)).toBe(true);
  });

  it('is not actionable for a confidence that is not a probability', () => {
    for (const confidence of [
      Number.NaN,
      -0.01,
      -1,
      1.0001,
      2,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      expect(classificationIsActionable(confidence), String(confidence)).toBe(false);
    }
  });

  it('is not actionable against a floor that is not a probability', () => {
    // A negative floor would otherwise let everything through, and a NaN one
    // would hold everything by accident rather than on purpose. Both answer
    // false, deliberately: a floor nobody set is not a reason to act.
    for (const floor of [Number.NaN, -0.5, 1.5, Number.POSITIVE_INFINITY]) {
      expect(classificationIsActionable(0.99, floor), String(floor)).toBe(false);
    }
  });

  it('agrees with a plain comparison everywhere inside [0, 1]', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (confidence, floor) => {
          expect(classificationIsActionable(confidence, floor)).toBe(confidence >= floor);
        },
      ),
    );
  });
});

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { quarantine } from '@recouple/core-domain';
import { DecisionContractError, MAX_CHOICE_CARDINALITY, type DecisionState } from '../src/types';
import {
  assertQuestionSetValid,
  assertStateIsStructured,
  canonicalJson,
  inputStateHash,
} from '../src/validate';

const state = (facts: DecisionState['facts']): DecisionState => ({
  orgId: '11111111-1111-1111-1111-111111111111',
  deductionId: '22222222-2222-2222-2222-222222222222',
  facts,
});

describe('question set validation', () => {
  it('rejects an empty set', () => {
    expect(() => assertQuestionSetValid({})).toThrow(DecisionContractError);
  });

  it('rejects a choice that exceeds the provider’s cardinality limit', () => {
    const tooMany = Array.from({ length: MAX_CHOICE_CARDINALITY + 1 }, (_, i) => `option_${i}`);
    expect(() =>
      assertQuestionSetValid({
        overflowing: { kind: 'choice', prompt: 'too many', options: tooMany },
      }),
    ).toThrow(/family \+ sub-code/);
  });

  it('rejects duplicate options and single-level scores', () => {
    expect(() =>
      assertQuestionSetValid({
        dupes: { kind: 'choice', prompt: 'dupes', options: ['a', 'a'] },
      }),
    ).toThrow(/duplicate/);
    expect(() =>
      assertQuestionSetValid({ flat: { kind: 'score', prompt: 'flat', levels: ['only'] } }),
    ).toThrow(/at least two levels/);
  });
});

describe('structured state only', () => {
  it('accepts extracted fields', () => {
    expect(() =>
      assertStateIsStructured(
        state({ claim_id: 'APDP-99812', shortage_cents: 312000, lines: [{ sku: '0001' }] }),
      ),
    ).not.toThrow();
  });

  it('refuses document-sized text', () => {
    expect(() => assertStateIsStructured(state({ notice_text: 'x'.repeat(1001) }))).toThrow(
      /extracted values, not document text/,
    );
  });

  it('refuses quarantined document text, however deeply nested', () => {
    expect(() =>
      assertStateIsStructured(state({ evidence: [{ excerpt: quarantine('hello') }] })),
    ).toThrow(/quarantined document text/);
  });
});

describe('input state hashing', () => {
  it('is stable regardless of key order', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), fc.integer(), {
          maxKeys: 8,
        }),
        (facts) => {
          const reversed = Object.fromEntries(Object.entries(facts).reverse());
          expect(inputStateHash(state(facts))).toBe(inputStateHash(state(reversed)));
        },
      ),
    );
  });

  it('changes when any fact changes, so re-deciding is not skipped by mistake', () => {
    const a = inputStateHash(state({ amount_cents: 312_000 }));
    const b = inputStateHash(state({ amount_cents: 312_001 }));
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('serialises nested values deterministically', () => {
    expect(canonicalJson({ b: 1, a: [3, { d: 4, c: 5 }] })).toBe('{"a":[3,{"c":5,"d":4}],"b":1}');
  });
});

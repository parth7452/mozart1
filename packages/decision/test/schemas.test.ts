import { describe, expect, it } from 'vitest';
import {
  CANONICAL_REASON_CODE_LIST,
  REASON_CODE_CARDINALITY_CEILING,
} from '@recouple/core-domain';
import {
  SCHEMAS,
  SCHEMA_A_CLASSIFY,
  SCHEMA_C_REQUIRED_TRUE,
  SCHEMA_C_VERIFIER,
  SCHEMA_VERSION,
} from '../src/schemas';
import { MAX_CHOICE_CARDINALITY } from '../src/types';
import { assertQuestionSetValid } from '../src/validate';

describe('decision schemas A–D', () => {
  it('are all valid against the provider’s limits', () => {
    for (const [id, questions] of Object.entries(SCHEMAS)) {
      expect(() => assertQuestionSetValid(questions), `schema ${id}`).not.toThrow();
    }
  });

  it('keeps the reason-code choice well inside the cardinality ceiling', () => {
    expect(SCHEMA_A_CLASSIFY.canonical_reason_code.options).toEqual(CANONICAL_REASON_CODE_LIST);
    expect(REASON_CODE_CARDINALITY_CEILING).toBeLessThan(MAX_CHOICE_CARDINALITY);
    expect(SCHEMA_A_CLASSIFY.canonical_reason_code.options.length).toBeLessThan(
      MAX_CHOICE_CARDINALITY,
    );
  });

  it('pins a schema version, because every decision row stores one', () => {
    expect(SCHEMA_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('makes the verifier a set of booleans that must all be true', () => {
    for (const question of Object.values(SCHEMA_C_VERIFIER)) {
      expect(question.kind).toBe('noul');
    }
    expect([...SCHEMA_C_REQUIRED_TRUE]).toEqual(Object.keys(SCHEMA_C_VERIFIER));
    expect(SCHEMA_C_REQUIRED_TRUE).toContain('submission_safe');
  });
});

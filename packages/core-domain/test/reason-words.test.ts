import { describe, expect, it } from 'vitest';
import { CANONICAL_REASON_CODE_LIST, isCanonicalReasonCode } from '../src/reason-codes';
import {
  DISPUTE_REASON_CODES,
  DISPUTE_REASONS,
  REASON_WORDS,
  REASON_WORDS_MAX_LENGTH,
  reasonInWords,
} from '../src/reason-words';

/**
 * The words a reason code is shown as — on the decide form and in the letter a
 * payer reads. One list, so what a person picks is what the payer is told.
 */
describe('reason words', () => {
  it('has words for every canonical code and for nothing else', () => {
    expect(Object.keys(REASON_WORDS).sort()).toEqual([...CANONICAL_REASON_CODE_LIST].sort());
  });

  it('keeps every entry inside the budget the packet narrative counts on', () => {
    for (const code of CANONICAL_REASON_CODE_LIST) {
      const words = reasonInWords(code);
      expect(words.trim(), code).toBe(words);
      expect(words.length, code).toBeGreaterThan(0);
      expect(words.length, code).toBeLessThanOrEqual(REASON_WORDS_MAX_LENGTH);
    }
  });

  // The engine is payer-agnostic (CLAUDE.md): a reason names what is wrong with
  // the deduction, never which kind of business took it, and never shows a
  // code to a payer.
  it('names no kind of payer and shows no code', () => {
    for (const code of CANONICAL_REASON_CODE_LIST) {
      expect(REASON_WORDS[code].toLowerCase(), code).not.toMatch(
        /retailer|distributor|shipper|broker/,
      );
      expect(REASON_WORDS[code], code).not.toMatch(/_/);
    }
  });

  it('gives no two codes the same words', () => {
    const all = Object.values(REASON_WORDS);
    expect(new Set(all).size).toBe(all.length);
  });

  it('offers on the form only canonical codes, each once, with their words', () => {
    expect(new Set(DISPUTE_REASON_CODES).size).toBe(DISPUTE_REASON_CODES.length);
    for (const [code, words] of DISPUTE_REASONS) {
      expect(isCanonicalReasonCode(code), code).toBe(true);
      expect(words).toBe(REASON_WORDS[code]);
    }
    expect(DISPUTE_REASONS.map(([code]) => code)).toEqual([...DISPUTE_REASON_CODES]);
  });

  // Pilot E5 put these on the form for the pilot verticals, after pilot E1 had
  // moved the list here. `views.test.tsx` renders whatever the list holds, so a
  // merge that dropped one would pass there; it fails here.
  it('keeps the eleven codes pilot E5 added on the form', () => {
    const pilot = [
      'shortage_carton',
      'shortage_pallet',
      'compliance_early_delivery',
      'compliance_appointment_missed',
      'compliance_routing_guide',
      'return_unsaleable',
      'promo_duplicate_allowance',
      'detention_or_layover',
      'quality_expired_short_dated',
      'quality_spec_mismatch',
      'administrative_fee',
    ] as const;
    const offered: readonly string[] = DISPUTE_REASON_CODES;
    for (const code of pilot) {
      expect(isCanonicalReasonCode(code), code).toBe(true);
      expect(offered, code).toContain(code);
    }
  });
});

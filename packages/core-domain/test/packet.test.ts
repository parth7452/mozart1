import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  buildPacketNarrative,
  MAX_NARRATIVE_LENGTH,
  MAX_RATIONALE_LENGTH,
  NARRATIVE_BUDGET_WITHOUT_RATIONALE,
  NOT_RECORDED,
  PacketError,
  packetContentHash,
  type PacketNarrativeInput,
} from '../src/packet';
import { CANONICAL_REASON_CODE_LIST } from '../src/reason-codes';
import { formatCents, cents } from '../src/money';

/**
 * The packet narrative is the one thing in the dispute a model does not write
 * (ADR 0020 §2), and the content hash it feeds is what an approval names and a
 * submission repeats. So the properties that matter are exactly three: it is a
 * pure function of its input, it says everything it was told, and it never
 * prints money as anything but exact cents.
 */

const anyText = fc
  .string({ minLength: 1, maxLength: 40 })
  // A value that is only whitespace is "not recorded" as far as a reader is
  // concerned, and the builder refuses an empty rationale; the properties below
  // are about values that are really there.
  .filter((s) => s.trim() !== '' && s === s.trim());

// `exactOptionalPropertyTypes` is on, so an absent field is an absent key
// rather than a key holding undefined — which is also how the store builds
// this input, and therefore what the builder has to be exercised with.
const anyInput: fc.Arbitrary<PacketNarrativeInput> = fc
  .record({
    claimId: fc.option(anyText, { nil: undefined }),
    retailer: fc.option(anyText, { nil: undefined }),
    deductionAmountCents: fc.integer({ min: 1, max: 9_000_000_000_000 }),
    deductionDate: fc.option(fc.constantFrom('2026-08-14', '2025-01-02'), { nil: undefined }),
    disputeDeadline: fc.option(fc.constantFrom('2026-10-13', '2025-03-03'), { nil: undefined }),
    reason: fc.constantFrom(...CANONICAL_REASON_CODE_LIST),
    rationale: anyText,
    documents: fc.array(
      fc.record({
        role: fc.constantFrom('notice' as const, 'evidence' as const),
        filename: anyText,
      }),
      { minLength: 1, maxLength: 5 },
    ),
  })
  .map((raw) => ({
    deductionAmountCents: raw.deductionAmountCents,
    reason: raw.reason,
    rationale: raw.rationale,
    documents: raw.documents,
    ...(raw.claimId !== undefined ? { claimId: raw.claimId } : {}),
    ...(raw.retailer !== undefined ? { retailer: raw.retailer } : {}),
    ...(raw.deductionDate !== undefined ? { deductionDate: raw.deductionDate } : {}),
    ...(raw.disputeDeadline !== undefined ? { disputeDeadline: raw.disputeDeadline } : {}),
  }));

const walmart: PacketNarrativeInput = {
  claimId: 'APDP-41007',
  retailer: 'Walmart Stores, Inc.',
  deductionAmountCents: 312_000,
  deductionDate: '2026-08-14',
  disputeDeadline: '2026-10-13',
  reason: 'shortage_never_received',
  rationale: 'POD signed for the full quantity on 2026-08-02.',
  documents: [
    { role: 'notice', filename: 'apdp-notice.pdf' },
    { role: 'evidence', filename: 'pod-signed.pdf' },
  ],
};

describe('the packet narrative', () => {
  it('reads as a cover page a human would send', () => {
    expect(buildPacketNarrative(walmart)).toBe(
      [
        'DISPUTE PACKET — COVER NARRATIVE',
        '',
        'Retailer: Walmart Stores, Inc.',
        'Claim: APDP-41007',
        'Deduction amount: $3,120.00',
        'Deduction date: 2026-08-14',
        'Dispute deadline: 2026-10-13',
        'Dispute reason: shortage_never_received',
        '',
        'This deduction is disputed in full.',
        '',
        'Rationale: POD signed for the full quantity on 2026-08-02.',
        '',
        'Enclosed documents:',
        '  1. notice: apdp-notice.pdf',
        '  2. evidence: pod-signed.pdf',
        '',
      ].join('\n'),
    );
  });

  it('says a value was not recorded rather than inventing one', () => {
    const sparse = buildPacketNarrative({
      deductionAmountCents: 45_000,
      reason: 'unauthorised_deduction_no_basis',
      rationale: 'No backup was provided with the deduction.',
      documents: [{ role: 'notice', filename: 'notice.pdf' }],
    });
    expect(sparse).toContain(`Claim: ${NOT_RECORDED}`);
    expect(sparse).toContain(`Retailer: ${NOT_RECORDED}`);
    expect(sparse).toContain(`Deduction date: ${NOT_RECORDED}`);
    expect(sparse).toContain(`Dispute deadline: ${NOT_RECORDED}`);
    // The amount is never "not recorded": a case has one, and the column is
    // `not null check (> 0)`.
    expect(sparse).toContain('Deduction amount: $450.00');
  });

  it('is deterministic — the same case is the same bytes, every time', () => {
    fc.assert(
      fc.property(anyInput, (input) => {
        expect(buildPacketNarrative(input)).toBe(buildPacketNarrative(input));
      }),
    );
  });

  it('contains every field it was given, verbatim', () => {
    fc.assert(
      fc.property(anyInput, (input) => {
        const narrative = buildPacketNarrative(input);
        if (input.claimId !== undefined) expect(narrative).toContain(input.claimId);
        if (input.retailer !== undefined) expect(narrative).toContain(input.retailer);
        if (input.deductionDate !== undefined) expect(narrative).toContain(input.deductionDate);
        if (input.disputeDeadline !== undefined) {
          expect(narrative).toContain(input.disputeDeadline);
        }
        expect(narrative).toContain(input.reason);
        expect(narrative).toContain(input.rationale);
        for (const document of input.documents) {
          expect(narrative).toContain(`${document.role}: ${document.filename}`);
        }
      }),
    );
  });

  // Invariant 3, at the one place the number becomes a string. `formatCents`
  // is exact; `${cents / 100}` is not, and would print 31.200000000000003 for
  // a case nobody would notice until a reconciliation.
  it('prints money only as exact cents, never as a float', () => {
    fc.assert(
      fc.property(anyInput, (input) => {
        const narrative = buildPacketNarrative(input);
        const rendered = formatCents(cents(input.deductionAmountCents));
        // The money line, and only the money line: an analyst's rationale may
        // contain anything at all, so a check over the whole narrative would
        // be a check on their prose rather than on our arithmetic.
        const amountLine = narrative
          .split('\n')
          .find((line) => line.startsWith('Deduction amount: '));
        expect(amountLine).toBe(`Deduction amount: ${rendered}`);
        // Exactly two decimal places, and no more — a float would show up here
        // as a longer tail, an exponent, or a NaN.
        expect(amountLine).toMatch(/^Deduction amount: \$[\d,]+\.\d{2}$/);
        expect(amountLine).not.toMatch(/e[+-]/i);
        expect(amountLine).not.toContain('NaN');
      }),
    );
  });

  it('refuses money that is not an integer number of cents', () => {
    expect(() => buildPacketNarrative({ ...walmart, deductionAmountCents: 1800.5 })).toThrow(
      /integer cents/,
    );
    expect(() =>
      buildPacketNarrative({ ...walmart, deductionAmountCents: Number.MAX_VALUE }),
    ).toThrow(/safe integer/);
  });

  it('refuses a packet with nothing in it, and a dispute with no reason given', () => {
    expect(() => buildPacketNarrative({ ...walmart, documents: [] })).toThrow(PacketError);
    expect(() => buildPacketNarrative({ ...walmart, rationale: '   ' })).toThrow(PacketError);
    expect(() =>
      buildPacketNarrative({ ...walmart, reason: 'made_up_code' as never }),
    ).toThrow(PacketError);
    expect(() =>
      buildPacketNarrative({
        ...walmart,
        documents: [{ role: 'notice', filename: '  ' }],
      }),
    ).toThrow(PacketError);
  });

  it('refuses a narrative longer than the record that holds it', () => {
    expect(() =>
      buildPacketNarrative({ ...walmart, rationale: 'x'.repeat(MAX_NARRATIVE_LENGTH + 1) }),
    ).toThrow(/shorten the rationale/);
  });
});

/**
 * The rationale cap, and why a store checks it before it writes a decision.
 *
 * `decisions` is append-only and the packet is assembled later. A rationale
 * that only `packets.narrative` could refuse gets the case to `analyst_review`
 * and wedges it there: nothing can amend the decision, and nothing can build a
 * packet from it. So the cap has to be something a store can check *first*,
 * which means it has to be a number that always leaves room for everything
 * else the cover page prints.
 */
describe('the rationale budget', () => {
  /** The caps the budget is made of (see `NARRATIVE_BUDGET_WITHOUT_RATIONALE`). */
  const CAPS = {
    retailer: 500,
    claimId: 200,
    documents: 25,
    filename: 255,
  } as const;

  it('leaves room for the rest of the cover page', () => {
    expect(MAX_RATIONALE_LENGTH).toBe(MAX_NARRATIVE_LENGTH - NARRATIVE_BUDGET_WITHOUT_RATIONALE);
    // A cap that had grown until nothing was left would be a cap in name only.
    expect(MAX_RATIONALE_LENGTH).toBeGreaterThan(1_000);
  });

  // The worst case the budget was computed for, built by hand: every field at
  // its cap, 25 documents with the longest role and a 255-character filename,
  // and a rationale of exactly MAX_RATIONALE_LENGTH.
  it('fits the column with every field at its cap', () => {
    const narrative = buildPacketNarrative({
      claimId: 'C'.repeat(CAPS.claimId),
      retailer: 'R'.repeat(CAPS.retailer),
      deductionAmountCents: Number.MAX_SAFE_INTEGER,
      deductionDate: '2026-08-14',
      disputeDeadline: '2026-10-13',
      reason: 'unauthorised_deduction_no_basis',
      rationale: 'x'.repeat(MAX_RATIONALE_LENGTH),
      documents: Array.from({ length: CAPS.documents }, () => ({
        role: 'remittance' as const,
        filename: 'f'.repeat(CAPS.filename),
      })),
    });
    expect(narrative.length).toBeLessThanOrEqual(MAX_NARRATIVE_LENGTH);
  });

  // And the same claim as a property: any rationale at or under the cap, with
  // any fields inside their caps, builds a narrative the column will hold.
  it('holds for any rationale at or under the cap', () => {
    const withinCaps = fc
      .record({
        claimId: fc.option(fc.string({ maxLength: CAPS.claimId }).filter((t) => t.trim() !== ''), {
          nil: undefined,
        }),
        retailer: fc.option(
          fc.string({ maxLength: CAPS.retailer }).filter((t) => t.trim() !== ''),
          { nil: undefined },
        ),
        deductionAmountCents: fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
        reason: fc.constantFrom(...CANONICAL_REASON_CODE_LIST),
        rationale: fc
          .string({ minLength: 1, maxLength: MAX_RATIONALE_LENGTH })
          .filter((t) => t.trim() !== ''),
        documents: fc.array(
          fc.record({
            role: fc.constantFrom(
              'notice' as const,
              'evidence' as const,
              'remittance' as const,
              'context' as const,
            ),
            filename: fc.string({ minLength: 1, maxLength: CAPS.filename }).filter(
              (t) => t.trim() !== '',
            ),
          }),
          { minLength: 1, maxLength: CAPS.documents },
        ),
      })
      .map((raw) => ({
        deductionAmountCents: raw.deductionAmountCents,
        reason: raw.reason,
        rationale: raw.rationale,
        documents: raw.documents,
        deductionDate: '2026-08-14',
        disputeDeadline: '2026-10-13',
        ...(raw.claimId !== undefined ? { claimId: raw.claimId } : {}),
        ...(raw.retailer !== undefined ? { retailer: raw.retailer } : {}),
      }));

    fc.assert(
      fc.property(withinCaps, (input) => {
        // Never throws, and never exceeds what `packets.narrative` holds: this
        // is the whole claim `recordHumanDecision` leans on.
        expect(buildPacketNarrative(input).length).toBeLessThanOrEqual(MAX_NARRATIVE_LENGTH);
      }),
      { numRuns: 200 },
    );
  });
});

describe('the packet content hash', () => {
  it('is 64 lower-case hex characters', () => {
    const hash = packetContentHash({
      decisionId: 'dec-1',
      narrative: buildPacketNarrative(walmart),
      fileDocumentIds: ['doc-a', 'doc-b'],
    });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not depend on the order two documents were attached in', () => {
    const narrative = buildPacketNarrative(walmart);
    expect(
      packetContentHash({ decisionId: 'dec-1', narrative, fileDocumentIds: ['a', 'b'] }),
    ).toBe(packetContentHash({ decisionId: 'dec-1', narrative, fileDocumentIds: ['b', 'a'] }));
  });

  // The hash covers the document set and the narrative covers the order, so
  // two documents that are the same document as far as the cover page is
  // concerned — same role, same filename, a POD scanned twice — hash the same
  // whichever way round they were attached. That is what lets a store hand
  // back the packet that already exists instead of writing a second one.
  it('is the same when two documents with the same role and filename swap places', () => {
    const enclosed = [
      { role: 'notice' as const, filename: 'apdp-notice.pdf' },
      { role: 'evidence' as const, filename: 'pod-signed.pdf' },
      { role: 'evidence' as const, filename: 'pod-signed.pdf' },
    ];
    const narrative = buildPacketNarrative({ ...walmart, documents: enclosed });
    // Reversing the two identical lines leaves the narrative byte-identical.
    expect(
      buildPacketNarrative({
        ...walmart,
        documents: [enclosed[0], enclosed[2], enclosed[1]] as typeof enclosed,
      }),
    ).toBe(narrative);
    expect(
      packetContentHash({
        decisionId: 'dec-1',
        narrative,
        fileDocumentIds: ['notice-1', 'pod-a', 'pod-b'],
      }),
    ).toBe(
      packetContentHash({
        decisionId: 'dec-1',
        narrative,
        fileDocumentIds: ['notice-1', 'pod-b', 'pod-a'],
      }),
    );
  });

  it('changes when the narrative, the documents or the decision change', () => {
    const narrative = buildPacketNarrative(walmart);
    const base = packetContentHash({
      decisionId: 'dec-1',
      narrative,
      fileDocumentIds: ['a', 'b'],
    });
    // Substituting a document after approval is the failure this hash exists
    // to catch.
    expect(
      packetContentHash({ decisionId: 'dec-1', narrative, fileDocumentIds: ['a', 'c'] }),
    ).not.toBe(base);
    expect(
      packetContentHash({ decisionId: 'dec-1', narrative, fileDocumentIds: ['a'] }),
    ).not.toBe(base);
    expect(
      packetContentHash({
        decisionId: 'dec-1',
        narrative: `${narrative}and one more thing`,
        fileDocumentIds: ['a', 'b'],
      }),
    ).not.toBe(base);
    expect(
      packetContentHash({ decisionId: 'dec-2', narrative, fileDocumentIds: ['a', 'b'] }),
    ).not.toBe(base);
  });

  it('cannot be confused by a document id that looks like the next field', () => {
    // JSON, not concatenation: `["a","b"]` and `["a\",\"b"]` are different
    // strings, and a separator smuggled into a value does not let one packet
    // hash as another.
    expect(
      packetContentHash({ decisionId: 'd', narrative: 'n', fileDocumentIds: ['a', 'b'] }),
    ).not.toBe(
      packetContentHash({ decisionId: 'd', narrative: 'n', fileDocumentIds: ['a","b'] }),
    );
  });
});

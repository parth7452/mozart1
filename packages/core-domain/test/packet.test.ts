import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  buildPacketNarrative,
  ENCLOSURE_ROLE_WORDS,
  FIXED_TEXT_BUDGET,
  INVOICE_NUMBERS_BUDGETED,
  MAX_NARRATIVE_LENGTH,
  MAX_RATIONALE_LENGTH,
  NARRATIVE_BUDGET_WITHOUT_RATIONALE,
  NOT_RECORDED,
  PacketError,
  packetContentHash,
  type PacketNarrativeInput,
} from '../src/packet';
import { CANONICAL_REASON_CODE_LIST } from '../src/reason-codes';
import { REASON_WORDS } from '../src/reason-words';
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
    supplier: anyText,
    claimId: fc.option(anyText, { nil: undefined }),
    payer: fc.option(anyText, { nil: undefined }),
    invoiceNumbers: fc.array(anyText, { maxLength: 3 }),
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
    supplier: raw.supplier,
    invoiceNumbers: raw.invoiceNumbers,
    deductionAmountCents: raw.deductionAmountCents,
    reason: raw.reason,
    rationale: raw.rationale,
    documents: raw.documents,
    ...(raw.claimId !== undefined ? { claimId: raw.claimId } : {}),
    ...(raw.payer !== undefined ? { payer: raw.payer } : {}),
    ...(raw.deductionDate !== undefined ? { deductionDate: raw.deductionDate } : {}),
    ...(raw.disputeDeadline !== undefined ? { disputeDeadline: raw.disputeDeadline } : {}),
  }));

const walmart: PacketNarrativeInput = {
  supplier: 'Harbor Lane Foods, LLC',
  claimId: 'APDP-41007',
  payer: 'Walmart Stores, Inc.',
  invoiceNumbers: ['INV-88213'],
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
  it('reads as a letter a supplier would send a payer', () => {
    expect(buildPacketNarrative(walmart)).toBe(
      [
        'DISPUTE OF DEDUCTION',
        '',
        'From: Harbor Lane Foods, LLC',
        'To: Walmart Stores, Inc.',
        '',
        'Claim or deduction reference: APDP-41007',
        'Invoice number: INV-88213',
        'Amount deducted: $3,120.00',
        'Deduction date: 2026-08-14',
        'Dispute deadline: 2026-10-13',
        '',
        'Harbor Lane Foods, LLC disputes this deduction in full and asks that $3,120.00 be repaid.',
        '',
        'Reason for dispute: Shipment deducted as never received, though delivery is documented',
        '',
        'Explanation:',
        'POD signed for the full quantity on 2026-08-02.',
        '',
        'Enclosures:',
        '  1. Deduction notice: apdp-notice.pdf',
        '  2. Supporting document: pod-signed.pdf',
        '',
        'Please quote the claim or deduction reference above in any reply about this dispute.',
        '',
      ].join('\n'),
    );
  });

  // A payer reads words, not our taxonomy: no canonical code may reach the
  // letter as itself, whichever one the analyst chose.
  it('says the reason in words, never as a code', () => {
    for (const reason of CANONICAL_REASON_CODE_LIST) {
      const narrative = buildPacketNarrative({ ...walmart, reason });
      expect(narrative, reason).toContain(`Reason for dispute: ${REASON_WORDS[reason]}\n`);
      expect(narrative, reason).not.toContain(reason);
    }
  });

  it('names no kind of payer: the engine is payer-agnostic', () => {
    const narrative = buildPacketNarrative({ ...walmart, payer: 'Acme Distribution' });
    expect(narrative.toLowerCase()).not.toMatch(/retailer|distributor|shipper/);
  });

  it('lists every invoice number once, in an order that does not depend on the store', () => {
    const narrative = buildPacketNarrative({
      ...walmart,
      invoiceNumbers: ['INV-9', 'INV-10', 'INV-9', '  '],
    });
    // Code-unit order, not numeric and not locale: '1' sorts before '9'.
    expect(narrative).toContain('Invoice numbers: INV-10, INV-9\n');
    expect(
      buildPacketNarrative({ ...walmart, invoiceNumbers: ['INV-10', 'INV-9'] }),
    ).toBe(narrative);
  });

  it('says a value was not recorded rather than inventing one', () => {
    const sparse = buildPacketNarrative({
      supplier: 'Harbor Lane Foods, LLC',
      invoiceNumbers: [],
      deductionAmountCents: 45_000,
      reason: 'unauthorised_deduction_no_basis',
      rationale: 'No backup was provided with the deduction.',
      documents: [{ role: 'notice', filename: 'notice.pdf' }],
    });
    expect(sparse).toContain(`Claim or deduction reference: ${NOT_RECORDED}`);
    expect(sparse).toContain(`To: ${NOT_RECORDED}`);
    expect(sparse).toContain(`Invoice number: ${NOT_RECORDED}`);
    expect(sparse).toContain(`Deduction date: ${NOT_RECORDED}`);
    // A deadline the case does not hold is left out of the letter rather than
    // telling the payer we do not know it.
    expect(sparse).not.toContain('Dispute deadline');
    // The amount is never "not recorded": a case has one, and the column is
    // `not null check (> 0)`.
    expect(sparse).toContain('Amount deducted: $450.00');
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
        expect(narrative).toContain(`From: ${input.supplier}\n`);
        if (input.claimId !== undefined) expect(narrative).toContain(input.claimId);
        if (input.payer !== undefined) expect(narrative).toContain(`To: ${input.payer}\n`);
        for (const invoice of input.invoiceNumbers) expect(narrative).toContain(invoice);
        if (input.deductionDate !== undefined) expect(narrative).toContain(input.deductionDate);
        if (input.disputeDeadline !== undefined) {
          expect(narrative).toContain(input.disputeDeadline);
        }
        expect(narrative).toContain(REASON_WORDS[input.reason]);
        expect(narrative).toContain(input.rationale);
        for (const document of input.documents) {
          expect(narrative).toContain(
            `${ENCLOSURE_ROLE_WORDS[document.role]}: ${document.filename}`,
          );
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
        const lines = narrative.split('\n');
        const amountLine = lines.find((line) => line.startsWith('Amount deducted: '));
        expect(amountLine).toBe(`Amount deducted: ${rendered}`);
        // Exactly two decimal places, and no more — a float would show up here
        // as a longer tail, an exponent, or a NaN.
        expect(amountLine).toMatch(/^Amount deducted: \$[\d,]+\.\d{2}$/);
        expect(amountLine).not.toMatch(/e[+-]/i);
        expect(amountLine).not.toContain('NaN');
        // The dispute sentence prints the same amount, and it is the same
        // string: one `formatCents`, never a second rendering.
        const asks = lines.find((line) => line.includes(' disputes this deduction in full'));
        expect(asks?.endsWith(` asks that ${rendered} be repaid.`)).toBe(true);
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
    expect(() => buildPacketNarrative({ ...walmart, supplier: ' ' })).toThrow(/who it is from/);
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
 * else the letter prints.
 */
describe('the rationale budget', () => {
  /** The caps the budget is made of (see `NARRATIVE_BUDGET_WITHOUT_RATIONALE`). */
  const CAPS = {
    supplier: 200,
    payer: 500,
    claimId: 200,
    invoiceNumber: 200,
    invoiceNumbers: INVOICE_NUMBERS_BUDGETED,
    documents: 25,
    filename: 255,
  } as const;

  // The fixed text is measured, not asserted: build the letter with every
  // value one character long (a single invoice, a single enclosure) and take
  // the values away. If the template grows past its budget, this is where it
  // says so.
  it('spends no more on its own words than the budget says', () => {
    const narrative = buildPacketNarrative({
      supplier: 'S',
      payer: 'P',
      claimId: 'C',
      invoiceNumbers: ['a', 'b'],
      deductionAmountCents: 1,
      deductionDate: 'D',
      disputeDeadline: 'E',
      reason: 'duplicate_claim',
      rationale: 'R',
      documents: [{ role: 'notice', filename: 'f' }],
    });
    const values =
      2 * 'S'.length +
      'P'.length +
      'C'.length +
      'a, b'.length +
      2 * '$0.01'.length +
      'D'.length +
      'E'.length +
      REASON_WORDS.duplicate_claim.length +
      'R'.length +
      `  1. ${ENCLOSURE_ROLE_WORDS.notice}: f\n`.length;
    expect(narrative.length - values).toBeLessThanOrEqual(FIXED_TEXT_BUDGET);
  });

  it('leaves room for the rest of the letter', () => {
    expect(MAX_RATIONALE_LENGTH).toBe(MAX_NARRATIVE_LENGTH - NARRATIVE_BUDGET_WITHOUT_RATIONALE);
    // A cap that had grown until nothing was left would be a cap in name only.
    expect(MAX_RATIONALE_LENGTH).toBeGreaterThan(1_000);
  });

  // The worst case the budget was computed for, built by hand: every field at
  // its cap, 25 documents with the longest role and a 255-character filename,
  // and a rationale of exactly MAX_RATIONALE_LENGTH.
  it('fits the column with every field at its cap', () => {
    const narrative = buildPacketNarrative({
      supplier: 'S'.repeat(CAPS.supplier),
      claimId: 'C'.repeat(CAPS.claimId),
      payer: 'P'.repeat(CAPS.payer),
      invoiceNumbers: Array.from({ length: CAPS.invoiceNumbers }, (_, i) =>
        String(i).padStart(CAPS.invoiceNumber, 'I'),
      ),
      deductionAmountCents: Number.MAX_SAFE_INTEGER,
      deductionDate: '2026-08-14',
      disputeDeadline: '2026-10-13',
      // The longest words any reason has, so the worst case is the worst case.
      reason: CANONICAL_REASON_CODE_LIST.reduce((a, b) =>
        REASON_WORDS[a].length >= REASON_WORDS[b].length ? a : b,
      ),
      rationale: 'x'.repeat(MAX_RATIONALE_LENGTH),
      documents: Array.from({ length: CAPS.documents }, () => ({
        // The longest role in words.
        role: 'evidence' as const,
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
        supplier: fc.string({ minLength: 1, maxLength: CAPS.supplier }).filter((t) => t.trim() !== ''),
        claimId: fc.option(fc.string({ maxLength: CAPS.claimId }).filter((t) => t.trim() !== ''), {
          nil: undefined,
        }),
        payer: fc.option(
          fc.string({ maxLength: CAPS.payer }).filter((t) => t.trim() !== ''),
          { nil: undefined },
        ),
        invoiceNumbers: fc.array(
          fc.string({ minLength: 1, maxLength: CAPS.invoiceNumber }),
          { maxLength: CAPS.invoiceNumbers },
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
        supplier: raw.supplier,
        invoiceNumbers: raw.invoiceNumbers,
        deductionAmountCents: raw.deductionAmountCents,
        reason: raw.reason,
        rationale: raw.rationale,
        documents: raw.documents,
        deductionDate: '2026-08-14',
        disputeDeadline: '2026-10-13',
        ...(raw.claimId !== undefined ? { claimId: raw.claimId } : {}),
        ...(raw.payer !== undefined ? { payer: raw.payer } : {}),
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
  // two documents that are the same document as far as the letter is
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

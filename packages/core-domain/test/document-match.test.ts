import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  DOCUMENT_MATCH_BASIS_KINDS,
  DOCUMENT_MATCH_FIELDS,
  basisKinds,
  documentMatchKindOf,
  documentMatchPathPattern,
  suggestCasesForDocument,
  type DocumentMatchCase,
  type DocumentMatchField,
} from '../src/document-match';
import { identifierMatchKey } from '../src/identity';
import { cents } from '../src/money';
import { CASE_STATES, CLOSED_STATES, isClosed } from '../src/state-machine';

const openCase = (
  caseId: string,
  over: Partial<DocumentMatchCase> = {},
): DocumentMatchCase => ({
  caseId,
  state: 'classified',
  amountCents: cents(10_000),
  identifiers: [],
  ...over,
});

const invoice = (...fields: DocumentMatchField[]) => ({
  documentType: 'invoice',
  documentFields: fields,
});

describe('suggestCasesForDocument — exact', () => {
  it('matches an invoice to the one open case that carries its number', () => {
    const got = suggestCasesForDocument({
      ...invoice({ path: 'invoice_number', value: '44817' }),
      cases: [
        openCase('a', { identifiers: [{ kind: 'invoice_number', value: ' 44817 ' }] }),
        openCase('b', { identifiers: [{ kind: 'invoice_number', value: '44818' }] }),
      ],
    });
    expect(got).toEqual([
      {
        caseId: 'a',
        strength: 'exact',
        basis: [{ kind: 'invoice_number', field: 'invoice_number', value: '44817' }],
      },
    ]);
  });

  it('lists every case when several carry the identifier, and calls none exact', () => {
    const got = suggestCasesForDocument({
      ...invoice({ path: 'invoice_number', value: 'INV-9' }),
      cases: [
        openCase('b', { identifiers: [{ kind: 'invoice_number', value: 'inv-9' }] }),
        openCase('a', { identifiers: [{ kind: 'invoice_number', value: 'INV-9' }] }),
      ],
    });
    expect(got.map((s) => [s.caseId, s.strength])).toEqual([
      ['a', 'ambiguous'],
      ['b', 'ambiguous'],
    ]);
  });

  it('compares within a kind: a purchase order number is not an invoice number', () => {
    const got = suggestCasesForDocument({
      documentType: 'po',
      documentFields: [{ path: 'po_number', value: '44817' }],
      cases: [openCase('a', { identifiers: [{ kind: 'invoice_number', value: '44817' }] })],
    });
    expect(got).toEqual([]);
  });

  it('reads a purchase order and a shipment number off the case’s linked documents', () => {
    const cases = [
      openCase('a', {
        identifiers: [
          { kind: 'po_number', value: 'PO-771' },
          { kind: 'bol_number', value: 'BOL 12' },
        ],
      }),
    ];
    const pod = suggestCasesForDocument({
      documentType: 'pod',
      documentFields: [
        { path: 'document_number', value: 'bol  12' },
        { path: 'po_number', value: 'po-771' },
      ],
      cases,
    });
    expect(pod).toHaveLength(1);
    expect(pod[0]?.strength).toBe('exact');
    expect(basisKinds(pod[0]?.basis ?? [])).toEqual(['po_number', 'bol_number']);
  });

  it('matches a claim id against the case’s own column and a portal’s claim id', () => {
    const notice = {
      documentType: 'deduction_notice',
      documentFields: [{ path: 'claim_id', value: 'DN-2609-003' }],
    };
    expect(
      suggestCasesForDocument({ ...notice, cases: [openCase('a', { claimId: 'dn-2609-003' })] })[0]
        ?.strength,
    ).toBe('exact');
    expect(
      suggestCasesForDocument({
        ...notice,
        cases: [openCase('a', { identifiers: [{ kind: 'portal_claim_id', value: 'DN-2609-003' }] })],
      })[0]?.strength,
    ).toBe('exact');
  });

  it('matches nothing on a ledger’s own ids', () => {
    expect(documentMatchKindOf('ledger_invoice_id')).toBeUndefined();
    expect(documentMatchKindOf('credit_memo_id')).toBeUndefined();
    expect(documentMatchKindOf('edi_812_reference')).toBeUndefined();
    const got = suggestCasesForDocument({
      ...invoice({ path: 'invoice_number', value: '71' }),
      cases: [openCase('a', { identifiers: [{ kind: 'ledger_invoice_id', value: '71' }] })],
    });
    expect(got).toEqual([]);
  });

  it('reads a remittance’s invoice numbers from any line', () => {
    const got = suggestCasesForDocument({
      documentType: 'remittance_advice',
      documentFields: [
        { path: 'lines[0].invoice_number', value: 'A-1' },
        { path: 'lines[12].invoice_number', value: 'A-2' },
      ],
      cases: [openCase('a', { identifiers: [{ kind: 'invoice_number', value: 'A-2' }] })],
    });
    expect(got[0]?.basis).toEqual([
      { kind: 'invoice_number', field: 'lines[12].invoice_number', value: 'A-2' },
    ]);
  });

  it('never suggests a closed or merged-away case', () => {
    for (const state of CLOSED_STATES) {
      const got = suggestCasesForDocument({
        ...invoice({ path: 'invoice_number', value: '44817' }),
        cases: [openCase('a', { state, identifiers: [{ kind: 'invoice_number', value: '44817' }] })],
      });
      expect(got).toEqual([]);
    }
  });

  it('does not let a closed case make an open one ambiguous', () => {
    const got = suggestCasesForDocument({
      ...invoice({ path: 'invoice_number', value: '44817' }),
      cases: [
        openCase('a', { identifiers: [{ kind: 'invoice_number', value: '44817' }] }),
        openCase('b', { state: 'merged', identifiers: [{ kind: 'invoice_number', value: '44817' }] }),
      ],
    });
    expect(got.map((s) => [s.caseId, s.strength])).toEqual([['a', 'exact']]);
  });
});

describe('suggestCasesForDocument — probable', () => {
  const priced = invoice(
    { path: 'customer_name', value: 'WALMART STORES, INC.' },
    { path: 'invoice_total', value: '$1,250.00' },
  );

  it('suggests a case of the same payer whose amount is the document’s, to the cent', () => {
    const got = suggestCasesForDocument({
      ...priced,
      cases: [
        openCase('a', { amountCents: cents(125_000), debtorNames: ['Walmart', 'Walmart Stores'] }),
        openCase('b', { amountCents: cents(125_001), debtorNames: ['Walmart Stores'] }),
      ],
    });
    expect(got).toEqual([
      {
        caseId: 'a',
        strength: 'probable',
        basis: [
          { kind: 'payer', field: 'customer_name' },
          { kind: 'amount_cents', field: 'invoice_total' },
        ],
      },
    ]);
  });

  it('accepts the name printed on a case no debtor matched', () => {
    const got = suggestCasesForDocument({
      ...priced,
      cases: [openCase('a', { amountCents: cents(125_000), retailerNameAsPrinted: 'Walmart Stores Inc' })],
    });
    expect(got.map((s) => s.strength)).toEqual(['probable']);
  });

  it('never suggests on an amount alone or a payer alone', () => {
    const got = suggestCasesForDocument({
      ...priced,
      cases: [
        openCase('amount-only', { amountCents: cents(125_000), debtorNames: ['Kroger'] }),
        openCase('payer-only', { amountCents: cents(5), debtorNames: ['Walmart Stores'] }),
        openCase('neither', { amountCents: cents(5) }),
      ],
    });
    expect(got).toEqual([]);
  });

  it('does not fold one retailer into another: that is data, not code', () => {
    const got = suggestCasesForDocument({
      ...priced,
      cases: [openCase('a', { amountCents: cents(125_000), debtorNames: ['Walmart'] })],
    });
    expect(got).toEqual([]);
  });

  it('skips an amount it cannot read to the cent rather than throwing', () => {
    const got = suggestCasesForDocument({
      ...invoice(
        { path: 'customer_name', value: 'Kroger' },
        { path: 'invoice_total', value: 'see attached' },
        { path: 'lines[0].extended_amount', value: 12.5 },
      ),
      cases: [openCase('a', { amountCents: cents(1250), debtorNames: ['Kroger'] })],
    });
    expect(got).toEqual([]);
  });

  it('offers a message’s unlabelled reference as probable, never exact', () => {
    const got = suggestCasesForDocument({
      documentType: 'correspondence',
      documentFields: [
        { path: 'references[0].label', value: 'Invoice' },
        { path: 'references[0].value', value: '44817' },
      ],
      cases: [openCase('a', { identifiers: [{ kind: 'invoice_number', value: '44817' }] })],
    });
    expect(got).toEqual([
      {
        caseId: 'a',
        strength: 'probable',
        basis: [{ kind: 'reference', field: 'references[0].value', value: '44817' }],
      },
    ]);
  });

  it('ranks probable below exact and below ambiguous', () => {
    const got = suggestCasesForDocument({
      ...invoice(
        { path: 'invoice_number', value: '44817' },
        { path: 'customer_name', value: 'Kroger' },
        { path: 'invoice_total', value: '100.00' },
      ),
      cases: [
        openCase('p', { debtorNames: ['Kroger'] }),
        openCase('x', { identifiers: [{ kind: 'invoice_number', value: '44817' }] }),
      ],
    });
    expect(got.map((s) => [s.caseId, s.strength])).toEqual([
      ['x', 'exact'],
      ['p', 'probable'],
    ]);
  });
});

describe('suggestCasesForDocument — nothing to go on', () => {
  it('answers nothing for a type that lists no fields, or one it does not know', () => {
    const cases = [openCase('a', { claimId: 'X' })];
    for (const documentType of ['other', 'routing_guide', 'not_a_type']) {
      expect(
        suggestCasesForDocument({ documentType, documentFields: [{ path: 'claim_id', value: 'X' }], cases }),
      ).toEqual([]);
    }
  });

  it('never matches a blank identifier to a blank identifier', () => {
    const got = suggestCasesForDocument({
      ...invoice({ path: 'invoice_number', value: '   ' }),
      cases: [openCase('a', { identifiers: [{ kind: 'invoice_number', value: '' }] })],
    });
    expect(got).toEqual([]);
  });
});

describe('the field lists', () => {
  it('builds one pattern that matches every listed path and no other', () => {
    const pattern = new RegExp(documentMatchPathPattern());
    expect(pattern.test('invoice_number')).toBe(true);
    expect(pattern.test('lines[41].invoice_number')).toBe(true);
    expect(pattern.test('references[0].value')).toBe(true);
    expect(pattern.test('terms[3].amount')).toBe(true);
    expect(pattern.test('references[0].label')).toBe(false);
    expect(pattern.test('lines[x].invoice_number')).toBe(false);
    expect(pattern.test('xinvoice_number')).toBe(false);
    expect(pattern.test('lines[0].sku_upc')).toBe(false);
  });

  it('names only basis kinds from the closed set', () => {
    for (const fields of Object.values(DOCUMENT_MATCH_FIELDS)) {
      for (const { kind } of fields.identifiers) {
        expect(DOCUMENT_MATCH_BASIS_KINDS).toContain(kind);
      }
    }
  });
});

// ---- properties -----------------------------------------------------------

const identifierText = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9 \-/]{0,11}$/);
const spacing = fc.constantFrom('', ' ', '  ', '\t');

/** Another writing of the same identifier: case flipped, padded, spaces widened. */
const rewritten = (text: string) =>
  fc.tuple(spacing, spacing, fc.boolean(), spacing).map(([before, after, upper, inner]) => {
    const cased = upper ? text.toUpperCase() : text.toLowerCase();
    return `${before}${cased.replace(/ /g, ` ${inner}`)}${after}`;
  });

const anyCase = fc.record({
  state: fc.constantFrom(...CASE_STATES),
  amount: fc.integer({ min: 1, max: 500 }),
  payer: fc.constantFrom('Kroger', 'Walmart Stores', 'UNFI', undefined),
  invoice: fc.option(fc.constantFrom('1', '2', '3', 'INV 4'), { nil: undefined }),
  po: fc.option(fc.constantFrom('P1', 'P2'), { nil: undefined }),
});

const cases = fc.array(anyCase, { maxLength: 12 }).map((rows) =>
  rows.map(
    (row, index): DocumentMatchCase => ({
      caseId: `case-${String(index).padStart(2, '0')}`,
      state: row.state,
      amountCents: cents(row.amount),
      ...(row.payer !== undefined ? { debtorNames: [row.payer] } : {}),
      identifiers: [
        ...(row.invoice !== undefined ? [{ kind: 'invoice_number' as const, value: row.invoice }] : []),
        ...(row.po !== undefined ? [{ kind: 'po_number' as const, value: row.po }] : []),
      ],
    }),
  ),
);

const invoiceFields = fc
  .record({
    invoice: fc.option(fc.constantFrom('1', '2', '3', 'inv  4', '9'), { nil: undefined }),
    po: fc.option(fc.constantFrom('P1', 'p2', 'P9'), { nil: undefined }),
    payer: fc.option(fc.constantFrom('KROGER CO.', 'Walmart Stores, Inc.', 'Target'), { nil: undefined }),
    total: fc.option(fc.integer({ min: 1, max: 500 }), { nil: undefined }),
  })
  .map((row): DocumentMatchField[] => [
    ...(row.invoice !== undefined ? [{ path: 'invoice_number', value: row.invoice }] : []),
    ...(row.po !== undefined ? [{ path: 'po_number', value: row.po }] : []),
    ...(row.payer !== undefined ? [{ path: 'customer_name', value: row.payer }] : []),
    ...(row.total !== undefined
      ? [{ path: 'invoice_total', value: `$${(row.total / 100).toFixed(2)}` }]
      : []),
  ]);

describe('suggestCasesForDocument — properties', () => {
  it('normalisation is symmetric: two writings of one identifier match either way round', () => {
    fc.assert(
      fc.property(
        identifierText.chain((text) => fc.tuple(rewritten(text), rewritten(text))),
        ([one, other]) => {
          expect(identifierMatchKey(one)).toBe(identifierMatchKey(other));
          const match = (onDocument: string, onCase: string) =>
            suggestCasesForDocument({
              ...invoice({ path: 'invoice_number', value: onDocument }),
              cases: [openCase('a', { identifiers: [{ kind: 'invoice_number', value: onCase }] })],
            }).map((s) => s.strength);
          expect(match(one, other)).toEqual(['exact']);
          expect(match(other, one)).toEqual(['exact']);
        },
      ),
    );
  });

  it('matching is symmetric for any two identifiers, alike or not', () => {
    fc.assert(
      fc.property(identifierText, identifierText, (one, other) => {
        const match = (onDocument: string, onCase: string) =>
          suggestCasesForDocument({
            ...invoice({ path: 'invoice_number', value: onDocument }),
            cases: [openCase('a', { identifiers: [{ kind: 'invoice_number', value: onCase }] })],
          }).length;
        expect(match(one, other)).toBe(match(other, one));
        expect(match(one, other)).toBe(identifierMatchKey(one) === identifierMatchKey(other) ? 1 : 0);
      }),
    );
  });

  it('one exact match comes before any number of probable ones', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 20 }), (probables) => {
        const got = suggestCasesForDocument({
          ...invoice(
            { path: 'invoice_number', value: '44817' },
            { path: 'customer_name', value: 'Kroger' },
            { path: 'invoice_total', value: '$100.00' },
          ),
          cases: [
            ...Array.from({ length: probables }, (_, index) =>
              openCase(`p-${index}`, { debtorNames: ['Kroger'] }),
            ),
            openCase('z-exact', { identifiers: [{ kind: 'invoice_number', value: '44817' }] }),
          ],
        });
        expect(got).toHaveLength(probables + 1);
        expect(got[0]).toMatchObject({ caseId: 'z-exact', strength: 'exact' });
        expect(got.slice(1).every((s) => s.strength === 'probable')).toBe(true);
      }),
    );
  });

  it('holds its invariants over arbitrary documents and cases', () => {
    fc.assert(
      fc.property(invoiceFields, cases, (documentFields, candidates) => {
        const got = suggestCasesForDocument({ documentType: 'invoice', documentFields, cases: candidates });
        const byId = new Map(candidates.map((c) => [c.caseId, c]));

        // No suggestion without a basis, and every basis kind is a constant.
        for (const suggestion of got) {
          expect(suggestion.basis.length).toBeGreaterThan(0);
          for (const basis of suggestion.basis) {
            expect(DOCUMENT_MATCH_BASIS_KINDS).toContain(basis.kind);
          }
        }
        // Never a closed case, never a case twice, never one it was not given.
        expect(new Set(got.map((s) => s.caseId)).size).toBe(got.length);
        for (const suggestion of got) {
          const candidate = byId.get(suggestion.caseId);
          expect(candidate).toBeDefined();
          expect(candidate !== undefined && isClosed(candidate.state)).toBe(false);
        }
        // Exact is unique or absent; exact and ambiguous never appear together.
        const exact = got.filter((s) => s.strength === 'exact');
        const ambiguous = got.filter((s) => s.strength === 'ambiguous');
        expect(exact.length).toBeLessThanOrEqual(1);
        expect(ambiguous.length === 0 || ambiguous.length >= 2).toBe(true);
        expect(exact.length === 0 || ambiguous.length === 0).toBe(true);
        // Strongest first.
        const rank = { exact: 0, ambiguous: 0, probable: 1 } as const;
        const ranks = got.map((s) => rank[s.strength]);
        expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
        // A probable suggestion is a payer and an amount together.
        for (const suggestion of got.filter((s) => s.strength === 'probable')) {
          expect(basisKinds(suggestion.basis)).toEqual(['payer', 'amount_cents']);
        }
        // The order cases arrive in changes nothing.
        expect(
          suggestCasesForDocument({
            documentType: 'invoice',
            documentFields,
            cases: [...candidates].reverse(),
          }),
        ).toEqual(got);
      }),
    );
  });
});

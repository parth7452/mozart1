import { describe, expect, it } from 'vitest';
import {
  HL_NAT_001,
  NATURAL_ADVICE_DEDUCTION_CENTS,
  NATURAL_ADVICE_LINES,
  NATURAL_ADVICE_NET_CENTS,
  NATURAL_KEYSTONE_TOTAL_CENTS,
  NATURAL_MCB_LINES,
  NATURAL_MCB_NUMBER,
  NATURAL_MCB_TOTAL_CENTS,
  NATURAL_SHORTAGE_PO,
  naturalDocuments,
  naturalMoney,
} from '../src/natural';
import type { FixtureDocument } from '../src/cases';

/**
 * The `natural` suite has to agree with itself before it can measure anything,
 * and before a founder uploads its advice on a call.
 *
 * Each document is generated from one table; these tests hold the claims the
 * case makes across documents: the advice's coded lines add up, the MCB backup
 * is the advice's MCB line, the deal agreed less than the backup billed on one
 * item, and the shortage's PO shipped and was received in full.
 */

const byKey = (key: string): FixtureDocument => {
  const found = naturalDocuments().find((d) => d.key === key);
  if (found === undefined) throw new Error(`no natural fixture ${key}`);
  return found;
};

const advice = byKey('natural-dda-remittance');
const mcb = byKey('natural-mcb-backup');
const keystone = byKey('natural-ksolve-deduction-detail');
const deal = byKey('natural-deal-confirmation');
const bol = byKey('natural-bol');
const pod = byKey('natural-pod');

const value = (document: FixtureDocument, path: string): string | number | boolean | undefined =>
  document.truth[path]?.value;

/** The sum of every `lines[n].deduction_amount` the truth asserts, in cents. */
function linesTotal(document: FixtureDocument): number {
  return Object.entries(document.truth)
    .filter(([path]) => /^lines\[\d+\]\.deduction_amount$/.test(path))
    .reduce((sum, [, expectation]) => sum + Number(expectation.value), 0);
}

describe('the natural suite', () => {
  it('is exactly the six documents of HL-NAT-001, one page each', () => {
    expect(naturalDocuments().map((d) => [d.key, d.docType])).toEqual([
      ['natural-dda-remittance', 'remittance_advice'],
      ['natural-mcb-backup', 'deduction_notice'],
      ['natural-ksolve-deduction-detail', 'deduction_notice'],
      ['natural-deal-confirmation', 'promo_agreement'],
      ['natural-bol', 'bol'],
      ['natural-pod', 'pod'],
    ]);
    expect(HL_NAT_001.documents).toBe(naturalDocuments());
    for (const document of naturalDocuments()) {
      expect(document.suite).toBe('natural');
      expect(document.pageText).toHaveLength(1);
      // A page this renderer can hold: about 48 lines of 10pt Helvetica.
      expect(document.pageText[0]?.split('\n').length, document.key).toBeLessThanOrEqual(46);
      expect(new TextDecoder().decode(document.bytes.slice(0, 5))).toBe('%PDF-');
    }
  });

  it('prints every value its truth asserts, on its own page', () => {
    // Text as the scorer compares it: case-insensitive, whitespace collapsed.
    // Money as the page prints it, and counts as digits.
    const fold = (s: string) => s.toLowerCase().replace(/\s+/g, ' ');
    for (const document of naturalDocuments()) {
      const page = fold(document.pageText.join('\n'));
      for (const [field, expectation] of Object.entries(document.truth)) {
        const where = `${document.key}.${field}`;
        switch (expectation.kind) {
          case 'text':
          case 'date':
            expect(page, where).toContain(fold(expectation.value));
            break;
          case 'money_cents':
            expect(page, where).toContain(naturalMoney(expectation.value));
            break;
          case 'int':
            expect(page, where).toMatch(new RegExp(`(^|\\D)${expectation.value}(\\D|$)`));
            break;
          case 'bool':
            break;
        }
      }
    }
  });

  it('never prints the real distributors’ names, nor a synthetic banner', () => {
    for (const document of naturalDocuments()) {
      const page = document.pageText.join('\n').toUpperCase();
      for (const banned of ['UNFI', 'KEHE', 'K-SOLVE', 'MYUNFI', 'SYNTHETIC']) {
        expect(page, `${document.key} prints ${banned}`).not.toContain(banned);
      }
    }
  });
});

describe('the direct deposit advice', () => {
  const shortPaid = NATURAL_ADVICE_LINES.flatMap((line, index) =>
    line.deduction === undefined ? [] : [{ line, index }],
  );

  it('pays five invoices and short-pays three, one per code pattern', () => {
    expect(NATURAL_ADVICE_LINES).toHaveLength(5);
    expect(shortPaid.map(({ line }) => line.deduction?.code)).toEqual([
      'HF-30418-111',
      NATURAL_MCB_NUMBER,
      'AVL4180311',
    ]);
    // `(Invoice#)-111` on its own invoice; `AVL(PO#)` on its own PO.
    expect(shortPaid[0]?.line.deduction?.code).toBe(`${shortPaid[0]?.line.invoice}-111`);
    expect(shortPaid[2]?.line.deduction?.code).toBe(`AVL${shortPaid[2]?.line.po}`);
    expect(NATURAL_MCB_NUMBER).toMatch(/^MCB\d{8}$/);
  });

  it('prints gross − net = deduction on every short-paid line', () => {
    for (const { index } of shortPaid) {
      const gross = Number(value(advice, `lines[${index}].gross_amount`));
      const net = Number(value(advice, `lines[${index}].net_amount`));
      const deduction = Number(value(advice, `lines[${index}].deduction_amount`));
      expect(gross - net, `line ${index}`).toBe(deduction);
    }
    // The other two lines are paid in full and assert no deduction.
    expect(Object.keys(advice.truth).filter((p) => p.endsWith('.deduction_amount'))).toHaveLength(3);
    expect(linesTotal(advice)).toBe(NATURAL_ADVICE_DEDUCTION_CENTS);
    expect(value(advice, 'payment_total')).toBe(NATURAL_ADVICE_NET_CENTS);
  });

  it('keys each short-pay on its own invoice, and clears the default floor', () => {
    // ADR 0028: a line's claim is `payment_reference:invoice_number`, so three
    // cases need three invoices; and the default floor is 500 cents and 50 bps
    // of gross, both of which every line has to clear to open on the call.
    const reference = String(value(advice, 'payment_reference'));
    const keys = shortPaid.map(({ line }) => `${reference}:${line.invoice}`);
    expect(new Set(keys).size).toBe(3);
    for (const { line } of shortPaid) {
      const cents = line.deduction?.cents ?? 0;
      expect(cents, line.invoice).toBeGreaterThanOrEqual(500);
      expect(cents * 10_000, line.invoice).toBeGreaterThanOrEqual(line.grossCents * 50);
    }
  });
});

describe('the MCB backup and the deal it is checked against', () => {
  it('totals exactly the advice’s MCB line', () => {
    const mcbLine = NATURAL_ADVICE_LINES.findIndex((l) => l.deduction?.code === NATURAL_MCB_NUMBER);
    expect(value(advice, `lines[${mcbLine}].deduction_amount`)).toBe(NATURAL_MCB_TOTAL_CENTS);
    expect(value(mcb, 'deduction_total')).toBe(NATURAL_MCB_TOTAL_CENTS);
    expect(linesTotal(mcb)).toBe(NATURAL_MCB_TOTAL_CENTS);
    expect(value(mcb, 'claim_id')).toBe(NATURAL_MCB_NUMBER);
    expect(value(mcb, 'invoice_number')).toBe(NATURAL_ADVICE_LINES[mcbLine]?.invoice);
    expect(value(mcb, 'remittance_or_check')).toBe(value(advice, 'payment_reference'));
  });

  it('bills one item above the agreed allowance, and only one', () => {
    const differing = NATURAL_MCB_LINES.filter((l) => l.billedRateCents !== l.agreedRateCents);
    expect(differing.map((l) => [l.item, l.billedRateCents, l.agreedRateCents])).toEqual([
      ['210441', 300, 250],
    ]);
    // Both rates are on their own pages, and the deal's truth asserts the agreed one.
    expect(mcb.pageText[0]).toMatch(/210441.*\$3\.00/);
    expect(deal.pageText[0]).toMatch(/210441.*\$2\.50/);
    const index = NATURAL_MCB_LINES.findIndex((l) => l.item === '210441');
    expect(value(deal, `terms[${index}].sku_upc`)).toBe('210441');
    expect(value(deal, `terms[${index}].amount`)).toBe(250);
    // The arguable difference: 96 cases × $0.50.
    const line = NATURAL_MCB_LINES[index];
    expect(line === undefined ? 0 : line.cases * (line.billedRateCents - line.agreedRateCents)).toBe(
      4_800,
    );
  });

  it('covers the same items, window and distributor', () => {
    NATURAL_MCB_LINES.forEach((line, index) => {
      expect(value(mcb, `lines[${index}].sku_upc`)).toBe(line.item);
      expect(value(deal, `terms[${index}].sku_upc`)).toBe(line.item);
    });
    expect(mcb.pageText[0]).toContain('Promotion Period: 08/01/2026 - 08/31/2026');
    expect(value(deal, 'effective_from')).toBe('08/01/2026');
    expect(value(deal, 'effective_to')).toBe('08/31/2026');
    expect(value(deal, 'counterparty')).toBe(value(mcb, 'retailer_name'));
  });
});

describe('the second distributor’s deduction detail export', () => {
  it('carries a spoils line and an MCB admin fee, each with its own deduction number', () => {
    expect([0, 1].map((i) => value(keystone, `lines[${i}].reason_code`))).toEqual([
      'SPL-WH',
      'MCB-ADM',
    ]);
    const references = [0, 1].map((i) => value(keystone, `lines[${i}].deduction_reference`));
    expect(new Set(references).size).toBe(2);
    expect(references).not.toContain(value(keystone, 'claim_id'));
    expect(linesTotal(keystone)).toBe(NATURAL_KEYSTONE_TOTAL_CENTS);
    expect(value(keystone, 'deduction_total')).toBe(NATURAL_KEYSTONE_TOTAL_CENTS);
  });
});

describe('the shortage’s BOL and POD', () => {
  const ordered = NATURAL_SHORTAGE_PO.items.reduce((sum, i) => sum + i.cases, 0);

  it('name the shortage’s PO, and the shortage names its invoice', () => {
    expect(value(bol, 'po_number')).toBe(NATURAL_SHORTAGE_PO.po);
    expect(value(pod, 'po_number')).toBe(NATURAL_SHORTAGE_PO.po);
    const line = NATURAL_ADVICE_LINES.find((l) => l.deduction?.code.endsWith('-111'));
    expect(line?.po).toBe(NATURAL_SHORTAGE_PO.po);
    expect(line?.invoice).toBe(NATURAL_SHORTAGE_PO.invoice);
  });

  it('shipped and received exactly what was ordered, signed, with no exception', () => {
    expect(value(bol, 'total_cartons_shipped')).toBe(ordered);
    expect(value(pod, 'total_cartons_shipped')).toBe(ordered);
    expect(value(pod, 'total_cartons_received')).toBe(ordered);
    NATURAL_SHORTAGE_PO.items.forEach((item, index) => {
      expect(value(bol, `lines[${index}].sku_upc`)).toBe(item.item);
      expect(value(bol, `lines[${index}].qty_shipped`)).toBe(item.cases);
      expect(value(pod, `lines[${index}].sku_upc`)).toBe(item.item);
      expect(value(pod, `lines[${index}].qty_received`)).toBe(item.cases);
    });
    expect(value(pod, 'signature_present')).toBe(true);
    expect(pod.pageText[0]).toContain('RECEIVED IN FULL');
    expect(pod.pageText[0]).toContain('Exceptions: NONE');
  });
});

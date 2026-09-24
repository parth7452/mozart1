import { describe, expect, it } from 'vitest';
import {
  NORTHGATE_812_TOTAL_CENTS,
  NORTHGATE_CHARGEBACK_LINES,
  NORTHGATE_CHARGEBACK_TOTAL_CENTS,
  formatsDocuments,
  northgate812Segments,
} from '../src/formats';

/**
 * The `formats` suite has to agree with itself before it can measure anything.
 *
 * Each document is generated from one table, and these tests hold the claims
 * the suite exists to make: that the chargeback's reason codes really are
 * printed once per merged cell, that its subtotal rows are not lines, and that
 * the 812 printout really does state every amount twice — once as money, once
 * as an EDI number with the decimal point implied.
 */

const byKey = (key: string) => {
  const found = formatsDocuments().find((d) => d.key === key);
  if (found === undefined) throw new Error(`no formats fixture ${key}`);
  return found;
};

const chargeback = byKey('northgate-chargeback-merged-cells');
const edi812 = byKey('northgate-edi-812-portal-export');

/** The sum of every `lines[n].deduction_amount` the truth asserts, in cents. */
function linesTotal(truth: (typeof chargeback)['truth']): number {
  return Object.entries(truth)
    .filter(([path]) => /^lines\[\d+\]\.deduction_amount$/.test(path))
    .reduce((sum, [, expectation]) => sum + Number(expectation.value), 0);
}

describe('the formats suite', () => {
  it('is two deduction notices, one page each, in their own suite', () => {
    expect(formatsDocuments().map((d) => d.key)).toEqual([
      'northgate-chargeback-merged-cells',
      'northgate-edi-812-portal-export',
    ]);
    for (const document of formatsDocuments()) {
      expect(document.suite).toBe('formats');
      expect(document.docType).toBe('deduction_notice');
      expect(document.pageText).toHaveLength(1);
      // A page this renderer can hold: about 48 lines of 10pt Helvetica.
      expect(document.pageText[0]?.split('\n').length, document.key).toBeLessThanOrEqual(46);
      expect(new TextDecoder().decode(document.bytes.slice(0, 5))).toBe('%PDF-');
    }
  });

  it('asserts nothing that is not printed on its own page', () => {
    // As the scorer compares text: case-insensitive, whitespace collapsed.
    const fold = (value: string) => value.toLowerCase().replace(/\s+/g, ' ');
    for (const document of formatsDocuments()) {
      const page = fold(document.pageText.join('\n'));
      for (const [field, expectation] of Object.entries(document.truth)) {
        if (expectation.kind !== 'text') continue;
        expect(page, `${document.key}.${field}`).toContain(fold(String(expectation.value)));
      }
    }
  });

  it('carries no synthetic banner a classifier could learn instead of the document', () => {
    for (const document of formatsDocuments()) {
      expect(document.pageText.join('').toUpperCase(), document.key).not.toContain('SYNTHETIC');
    }
  });
});

describe('the chargeback with merged program cells', () => {
  it('adds up: every line to the total, and no subtotal is a line', () => {
    expect(linesTotal(chargeback.truth)).toBe(NORTHGATE_CHARGEBACK_TOTAL_CENTS);
    expect(chargeback.truth.deduction_total?.value).toBe(NORTHGATE_CHARGEBACK_TOTAL_CENTS);
    const lines = Object.keys(chargeback.truth).filter((p) => p.endsWith('.deduction_amount'));
    expect(lines).toHaveLength(NORTHGATE_CHARGEBACK_LINES);
    // $1,367.10 across 13 lines in three programs, and three subtotal rows on
    // the page that a reader must not take for lines.
    expect(NORTHGATE_CHARGEBACK_TOTAL_CENTS).toBe(136_710);
    expect((chargeback.pageText[0]?.match(/Subtotal /g) ?? []).length).toBe(3);
  });

  it('prints each reason code once, on its group’s first row, and gives every line one', () => {
    const rows = (chargeback.pageText[0] ?? '').split('\n');
    for (const code of ['DPB-0917', 'SWELL-Q3', 'OSD-SHORT']) {
      // Once in the merged cell, once in its subtotal — never on the rows
      // between, which is the whole difficulty.
      const printed = rows.filter((row) => row.startsWith(code));
      expect(printed, code).toHaveLength(1);
      const withCode = Object.entries(chargeback.truth).filter(
        ([path, e]) => path.endsWith('.reason_code') && e.value === code,
      );
      expect(withCode.length, code).toBeGreaterThan(1);
    }
    // A row that prints no code still has one in the truth: the group's.
    expect(chargeback.truth['lines[5].reason_code']?.value).toBe('DPB-0917');
    expect(rows.find((row) => row.includes('44137'))?.startsWith(' ')).toBe(true);
  });

  it('puts the same item in two programs under two codes', () => {
    const lines = Object.entries(chargeback.truth).filter(
      ([path, e]) => path.endsWith('.sku_upc') && e.value === '44102',
    );
    expect(lines.map(([path]) => chargeback.truth[path.replace('sku_upc', 'reason_code')]?.value))
      .toEqual(['DPB-0917', 'OSD-SHORT']);
  });
});

describe('the 812 as a supplier portal prints it', () => {
  it('adds up, and states the total as money', () => {
    expect(linesTotal(edi812.truth)).toBe(NORTHGATE_812_TOTAL_CENTS);
    expect(NORTHGATE_812_TOTAL_CENTS).toBe(184_250);
    expect(edi812.pageText[0]).toContain('Total Adjustment Amount');
    expect(edi812.pageText[0]).toContain('$1,842.50');
  });

  it('prints every amount a second time as an EDI number with the decimal point implied', () => {
    const segments = northgate812Segments();
    const bcd = segments.find((s) => s.startsWith('BCD*'));
    // BCD04 is the total, in cents, with no decimal point: the value a reader
    // must not copy as money.
    expect(bcd?.split('*')[4]).toBe(String(NORTHGATE_812_TOTAL_CENTS));
    const cdd = segments.filter((s) => s.startsWith('CDD*'));
    const segmentAmounts = cdd.map((s) => Number(s.replace(/~$/, '').split('*')[4]));
    const truthAmounts = [0, 1, 2].map((i) => edi812.truth[`lines[${i}].deduction_amount`]?.value);
    expect(segmentAmounts).toEqual(truthAmounts);
    expect(segmentAmounts.reduce((a, b) => a + b, 0)).toBe(NORTHGATE_812_TOTAL_CENTS);
  });

  it('states the one quantity-contested line’s arithmetic: (120 − 105) × $75.00 = $1,125.00', () => {
    expect(edi812.truth['lines[0].qty_invoiced']?.value).toBe(120);
    expect(edi812.truth['lines[0].qty_received']?.value).toBe(105);
    expect(edi812.truth['lines[0].unit_cost']?.value).toBe(7_500);
    expect((120 - 105) * 7_500).toBe(edi812.truth['lines[0].deduction_amount']?.value);
  });
});

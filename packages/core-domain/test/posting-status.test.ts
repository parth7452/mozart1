import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  NOTHING_SENT_REASONS,
  STATED_INVOICE,
  nothingWasSent,
  resolveStatedInvoice,
  type LedgerInvoiceRef,
} from '../src/posting-status';

const ref = (id: string, docNumber?: string): LedgerInvoiceRef => ({ id, docNumber });

describe('which invoice a person named (ADR 0069 §1)', () => {
  it('takes a printed number that exactly one invoice carries, and answers its internal id', () => {
    // Production, 2026-10-05: 120324 was printed on the notice; no invoice has that id.
    expect(
      resolveStatedInvoice('120324', { byId: undefined, byDocNumber: [ref('3391', '120324')] }, undefined),
    ).toEqual({ ok: true, invoice: ref('3391', '120324') });
  });

  it('refuses what the ledger has no invoice for, and what several carry', () => {
    expect(resolveStatedInvoice('120324', { byId: undefined, byDocNumber: [] }, undefined)).toEqual({
      ok: false,
      reason: 'invoice_not_found',
    });
    expect(
      resolveStatedInvoice('1001', { byId: undefined, byDocNumber: [ref('5', '1001'), ref('6', '1001')] }, undefined),
    ).toEqual({ ok: false, reason: 'invoice_ambiguous' });
  });

  it('refuses digits that are one invoice’s id and another’s printed number', () => {
    expect(
      resolveStatedInvoice('71', { byId: ref('71', '1040'), byDocNumber: [ref('9', '71')] }, undefined),
    ).toEqual({ ok: false, reason: 'invoice_ambiguous' });
  });

  it('counts an invoice found both ways once', () => {
    expect(
      resolveStatedInvoice('71', { byId: ref('71', '71'), byDocNumber: [ref('71', '71')] }, undefined),
    ).toEqual({ ok: true, invoice: ref('71', '71') });
  });

  it('keeps a ledger-opened case on its own invoice id, whatever else prints those digits', () => {
    const found = { byId: ref('71', '1040'), byDocNumber: [ref('9', '71')] };
    expect(resolveStatedInvoice('71', found, '71')).toEqual({ ok: true, invoice: ref('71', '1040') });
    // Only while the ledger still has it, and only for the id the sync recorded.
    expect(resolveStatedInvoice('71', { byId: undefined, byDocNumber: [] }, '71')).toEqual({
      ok: false,
      reason: 'invoice_not_found',
    });
    expect(resolveStatedInvoice('71', found, '72')).toEqual({ ok: false, reason: 'invoice_ambiguous' });
  });

  it('refuses an answer by id that is not the id asked for', () => {
    expect(() => resolveStatedInvoice('71', { byId: ref('72'), byDocNumber: [] }, undefined)).toThrow(RangeError);
  });

  it('never answers an id the ledger did not report', () => {
    const refs = fc.array(fc.record({ id: fc.stringMatching(/^[1-9][0-9]{0,5}$/), docNumber: fc.constant('N1') }), {
      maxLength: 4,
    });
    fc.assert(
      fc.property(refs, fc.option(fc.stringMatching(/^[1-9][0-9]{0,5}$/), { nil: undefined }), (byDocNumber, own) => {
        const result = resolveStatedInvoice('N1', { byId: undefined, byDocNumber }, own);
        const ids = new Set(byDocNumber.map((r) => r.id));
        if (result.ok) {
          expect(ids.has(result.invoice.id)).toBe(true);
          expect(ids.size).toBe(1);
        } else {
          expect(result.reason).toBe(ids.size === 0 ? 'invoice_not_found' : 'invoice_ambiguous');
        }
      }),
    );
  });

  it('admits no character that could leave a quoted literal', () => {
    for (const bad of ["1'", 'a\\b', 'a"b', 'a\nb', '', ' 71', 'x'.repeat(22), 'a;b', 'a%b']) {
      expect(STATED_INVOICE.test(bad)).toBe(false);
    }
    for (const good of ['120324', 'INV-1001', 'A 12/3', 'SO#44.1', 'x'.repeat(21)]) {
      expect(STATED_INVOICE.test(good)).toBe(true);
    }
  });
});

describe('whether anything was sent (ADR 0069 §2)', () => {
  it('is true only when every attempt ended before the send, and there was one', () => {
    expect(nothingWasSent(['invoice_not_found'])).toBe(true);
    expect(nothingWasSent([...NOTHING_SENT_REASONS])).toBe(true);
    expect(nothingWasSent([])).toBe(false);
    for (const sent of ['send_failed', 'unknown_outcome', 'readback_failed', 'readback_mismatch', 'sent', undefined]) {
      expect(nothingWasSent(['invoice_not_found', sent])).toBe(false);
      expect(nothingWasSent([sent, 'invoice_not_found'])).toBe(false);
    }
  });
});

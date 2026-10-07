import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  MANUAL_ENTRY_MAX_INVOICES,
  MANUAL_ENTRY_NOTES_MAX,
  MANUAL_ENTRY_TEXT_MAX,
  ManualEntryError,
  buildManualEntryDocument,
  manualEntryFromForm,
  parseMoneyToCents,
} from '../src';
import type { ManualEntryField, ManualEntryForm } from '../src';

const DEBTOR = '11111111-2222-4333-8444-555555555555';
const OTHER = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const TODAY = new Date('2026-10-07T12:00:00Z');

function form(over: Partial<ManualEntryForm> = {}): ManualEntryForm {
  return {
    debtorId: DEBTOR,
    deductionReference: ' CB-203 ',
    amount: '$3,120.00',
    deductionDate: '2026-09-30',
    reasonCode: 'PREMIUM-NOAUTH',
    invoiceNumbers: 'INV-1, INV-2\nINV-1\n\n',
    ...over,
  };
}

function refused(over: Partial<ManualEntryForm>, field: ManualEntryField): void {
  try {
    manualEntryFromForm(form(over), TODAY);
  } catch (e) {
    expect(e).toBeInstanceOf(ManualEntryError);
    expect((e as ManualEntryError).field).toBe(field);
    return;
  }
  throw new Error(`expected ${field} to be refused`);
}

describe('a manual entry read from the form (ADR 0070)', () => {
  it('reads the happy path, trimmed, money in cents, dispute defaulting to the whole', () => {
    const e = manualEntryFromForm(form(), TODAY);
    expect(e.debtorId).toBe(DEBTOR);
    expect(e.deductionReference).toBe('CB-203');
    expect(e.amountCents).toBe(312000);
    expect(e.disputeAmountCents).toBe(312000);
    expect(e.deductionDate).toBe('2026-09-30');
    expect(e.invoiceNumbers).toEqual(['INV-1', 'INV-2']);
    expect(e.poNumber).toBeUndefined();
    expect('notes' in e).toBe(false);
  });

  it('keeps a partial dispute and the optional fields', () => {
    const e = manualEntryFromForm(
      form({
        disputeAmount: '1,000.00',
        poNumber: 'PO-9',
        paymentReference: 'CHK-1',
        endRetailerDebtorId: OTHER,
        assigneeId: OTHER,
        notes: 'Called the buyer.\n\tSays it was approved.',
      }),
      TODAY,
    );
    expect(e.disputeAmountCents).toBe(100000);
    expect(e.poNumber).toBe('PO-9');
    expect(e.paymentReference).toBe('CHK-1');
    expect(e.endRetailerDebtorId).toBe(OTHER);
    expect(e.assigneeId).toBe(OTHER);
    expect(e.notes).toContain('\n');
  });

  it('treats an empty optional id as absent', () => {
    const e = manualEntryFromForm(form({ endRetailerDebtorId: '', assigneeId: '  ' }), TODAY);
    expect(e.endRetailerDebtorId).toBeUndefined();
    expect(e.assigneeId).toBeUndefined();
  });

  it('refuses each field by name', () => {
    refused({ debtorId: '' }, 'debtorId');
    refused({ debtorId: 'walmart' }, 'debtorId');
    refused({ deductionReference: '   ' }, 'deductionReference');
    refused({ deductionReference: 'x'.repeat(MANUAL_ENTRY_TEXT_MAX + 1) }, 'deductionReference');
    refused({ deductionReference: 'CB\u0007203' }, 'deductionReference');
    refused({ amount: '' }, 'amount');
    refused({ amount: 'twelve' }, 'amount');
    refused({ amount: '0.00' }, 'amount');
    refused({ amount: '-5.00' }, 'amount');
    refused({ amount: '$0.0125' }, 'amount');
    refused({ deductionDate: '09/30/2026' }, 'deductionDate');
    refused({ deductionDate: '2026-02-30' }, 'deductionDate');
    refused({ deductionDate: '2026-10-08' }, 'deductionDate');
    refused({ reasonCode: '' }, 'reasonCode');
    refused({ reasonCode: 'A\nB' }, 'reasonCode');
    refused({ invoiceNumbers: ' , \n' }, 'invoiceNumbers');
    refused({ invoiceNumbers: 'x'.repeat(MANUAL_ENTRY_TEXT_MAX + 1) }, 'invoiceNumbers');
    refused({ poNumber: 'x'.repeat(MANUAL_ENTRY_TEXT_MAX + 1) }, 'poNumber');
    refused({ paymentReference: 'a\u0000b' }, 'paymentReference');
    refused({ disputeAmount: 'abc' }, 'disputeAmount');
    refused({ disputeAmount: '0' }, 'disputeAmount');
    refused({ disputeAmount: '3,120.01' }, 'disputeAmount');
    refused({ endRetailerDebtorId: 'nope' }, 'endRetailerDebtorId');
    refused({ notes: 'x'.repeat(MANUAL_ENTRY_NOTES_MAX + 1) }, 'notes');
    refused({ notes: 'bell\u0007' }, 'notes');
    refused({ assigneeId: 'me' }, 'assigneeId');
  });

  it('accepts today, and a dispute equal to the deduction', () => {
    const e = manualEntryFromForm(form({ deductionDate: '2026-10-07', disputeAmount: '3120' }), TODAY);
    expect(e.disputeAmountCents).toBe(312000);
  });

  it('splits invoices on commas and newlines, de-duplicates in order, and bounds the count', () => {
    const e = manualEntryFromForm(form({ invoiceNumbers: 'B,A\r\nB , C' }), TODAY);
    expect(e.invoiceNumbers).toEqual(['B', 'A', 'C']);
    const max = Array.from({ length: MANUAL_ENTRY_MAX_INVOICES }, (_, i) => `I${i}`);
    expect(manualEntryFromForm(form({ invoiceNumbers: max.join(',') }), TODAY).invoiceNumbers).toHaveLength(
      MANUAL_ENTRY_MAX_INVOICES,
    );
    refused({ invoiceNumbers: [...max, 'one-more'].join(',') }, 'invoiceNumbers');
  });

  it('reads the amount exactly as parseMoneyToCents does', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 99_999_999 }), (n) => {
        const amount = `${Math.floor(n / 100)}.${String(n % 100).padStart(2, '0')}`;
        const e = manualEntryFromForm(form({ amount }), TODAY);
        expect(e.amountCents).toBe(parseMoneyToCents(amount));
        expect(e.amountCents).toBe(n);
      }),
    );
  });
});

describe('the manual entry document', () => {
  const at = new Date('2026-10-07T09:30:00Z');

  it('is canonical JSON with sorted snake_case keys and only the optional keys given', () => {
    const e = manualEntryFromForm(form({ poNumber: 'PO-9' }), TODAY);
    const doc = buildManualEntryDocument(e, OTHER, at);
    expect(doc.filename).toBe('manual-entry.json');
    expect(doc.mimeType).toBe('application/json');
    const body = JSON.parse(new TextDecoder().decode(doc.bytes)) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual([...Object.keys(body)].sort());
    expect(body).toEqual({
      amount_cents: 312000,
      debtor_id: DEBTOR,
      deduction_date: '2026-09-30',
      deduction_reference: 'CB-203',
      dispute_amount_cents: 312000,
      entered_at: '2026-10-07T09:30:00.000Z',
      entered_by: OTHER,
      invoice_numbers: ['INV-1', 'INV-2'],
      kind: 'manual_entry',
      po_number: 'PO-9',
      reason_code: 'PREMIUM-NOAUTH',
      version: 1,
    });
    expect(doc.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is byte-identical for the same entry, person and instant, and differs otherwise', () => {
    const e = manualEntryFromForm(form(), TODAY);
    const a = buildManualEntryDocument(e, OTHER, at);
    const b = buildManualEntryDocument(manualEntryFromForm(form(), TODAY), OTHER, at);
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
    expect(a.sha256).toBe(b.sha256);
    expect(buildManualEntryDocument(e, DEBTOR, at).sha256).not.toBe(a.sha256);
  });
});

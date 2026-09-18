import { describe, expect, it } from 'vitest';
import {
  EXPECTED_EXTRACTIONS,
  KEHE_UNSIGNED_POD,
  TARGET_PRICE_DISCREPANCY,
  WALMART_CODE_24,
} from '@recouple/fixtures';
import { blockingFindings, disputeSupport, reconcileNotice } from '../src/reconcile';
import type { DeductionNotice, Invoice, PurchaseOrder, ShipmentDocument } from '../src/schemas';

const expected = <T>(key: string): T => EXPECTED_EXTRACTIONS[key] as T;

const codes = (findings: readonly { code: string }[]) => findings.map((f) => f.code);

describe('the plan’s worked case: Walmart code 24, $3,120', () => {
  const notice = expected<DeductionNotice>('walmart-apdp-notice');
  const po = expected<PurchaseOrder>('walmart-po');
  const invoice = expected<Invoice>('harborline-invoice');
  const bol = expected<ShipmentDocument>('carrier-bol');

  it('confirms the shortage arithmetic the notice claims', () => {
    const result = reconcileNotice({ notice, po, invoice, shipment: bol });
    // (30 invoiced − 25 received) × $624.00 = $3,120.00
    expect(result.lines[0]?.expectedShortageCents).toBe(312_000);
    expect(result.lines[0]?.claimedCents).toBe(312_000);
    expect(result.lines[0]?.verdict).toBe('matches');
    expect(result.lines[0]?.deltaCents).toBe(0);
  });

  it('agrees the lines add up to the stated total', () => {
    const result = reconcileNotice({ notice });
    expect(result.lineSumCents).toBe(312_000);
    expect(result.claimedTotalCents).toBe(312_000);
    expect(codes(result.findings)).not.toContain('total_does_not_match_lines');
    expect(result.internallyConsistent).toBe(true);
  });

  it('finds the evidence that makes this disputable: a signed BOL showing the shortage', () => {
    const result = reconcileNotice({ notice, po, invoice, shipment: bol });
    expect(codes(disputeSupport(result))).toContain('delivery_confirms_shortage');
    expect(blockingFindings(result)).toHaveLength(0);
  });

  it('matches the PO price and the invoiced quantity, so neither is a basis', () => {
    const result = reconcileNotice({ notice, po, invoice, shipment: bol });
    expect(codes(result.findings)).not.toContain('unit_cost_differs_from_po');
    expect(codes(result.findings)).not.toContain('invoiced_quantity_differs');
  });

  it('is the case the demo script tells', () => {
    expect(WALMART_CODE_24.documents).toHaveLength(4);
    expect(WALMART_CODE_24.expectedOutcome).toMatch(/\$3,120/);
  });
});

describe('a claim the supporting document contradicts', () => {
  it('flags an unsigned, carrier-generated delivery report as blocking', () => {
    const result = reconcileNotice({
      notice: expected<DeductionNotice>('kehe-notice'),
      shipment: expected<ShipmentDocument>('unsigned-pod'),
    });
    expect(codes(blockingFindings(result))).toContain('delivery_document_unsigned');
    expect(result.internallyConsistent).toBe(false);
    expect(KEHE_UNSIGNED_POD.expectedOutcome).toMatch(/signed POD/);
  });

  it('flags a delivery document that belongs to a different PO', () => {
    const result = reconcileNotice({
      notice: expected<DeductionNotice>('target-price-notice'),
      shipment: expected<ShipmentDocument>('unsigned-pod'),
    });
    expect(codes(result.findings)).toContain('shipment_po_mismatch');
  });

  it('notes when a delivery shows everything was received', () => {
    const result = reconcileNotice({
      notice: expected<DeductionNotice>('kehe-notice'),
      shipment: expected<ShipmentDocument>('unsigned-pod'),
    });
    expect(codes(disputeSupport(result))).toContain('delivery_shows_full_receipt');
  });
});

describe('price discrepancy where the PO agrees with the invoice', () => {
  it('finds no price difference, which is what makes the deduction questionable', () => {
    const result = reconcileNotice({
      notice: expected<DeductionNotice>('target-price-notice'),
      po: expected<PurchaseOrder>('target-po'),
    });
    expect(codes(result.findings)).not.toContain('unit_cost_differs_from_po');
    expect(result.claimedTotalCents).toBe(171_000);
    expect(TARGET_PRICE_DISCREPANCY.expectedOutcome).toMatch(/invalid deduction/);
  });

  it('does report a price difference when there is one', () => {
    const notice = expected<DeductionNotice>('target-price-notice');
    const cheaperPo = structuredClone(expected<PurchaseOrder>('target-po'));
    (cheaperPo.lines[0] as { unit_cost: { value: string } }).unit_cost.value = '$12.00';
    const result = reconcileNotice({ notice, po: cheaperPo });
    expect(codes(disputeSupport(result))).toContain('unit_cost_differs_from_po');
  });
});

describe('arithmetic the notice gets wrong', () => {
  const notice = () => structuredClone(expected<DeductionNotice>('walmart-apdp-notice'));

  it('catches a line total that does not follow from the quantities', () => {
    const tampered = notice();
    (tampered.lines[0] as { deduction_amount: { value: string } }).deduction_amount.value =
      '$4,000.00';
    tampered.deduction_total.value = '$4,000.00';
    const result = reconcileNotice({ notice: tampered });
    expect(codes(result.findings)).toContain('line_arithmetic_differs');
    // Over-claiming supports a dispute; the supplier is owed the difference.
    expect(codes(disputeSupport(result))).toContain('line_arithmetic_differs');
  });

  it('catches a total that does not match its own lines', () => {
    const tampered = notice();
    tampered.deduction_total.value = '$5,000.00';
    const result = reconcileNotice({ notice: tampered });
    expect(codes(blockingFindings(result))).toContain('total_does_not_match_lines');
  });

  it('refuses to guess at an amount it cannot read', () => {
    const tampered = notice();
    (tampered.lines[0] as { deduction_amount: { value: string } }).deduction_amount.value =
      'three thousand one hundred twenty';
    const result = reconcileNotice({ notice: tampered });
    expect(codes(blockingFindings(result))).toContain('unparseable_amount');
    expect(result.lines[0]?.claimedCents).toBeNull();
  });

  it('calls an overage what it is, rather than computing a negative shortage', () => {
    const tampered = notice();
    (tampered.lines[0] as { qty_received: { value: number } }).qty_received.value = 35;
    const result = reconcileNotice({ notice: tampered });
    expect(codes(result.findings)).toContain('overage_not_shortage');
    expect(result.lines[0]?.expectedShortageCents).toBeNull();
  });

  it('notices an item that was deducted but never invoiced', () => {
    const tampered = notice();
    (tampered.lines[0] as { sku_upc: { value: string } }).sku_upc.value = '999-0000-00';
    const result = reconcileNotice({
      notice: tampered,
      invoice: expected<Invoice>('harborline-invoice'),
    });
    expect(codes(disputeSupport(result))).toContain('item_not_on_invoice');
  });
});

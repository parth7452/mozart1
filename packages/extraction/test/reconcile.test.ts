import { describe, expect, it } from 'vitest';
import {
  EXPECTED_EXTRACTIONS,
  KEHE_UNSIGNED_POD,
  TARGET_PRICE_DISCREPANCY,
  WALMART_CODE_24,
} from '@recouple/fixtures';
import { blockingFindings, disputeSupport, reconcileNotice } from '../src/reconcile';
import type {
  Correspondence,
  DeductionNotice,
  Invoice,
  PurchaseOrder,
  ShipmentDocument,
} from '../src/schemas';

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

/**
 * The logistics case: a $600 late-delivery fee assessed against an appointment
 * the customer had already replaced in writing.
 *
 * Built from the LOG-001 dispute pack. The whole argument is two timestamps and
 * a message — nothing a model should be asked to decide, and all of it checkable
 * here. Fields carry only what these rules read; the extraction schemas are
 * tested separately.
 */
describe('a late-delivery fee against a superseded appointment', () => {
  const f = <T>(value: T) => ({ value, source_page: 1, source_quote: 'x' }) as never;

  const lateFeeNotice = {
    retailer_name: f('Brookfield Supply Co.'),
    vendor_number: f(null),
    claim_id: f('CB-BSC-441'),
    invoice_number: f('INV-AFS-260814'),
    po_number: f('PO-BSC-8841'),
    store_or_dc: f(null),
    gln: f(null),
    asn_number: f(null),
    lines: [
      {
        sku_upc: f(null),
        description: f('Flat late-delivery fee'),
        qty_invoiced: f(null),
        qty_received: f(null),
        unit_cost: f(null),
        deduction_amount: f('$600.00'),
        reason_code: f('LATE-DEL'),
        reason_description: f('Delivery after original appointment'),
      },
    ],
    deduction_total: f('$600.00'),
    deduction_date: f('September 18, 2026'),
    dispute_deadline: f('October 18, 2026'),
    remittance_or_check: f('REM-BSC-0918-44'),
  } as unknown as DeductionNotice;

  const pod = {
    document_number: f('POD-771'),
    ship_date: f('August 13, 2026'),
    carrier_name: f('Alder Freight Services LLC'),
    po_number: f('PO-BSC-8841'),
    ship_from: f(null),
    ship_to: f(null),
    appointment_at: f('August 13, 2026, 2:00 PM Eastern'),
    gate_check_in_at: f('August 13, 2026, 1:42 PM Eastern'),
    appointment_reference: f('AP-BSC-771 revision 2'),
    total_cartons_shipped: f(24),
    total_cartons_received: f(24),
    signed_by: f('Jordan Ellis'),
    signature_present: f(true),
    lines: [],
  } as unknown as ShipmentDocument;

  const approvedReschedule = {
    message_reference: f('MSG-BSC-0811-338'),
    sent_at: f('August 11, 2026, 2:05 PM Eastern'),
    sender: f('Maya Chen <transport@brookfieldsupply.example>'),
    sender_organisation: f('Brookfield Supply Co.'),
    recipient: f('Evan Brooks <dispatch@alderfreight.example>'),
    subject: f('Approved reschedule - LD-260812-77 / AP-BSC-771'),
    references: [{ label: f('Load'), value: f('LD-260812-77') }],
    commitments: [
      {
        commitment_text: f(
          'Appointment AP-BSC-771 revision 2 replaces revision 1. No carrier late-delivery charge applies for moving delivery to this revised appointment.',
        ),
        effective_at: f('August 13, 2026, 2:00 PM Eastern'),
        supersedes: f('AP-BSC-771 revision 1'),
        establishes: f('AP-BSC-771 revision 2'),
        waives_charge: f(true),
        attributed_to: f('customer-requested'),
      },
    ],
  } as unknown as Correspondence;

  it('finds the carrier arrived before the appointment that was in force', () => {
    const result = reconcileNotice({ notice: lateFeeNotice, shipment: pod });
    expect(codes(disputeSupport(result))).toContain('arrived_before_appointment');
    // 13:42 against 14:00. The whole $600 turns on these eighteen minutes.
    expect(result.findings.find((x) => x.code === 'arrived_before_appointment')?.message).toMatch(
      /18 minutes before/,
    );
  });

  it('finds the appointment it was charged against had been replaced in writing', () => {
    const result = reconcileNotice({
      notice: lateFeeNotice,
      shipment: pod,
      correspondence: [approvedReschedule],
    });
    const supporting = codes(disputeSupport(result));
    expect(supporting).toContain('appointment_superseded');
    expect(supporting).toContain('charge_waived_in_writing');
  });

  it('quotes the customer rather than paraphrasing them', () => {
    // A packet argues with the customer's own words. A summary of them is worth
    // much less, and we cannot check it.
    const result = reconcileNotice({
      notice: lateFeeNotice,
      shipment: pod,
      correspondence: [approvedReschedule],
    });
    expect(result.findings.find((x) => x.code === 'charge_waived_in_writing')?.message).toContain(
      'No carrier late-delivery charge applies',
    );
  });

  it('does not read a plain reschedule as a waiver', () => {
    // Moving an appointment is not the same as promising not to charge. Reading
    // one as the other would invent the strongest part of the case.
    const rescheduleOnly = structuredClone(approvedReschedule) as unknown as {
      commitments: { waives_charge: { value: boolean } }[];
    };
    rescheduleOnly.commitments[0]!.waives_charge.value = false;
    const result = reconcileNotice({
      notice: lateFeeNotice,
      shipment: pod,
      correspondence: [rescheduleOnly as unknown as Correspondence],
    });
    const supporting = codes(disputeSupport(result));
    expect(supporting).toContain('appointment_superseded');
    expect(supporting).not.toContain('charge_waived_in_writing');
  });

  it('reads a waiver that supersedes nothing as a waiver (ADR 0040)', () => {
    // Both recorded readings of LOG-001's message split its two sentences into
    // two commitments, and the second — "No carrier late-delivery charge
    // applies" — waives and supersedes nothing. When the waiver was only looked
    // for inside the supersession loop, that sentence was skipped.
    const split = structuredClone(approvedReschedule) as unknown as {
      commitments: {
        commitment_text: { value: string };
        supersedes: { value: string | null };
        establishes: { value: string | null };
        waives_charge: { value: boolean };
      }[];
    };
    const [moved] = split.commitments;
    const waiver = structuredClone(moved!);
    moved!.waives_charge.value = false;
    moved!.commitment_text.value = 'Appointment AP-BSC-771 revision 2 replaces revision 1.';
    waiver.supersedes.value = null;
    waiver.establishes.value = null;
    waiver.commitment_text.value =
      'No carrier late-delivery charge applies for moving delivery to this revised appointment.';
    split.commitments.push(waiver);

    const result = reconcileNotice({
      notice: lateFeeNotice,
      shipment: pod,
      correspondence: [split as unknown as Correspondence],
    });
    const supporting = codes(disputeSupport(result));
    expect(supporting).toContain('appointment_superseded');
    expect(supporting.filter((c) => c === 'charge_waived_in_writing')).toHaveLength(1);
    expect(result.findings.find((x) => x.code === 'charge_waived_in_writing')?.message).toContain(
      'No carrier late-delivery charge applies',
    );
  });

  it('finds a waiver with no delivery record on the case at all', () => {
    // Whether the carrier was late is a question about timestamps; a customer
    // who wrote that no charge applies has answered a different one.
    const waiverOnly = structuredClone(approvedReschedule) as unknown as {
      commitments: { supersedes: { value: null }; establishes: { value: null } }[];
    };
    waiverOnly.commitments[0]!.supersedes.value = null;
    waiverOnly.commitments[0]!.establishes.value = null;
    const result = reconcileNotice({
      notice: lateFeeNotice,
      correspondence: [waiverOnly as unknown as Correspondence],
    });
    const supporting = codes(disputeSupport(result));
    expect(supporting).toContain('charge_waived_in_writing');
    expect(supporting).not.toContain('appointment_superseded');
  });

  it('says it could not check rather than comparing across zones', () => {
    const mixed = structuredClone(pod) as unknown as {
      gate_check_in_at: { value: string };
    };
    mixed.gate_check_in_at.value = 'August 13, 2026, 1:42 PM UTC';
    const result = reconcileNotice({
      notice: lateFeeNotice,
      shipment: mixed as unknown as ShipmentDocument,
    });
    expect(codes(result.findings)).toContain('appointment_times_not_comparable');
    expect(codes(disputeSupport(result))).not.toContain('arrived_before_appointment');
  });

  it('warns rather than supports when the carrier really was late', () => {
    const late = structuredClone(pod) as unknown as { gate_check_in_at: { value: string } };
    late.gate_check_in_at.value = 'August 13, 2026, 3:05 PM Eastern';
    const result = reconcileNotice({
      notice: lateFeeNotice,
      shipment: late as unknown as ShipmentDocument,
    });
    expect(codes(result.findings)).toContain('arrived_after_appointment');
    expect(codes(disputeSupport(result))).not.toContain('arrived_before_appointment');
  });

  it('checks nothing at all when the delivery record has no timestamps', () => {
    const bare = structuredClone(pod) as unknown as {
      gate_check_in_at: { value: string | null };
    };
    bare.gate_check_in_at.value = null;
    const result = reconcileNotice({
      notice: lateFeeNotice,
      shipment: bare as unknown as ShipmentDocument,
    });
    for (const code of ['arrived_before_appointment', 'arrived_after_appointment']) {
      expect(codes(result.findings)).not.toContain(code);
    }
  });
});

/**
 * The column-shift misread, caught by the money on the same line.
 *
 * A cassette re-recording read the Walmart notice's quantities as 24 and 30
 * instead of 30 and 25 — one column left, taking the reason code as the
 * invoiced quantity. Both numbers are plausible; nothing about them looks
 * wrong. The amount on the same line is what makes it checkable.
 */
describe('quantities that contradict the amount beside them', () => {
  const f = <T>(value: T) => ({ value, source_page: 1, source_quote: 'x' }) as never;

  const withQuantities = (invoiced: number | null, received: number | null): DeductionNotice =>
    ({
      retailer_name: f('Walmart'),
      vendor_number: f(null),
      claim_id: f('APDP-99812'),
      invoice_number: f(null),
      po_number: f(null),
      store_or_dc: f(null),
      gln: f(null),
      asn_number: f(null),
      lines: [
        {
          sku_upc: f('000-4471-08'),
          description: f('Case Pack Olive Oil'),
          qty_invoiced: f(invoiced),
          qty_received: f(received),
          unit_cost: f('$624.00'),
          deduction_amount: f('$3,120.00'),
          reason_code: f('24'),
          reason_description: f('Merchandise billed not received'),
        },
      ],
      deduction_total: f('$3,120.00'),
      deduction_date: f('08/14/2026'),
      dispute_deadline: f(null),
      remittance_or_check: f(null),
    }) as unknown as DeductionNotice;

  it('accepts the correct reading, where the money and the gap agree', () => {
    // $3,120.00 ÷ $624.00 = 5 units, and 30 − 25 = 5.
    const result = reconcileNotice({ notice: withQuantities(30, 25) });
    expect(codes(result.findings)).not.toContain('quantities_contradict_the_amount');
    expect(result.lines[0]?.verdict).toBe('matches');
  });

  it('blocks the column-shifted reading that a re-recording actually produced', () => {
    // 24 is the reason code, not a quantity. The gap of 6 cannot produce
    // $3,120.00 at $624.00 each, and the line says so without any help from us.
    const result = reconcileNotice({ notice: withQuantities(24, 30) });
    const contradiction = result.findings.find(
      (x) => x.code === 'quantities_contradict_the_amount',
    );
    expect(contradiction?.severity).toBe('blocking');
    expect(contradiction?.message).toMatch(/5 units/);
    expect(contradiction?.message).toMatch(/gap of 6/);
    // Blocking means the claim's own numbers do not hold up, which is the
    // honest verdict: we cannot file on a line that contradicts itself.
    expect(result.internallyConsistent).toBe(false);
  });

  it('catches it whichever way the columns slipped', () => {
    // The old `overage_not_shortage` branch only fired when received exceeded
    // invoiced, and then stopped without doing the arithmetic. This check runs
    // in both directions.
    for (const [invoiced, received] of [
      [24, 30],
      [30, 24],
    ] as const) {
      const result = reconcileNotice({ notice: withQuantities(invoiced, received) });
      expect(codes(result.findings), `${invoiced}/${received}`).toContain(
        'quantities_contradict_the_amount',
      );
    }
  });

  it('says nothing when the deduction is not a unit count times a unit cost', () => {
    // A price variance, a partial credit or a flat fee has no quotient to
    // compare. Guessing there would invent a contradiction.
    const priceVariance = withQuantities(30, 30) as unknown as {
      lines: { deduction_amount: { value: string } }[];
    };
    priceVariance.lines[0]!.deduction_amount.value = '$97.50';
    const result = reconcileNotice({ notice: priceVariance as unknown as DeductionNotice });
    expect(codes(result.findings)).not.toContain('quantities_contradict_the_amount');
  });

  it('says nothing when a quantity is missing', () => {
    const result = reconcileNotice({ notice: withQuantities(30, null) });
    expect(codes(result.findings)).not.toContain('quantities_contradict_the_amount');
  });
});

/**
 * A unit price printed past the cent (ADR 0049). It is stored rounded half-up
 * to the cent, and every check works at the price the page printed, so a line
 * that is right is never made wrong by the rounding.
 */
describe('a unit price printed past the cent', () => {
  /** The Walmart notice, re-priced as a deviated-price line by the pound. */
  function pricedNotice(unitCost: string, invoiced: number, received: number, deducted: string) {
    const notice = structuredClone(expected<DeductionNotice>('walmart-apdp-notice'));
    const line = notice.lines[0] as unknown as Record<string, { value: unknown }>;
    line.unit_cost!.value = unitCost;
    line.qty_invoiced!.value = invoiced;
    line.qty_received!.value = received;
    line.deduction_amount!.value = deducted;
    (notice as unknown as Record<string, { value: unknown }>).deduction_total!.value = deducted;
    return notice;
  }

  it('prices 10,000 lb at $0.0125 as $125.00, identical to the page', () => {
    const result = reconcileNotice({ notice: pricedNotice('$0.0125', 10_000, 0, '$125.00') });
    expect(result.lines[0]?.expectedShortageCents).toBe(12_500);
    expect(result.lines[0]?.verdict).toBe('matches');
    expect(codes(result.findings)).not.toContain('line_arithmetic_differs');
    expect(codes(result.findings)).not.toContain('quantities_contradict_the_amount');
    expect(codes(result.findings)).not.toContain('unparseable_amount');
  });

  it('never checks the line at the stored cent, which would invent a $25 over-deduction', () => {
    const result = reconcileNotice({ notice: pricedNotice('$0.0125', 10_000, 0, '$125.00') });
    expect(disputeSupport(result)).toHaveLength(0);
    expect(blockingFindings(result)).toHaveLength(0);
  });

  it('rounds the line total once, half-up, and prints the price as the page did', () => {
    // 3 lb at $0.0125 is $0.0375, rounded once to $0.04; $0.05 is a cent over.
    const matching = reconcileNotice({ notice: pricedNotice('$0.0125', 3, 0, '$0.04') });
    expect(matching.lines[0]?.verdict).toBe('matches');
    const over = reconcileNotice({ notice: pricedNotice('$0.0125', 3, 0, '$0.05') });
    const finding = over.findings.find((f) => f.code === 'line_arithmetic_differs');
    expect(finding?.severity).toBe('supports_dispute');
    expect(finding?.message).toContain('× $0.0125 = $0.04, but $0.05 was deducted');
  });

  it('does not call a line rounded to the cent a contradiction of its quantities', () => {
    // One unit at $0.0050 rounds to 1 cent, and 1 cent also divides into two.
    const result = reconcileNotice({ notice: pricedNotice('$0.0050', 1, 0, '$0.01') });
    expect(codes(result.findings)).not.toContain('quantities_contradict_the_amount');
    expect(result.lines[0]?.verdict).toBe('matches');
  });

  it('still catches quantities the amount contradicts, at the printed price', () => {
    // $125.00 at $0.0125 is 10,000 lb, but the line says a gap of 8,000.
    const result = reconcileNotice({ notice: pricedNotice('$0.0125', 8_000, 0, '$125.00') });
    const finding = blockingFindings(result).find((f) => f.code === 'quantities_contradict_the_amount');
    expect(finding?.message).toContain('$125.00 deducted at $0.0125 each is 10000 units');
  });

  it('compares a PO price exactly, though both prices are stored as one cent', () => {
    const notice = pricedNotice('$0.0125', 10_000, 0, '$125.00');
    const po = structuredClone(expected<PurchaseOrder>('walmart-po'));
    const poLine = po.lines[0] as unknown as Record<string, { value: unknown }>;
    poLine.unit_cost!.value = '$0.0130';
    const differs = reconcileNotice({ notice, po });
    const finding = disputeSupport(differs).find((f) => f.code === 'unit_cost_differs_from_po');
    expect(finding?.message).toContain('the deduction uses $0.0125 but the PO agreed $0.0130');

    poLine.unit_cost!.value = '$0.012500';
    const same = reconcileNotice({ notice, po });
    expect(codes(same.findings)).not.toContain('unit_cost_differs_from_po');
  });

  it('reports a cent of rounding as arithmetic, never as miscounted quantities', () => {
    // 1,001 at $0.0050 is $5.005: $5.00 also divides into 1,000 units, but it
    // is a payer rounding differently, not a different quantity.
    for (const [price, qty, deducted] of [
      ['$0.0050', 1_001, '$5.00'],
      ['$0.0050', 5, '$0.02'],
      ['$0.0125', 2, '$0.02'],
    ] as const) {
      const result = reconcileNotice({ notice: pricedNotice(price, qty, 0, deducted) });
      expect(codes(blockingFindings(result)), `${qty} at ${price}`).toEqual([]);
      expect(codes(result.findings), `${qty} at ${price}`).toContain('line_arithmetic_differs');
    }
  });

  it('reconciles an overage too large to price without throwing', () => {
    const result = reconcileNotice({ notice: pricedNotice('$1.00', 0, 9_000_000_000_000_000, '$1.00') });
    expect(codes(result.findings)).toContain('overage_not_shortage');
    expect(codes(result.findings)).toContain('quantities_contradict_the_amount');
  });

  it('refuses a negative unit price as a finding, never an exception', () => {
    for (const price of ['($0.0125)', '-$0.0125', '(0.05)']) {
      const result = reconcileNotice({ notice: pricedNotice(price, 10, 0, '$0.13') });
      const finding = blockingFindings(result).find((f) => f.code === 'unparseable_amount');
      expect(finding?.message, price).toMatch(/cannot be negative/);
    }
  });

  it('still refuses a unit price it cannot read, as a blocking finding', () => {
    const result = reconcileNotice({ notice: pricedNotice('$1.250', 100, 0, '$125.00') });
    const finding = blockingFindings(result).find((f) => f.code === 'unparseable_amount');
    expect(finding?.fieldPath).toBe('lines[0].unit_cost');
    expect(finding?.message).toMatch(/thousands group/);
  });
});

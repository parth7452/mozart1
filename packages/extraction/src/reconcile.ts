/**
 * Cross-document reconciliation (plan §7).
 *
 * Deterministic code, not a model. Shortage arithmetic, total checks and
 * three-way matching are exactly the things a model should never be trusted with
 * and exactly the things that decide whether a claim is worth filing.
 *
 * Findings are evidence for the decision layer, not a decision. A finding in the
 * supplier's favour ("the retailer paid below the PO price") is as important as
 * one against ("the notice's lines do not add up to its total").
 */

import {
  MoneyError,
  formatCents,
  parseMoneyToCents,
  shortageCents,
  sumCents,
  type Cents,
} from '@recouple/core-domain';
import type { FieldValue } from './field';
import type { DeductionNotice, Invoice, PurchaseOrder, ShipmentDocument } from './schemas';

export type FindingSeverity = 'blocking' | 'warning' | 'supports_dispute' | 'info';

export interface Finding {
  readonly code: string;
  readonly severity: FindingSeverity;
  readonly message: string;
  readonly fieldPath?: string;
}

export type LineVerdict = 'matches' | 'differs' | 'not_checkable';

export interface LineReconciliation {
  readonly sku: string;
  readonly reasonCode: string;
  readonly claimedCents: Cents | null;
  readonly expectedShortageCents: Cents | null;
  readonly deltaCents: Cents | null;
  readonly verdict: LineVerdict;
}

export interface Reconciliation {
  readonly lines: readonly LineReconciliation[];
  readonly claimedTotalCents: Cents | null;
  readonly lineSumCents: Cents | null;
  readonly findings: readonly Finding[];
  /** True when nothing blocking was found: the claim's own numbers hold up. */
  readonly internallyConsistent: boolean;
}

function valueOf<T>(field: FieldValue<T> | null | undefined): T | undefined {
  return field === null || field === undefined ? undefined : field.value;
}

/** Parses a money field, turning a failure into a finding instead of a throw. */
function money(
  field: FieldValue<string> | null | undefined,
  fieldPath: string,
  findings: Finding[],
): Cents | undefined {
  const text = valueOf(field);
  if (text === undefined) return undefined;
  try {
    return parseMoneyToCents(text);
  } catch (error) {
    findings.push({
      code: 'unparseable_amount',
      severity: 'blocking',
      message: `could not read ${JSON.stringify(text)} as an amount: ${
        error instanceof MoneyError ? error.message : 'unknown error'
      }`,
      fieldPath,
    });
    return undefined;
  }
}

function normaliseSku(sku: string): string {
  return sku.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface ReconcileInput {
  readonly notice: DeductionNotice;
  readonly invoice?: Invoice;
  readonly po?: PurchaseOrder;
  readonly shipment?: ShipmentDocument;
}

export function reconcileNotice(input: ReconcileInput): Reconciliation {
  const findings: Finding[] = [];
  const lines: LineReconciliation[] = [];
  const claimedAmounts: Cents[] = [];

  input.notice.lines.forEach((line, index) => {
    const path = `lines[${index}]`;
    const sku = line.sku_upc.value;
    const claimed = money(line.deduction_amount, `${path}.deduction_amount`, findings);
    if (claimed !== undefined) claimedAmounts.push(claimed);

    const qtyInvoiced = valueOf(line.qty_invoiced);
    const qtyReceived = valueOf(line.qty_received);
    const unitCost = money(line.unit_cost, `${path}.unit_cost`, findings);

    let expected: Cents | null = null;
    let verdict: LineVerdict = 'not_checkable';

    if (qtyInvoiced !== undefined && qtyReceived !== undefined && unitCost !== undefined) {
      if (qtyReceived > qtyInvoiced) {
        findings.push({
          code: 'overage_not_shortage',
          severity: 'warning',
          message: `${sku}: the retailer received ${qtyReceived} of ${qtyInvoiced} invoiced — that is an overage, so a shortage claim does not apply`,
          fieldPath: path,
        });
      } else {
        expected = shortageCents(qtyInvoiced, qtyReceived, unitCost);
        if (claimed !== undefined) {
          verdict = expected === claimed ? 'matches' : 'differs';
          if (verdict === 'differs') {
            findings.push({
              code: 'line_arithmetic_differs',
              severity: claimed > expected ? 'supports_dispute' : 'warning',
              message:
                `${sku}: (${qtyInvoiced} invoiced − ${qtyReceived} received) × ${formatCents(unitCost)} = ` +
                `${formatCents(expected)}, but ${formatCents(claimed)} was deducted`,
              fieldPath: path,
            });
          }
        }
      }
    }

    lines.push({
      sku,
      reasonCode: line.reason_code.value,
      claimedCents: claimed ?? null,
      expectedShortageCents: expected,
      deltaCents:
        claimed !== undefined && expected !== null ? ((claimed - expected) as Cents) : null,
      verdict,
    });
  });

  // Do the notice's own lines add up to the total it claims?
  const lineSum = claimedAmounts.length === input.notice.lines.length ? sumCents(claimedAmounts) : null;
  const claimedTotal = money(input.notice.deduction_total, 'deduction_total', findings) ?? null;
  if (lineSum !== null && claimedTotal !== null && lineSum !== claimedTotal) {
    findings.push({
      code: 'total_does_not_match_lines',
      severity: 'blocking',
      message: `the notice's lines sum to ${formatCents(lineSum)} but its total says ${formatCents(claimedTotal)}`,
      fieldPath: 'deduction_total',
    });
  }

  // Three-way match, where the supporting documents exist.
  if (input.invoice !== undefined) {
    const invoiceBySku = new Map(
      input.invoice.lines.map((l) => [normaliseSku(l.sku_upc.value), l] as const),
    );
    input.notice.lines.forEach((line, index) => {
      const invoiceLine = invoiceBySku.get(normaliseSku(line.sku_upc.value));
      if (invoiceLine === undefined) {
        findings.push({
          code: 'item_not_on_invoice',
          severity: 'supports_dispute',
          message: `${line.sku_upc.value} was deducted but does not appear on the invoice`,
          fieldPath: `lines[${index}].sku_upc`,
        });
        return;
      }
      const noticeQty = valueOf(line.qty_invoiced);
      const invoiceQty = invoiceLine.qty.value;
      if (noticeQty !== undefined && noticeQty !== invoiceQty) {
        findings.push({
          code: 'invoiced_quantity_differs',
          severity: 'warning',
          message: `${line.sku_upc.value}: the notice says ${noticeQty} invoiced, the invoice says ${invoiceQty}`,
          fieldPath: `lines[${index}].qty_invoiced`,
        });
      }
    });
  }

  if (input.po !== undefined) {
    const poBySku = new Map(input.po.lines.map((l) => [normaliseSku(l.sku_upc.value), l] as const));
    input.notice.lines.forEach((line, index) => {
      const poLine = poBySku.get(normaliseSku(line.sku_upc.value));
      if (poLine === undefined) return;
      const noticeCost = money(line.unit_cost, `lines[${index}].unit_cost`, findings);
      const poCost = money(poLine.unit_cost, `po.lines.unit_cost`, findings);
      if (noticeCost !== undefined && poCost !== undefined && noticeCost !== poCost) {
        findings.push({
          code: 'unit_cost_differs_from_po',
          severity: 'supports_dispute',
          message: `${line.sku_upc.value}: the deduction uses ${formatCents(noticeCost)} but the PO agreed ${formatCents(poCost)}`,
          fieldPath: `lines[${index}].unit_cost`,
        });
      }
      const noticeQty = valueOf(line.qty_invoiced);
      if (noticeQty !== undefined && noticeQty > poLine.qty_ordered.value) {
        findings.push({
          code: 'invoiced_above_po_quantity',
          severity: 'warning',
          message: `${line.sku_upc.value}: ${noticeQty} invoiced against a PO for ${poLine.qty_ordered.value}`,
          fieldPath: `lines[${index}].qty_invoiced`,
        });
      }
    });
  }

  if (input.shipment !== undefined) {
    const shipped = valueOf(input.shipment.total_cartons_shipped);
    const received = valueOf(input.shipment.total_cartons_received);
    const signed = input.shipment.signature_present.value;

    if (!signed) {
      findings.push({
        code: 'delivery_document_unsigned',
        severity: 'blocking',
        message:
          'the delivery document shows no signature or stamp — most retailers reject an unsigned delivery report as evidence',
        fieldPath: 'shipment.signature_present',
      });
    }
    if (shipped !== undefined && received !== undefined && received < shipped) {
      findings.push({
        code: 'delivery_confirms_shortage',
        severity: 'supports_dispute',
        message: `the delivery document shows ${shipped} shipped and ${received} signed for: a ${shipped - received}-carton shortage at the dock`,
        fieldPath: 'shipment.total_cartons_received',
      });
    }
    if (shipped !== undefined && received !== undefined && received === shipped) {
      findings.push({
        code: 'delivery_shows_full_receipt',
        severity: 'supports_dispute',
        message: `the delivery document shows all ${shipped} cartons signed for, contradicting a shortage deduction`,
        fieldPath: 'shipment.total_cartons_received',
      });
    }

    const noticePo = valueOf(input.notice.po_number);
    const shipmentPo = valueOf(input.shipment.po_number);
    if (
      noticePo !== undefined &&
      shipmentPo !== undefined &&
      noticePo.trim().toLowerCase() !== shipmentPo.trim().toLowerCase()
    ) {
      findings.push({
        code: 'shipment_po_mismatch',
        severity: 'warning',
        message: `the notice cites PO ${noticePo} but the delivery document cites ${shipmentPo}: check this evidence belongs to this claim`,
        fieldPath: 'shipment.po_number',
      });
    }
  }

  return {
    lines,
    claimedTotalCents: claimedTotal,
    lineSumCents: lineSum,
    findings,
    internallyConsistent: !findings.some((f) => f.severity === 'blocking'),
  };
}

export function blockingFindings(reconciliation: Reconciliation): readonly Finding[] {
  return reconciliation.findings.filter((f) => f.severity === 'blocking');
}

export function disputeSupport(reconciliation: Reconciliation): readonly Finding[] {
  return reconciliation.findings.filter((f) => f.severity === 'supports_dispute');
}

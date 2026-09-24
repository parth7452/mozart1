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
  subCents,
  sumCents,
  type Cents,
} from '@recouple/core-domain';
import type { FieldValue } from './field';
import type {
  Correspondence,
  DeductionNotice,
  Invoice,
  PurchaseOrder,
  RemittanceAdvice,
  ShipmentDocument,
} from './schemas';
import { minutesLate, parseTimestamp } from './timestamps';

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
  /**
   * A remittance line's two columns, when it printed them: what was owed and
   * what was paid, whose difference is `expectedShortageCents` (ADR 0040).
   * Present only on the line `reconcileRemittanceLine` reconciled, so a page can
   * show the working — "$4,800.00 gross less $4,200.00 paid" — rather than only
   * its answer. A notice line's working is quantities and a unit cost, and is
   * not carried here.
   */
  readonly grossCents?: Cents | null;
  readonly netCents?: Cents | null;
}

export interface Reconciliation {
  readonly lines: readonly LineReconciliation[];
  readonly claimedTotalCents: Cents | null;
  readonly lineSumCents: Cents | null;
  readonly findings: readonly Finding[];
  /** True when nothing blocking was found: the claim's own numbers hold up. */
  readonly internallyConsistent: boolean;
}

/**
 * The value of a field, or undefined when the document does not carry it.
 *
 * An optional field arrives as a null *value* inside the field object, and a
 * document rebuilt by something that dropped the absences arrives with no field
 * object at all. Both mean the same thing here, and neither may throw: this
 * file runs on every render of a review page, over documents read back out of a
 * store, and a shape it did not expect has to become a missing finding rather
 * than a 500. Nothing below reads `.value` directly — that is the rule.
 * `??` leaves false and 0 alone.
 */
function valueOf<T>(field: FieldValue<T | null> | null | undefined): T | undefined {
  if (field === null || field === undefined) return undefined;
  return field.value ?? undefined;
}

/** Parses a money field, turning a failure into a finding instead of a throw. */
function money(
  field: FieldValue<string | null> | null | undefined,
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

/** Two printed references to the same thing: a PO, an invoice number. */
function sameReference(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export interface ReconcileInput {
  readonly notice: DeductionNotice;
  readonly invoice?: Invoice;
  readonly po?: PurchaseOrder;
  readonly shipment?: ShipmentDocument;
  /** Messages on the case: an approved reschedule, a waiver, a confirmation. */
  readonly correspondence?: readonly Correspondence[];
}

/**
 * How late the carrier was against the appointment that was actually in force,
 * and whether anything on the case says the appointment moved.
 *
 * A whole class of deduction — late delivery, detention, appointment compliance
 * — is decided by two timestamps and a piece of paper saying which appointment
 * counted. None of that is arithmetic a model should do, and all of it is
 * checkable here.
 *
 * Deliberately conservative in three ways:
 *
 * - Timestamps in different zones are not compared at all (see `timestamps.ts`).
 * - A reschedule is not a waiver. The finding says the appointment moved; a
 *   charge not applying is `reconcileWaivers`' finding, and only where a
 *   message said so in writing.
 * - Nothing here decides anything. These are findings for a human and, later,
 *   for the decision layer.
 */
function reconcileAppointment(
  shipment: ShipmentDocument | undefined,
  correspondence: readonly Correspondence[],
  findings: Finding[],
): void {
  if (shipment === undefined) return;

  const checkInText = valueOf(shipment.gate_check_in_at);
  const appointmentText = valueOf(shipment.appointment_at);
  if (checkInText === undefined || appointmentText === undefined) return;

  const checkIn = parseTimestamp(checkInText);
  const appointment = parseTimestamp(appointmentText);
  if (checkIn === null || appointment === null) {
    findings.push({
      code: 'appointment_times_unreadable',
      severity: 'info',
      message:
        `could not read the appointment (${appointmentText}) or the gate check-in ` +
        `(${checkInText}) as a date and time, so lateness was not checked`,
      fieldPath: 'shipment.gate_check_in_at',
    });
    return;
  }

  // Did anything in writing move the appointment this was measured against? The
  // supersession is reported whether or not the times then work out, because a
  // fee assessed against a replaced appointment is wrong on its own terms.
  for (const message of correspondence) {
    for (const commitment of message.commitments) {
      const supersedes = valueOf(commitment.supersedes);
      const establishes = valueOf(commitment.establishes);
      if (supersedes === undefined && establishes === undefined) continue;

      const cited = valueOf(shipment.appointment_reference);
      findings.push({
        code: 'appointment_superseded',
        severity: 'supports_dispute',
        message:
          `${valueOf(message.sender_organisation) ?? 'the customer'} confirmed in writing ` +
          `(${valueOf(message.message_reference) ?? 'in a message on this case'}) ` +
          `that ${establishes ?? 'a later appointment'} ` +
          `replaced ${supersedes ?? 'the earlier appointment'}` +
          (cited !== undefined ? `; the delivery record cites ${cited}` : '') +
          `: “${valueOf(commitment.commitment_text) ?? ''}”`,
        fieldPath: 'correspondence.commitments',
      });
    }
  }

  const comparison = minutesLate(checkIn, appointment);
  if (!comparison.comparable) {
    findings.push({
      code: 'appointment_times_not_comparable',
      severity: 'info',
      message: `lateness was not checked: ${comparison.why}`,
      fieldPath: 'shipment.gate_check_in_at',
    });
    return;
  }

  const late = comparison.minutesLate;
  if (late <= 0) {
    findings.push({
      code: 'arrived_before_appointment',
      severity: 'supports_dispute',
      message:
        `gate check-in was ${Math.abs(late)} minutes before the confirmed appointment ` +
        `(${checkIn.asPrinted} against ${appointment.asPrinted})`,
      fieldPath: 'shipment.gate_check_in_at',
    });
    return;
  }

  // Late against the appointment on the delivery record. Whether that costs
  // anything depends on the agreement's grace window and on who caused it,
  // neither of which is decided here.
  findings.push({
    code: 'arrived_after_appointment',
    severity: 'warning',
    message:
      `gate check-in was ${late} minutes after the confirmed appointment ` +
      `(${checkIn.asPrinted} against ${appointment.asPrinted}); check the agreement’s ` +
      'grace window and whether the delay was carrier-caused before disputing',
    fieldPath: 'shipment.gate_check_in_at',
  });
}

/**
 * Every place a message on the case says in writing that a charge does not
 * apply.
 *
 * Its own pass, not a branch of the supersession loop above, because a waiver
 * is its own sentence. LOG-001's customer wrote "Appointment AP-BSC-771
 * revision 2 replaces revision 1. No carrier late-delivery charge applies…",
 * and both recorded readings of that page report the second sentence as a
 * commitment of its own: `waives_charge` true, superseding nothing. Nested
 * under "did this commitment move something", the one sentence that wins the
 * case was skipped (ADR 0040).
 *
 * And not gated on a delivery record either, for the same reason: whether the
 * carrier was late is a question about timestamps, and a customer who wrote
 * that no charge applies has answered a different one.
 */
function reconcileWaivers(correspondence: readonly Correspondence[], findings: Finding[]): void {
  for (const message of correspondence) {
    for (const commitment of message.commitments) {
      if (valueOf(commitment.waives_charge) !== true) continue;
      findings.push({
        code: 'charge_waived_in_writing',
        severity: 'supports_dispute',
        message:
          `${valueOf(message.sender_organisation) ?? 'the customer'} stated in writing that ` +
          `a charge would not apply: “${valueOf(commitment.commitment_text) ?? ''}”`,
        fieldPath: 'correspondence.commitments',
      });
    }
  }
}

/**
 * What the delivery record says about the claim, whatever the claim arrived on.
 *
 * `claimedPo` is the purchase order the claim itself names, when it names one:
 * a notice prints a PO, a remittance line does not, and a delivery record cannot
 * be checked against a PO nobody wrote down.
 */
function reconcileShipment(
  shipment: ShipmentDocument | undefined,
  claimedPo: string | undefined,
  findings: Finding[],
): void {
  if (shipment === undefined) return;
  const shipped = valueOf(shipment.total_cartons_shipped);
  const received = valueOf(shipment.total_cartons_received);
  // Undefined is not "signed": a delivery document whose signature field we
  // cannot read is not evidence that anybody signed for anything.
  const signed = valueOf(shipment.signature_present) ?? false;

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

  const shipmentPo = valueOf(shipment.po_number);
  if (claimedPo !== undefined && shipmentPo !== undefined && !sameReference(claimedPo, shipmentPo)) {
    findings.push({
      code: 'shipment_po_mismatch',
      severity: 'warning',
      message: `the notice cites PO ${claimedPo} but the delivery document cites ${shipmentPo}: check this evidence belongs to this claim`,
      fieldPath: 'shipment.po_number',
    });
  }
}

export function reconcileNotice(input: ReconcileInput): Reconciliation {
  const findings: Finding[] = [];
  const lines: LineReconciliation[] = [];
  const claimedAmounts: Cents[] = [];

  input.notice.lines.forEach((line, index) => {
    const path = `lines[${index}]`;
    // An invoice-level deduction (allowance, compliance charge, discount) has no
    // item identifier. It is still a line, and still has to add up.
    const sku = valueOf(line.sku_upc) ?? `line ${index + 1}`;
    const claimed = money(line.deduction_amount, `${path}.deduction_amount`, findings);
    if (claimed !== undefined) claimedAmounts.push(claimed);

    const qtyInvoiced = valueOf(line.qty_invoiced);
    const qtyReceived = valueOf(line.qty_received);
    const unitCost = money(line.unit_cost, `${path}.unit_cost`, findings);

    let expected: Cents | null = null;
    let verdict: LineVerdict = 'not_checkable';

    // The money checks the quantities.
    //
    // A deduction line prints the same fact twice: as a pair of quantities and
    // as an amount. When the amount divides evenly by the unit cost, the
    // quotient is how many units the retailer is charging for, and it has to
    // equal the gap between the quantities. When it does not, the line
    // contradicts itself and the reading cannot be trusted.
    //
    // This is worth a check of its own because of how these tables are laid
    // out. A reason code is often a bare number sitting immediately left of the
    // quantity columns, so a reader that slips one column takes the reason code
    // as a quantity — and the result is two plausible numbers that happen to be
    // wrong. The money columns carry currency symbols and are much harder to
    // mistake, so they are the better witness.
    //
    // Only when the division is exact: a deduction that is not a unit count
    // times a unit cost (a price variance, a partial credit, a flat fee) has no
    // quotient to compare, and says nothing here rather than guessing.
    if (
      qtyInvoiced !== undefined &&
      qtyReceived !== undefined &&
      unitCost !== undefined &&
      unitCost > 0 &&
      claimed !== undefined
    ) {
      const impliedUnits = claimed / unitCost;
      const statedGap = Math.abs(qtyInvoiced - qtyReceived);
      if (Number.isInteger(impliedUnits) && impliedUnits !== statedGap) {
        findings.push({
          code: 'quantities_contradict_the_amount',
          severity: 'blocking',
          message:
            `${sku}: ${formatCents(claimed)} deducted at ${formatCents(unitCost)} each is ` +
            `${impliedUnits} unit${impliedUnits === 1 ? '' : 's'}, but the line says ` +
            `${qtyInvoiced} invoiced and ${qtyReceived} received, a gap of ${statedGap}. ` +
            'The quantities and the amount on this line cannot both be right',
          fieldPath: path,
        });
      }
    }

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
      reasonCode: valueOf(line.reason_code) ?? '',
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
      input.invoice.lines.flatMap((l) => {
        const itemised = valueOf(l.sku_upc);
        return itemised === undefined ? [] : [[normaliseSku(itemised), l] as const];
      }),
    );
    input.notice.lines.forEach((line, index) => {
      // Nothing to match a line against when the deduction names no item.
      const sku = valueOf(line.sku_upc);
      if (sku === undefined) return;
      const invoiceLine = invoiceBySku.get(normaliseSku(sku));
      if (invoiceLine === undefined) {
        findings.push({
          code: 'item_not_on_invoice',
          severity: 'supports_dispute',
          message: `${sku} was deducted but does not appear on the invoice`,
          fieldPath: `lines[${index}].sku_upc`,
        });
        return;
      }
      const noticeQty = valueOf(line.qty_invoiced);
      const invoiceQty = valueOf(invoiceLine.qty);
      if (noticeQty !== undefined && invoiceQty !== undefined && noticeQty !== invoiceQty) {
        findings.push({
          code: 'invoiced_quantity_differs',
          severity: 'warning',
          message: `${sku}: the notice says ${noticeQty} invoiced, the invoice says ${invoiceQty}`,
          fieldPath: `lines[${index}].qty_invoiced`,
        });
      }
    });
  }

  if (input.po !== undefined) {
    const poBySku = new Map(
      input.po.lines.flatMap((l) => {
        const ordered = valueOf(l.sku_upc);
        return ordered === undefined ? [] : [[normaliseSku(ordered), l] as const];
      }),
    );
    input.notice.lines.forEach((line, index) => {
      const sku = valueOf(line.sku_upc);
      if (sku === undefined) return;
      const poLine = poBySku.get(normaliseSku(sku));
      if (poLine === undefined) return;
      const noticeCost = money(line.unit_cost, `lines[${index}].unit_cost`, findings);
      const poCost = money(poLine.unit_cost, `po.lines.unit_cost`, findings);
      if (noticeCost !== undefined && poCost !== undefined && noticeCost !== poCost) {
        findings.push({
          code: 'unit_cost_differs_from_po',
          severity: 'supports_dispute',
          message: `${sku}: the deduction uses ${formatCents(noticeCost)} but the PO agreed ${formatCents(poCost)}`,
          fieldPath: `lines[${index}].unit_cost`,
        });
      }
      const noticeQty = valueOf(line.qty_invoiced);
      const orderedQty = valueOf(poLine.qty_ordered);
      if (noticeQty !== undefined && orderedQty !== undefined && noticeQty > orderedQty) {
        findings.push({
          code: 'invoiced_above_po_quantity',
          severity: 'warning',
          message: `${sku}: ${noticeQty} invoiced against a PO for ${orderedQty}`,
          fieldPath: `lines[${index}].qty_invoiced`,
        });
      }
    });
  }

  reconcileShipment(input.shipment, valueOf(input.notice.po_number), findings);
  reconcileAppointment(input.shipment, input.correspondence ?? [], findings);
  reconcileWaivers(input.correspondence ?? [], findings);

  return {
    lines,
    claimedTotalCents: claimedTotal,
    lineSumCents: lineSum,
    findings,
    internallyConsistent: !findings.some((f) => f.severity === 'blocking'),
  };
}

export interface RemittanceLineInput {
  /**
   * The advice, and which of its lines is this case's: the one that opened it.
   *
   * The caller's answer, because what makes a line a case's is the claim id
   * `openCasesFromRemittance` built from it, and that is the pipeline's rule
   * rather than this file's. Undefined when no line on any remittance on the
   * case is the case's — which is said, as a blocking finding, and not guessed
   * at.
   */
  readonly line: { readonly advice: RemittanceAdvice; readonly index: number } | undefined;
  readonly invoice?: Invoice;
  readonly shipment?: ShipmentDocument;
  readonly correspondence?: readonly Correspondence[];
}

/**
 * Reconciles a case that a remittance line opened (ADR 0040).
 *
 * Since ADR 0028 the line *is* the notice for most staffing, freight and
 * foodservice deductions: nobody filed a claim, they paid an invoice short and
 * printed a code beside it. So the case's claim is that one line — its invoice,
 * its short-pay and its reason code — and the rest of the advice is other
 * invoices, some of them other cases.
 *
 * The line is checked against itself first. A remittance prints the same fact
 * twice, as a deduction and as a gross and a net, and when it prints both they
 * have to agree: a line where they do not is a reading that cannot be trusted,
 * or a payer who took more than they wrote down. Then against the invoice it
 * short-paid, and then against the evidence exactly as a notice is: the
 * delivery record, the appointment in force, and anything the customer wrote.
 *
 * What a remittance does not have, this does not pretend to check. It names no
 * item and no PO, so there is no three-way match and no PO on the delivery
 * record to compare.
 */
/** A money field's cents, or undefined when absent or unreadable. Records nothing. */
function quietMoney(field: FieldValue<string | null> | null | undefined): Cents | undefined {
  const text = valueOf(field);
  if (text === undefined) return undefined;
  try {
    return parseMoneyToCents(text);
  } catch {
    return undefined;
  }
}

/**
 * The other lines of an advice that print this line's invoice with the same
 * gross and the same net: the invoice's own figures, repeated once per
 * deduction against it (ADR 0048 §5).
 */
function sharingInvoice(
  lines: RemittanceAdvice['lines'],
  index: number,
  gross: Cents,
  net: Cents,
): number[] {
  const invoice = valueOf(lines[index]?.invoice_number);
  if (invoice === undefined) return [];
  const siblings: number[] = [];
  lines.forEach((other, i) => {
    if (i === index) return;
    const theirs = valueOf(other.invoice_number);
    if (theirs === undefined || !sameReference(theirs, invoice)) return;
    if (quietMoney(other.gross_amount) !== gross || quietMoney(other.net_amount) !== net) return;
    siblings.push(i);
  });
  return siblings;
}

/** The printed deductions of these lines, summed; undefined if any is unreadable. */
function sharedDeductions(
  lines: RemittanceAdvice['lines'],
  indices: readonly number[],
): Cents | undefined {
  const amounts: Cents[] = [];
  for (const i of indices) {
    const amount = quietMoney(lines[i]?.deduction_amount);
    if (amount === undefined) return undefined;
    amounts.push(amount);
  }
  return sumCents(amounts);
}

export function reconcileRemittanceLine(input: RemittanceLineInput): Reconciliation {
  const findings: Finding[] = [];
  const lines: LineReconciliation[] = [];
  let claimed: Cents | undefined;

  const index = input.line?.index;
  const line = index === undefined ? undefined : input.line?.advice.lines[index];
  if (index === undefined || line === undefined) {
    findings.push({
      code: 'remittance_line_not_found',
      severity: 'blocking',
      message:
        'no line on the remittance is the one this case was opened from, so there is no ' +
        'short-pay to reconcile; the evidence below was still checked',
    });
  } else {
    const path = `lines[${index}]`;
    const invoiceNumber = valueOf(line.invoice_number);
    const label = invoiceNumber ?? `line ${index + 1}`;
    const printed = money(line.deduction_amount, `${path}.deduction_amount`, findings);
    const gross = money(line.gross_amount, `${path}.gross_amount`, findings);
    const net = money(line.net_amount, `${path}.net_amount`, findings);

    let implied: Cents | undefined;
    let verdict: LineVerdict = 'not_checkable';
    if (gross !== undefined && net !== undefined) {
      // What the columns say was withheld: owed less paid, in integer cents
      // here and never in the model (invariant 3).
      implied = subCents(gross, net);
      // Two witnesses to one fact only when the page printed both.
      const siblings = sharingInvoice(input.line?.advice.lines ?? [], index, gross, net);
      if (printed !== undefined && siblings.length > 0) {
        // The invoice's gross and net are repeated on every line of it, and each
        // line prints its own deduction: the witnesses are the sum of those
        // deductions and the one subtraction (ADR 0048 §5).
        const shared = sharedDeductions(input.line?.advice.lines ?? [], [index, ...siblings]);
        verdict = shared === implied ? 'matches' : 'differs';
        if (verdict === 'matches') {
          findings.push({
            code: 'remittance_invoice_shared',
            severity: 'info',
            message:
              `${label}: ${siblings.length + 1} lines of this remittance share the invoice's ` +
              `${formatCents(gross)} gross and ${formatCents(net)} paid, and their deductions ` +
              `add up to the ${formatCents(implied)} withheld; this case is the ` +
              `${formatCents(printed)} of it`,
            fieldPath: path,
          });
        } else {
          findings.push({
            code: 'remittance_line_does_not_add_up',
            severity: 'blocking',
            message:
              `${label}: ${formatCents(gross)} gross less ${formatCents(net)} paid is ` +
              `${formatCents(implied)} withheld, but the ${siblings.length + 1} lines sharing ` +
              `this invoice ${
                shared === undefined
                  ? 'do not all print a readable deduction'
                  : `deduct ${formatCents(shared)} between them`
              }. The lines and their own columns cannot all be right`,
            fieldPath: path,
          });
        }
      } else if (printed !== undefined) {
        verdict = printed === implied ? 'matches' : 'differs';
        if (verdict === 'differs') {
          findings.push({
            code: 'remittance_line_does_not_add_up',
            severity: 'blocking',
            message:
              `${label}: ${formatCents(gross)} gross less ${formatCents(net)} paid is ` +
              `${formatCents(implied)} withheld, but the line says ${formatCents(printed)} was ` +
              'deducted. The line and its own columns cannot both be right',
            fieldPath: path,
          });
        }
      }
    }
    // What the case claims is what opened it: the deduction as printed, else
    // the subtraction (ADR 0028 §2).
    claimed = printed ?? implied;

    // On a shared invoice this line's expected share is what it printed once
    // the lines add up; the whole invoice's gap is not this case's.
    const expected = verdict === 'matches' && printed !== undefined ? printed : implied;
    lines.push({
      sku: label,
      reasonCode: valueOf(line.reason_code) ?? '',
      claimedCents: claimed ?? null,
      expectedShortageCents: expected ?? null,
      deltaCents:
        printed !== undefined && expected !== undefined ? subCents(printed, expected) : null,
      verdict,
      grossCents: gross ?? null,
      netCents: net ?? null,
    });

    if (input.invoice !== undefined) {
      const billed = valueOf(input.invoice.invoice_number);
      if (invoiceNumber !== undefined && billed !== undefined && !sameReference(invoiceNumber, billed)) {
        findings.push({
          code: 'invoice_number_mismatch',
          severity: 'warning',
          message: `the remittance line pays invoice ${invoiceNumber} but the invoice on this case is ${billed}: check this evidence belongs to this claim`,
          fieldPath: `${path}.invoice_number`,
        });
      } else {
        // Only once it is the same invoice: two totals of two invoices differing
        // says nothing about either.
        const total = money(input.invoice.invoice_total, 'invoice.invoice_total', findings);
        if (gross !== undefined && total !== undefined && gross !== total) {
          findings.push({
            code: 'gross_differs_from_invoice',
            severity: 'warning',
            message:
              `${label}: the remittance puts the invoice at ${formatCents(gross)} gross, but the ` +
              `invoice totals ${formatCents(total)} — a difference the deduction on this line ` +
              'does not account for',
            fieldPath: `${path}.gross_amount`,
          });
        }
      }
    }
  }

  reconcileShipment(input.shipment, undefined, findings);
  reconcileAppointment(input.shipment, input.correspondence ?? [], findings);
  reconcileWaivers(input.correspondence ?? [], findings);

  const total = claimed ?? null;
  return {
    lines,
    // One line is the whole claim: what it says was withheld is both the total
    // and the sum of its lines.
    claimedTotalCents: total,
    lineSumCents: total,
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

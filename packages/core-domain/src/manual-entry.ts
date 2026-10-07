/**
 * A deduction a person typed in, rendered as a document (ADR 0070 §1).
 *
 * An accountant who already knows a deduction — from a payer's portal, a phone
 * call, a remittance they have not got as a file — opens its case by hand. What
 * they typed is stored the way a ledger extract is (ADR 0029 §1): canonical
 * JSON, kept as the case's `notice`, arriving through
 * `uploads.source = 'manual_entry'`. That one choice is what lets provenance,
 * `declineCase` and coverage work unchanged, and what the post-audit defence
 * can show: the entry as it was typed on the day, append-only.
 *
 * Two halves, both pure. `manualEntryFromForm` reads the form's strings and
 * refuses — never cuts — anything past its bound; money goes through
 * `parseMoneyToCents` and nowhere else (invariant 3). `buildManualEntryDocument`
 * writes the bytes: keys sorted, snake_case, absent optional fields absent
 * rather than null, so the same entry by the same person at the same instant
 * is byte-identical. The clock is a parameter, never read here.
 *
 * No model reads any of this (invariant 4 is not engaged), and the entry is
 * never enclosed in a packet (ADR 0070 §4): it is our record of what a person
 * said, not evidence.
 */

import { createHash } from 'node:crypto';
import { MoneyError, parseMoneyToCents } from './money';
import type { Cents } from './money';
import { isIsoDate } from './payer-code-map';

/** Identifiers, the reason code and a payer's name. */
export const MANUAL_ENTRY_TEXT_MAX = 200;
export const MANUAL_ENTRY_NOTES_MAX = 2000;
export const MANUAL_ENTRY_MAX_INVOICES = 20;
export const MANUAL_ENTRY_FILENAME = 'manual-entry.json';

export type ManualEntryField =
  | 'debtorId'
  | 'deductionReference'
  | 'amount'
  | 'deductionDate'
  | 'reasonCode'
  | 'invoiceNumbers'
  | 'poNumber'
  | 'paymentReference'
  | 'disputeAmount'
  | 'endRetailerDebtorId'
  | 'notes'
  | 'assigneeId';

/** The first field the form got wrong, and why, in words a person can act on. */
export class ManualEntryError extends Error {
  constructor(
    readonly field: ManualEntryField,
    message: string,
  ) {
    super(message);
    this.name = 'ManualEntryError';
  }
}

export interface ManualEntry {
  readonly debtorId: string;
  readonly deductionReference: string;
  readonly amountCents: Cents;
  /** ISO `yyyy-mm-dd`, not after the day it was entered. */
  readonly deductionDate: string;
  /** Verbatim, trimmed. Mapped to a canonical reason at read time (ADR 0067). */
  readonly reasonCode: string;
  /** 1..MANUAL_ENTRY_MAX_INVOICES, trimmed, de-duplicated in the order typed. */
  readonly invoiceNumbers: readonly string[];
  readonly poNumber?: string;
  readonly paymentReference?: string;
  /** Defaults to the whole deduction; 0 < x <= amountCents. */
  readonly disputeAmountCents: Cents;
  readonly endRetailerDebtorId?: string;
  readonly notes?: string;
  readonly assigneeId?: string;
}

/** The form exactly as posted: every value a string, an optional one maybe absent. */
export interface ManualEntryForm {
  debtorId: string;
  deductionReference: string;
  amount: string;
  deductionDate: string;
  reasonCode: string;
  invoiceNumbers: string;
  poNumber?: string;
  paymentReference?: string;
  disputeAmount?: string;
  endRetailerDebtorId?: string;
  notes?: string;
  assigneeId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
// Notes may break lines and tab; nothing else below the space.
// eslint-disable-next-line no-control-regex
const NOTES_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function uuid(field: ManualEntryField, value: string | undefined, required: true): string;
function uuid(field: ManualEntryField, value: string | undefined, required: false): string | undefined;
function uuid(field: ManualEntryField, value: string | undefined, required: boolean): string | undefined {
  const v = (value ?? '').trim();
  if (v === '') {
    if (required) throw new ManualEntryError(field, 'Choose one.');
    return undefined;
  }
  if (!UUID.test(v)) throw new ManualEntryError(field, 'Not a recognised id.');
  return v.toLowerCase();
}

function text(field: ManualEntryField, value: string | undefined, required: true): string;
function text(field: ManualEntryField, value: string | undefined, required: false): string | undefined;
function text(field: ManualEntryField, value: string | undefined, required: boolean): string | undefined {
  const v = (value ?? '').trim();
  if (v === '') {
    if (required) throw new ManualEntryError(field, 'Required.');
    return undefined;
  }
  if (v.length > MANUAL_ENTRY_TEXT_MAX) {
    throw new ManualEntryError(field, `At most ${MANUAL_ENTRY_TEXT_MAX} characters.`);
  }
  if (CONTROL.test(v)) throw new ManualEntryError(field, 'Contains a control character.');
  return v;
}

function money(field: ManualEntryField, value: string): Cents {
  let parsed: Cents;
  try {
    parsed = parseMoneyToCents(value.trim());
  } catch (e) {
    if (e instanceof MoneyError) {
      throw new ManualEntryError(field, 'Not an amount that can be read to the cent.');
    }
    throw e;
  }
  if (parsed <= 0) throw new ManualEntryError(field, 'Must be more than zero.');
  return parsed;
}

function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * The form's strings as a `ManualEntry`, or a `ManualEntryError` naming the
 * first field that is wrong. Nothing is truncated or guessed.
 */
export function manualEntryFromForm(form: ManualEntryForm, today: Date = new Date()): ManualEntry {
  const debtorId = uuid('debtorId', form.debtorId, true);
  const deductionReference = text('deductionReference', form.deductionReference, true);

  if ((form.amount ?? '').trim() === '') throw new ManualEntryError('amount', 'Required.');
  const amountCents = money('amount', form.amount);

  const deductionDate = (form.deductionDate ?? '').trim();
  if (!isIsoDate(deductionDate)) {
    throw new ManualEntryError('deductionDate', 'Not a date (yyyy-mm-dd).');
  }
  if (deductionDate > utcDay(today)) {
    throw new ManualEntryError('deductionDate', 'Cannot be after today.');
  }

  const reasonCode = text('reasonCode', form.reasonCode, true);

  const invoiceNumbers: string[] = [];
  for (const raw of (form.invoiceNumbers ?? '').split(/[,\r\n]/)) {
    const v = raw.trim();
    if (v === '') continue;
    if (v.length > MANUAL_ENTRY_TEXT_MAX) {
      throw new ManualEntryError('invoiceNumbers', `Each at most ${MANUAL_ENTRY_TEXT_MAX} characters.`);
    }
    if (CONTROL.test(v)) {
      throw new ManualEntryError('invoiceNumbers', 'Contains a control character.');
    }
    if (!invoiceNumbers.includes(v)) invoiceNumbers.push(v);
  }
  if (invoiceNumbers.length === 0) {
    throw new ManualEntryError('invoiceNumbers', 'At least one invoice number.');
  }
  if (invoiceNumbers.length > MANUAL_ENTRY_MAX_INVOICES) {
    throw new ManualEntryError('invoiceNumbers', `At most ${MANUAL_ENTRY_MAX_INVOICES} invoices.`);
  }

  const poNumber = text('poNumber', form.poNumber, false);
  const paymentReference = text('paymentReference', form.paymentReference, false);

  const disputeRaw = (form.disputeAmount ?? '').trim();
  const disputeAmountCents = disputeRaw === '' ? amountCents : money('disputeAmount', disputeRaw);
  if (disputeAmountCents > amountCents) {
    throw new ManualEntryError('disputeAmount', 'Cannot be more than the deduction.');
  }

  const endRetailerDebtorId = uuid('endRetailerDebtorId', form.endRetailerDebtorId, false);

  const notesRaw = (form.notes ?? '').trim();
  let notes: string | undefined;
  if (notesRaw !== '') {
    if (notesRaw.length > MANUAL_ENTRY_NOTES_MAX) {
      throw new ManualEntryError('notes', `At most ${MANUAL_ENTRY_NOTES_MAX} characters.`);
    }
    if (NOTES_CONTROL.test(notesRaw)) {
      throw new ManualEntryError('notes', 'Contains a control character.');
    }
    notes = notesRaw;
  }

  const assigneeId = uuid('assigneeId', form.assigneeId, false);

  return {
    debtorId,
    deductionReference,
    amountCents,
    deductionDate,
    reasonCode,
    invoiceNumbers,
    disputeAmountCents,
    ...(poNumber !== undefined ? { poNumber } : {}),
    ...(paymentReference !== undefined ? { paymentReference } : {}),
    ...(endRetailerDebtorId !== undefined ? { endRetailerDebtorId } : {}),
    ...(notes !== undefined ? { notes } : {}),
    ...(assigneeId !== undefined ? { assigneeId } : {}),
  };
}

/** What the store keeps: bytes, and what they are. */
export interface ManualEntryDocument {
  readonly bytes: Uint8Array;
  /** Hex, as `LedgerExtract.sha256`. */
  readonly sha256: string;
  readonly filename: string;
  readonly mimeType: 'application/json';
}

/**
 * The entry as canonical JSON: keys sorted, snake_case, two-space indent
 * because a reviewer opens it, and only the optional keys that were given.
 */
export function buildManualEntryDocument(
  entry: ManualEntry,
  enteredBy: string,
  enteredAt: Date,
): ManualEntryDocument {
  const body: Record<string, unknown> = {
    amount_cents: entry.amountCents as number,
    debtor_id: entry.debtorId,
    deduction_date: entry.deductionDate,
    deduction_reference: entry.deductionReference,
    dispute_amount_cents: entry.disputeAmountCents as number,
    entered_at: enteredAt.toISOString(),
    entered_by: enteredBy,
    invoice_numbers: [...entry.invoiceNumbers],
    kind: 'manual_entry',
    reason_code: entry.reasonCode,
    version: 1,
  };
  if (entry.poNumber !== undefined) body.po_number = entry.poNumber;
  if (entry.paymentReference !== undefined) body.payment_reference = entry.paymentReference;
  if (entry.endRetailerDebtorId !== undefined) body.end_retailer_debtor_id = entry.endRetailerDebtorId;
  if (entry.notes !== undefined) body.notes = entry.notes;
  if (entry.assigneeId !== undefined) body.assignee_id = entry.assigneeId;

  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(body).sort()) sorted[key] = body[key];

  const bytes = new TextEncoder().encode(JSON.stringify(sorted, null, 2));
  return {
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    filename: MANUAL_ENTRY_FILENAME,
    mimeType: 'application/json',
  };
}

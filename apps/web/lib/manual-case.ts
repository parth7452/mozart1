import { NextResponse } from 'next/server';
import type { ManualEntryField } from '@recouple/core-domain';
import { isUuid } from './request';
import type { NoticeKey } from './notices';

/**
 * Opening a case by hand (ADR 0070): the dialog over the deductions list, and
 * what its two POSTs answer with.
 *
 * A refusal sends the person back to the list with the dialog open
 * (`#new-case`) and what they typed echoed in the query string, so a typo does
 * not cost the whole form. Everything echoed is re-validated on the way in
 * (`prefillFrom`) and rendered as a value, never as markup. Notes are never
 * echoed: they are prose about a payer and do not belong in a URL, a log or a
 * browser's history.
 */

/** A link to the dialog; the page redirects to `/#new-case`. */
export const NEW_CASE_PATH = '/cases/new';
/** The dialog's id, which is also the fragment that opens it. */
export const NEW_CASE_ANCHOR = 'new-case';

/** The fields that may be echoed back in the URL after a refusal. Never `notes`. */
export const NEW_CASE_FIELDS = [
  'debtorId',
  'deductionReference',
  'amount',
  'deductionDate',
  'reasonCode',
  'invoiceNumbers',
  'poNumber',
  'paymentReference',
  'disputeAmount',
  'endRetailerDebtorId',
  'assigneeId',
] as const;

export type NewCaseField = (typeof NEW_CASE_FIELDS)[number];
export type NewCasePrefill = Partial<Record<NewCaseField, string>>;

/** The longest echoed value: past it the field is left for the person to type again. */
const ECHO_MAX = 600;
const ID_FIELDS: ReadonlySet<NewCaseField> = new Set(['debtorId', 'endRetailerDebtorId', 'assigneeId']);
// Line breaks are allowed: invoice numbers may be one per line.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/;

/** The notice keys the dialog shows (`nc=`). */
export type NewCaseNoticeKey = Extract<NoticeKey, `nc_${string}`>;

/** What a person reads for a field the form refused. */
export const NEW_CASE_FIELD_LABELS: Readonly<Record<ManualEntryField, string>> = {
  debtorId: 'payer',
  deductionReference: 'deduction reference',
  amount: 'deduction amount',
  deductionDate: 'deduction date',
  reasonCode: 'payer reason code',
  invoiceNumbers: 'invoice numbers',
  poNumber: 'PO number',
  paymentReference: 'check or remittance number',
  disputeAmount: 'amount to dispute',
  endRetailerDebtorId: 'end retailer',
  notes: 'notes',
  assigneeId: 'owner',
};

export function isManualEntryField(value: unknown): value is ManualEntryField {
  return typeof value === 'string' && Object.hasOwn(NEW_CASE_FIELD_LABELS, value);
}

function keep(field: NewCaseField, value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '' || value.length > ECHO_MAX) return undefined;
  if (CONTROL.test(value)) return undefined;
  if (ID_FIELDS.has(field) && !isUuid(value)) return undefined;
  return value;
}

/** The echoed fields, each only if it is a single plausible value. */
export function prefillFrom(
  searchParams: Readonly<Record<string, string | readonly string[] | undefined>>,
): NewCasePrefill {
  const prefill: NewCasePrefill = {};
  for (const field of NEW_CASE_FIELDS) {
    const kept = keep(field, searchParams[field]);
    if (kept !== undefined) prefill[field] = kept;
  }
  return prefill;
}

/** Back to the list with the dialog open, a notice key, and what was typed. */
export function newCaseRedirect(
  request: Request,
  notice: NewCaseNoticeKey,
  values?: NewCasePrefill,
  field?: ManualEntryField,
): NextResponse {
  const url = new URL('/', request.url);
  url.searchParams.set('nc', notice);
  if (field !== undefined) url.searchParams.set('field', field);
  for (const name of NEW_CASE_FIELDS) {
    const kept = keep(name, values?.[name]);
    if (kept !== undefined) url.searchParams.set(name, kept);
  }
  url.hash = NEW_CASE_ANCHOR;
  return NextResponse.redirect(url, { status: 303 });
}

/** A form value as a string; a missing one is ''; a file is not a string. */
export function formString(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  if (value === null) return '';
  return typeof value === 'string' ? value : undefined;
}

export const className = (error: unknown): string =>
  error instanceof Error ? error.name || error.constructor.name : typeof error;

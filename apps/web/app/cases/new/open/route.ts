import { NextResponse, type NextRequest } from 'next/server';
import { ManualEntryError, manualEntryFromForm, type ManualEntryForm } from '@recouple/core-domain';
import { ManualCaseRefusedError } from '@recouple/store-postgres';
import { AmbiguousIdentityError, DuplicateCaseError } from '@recouple/pipeline';
import { requireSession, storeFor } from '../../../../lib/session';
import { mayWrite } from '../../../../lib/pipeline';
import { isCrossSite, refuseCrossSite } from '../../../../lib/request';
import {
  className,
  formString,
  isManualEntryField,
  NEW_CASE_FIELDS,
  newCaseRedirect,
  type NewCaseNoticeKey,
  type NewCasePrefill,
} from '../../../../lib/manual-case';
import type { NoticeKey } from '../../../../lib/notices';

const REFUSAL_NOTICE: Readonly<Record<ManualCaseRefusedError['refusal'], NewCaseNoticeKey>> = {
  invalid: 'nc_invalid',
  unknown_debtor: 'nc_unknown_debtor',
  unknown_end_retailer: 'nc_unknown_debtor',
  unknown_assignee: 'nc_unknown_assignee',
};

/**
 * Opens a case a person entered by hand (ADR 0070).
 *
 * The person entering is the session's member, never a form field. The form
 * is parsed by the one rule (`manualEntryFromForm`), and the store writes the
 * entry as the case's notice with its duplicate check in one transaction.
 *
 * A refusal goes back to the dialog with what was typed — never the notes —
 * and the field to fix. Logs carry ids and a class name only, never typed text.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (isCrossSite(request)) return refuseCrossSite();

  const session = await requireSession();
  if (!mayWrite(session.org.role)) return newCaseRedirect(request, 'nc_role');

  const form = await request.formData();
  const values: Record<string, string> = {};
  for (const name of [...NEW_CASE_FIELDS, 'notes'] as const) {
    const value = formString(form, name);
    if (value === undefined) return newCaseRedirect(request, 'nc_failed');
    values[name] = value;
  }
  const echoed: NewCasePrefill = {};
  for (const name of NEW_CASE_FIELDS) echoed[name] = values[name] ?? '';

  const posted: ManualEntryForm = {
    debtorId: values.debtorId ?? '',
    deductionReference: values.deductionReference ?? '',
    amount: values.amount ?? '',
    deductionDate: values.deductionDate ?? '',
    reasonCode: values.reasonCode ?? '',
    invoiceNumbers: values.invoiceNumbers ?? '',
    poNumber: values.poNumber ?? '',
    paymentReference: values.paymentReference ?? '',
    disputeAmount: values.disputeAmount ?? '',
    endRetailerDebtorId: values.endRetailerDebtorId ?? '',
    notes: values.notes ?? '',
    assigneeId: values.assigneeId ?? '',
  };

  let entry;
  try {
    entry = manualEntryFromForm(posted);
  } catch (error) {
    if (error instanceof ManualEntryError) {
      return newCaseRedirect(request, 'nc_invalid', echoed, error.field);
    }
    throw error;
  }

  const toCase = (deductionId: string, notice: NoticeKey, hash?: string): NextResponse => {
    const url = new URL(`/cases/${deductionId}`, request.url);
    url.searchParams.set('action', notice);
    if (hash !== undefined) url.hash = hash;
    return NextResponse.redirect(url, { status: 303 });
  };

  const identity = { orgId: session.org.orgId, userId: session.userId };
  const store = storeFor(session);
  try {
    if (!(await store.memberMayWrite(identity))) return newCaseRedirect(request, 'nc_role', echoed);
    const opened = await store.openManualCase({ entry });
    console.info(
      `[recouple] manual case opened: ${opened.deductionId} document ${opened.documentId} ` +
        `org ${identity.orgId} by ${identity.userId}`,
    );
    return toCase(opened.deductionId, 'case_opened_manually', 'add-evidence');
  } catch (error) {
    if (error instanceof ManualCaseRefusedError) {
      const field = isManualEntryField(error.field) ? error.field : undefined;
      return newCaseRedirect(request, REFUSAL_NOTICE[error.refusal], echoed, field);
    }
    if (error instanceof DuplicateCaseError) return toCase(error.existingDeductionId, 'case_duplicate_manual');
    if (error instanceof AmbiguousIdentityError) return newCaseRedirect(request, 'nc_ambiguous', echoed);
    console.error(`[recouple] manual case failed: org ${identity.orgId} (${className(error)})`);
    return newCaseRedirect(request, 'nc_failed', echoed);
  } finally {
    await store.close();
  }
}

import type { NextRequest, NextResponse } from 'next/server';
import { DEBTOR_NAME_MAX, ManualCaseRefusedError } from '@recouple/store-postgres';
import { requireSession, storeFor } from '../../../../lib/session';
import { mayWrite } from '../../../../lib/pipeline';
import { isCrossSite, refuseCrossSite } from '../../../../lib/request';
import {
  className,
  formString,
  NEW_CASE_FIELDS,
  newCaseRedirect,
  type NewCasePrefill,
} from '../../../../lib/manual-case';

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Adds a payer from the open-a-case dialog (ADR 0070, ADR 0019: a debtor is
 * master data a person made). The same name folded the same way is the payer
 * already there, and is selected rather than added twice. What the person had
 * typed in the case form travels as hidden fields and comes back echoed.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (isCrossSite(request)) return refuseCrossSite();

  const session = await requireSession();
  if (!mayWrite(session.org.role)) return newCaseRedirect(request, 'nc_role');

  const form = await request.formData();
  const echoed: NewCasePrefill = {};
  for (const name of NEW_CASE_FIELDS) {
    if (name === 'debtorId') continue;
    const value = formString(form, name);
    if (value !== undefined && value !== '') echoed[name] = value;
  }
  const raw = formString(form, 'displayName');
  const displayName = raw?.trim() ?? '';
  if (displayName === '' || displayName.length > DEBTOR_NAME_MAX || CONTROL.test(displayName)) {
    return newCaseRedirect(request, 'nc_payer_invalid', echoed);
  }

  const identity = { orgId: session.org.orgId, userId: session.userId };
  const store = storeFor(session);
  try {
    if (!(await store.memberMayWrite(identity))) return newCaseRedirect(request, 'nc_role', echoed);
    const debtor = await store.createDebtor({ displayName });
    console.info(
      `[recouple] payer ${debtor.created ? 'added' : 'already listed'}: ${debtor.debtorId} ` +
        `org ${identity.orgId} by ${identity.userId}`,
    );
    return newCaseRedirect(request, debtor.created ? 'nc_payer_added' : 'nc_payer_exists', {
      ...echoed,
      debtorId: debtor.debtorId,
    });
  } catch (error) {
    if (error instanceof ManualCaseRefusedError) return newCaseRedirect(request, 'nc_payer_invalid', echoed);
    console.error(`[recouple] add payer failed: org ${identity.orgId} (${className(error)})`);
    return newCaseRedirect(request, 'nc_failed', echoed);
  } finally {
    await store.close();
  }
}

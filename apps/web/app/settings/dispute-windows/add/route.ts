import type { NextRequest, NextResponse } from 'next/server';
import {
  DISPUTE_WINDOW_MAX_DAYS,
  isIsoDate,
  isPayerCodeConfidence,
  isPayerCodeSource,
  PAYER_CODE_SOURCE_NOTE_MAX_LENGTH,
} from '@recouple/core-domain';
import { requireSession, storeFor } from '../../../../lib/session';
import { isCrossSite, isUuid, refuseCrossSite } from '../../../../lib/request';
import { className } from '../../../../lib/reason-code-maps';
import {
  disputeWindowRefusalNotice,
  disputeWindowStoreFor,
  disputeWindowsRedirect,
  mayRecordWindows,
} from '../../../../lib/dispute-windows';

const DAYS = /^[1-9][0-9]{0,2}$/;

/**
 * Adds one payer dispute window (ADR 0071): for one of this workspace's
 * payers, N calendar days from the deduction date, from a date on.
 *
 * The author is the session's member and never a form field: the database
 * refuses a row naming anyone but its caller, and the insert to anyone but an
 * owner or approver. Nothing is updated: a window is corrected by adding
 * another. A case already open is never rewritten by it.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (isCrossSite(request)) return refuseCrossSite();

  const session = await requireSession();
  if (!mayRecordWindows(session.org.role)) return disputeWindowsRedirect(request, 'windows_role');

  const form = await request.formData();
  const debtorId = form.get('debtorId');
  const days = form.get('windowDays');
  const effectiveFrom = form.get('effectiveFrom');
  const effectiveTo = form.get('effectiveTo') ?? '';
  const source = form.get('source');
  const sourceNote = form.get('sourceNote') ?? '';
  const confidence = form.get('confidence');
  const windowDays = typeof days === 'string' && DAYS.test(days.trim()) ? Number(days.trim()) : undefined;
  if (
    !isUuid(debtorId) ||
    windowDays === undefined ||
    windowDays > DISPUTE_WINDOW_MAX_DAYS ||
    !isIsoDate(effectiveFrom) ||
    typeof effectiveTo !== 'string' ||
    (effectiveTo !== '' && !isIsoDate(effectiveTo)) ||
    !isPayerCodeSource(source) ||
    typeof sourceNote !== 'string' ||
    sourceNote.length > PAYER_CODE_SOURCE_NOTE_MAX_LENGTH ||
    !isPayerCodeConfidence(confidence)
  ) {
    return disputeWindowsRedirect(request, 'windows_invalid');
  }
  if (effectiveTo !== '' && effectiveTo < effectiveFrom) return disputeWindowsRedirect(request, 'windows_dates');

  const identity = { orgId: session.org.orgId, userId: session.userId };
  try {
    if (!(await storeFor(session).memberMayWrite(identity))) return disputeWindowsRedirect(request, 'windows_role');
    const row = await disputeWindowStoreFor(identity).recordDisputeWindow({
      debtorId,
      windowDays,
      effectiveFrom,
      ...(effectiveTo === '' ? {} : { effectiveTo }),
      source,
      ...(sourceNote.trim() === '' ? {} : { sourceNote }),
      confidence,
    });
    console.info(
      `[recouple] dispute window added: ${row.id} debtor ${row.debtorId} org ${identity.orgId} ` +
        `by ${identity.userId} (${row.windowDays} days, ${row.source}, ${row.confidence})`,
    );
    return disputeWindowsRedirect(request, 'windows_recorded');
  } catch (error) {
    const refused = disputeWindowRefusalNotice(error);
    if (refused !== undefined) return disputeWindowsRedirect(request, refused);
    console.error(`[recouple] dispute window failed: org ${identity.orgId} (${className(error)})`);
    return disputeWindowsRedirect(request, 'windows_failed');
  }
}

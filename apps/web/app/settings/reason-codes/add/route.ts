import type { NextRequest, NextResponse } from 'next/server';
import {
  isCanonicalReasonCode,
  isIsoDate,
  isPayerCodeConfidence,
  isPayerCodeSource,
  PAYER_CODE_SOURCE_NOTE_MAX_LENGTH,
} from '@recouple/core-domain';
import { requireSession, storeFor } from '../../../../lib/session';
import { isCrossSite, isUuid, refuseCrossSite } from '../../../../lib/request';
import {
  className,
  mayMapPayerCodes,
  payerCodeMapRefusalNotice,
  payerCodeMapStoreFor,
  reasonCodesRedirect,
} from '../../../../lib/reason-code-maps';

/** Longer than any code the table takes; a field past it is refused unread. */
const CODE_FIELD_MAX = 200;

/**
 * Adds one payer code mapping (ADR 0066): for one of this workspace's payers,
 * a printed code means one canonical reason from a date on.
 *
 * The author is the session's member and never a form field: the database
 * refuses a row naming anyone but its caller, and refuses the insert to anyone
 * but an owner or approver, whatever this handler checked. The code is
 * normalised by the store, by the one rule (`normalisePayerCode`). Nothing is
 * updated: a mapping is corrected by adding another with a later start.
 *
 * The answer is a redirect with a notice key. The log line carries ids and a
 * class name, never the code, which may be text off a document.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (isCrossSite(request)) return refuseCrossSite();

  const session = await requireSession();
  if (!mayMapPayerCodes(session.org.role)) return reasonCodesRedirect(request, 'codes_role');

  const form = await request.formData();
  const debtorId = form.get('debtorId');
  const payerCode = form.get('payerCode');
  const canonicalCode = form.get('canonicalCode');
  const effectiveFrom = form.get('effectiveFrom');
  const effectiveTo = form.get('effectiveTo') ?? '';
  const source = form.get('source');
  const sourceNote = form.get('sourceNote') ?? '';
  const confidence = form.get('confidence');
  if (
    !isUuid(debtorId) ||
    typeof payerCode !== 'string' ||
    payerCode.trim() === '' ||
    payerCode.length > CODE_FIELD_MAX ||
    typeof canonicalCode !== 'string' ||
    !isCanonicalReasonCode(canonicalCode) ||
    !isIsoDate(effectiveFrom) ||
    typeof effectiveTo !== 'string' ||
    (effectiveTo !== '' && !isIsoDate(effectiveTo)) ||
    !isPayerCodeSource(source) ||
    typeof sourceNote !== 'string' ||
    sourceNote.length > PAYER_CODE_SOURCE_NOTE_MAX_LENGTH ||
    !isPayerCodeConfidence(confidence)
  ) {
    return reasonCodesRedirect(request, 'codes_invalid');
  }
  if (effectiveTo !== '' && effectiveTo < effectiveFrom) return reasonCodesRedirect(request, 'codes_dates');

  const identity = { orgId: session.org.orgId, userId: session.userId };
  try {
    if (!(await storeFor(session).memberMayWrite(identity))) return reasonCodesRedirect(request, 'codes_role');
    const row = await payerCodeMapStoreFor(identity).recordPayerCodeMap({
      debtorId,
      payerCode,
      canonicalCode,
      effectiveFrom,
      ...(effectiveTo === '' ? {} : { effectiveTo }),
      source,
      ...(sourceNote.trim() === '' ? {} : { sourceNote }),
      confidence,
    });
    console.info(
      `[recouple] payer code map added: ${row.id} debtor ${row.debtorId} org ${identity.orgId} ` +
        `by ${identity.userId} (${row.source}, ${row.confidence})`,
    );
    return reasonCodesRedirect(request, 'codes_mapped');
  } catch (error) {
    const refused = payerCodeMapRefusalNotice(error);
    if (refused !== undefined) return reasonCodesRedirect(request, refused);
    console.error(`[recouple] payer code map failed: org ${identity.orgId} (${className(error)})`);
    return reasonCodesRedirect(request, 'codes_failed');
  }
}

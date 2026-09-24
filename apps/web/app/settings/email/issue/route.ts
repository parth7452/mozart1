import type { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '../../../../lib/session';
import { isCrossSite, refuseCrossSite } from '../../../../lib/request';
import { inboundStoreFor } from '../../../../lib/inbound';
import {
  className,
  inboundSettingsRedirect,
  mayManageInboundAddresses,
  refusalNotice,
} from '../../../../lib/inbound-settings';

/**
 * Issues a new address (ADR 0047 §4). The database generates the token and
 * refuses one supplied, so no person ever chooses an address; this route
 * supplies nothing but the owner it acts as.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (isCrossSite(request)) return refuseCrossSite();

  const session = await requireSession();
  const say = (notice: Parameters<typeof inboundSettingsRedirect>[1]) =>
    inboundSettingsRedirect(request, notice);
  if (!mayManageInboundAddresses(session.org.role)) return say('email_role');

  const identity = { orgId: session.org.orgId, userId: session.userId };
  try {
    const issued = await inboundStoreFor(identity).issueAddress();
    console.info(
      `[recouple] inbound address issued: address ${issued.addressId} org ${identity.orgId} ` +
        `by ${identity.userId}`,
    );
    return say('email_issued');
  } catch (error) {
    const refused = refusalNotice(error, 'email_failed');
    if (refused !== undefined) return say(refused);
    console.error(
      `[recouple] inbound address issue failed: org ${identity.orgId} (${className(error)})`,
    );
    return say('email_failed');
  }
}

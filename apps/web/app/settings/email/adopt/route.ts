import type { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '../../../../lib/session';
import { isCrossSite, isUuid, refuseCrossSite } from '../../../../lib/request';
import { inboundStoreFor } from '../../../../lib/inbound';
import {
  className,
  inboundSettingsRedirect,
  mayManageInboundAddresses,
  refusalNotice,
} from '../../../../lib/inbound-settings';

/**
 * Makes the pressing owner the member an address acts as (ADR 0047 §4, §6):
 * how an address outlives the owner who issued it without its senders
 * learning a new one. A retired address cannot be adopted — the database
 * refuses it, and this route says so before asking.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (isCrossSite(request)) return refuseCrossSite();

  const session = await requireSession();
  const say = (notice: Parameters<typeof inboundSettingsRedirect>[1]) =>
    inboundSettingsRedirect(request, notice);
  if (!mayManageInboundAddresses(session.org.role)) return say('email_role');

  const form = await request.formData();
  const addressId = form.get('addressId');
  if (!isUuid(addressId)) return say('email_unknown_address');

  const identity = { orgId: session.org.orgId, userId: session.userId };
  const inbound = inboundStoreFor(identity);
  try {
    const address = (await inbound.addresses()).find((row) => row.addressId === addressId);
    if (address === undefined || address.retiredAt !== undefined) return say('email_unknown_address');
    if (address.actingMember === identity.userId) return say('email_already_yours');

    await inbound.adoptAddress(addressId);
    console.info(
      `[recouple] inbound address adopted: address ${addressId} org ${identity.orgId} ` +
        `by ${identity.userId}`,
    );
    return say('email_adopted');
  } catch (error) {
    const refused = refusalNotice(error, 'email_failed');
    if (refused !== undefined) return say(refused);
    console.error(
      `[recouple] inbound address adopt failed: address ${addressId} org ${identity.orgId} ` +
        `(${className(error)})`,
    );
    return say('email_failed');
  }
}

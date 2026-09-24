import type { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '../../../../lib/session';
import { isCrossSite, isUuid, refuseCrossSite } from '../../../../lib/request';
import { inboundStoreFor } from '../../../../lib/inbound';
import {
  className,
  inboundSettingsRedirect,
  mayManageInboundAddresses,
  refusalNotice,
  retireAsksFirst,
} from '../../../../lib/inbound-settings';

/**
 * Retires an address, for good (ADR 0047 §4). The token is never issued again,
 * to this tenant or another, so mail still in flight to it cannot land in
 * someone else's workspace; it is refused from now on. An address that
 * received mail in the last `RETIRE_CONFIRM_DAYS` asks first — the page shows
 * a confirmation, and only a second press carrying `confirmed=yes` retires it.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (isCrossSite(request)) return refuseCrossSite();

  const session = await requireSession();
  const say = (notice: Parameters<typeof inboundSettingsRedirect>[1], confirm?: string) =>
    inboundSettingsRedirect(request, notice, confirm);
  if (!mayManageInboundAddresses(session.org.role)) return say('email_role');

  const form = await request.formData();
  const addressId = form.get('addressId');
  if (!isUuid(addressId)) return say('email_unknown_address');
  const confirmed = form.get('confirmed') === 'yes';

  const identity = { orgId: session.org.orgId, userId: session.userId };
  const inbound = inboundStoreFor(identity);
  try {
    const address = (await inbound.addresses()).find((row) => row.addressId === addressId);
    if (address === undefined) return say('email_unknown_address');
    if (address.retiredAt !== undefined) return say('email_already_retired');
    if (!confirmed && retireAsksFirst(address, new Date())) {
      return say('email_retire_confirm', addressId);
    }

    await inbound.retireAddress(addressId);
    console.info(
      `[recouple] inbound address retired: address ${addressId} org ${identity.orgId} ` +
        `by ${identity.userId}`,
    );
    return say('email_retired');
  } catch (error) {
    const refused = refusalNotice(error, 'email_already_retired');
    if (refused !== undefined) return say(refused);
    console.error(
      `[recouple] inbound address retire failed: address ${addressId} org ${identity.orgId} ` +
        `(${className(error)})`,
    );
    return say('email_failed');
  }
}

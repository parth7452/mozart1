import type { NextRequest, NextResponse } from 'next/server';
import {
  PortalAccountAlreadyConnectedError,
  PortalAccountConnectedElsewhereError,
  PortalCredentialReplacementRequiredError,
  PortalOwnerRequiredError,
} from '@recouple/store-postgres';
import { requireSession } from '../../../../lib/session';
import { isCrossSite, isUuid, refuseCrossSite } from '../../../../lib/request';
import {
  errorForLog,
  formText,
  mayManagePortals,
  portalForm,
  portalRedirect,
  portalStoreFor,
  PORTAL_SETTINGS_PATH,
  type PortalNoticeKey,
} from '../../../../lib/portals';

/**
 * Turns a portal connection off or on (ADR 0057 §13, ADR 0062's rollback),
 * with one audit row naming why.
 *
 * Off is `turned_off`, an owner's reason, and nothing signs in to the portal
 * until an owner turns it on again. On is refused by the store while the
 * connection is off because the portal refused its credential or its
 * credential was removed, until a newer credential has been entered: the
 * refused password is never typed into the portal again (ADR 0057 §8). One
 * enabled connection per portal account holds for turning one on, as for
 * adding one.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (isCrossSite(request)) return refuseCrossSite();

  const session = await requireSession();
  const say = (notice: PortalNoticeKey) => portalRedirect(request, PORTAL_SETTINGS_PATH, notice);
  if (!mayManagePortals(session.org.role)) return say('portal_role');

  const identity = { orgId: session.org.orgId, userId: session.userId };
  const form = await portalForm(request, 'switch', identity.orgId);
  if (form === undefined) return say('portal_failed');

  const connectionField = formText(form, 'connectionId');
  const turn = formText(form, 'turn');
  if (!isUuid(connectionField) || (turn !== 'on' && turn !== 'off')) {
    return say('portal_unknown_connection');
  }
  const connectionId = connectionField.toLowerCase();

  const store = portalStoreFor(identity);
  try {
    if (!(await store.memberMayWrite(identity))) return say('portal_role');

    if (turn === 'off') {
      const outcome = await store.disableConnection({ connectionId, reason: 'turned_off' });
      if (outcome === undefined) return say('portal_unknown_connection');
      if (outcome === 'already_off') return say('portal_already_off');
      if (outcome !== 'disabled') {
        // `newer_credential` answers only a refused credential's disable.
        throw new Error(`disableConnection answered ${outcome} to an owner turning it off`);
      }
      log('turned off', connectionId, identity);
      return say('portal_turned_off');
    }

    const outcome = await store.enableConnection(connectionId);
    if (outcome === undefined) return say('portal_unknown_connection');
    if (outcome === 'already_on') return say('portal_already_on');
    log('turned on', connectionId, identity);
    return say('portal_turned_on');
  } catch (error) {
    if (error instanceof PortalOwnerRequiredError) return say('portal_role');
    if (error instanceof PortalCredentialReplacementRequiredError) {
      return say(
        error.disabledFor === 'credential_rejected'
          ? 'portal_needs_credential_rejected'
          : 'portal_needs_credential_removed',
      );
    }
    if (error instanceof PortalAccountAlreadyConnectedError) return say('portal_account_here');
    if (error instanceof PortalAccountConnectedElsewhereError) return say('portal_account_elsewhere');
    console.error(
      `[recouple] portal connection turn ${turn} failed: connection ${connectionId} ` +
        `org ${identity.orgId} (${errorForLog(error)})`,
    );
    return say('portal_failed');
  }
}

function log(
  what: string,
  connectionId: string,
  identity: { readonly orgId: string; readonly userId: string },
): void {
  console.info(
    `[recouple] portal connection ${what}: connection ${connectionId} org ${identity.orgId} ` +
      `by ${identity.userId}`,
  );
}

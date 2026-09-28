import type { NextRequest, NextResponse } from 'next/server';
import { PORTAL_KEY_PATTERN } from '@recouple/portal';
import {
  PortalAccountAlreadyConnectedError,
  PortalAccountConnectedElsewhereError,
  PortalInputError,
  PortalOwnerRequiredError,
} from '@recouple/store-postgres';
import { requireSession } from '../../../../lib/session';
import { isCrossSite, refuseCrossSite } from '../../../../lib/request';
import {
  errorForLog,
  formText,
  mayManagePortals,
  parseRunParams,
  portalForm,
  portalRedirect,
  portalStoreFor,
  PORTAL_SETTINGS_PATH,
  type PortalNoticeKey,
} from '../../../../lib/portals';

/**
 * Adds a portal connection (ADR 0057 §13): a portal key, a label, the portal
 * account's public id (for SAP Business Network, the ANID — never the
 * username) and the run parameters, if any. Everything but the label and
 * `enabled` is frozen once written, and the owner who adds it is the member
 * every run of it acts as.
 *
 * Nothing is checked with the portal here, and nothing can be: the account id
 * is what an owner typed, so every run's first step after sign-in compares it
 * with what the portal shows (`account_mismatch`). One enabled connection per
 * portal account across the deployment is the database's rule.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (isCrossSite(request)) return refuseCrossSite();

  const session = await requireSession();
  const say = (notice: PortalNoticeKey) => portalRedirect(request, PORTAL_SETTINGS_PATH, notice);
  if (!mayManagePortals(session.org.role)) return say('portal_role');

  const identity = { orgId: session.org.orgId, userId: session.userId };
  const form = await portalForm(request, 'connect', identity.orgId);
  if (form === undefined) return say('portal_failed');

  // A key is a code: whitespace around one is never part of it.
  const portalKey = formText(form, 'portalKey')?.trim();
  const label = formText(form, 'label');
  const accountId = formText(form, 'accountId');
  if (portalKey === undefined || !PORTAL_KEY_PATTERN.test(portalKey)) {
    return say('portal_connection_key_invalid');
  }
  if (label === undefined || label === '') return say('portal_connection_label_invalid');
  if (accountId === undefined || accountId === '') return say('portal_connection_account_invalid');
  const params = parseRunParams(formText(form, 'params'));
  if (params === undefined) return say('portal_connection_params_invalid');

  const store = portalStoreFor(identity);
  try {
    if (!(await store.memberMayWrite(identity))) return say('portal_role');
    const connectionId = await store.createConnection({ portalKey, label, accountId, params });
    console.info(
      `[recouple] portal connection added: connection ${connectionId} portal ${portalKey} ` +
        `org ${identity.orgId} by ${identity.userId}`,
    );
    return say('portal_connection_added');
  } catch (error) {
    const refused = connectionRefusal(error);
    if (refused !== undefined) return say(refused);
    console.error(
      `[recouple] portal connection add failed: portal ${portalKey} org ${identity.orgId} ` +
        `(${errorForLog(error)})`,
    );
    return say('portal_failed');
  }
}

/** A named refusal's notice, or nothing for a fault. The input's refusal names a field, never its value. */
function connectionRefusal(error: unknown): PortalNoticeKey | undefined {
  if (error instanceof PortalOwnerRequiredError) return 'portal_role';
  if (error instanceof PortalAccountAlreadyConnectedError) return 'portal_account_here';
  if (error instanceof PortalAccountConnectedElsewhereError) return 'portal_account_elsewhere';
  if (error instanceof PortalInputError) {
    const field = error.issues[0]?.field ?? '';
    if (field.startsWith('portalKey')) return 'portal_connection_key_invalid';
    if (field.startsWith('label')) return 'portal_connection_label_invalid';
    if (field.startsWith('accountId')) return 'portal_connection_account_invalid';
    if (field.startsWith('params')) return 'portal_connection_params_invalid';
  }
  return undefined;
}

import type { NextRequest, NextResponse } from 'next/server';
import { TokenCipherError } from '@recouple/crypto';
import {
  PortalConnectionNotFoundError,
  PortalCredentialLabelError,
  PortalInputError,
  PortalOwnerRequiredError,
  PortalRecipeVersionNotFoundError,
  PortalRecipeVersionPortalMismatchError,
  PortalSealingNotConfiguredError,
} from '@recouple/store-postgres';
import { requireSession } from '../../../../lib/session';
import { isCrossSite, isUuid, refuseCrossSite } from '../../../../lib/request';
import {
  errorForLog,
  foldSetupKey,
  formText,
  isNamed,
  labelHoldsSecret,
  mayManagePortals,
  portalCipherFromEnv,
  portalForm,
  portalRedirect,
  portalStoreFor,
  PORTAL_SETTINGS_PATH,
  type PortalNoticeKey,
} from '../../../../lib/portals';

/**
 * Seals and stores a connection's credential (ADR 0057 §7, §8): the dedicated
 * portal user's username and password, and the authenticator's setup key when
 * the portal asks for TOTP.
 *
 * **Sealed before anything is written, and never opened here.** The cipher is
 * the portal KMS key's `seal_only` one, so this app can seal a password and
 * never read one back; a deployment without `PORTAL_KMS_KEY_ID` is refused
 * before the form is read, and stores nothing. The store reads the named
 * recipe version as the database holds it and seals to that version's
 * binding — where the credential may be typed — never to anything in this
 * request.
 *
 * **The plaintext goes one place: `sealAndStoreCredential`'s payload.** It is
 * never logged, never put in a redirect (a notice is a key), never repeated in
 * a refusal (the store's name fields and rules, never values) and never
 * rethrown: every failure is answered here, logged by class name. Replacing a
 * credential is a new row; it does not turn a connection on.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (isCrossSite(request)) return refuseCrossSite();

  const session = await requireSession();
  const say = (notice: PortalNoticeKey) => portalRedirect(request, PORTAL_SETTINGS_PATH, notice);
  if (!mayManagePortals(session.org.role)) return say('portal_role');

  // Before the body is read: nothing is sealed, so nothing is taken in.
  const cipher = portalCipherFromEnv();
  if (cipher === undefined) return say('portal_not_configured');

  const identity = { orgId: session.org.orgId, userId: session.userId };
  const form = await portalForm(request, 'credential', identity.orgId);
  if (form === undefined) return say('portal_failed');

  const connectionField = formText(form, 'connectionId');
  if (!isUuid(connectionField)) return say('portal_unknown_connection');
  const versionField = formText(form, 'recipeVersionId');
  if (!isUuid(versionField)) return say('portal_credential_no_version');
  const connectionId = connectionField.toLowerCase();
  const recipeVersionId = versionField.toLowerCase();

  const username = formText(form, 'username') ?? '';
  const password = formText(form, 'password') ?? '';
  const typedKey = formText(form, 'totpSecret') ?? '';
  const typedLabel = formText(form, 'label') ?? '';
  if (username === '') return say('portal_credential_username_invalid');
  if (password === '') return say('portal_credential_password_invalid');
  let totpSecret: string | undefined;
  if (typedKey.trim() !== '') {
    totpSecret = foldSetupKey(typedKey);
    if (totpSecret === undefined) return say('portal_credential_key_invalid');
  }
  const label = typedLabel === '' ? undefined : typedLabel;
  if (label !== undefined && labelHoldsSecret(label, { username, password, totpSecret })) {
    return say('portal_credential_label_secret');
  }

  const store = portalStoreFor(identity, cipher);
  try {
    if (!(await store.memberMayWrite(identity))) return say('portal_role');
    const connection = await store.connection(connectionId);
    if (connection === undefined) return say('portal_unknown_connection');

    const credentialId = await store.sealAndStoreCredential({
      connectionId,
      recipeVersionId,
      ...(label === undefined ? {} : { label }),
      payload: { username, password, ...(totpSecret === undefined ? {} : { totpSecret }) },
    });
    console.info(
      `[recouple] portal credential stored: credential ${credentialId} connection ${connectionId} ` +
        `version ${recipeVersionId} org ${identity.orgId} by ${identity.userId}`,
    );
    return say(connection.enabled ? 'portal_credential_stored' : 'portal_credential_stored_off');
  } catch (error) {
    const refused = credentialRefusal(error);
    if (refused !== undefined) {
      console.info(
        `[recouple] portal credential refused: connection ${connectionId} version ` +
          `${recipeVersionId} org ${identity.orgId} by ${identity.userId} (${refusalForLog(error)})`,
      );
      return say(refused);
    }
    console.error(
      `[recouple] portal credential store failed: connection ${connectionId} version ` +
        `${recipeVersionId} org ${identity.orgId} (${errorForLog(error)})`,
    );
    return say(error instanceof TokenCipherError ? 'portal_credential_seal_failed' : 'portal_failed');
  }
}

/** A refusal for the log: its class, and for an input refusal the field — a name, never the value. */
function refusalForLog(error: unknown): string {
  if (error instanceof PortalInputError) {
    return `PortalInputError ${error.issues.map((issue) => issue.field).join(', ')}`;
  }
  return errorForLog(error);
}

/** A named refusal's notice, or nothing for a fault. */
function credentialRefusal(error: unknown): PortalNoticeKey | undefined {
  if (error instanceof PortalOwnerRequiredError) return 'portal_role';
  if (error instanceof PortalConnectionNotFoundError) return 'portal_unknown_connection';
  if (
    error instanceof PortalRecipeVersionNotFoundError ||
    error instanceof PortalRecipeVersionPortalMismatchError
  ) {
    return 'portal_credential_no_version';
  }
  if (error instanceof PortalCredentialLabelError) return 'portal_credential_label_secret';
  if (error instanceof PortalSealingNotConfiguredError) return 'portal_not_configured';
  if (isNamed(error, 'PortalBindingError')) return 'portal_credential_unbindable';
  if (error instanceof PortalInputError) {
    const field = error.issues[0]?.field ?? '';
    if (field.startsWith('payload.username')) return 'portal_credential_username_invalid';
    if (field.startsWith('payload.password')) return 'portal_credential_password_invalid';
    if (field.startsWith('payload.totpSecret')) return 'portal_credential_key_invalid';
    if (field.startsWith('label')) return 'portal_credential_label_invalid';
    if (field === 'connectionId') return 'portal_unknown_connection';
    if (field === 'recipeVersionId') return 'portal_credential_no_version';
  }
  return undefined;
}

import { NextResponse, type NextRequest } from 'next/server';
import { revokeIntuitToken } from '@recouple/qbo';
import { disconnectLedger, OwnerRequiredError } from '@recouple/store-postgres';
import { requireSession, storeFor } from '../../../../lib/session';
import { isCrossSite, isUuid, refuseCrossSite } from '../../../../lib/request';
import { env } from '../../../../lib/env';
import { type NoticeKey } from '../../../../lib/notices';
import {
  mayConnectLedger,
  qboConnectFromEnv,
  QBO_SETTINGS_PATH,
} from '../../../../lib/qbo-connect';

/**
 * Disconnects QuickBooks: off here first, then revoked at Intuit, and both
 * recorded (ADR 0039 §9).
 *
 * The connection is turned off and that is committed before Intuit is asked
 * anything, because the database is the truth of whether we sync. A revoke
 * Intuit refuses — or one this deployment cannot make, having no Intuit app or
 * no KMS key — is said to the owner, with the one thing they can do about it,
 * and does not undo the disable.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (isCrossSite(request)) return refuseCrossSite();

  const session = await requireSession();
  const settings = new URL(QBO_SETTINGS_PATH, request.url);
  const say = (notice: NoticeKey): NextResponse => {
    settings.searchParams.set('qbo', notice);
    return NextResponse.redirect(settings, { status: 303 });
  };

  if (!mayConnectLedger(session.org.role)) return say('qbo_role');

  const form = await request.formData();
  const connectionId = form.get('connectionId');
  if (!isUuid(connectionId)) return say('qbo_disconnect_unknown');

  const identity = { orgId: session.org.orgId, userId: session.userId };
  const store = storeFor(session);
  try {
    if (!(await store.memberMayWrite(identity))) return say('qbo_role');

    const configured = qboConnectFromEnv();
    const result = await disconnectLedger({ connectionString: env.databaseUrl }, identity, {
      connectionId,
      via: 'web_consent',
      ...(configured.kind === 'ready'
        ? {
            revoke: {
              cipher: configured.cipher,
              revokeToken: (token: string) => revokeIntuitToken(configured.app, token),
            },
          }
        : {}),
    });

    if (result === undefined) return say('qbo_disconnect_unknown');
    if (!result.disabled) return say('qbo_already_disconnected');
    if (result.revokeAuditErrorClass !== undefined) {
      // The connection is off and that is audited; the revoke's own row is
      // what is missing. Loud for an operator, and not the owner's problem.
      console.error(
        `[recouple] QuickBooks disconnect: connection ${connectionId} for org ${identity.orgId} ` +
          `is off and revoke ${result.revoke}, but the revoke's audit row was not written ` +
          `(${result.revokeAuditErrorClass})`,
      );
    }
    if (result.revoke !== 'confirmed') {
      console.warn(
        `[recouple] QuickBooks disconnect: connection ${connectionId} for org ${identity.orgId} ` +
          `is off; revoke ${result.revoke}${
            result.revokeErrorClass === undefined ? '' : ` (${result.revokeErrorClass})`
          }`,
      );
      return say('qbo_disconnected_not_revoked');
    }
    return say('qbo_disconnected');
  } catch (cause) {
    if (cause instanceof OwnerRequiredError) return say('qbo_role');
    console.error(
      `[recouple] QuickBooks disconnect: connection ${connectionId} for org ${identity.orgId} ` +
        `failed (${cause instanceof Error ? cause.name : typeof cause})`,
    );
    return say('qbo_disconnect_failed');
  } finally {
    await store.close();
  }
}

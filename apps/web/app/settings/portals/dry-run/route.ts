import type { NextRequest, NextResponse } from 'next/server';
import { bindingOf, sameBinding } from '@recouple/portal';
import { PortalOwnerRequiredError } from '@recouple/store-postgres';
import { requireSession } from '../../../../lib/session';
import { isCrossSite, isUuid, refuseCrossSite } from '../../../../lib/request';
import {
  errorForLog,
  formText,
  mayManagePortals,
  portalForm,
  portalRedirect,
  portalStoreFor,
  queuePortalDryRun,
  runInFlight,
  utcMinute,
  PORTAL_SETTINGS_PATH,
  type PortalNoticeKey,
} from '../../../../lib/portals';

/**
 * Starts a dry run of one recipe version on one connection (ADR 0057 §3,
 * ADR 0062 §4): the same runner, refusals, host allowlist, binding and caps,
 * with nothing captured or stored and a step log for its record. It is a real
 * sign-in on the portal account, so it is started only by an owner pressing
 * the button, and only when it could get somewhere.
 *
 * What this route checks first is what would otherwise be a run that could
 * only fail: the connection off, a version of another portal or one an owner
 * rejected, no credential, a credential sealed for another sign-in than the
 * version's (the worker would refuse it before opening it), or a run of the
 * same connection still in flight. The job asks every question that matters
 * again — enabled, `memberMayWrite`, the portal's terms — before it calls the
 * worker, acting as the connection's `created_by`, never as whoever pressed.
 *
 * The event carries ids and nothing else (ADR 0021): never a credential, a
 * recipe or a page.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (isCrossSite(request)) return refuseCrossSite();

  const session = await requireSession();
  const say = (notice: PortalNoticeKey, about: readonly string[] = []) =>
    portalRedirect(request, PORTAL_SETTINGS_PATH, notice, about);
  if (!mayManagePortals(session.org.role)) return say('portal_role');

  const identity = { orgId: session.org.orgId, userId: session.userId };
  const form = await portalForm(request, 'dry run', identity.orgId);
  if (form === undefined) return say('portal_failed');

  const connectionField = formText(form, 'connectionId');
  if (!isUuid(connectionField)) return say('portal_unknown_connection');
  const versionField = formText(form, 'recipeVersionId');
  if (!isUuid(versionField)) return say('portal_unknown_version');
  const connectionId = connectionField.toLowerCase();
  const recipeVersionId = versionField.toLowerCase();

  const store = portalStoreFor(identity);
  try {
    if (!(await store.memberMayWrite(identity))) return say('portal_role');

    const connection = await store.connection(connectionId);
    if (connection === undefined) return say('portal_unknown_connection');
    if (!connection.enabled) return say('portal_dry_run_off');

    const version = await store.recipeVersion(recipeVersionId);
    if (version === undefined || version.portalKey !== connection.portalKey) {
      return say('portal_unknown_version');
    }
    if (version.review?.verdict === 'rejected') return say('portal_dry_run_rejected');

    const credential = await store.latestCredential(connectionId);
    if (credential === undefined) return say('portal_dry_run_no_credential');
    if (!sameBinding(credential.binding, bindingOf(version.recipe))) {
      return say('portal_dry_run_binding');
    }

    // A run with no outcome yet holds the next for as long as the job may
    // still be waiting on it, which its own recipe's cap decides.
    const [latest] = await store.listRuns(connectionId, 1);
    if (latest !== undefined && latest.end === null) {
      const ran =
        latest.recipeVersionId === null ? undefined : await store.recipeVersion(latest.recipeVersionId);
      if (runInFlight(latest, new Date(), ran?.recipe.caps.maxRunMs)) {
        return say('portal_dry_run_in_flight', [utcMinute(latest.startedAt)]);
      }
    }

    return say(
      await queuePortalDryRun({
        connectionId,
        orgId: identity.orgId,
        actingAs: connection.createdBy,
        recipeVersionId,
        pressedBy: identity.userId,
      }),
    );
  } catch (error) {
    if (error instanceof PortalOwnerRequiredError) return say('portal_role');
    console.error(
      `[recouple] portal dry run failed to start: connection ${connectionId} version ` +
        `${recipeVersionId} org ${identity.orgId} (${errorForLog(error)})`,
    );
    return say('portal_failed');
  }
}

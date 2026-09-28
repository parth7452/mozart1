import type { NextRequest, NextResponse } from 'next/server';
import {
  PortalAgentDraftAdditionsError,
  PortalOwnerRequiredError,
  PortalRecipeAlreadyReviewedError,
  PortalRecipeVersionNotFoundError,
} from '@recouple/store-postgres';
import { requireSession } from '../../../../lib/session';
import { isCrossSite, isUuid, refuseCrossSite } from '../../../../lib/request';
import {
  COMPARED_WITH_NONE,
  errorForLog,
  formText,
  mayManagePortals,
  portalForm,
  portalRedirect,
  portalStoreFor,
  portalVersionPath,
  PORTAL_SETTINGS_PATH,
  type PortalNoticeKey,
} from '../../../../lib/portals';

/**
 * An owner's one verdict on a recipe version (ADR 0057 §3): promoted or
 * rejected, final, and written as its own append-only review row naming what
 * the version adds beyond the promoted version in effect.
 *
 * The review page showed an owner what the version adds against one promoted
 * version, and the form carries which. If another version has been promoted
 * since, what this one adds may have changed, so nothing is recorded and the
 * owner is sent back to read it again: what an owner read before promoting is
 * what the review row says. An agent session's draft that adds anything is
 * refused promotion by the store, by name.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (isCrossSite(request)) return refuseCrossSite();

  const session = await requireSession();
  const toSettings = (notice: PortalNoticeKey, about: readonly string[] = []) =>
    portalRedirect(request, PORTAL_SETTINGS_PATH, notice, about);
  if (!mayManagePortals(session.org.role)) return toSettings('portal_role');

  const identity = { orgId: session.org.orgId, userId: session.userId };
  const form = await portalForm(request, 'review', identity.orgId);
  if (form === undefined) return toSettings('portal_failed');

  const recipeVersionId = formText(form, 'recipeVersionId');
  if (!isUuid(recipeVersionId)) return toSettings('portal_unknown_version');
  const id = recipeVersionId.toLowerCase();
  const toReview = (notice: PortalNoticeKey) => portalRedirect(request, portalVersionPath(id), notice);

  const verdict = formText(form, 'verdict');
  if (verdict !== 'promoted' && verdict !== 'rejected') return toReview('portal_verdict_invalid');
  const comparedWith = formText(form, 'comparedWith');

  const store = portalStoreFor(identity);
  try {
    if (!(await store.memberMayWrite(identity))) return toReview('portal_role');

    const version = await store.recipeVersion(id);
    if (version === undefined) return toSettings('portal_unknown_version');
    if (version.review !== null) return toReview('portal_version_reviewed_already');

    const preview = await store.reviewPreview(id);
    if (preview === undefined) return toSettings('portal_unknown_version');
    if ((preview.comparedWithVersionId ?? COMPARED_WITH_NONE) !== comparedWith) {
      return toReview('portal_version_review_stale');
    }

    const reviewId = await store.reviewRecipeVersion({ recipeVersionId: id, verdict });
    console.info(
      `[recouple] portal recipe version reviewed: version ${id} ${verdict} review ${reviewId} ` +
        `compared with ${preview.comparedWithVersionId ?? COMPARED_WITH_NONE} ` +
        `(${preview.additions.length} additions) org ${identity.orgId} by ${identity.userId}`,
    );
    return verdict === 'promoted'
      ? toSettings('portal_version_promoted', [
          version.portalKey,
          String(version.version),
          version.effectiveFrom,
        ])
      : toSettings('portal_version_rejected', [version.portalKey, String(version.version)]);
  } catch (error) {
    if (error instanceof PortalOwnerRequiredError) return toReview('portal_role');
    if (error instanceof PortalRecipeAlreadyReviewedError) {
      return toReview('portal_version_reviewed_already');
    }
    if (error instanceof PortalAgentDraftAdditionsError) {
      return toReview('portal_version_agent_additions');
    }
    if (error instanceof PortalRecipeVersionNotFoundError) {
      return toSettings('portal_unknown_version');
    }
    console.error(
      `[recouple] portal recipe version review failed: version ${id} org ${identity.orgId} ` +
        `(${errorForLog(error)})`,
    );
    return toReview('portal_failed');
  }
}

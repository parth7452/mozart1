import { notFound } from 'next/navigation';
import { NEVER_CLICK_FLOOR, bindingOf, type PortalBinding } from '@recouple/portal';
import { requireSession } from '../../../../../lib/session';
import { mayWrite } from '../../../../../lib/pipeline';
import { isUuid } from '../../../../../lib/request';
import { aboutFrom } from '../../../../../lib/notices';
import { teamStoreFor } from '../../../../../lib/team';
import { className, mayManagePortals, portalStoreFor } from '../../../../../lib/portals';
import { PortalVersionReviewPage } from '../../../../../components/portal-review';
import { viewerOf } from '../../../../../lib/viewer';

export const dynamic = 'force-dynamic';

/**
 * One recipe version's review screen (ADR 0057 §3): resolve the member, read
 * the version through RLS, and — for a version nobody has reviewed — what a
 * review now would name, from the store's own `reviewPreview`, so what an
 * owner reads before promoting is what the review row will say.
 *
 * A version this tenant cannot see is a 404, as is an id that is not one.
 */
export default async function PortalVersionRoute({
  params,
  searchParams,
}: {
  params: Promise<{ versionId: string }>;
  searchParams: Promise<{ portal?: string; about?: string | string[] }>;
}) {
  const { versionId } = await params;
  const { portal, about } = await searchParams;
  if (!isUuid(versionId)) notFound();

  const session = await requireSession();
  if (!mayWrite(session.org.role)) {
    return <PortalVersionReviewPage kind="hidden" viewer={viewerOf(session)} />;
  }

  const identity = { orgId: session.org.orgId, userId: session.userId };
  const store = portalStoreFor(identity);
  const id = versionId.toLowerCase();
  const version = await store.recipeVersion(id);
  if (version === undefined) notFound();

  const preview = version.review === null ? await store.reviewPreview(id) : undefined;
  const comparedWithId =
    version.review === null
      ? (preview?.comparedWithVersionId ?? null)
      : version.review.comparedWithVersionId;
  const [comparedWith, members] = await Promise.all([
    comparedWithId === null ? Promise.resolve(undefined) : store.recipeVersion(comparedWithId),
    teamStoreFor(identity).members(),
  ]);

  let binding: PortalBinding | undefined;
  try {
    binding = bindingOf(version.recipe);
  } catch (error) {
    // The store refuses a version it cannot bind when it is added; one that
    // could not be bound here is said loudly and shown as not bindable.
    console.error(
      `[recouple] portal version review: recipe version ${id} cannot be bound (${className(error)})`,
    );
  }

  return (
    <PortalVersionReviewPage
      kind="details"
      viewer={viewerOf(session)}
      mayManage={mayManagePortals(session.org.role)}
      version={version}
      preview={preview}
      comparedWith={comparedWith}
      binding={binding}
      floor={NEVER_CLICK_FLOOR}
      members={members.map((member) => ({
        userId: member.userId,
        email: member.email,
        role: member.role,
      }))}
      notice={portal}
      about={aboutFrom(about)}
    />
  );
}

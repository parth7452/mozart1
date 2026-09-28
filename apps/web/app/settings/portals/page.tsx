import { bindingOf, sameBinding, type PortalRecipeVersionRecord } from '@recouple/portal';
import type { PortalCredentialRecord } from '@recouple/portal';
import { requireSession } from '../../../lib/session';
import { mayWrite } from '../../../lib/pipeline';
import { aboutFrom } from '../../../lib/notices';
import { teamStoreFor } from '../../../lib/team';
import {
  className,
  mayManagePortals,
  portalRunsMissingFromEnv,
  portalSealingFromEnv,
  portalStoreFor,
} from '../../../lib/portals';
import {
  PortalSettingsPage,
  PORTAL_RUNS_SHOWN,
  type PortalCredentialSummary,
  type PortalGroup,
} from '../../../components/portal-settings';
import { viewerOf } from '../../../lib/viewer';

export const dynamic = 'force-dynamic';

/**
 * Settings → Portals: resolve the member, read, render (ADR 0057 §13, ADR 0062).
 *
 * Every read is this tenant's through RLS, as the member signed in, and none
 * of it is a credential: the latest credential row is reduced to when, by
 * whom, under which label and for which sign-in before it reaches the view,
 * which never holds its sealed columns. A member who may not add documents is
 * told how many connections there are and nothing is read about them.
 */
export default async function PortalSettingsRoute({
  searchParams,
}: {
  searchParams: Promise<{ portal?: string; about?: string | string[] }>;
}) {
  const session = await requireSession();
  const { portal, about } = await searchParams;
  const identity = { orgId: session.org.orgId, userId: session.userId };
  const store = portalStoreFor(identity);
  const connections = await store.listConnections();

  if (!mayWrite(session.org.role)) {
    return (
      <PortalSettingsPage
        kind="counts"
        viewer={viewerOf(session)}
        connections={connections.length}
        enabled={connections.filter((connection) => connection.enabled).length}
        notice={portal}
        about={aboutFrom(about)}
      />
    );
  }

  const portalKeys = [...new Set(connections.map((connection) => connection.portalKey))].sort();
  const [members, groups] = await Promise.all([
    teamStoreFor(identity).members(),
    Promise.all(
      portalKeys.map(async (portalKey): Promise<PortalGroup> => {
        const versions = await store.listRecipeVersions(portalKey);
        const views = await Promise.all(
          connections
            .filter((connection) => connection.portalKey === portalKey)
            .map(async (connection) => {
              const [credential, promoted, runs] = await Promise.all([
                store.latestCredential(connection.connectionId),
                store.promotedRecipe(connection.connectionId),
                store.listRuns(connection.connectionId, PORTAL_RUNS_SHOWN),
              ]);
              return {
                connection,
                credential: credential === undefined ? undefined : summarize(credential, versions),
                promoted,
                runs,
              };
            }),
        );
        return { portalKey, versions, connections: views };
      }),
    ),
  ]);

  const sealing = portalSealingFromEnv();
  return (
    <PortalSettingsPage
      kind="details"
      viewer={viewerOf(session)}
      viewerUserId={session.userId}
      mayManage={mayManagePortals(session.org.role)}
      deployment={{
        sealing: sealing.kind === 'ready' ? { ready: true } : { ready: false, reason: sealing.reason },
        runsMissing: portalRunsMissingFromEnv(),
      }}
      groups={groups}
      members={members.map((member) => ({
        userId: member.userId,
        email: member.email,
        role: member.role,
      }))}
      notice={portal}
      about={aboutFrom(about)}
      now={new Date()}
    />
  );
}

/**
 * The credential as the view may know it: never its sealed columns. Whether
 * it would open for each version is its binding against that version's
 * (`bindingOf`, the one computation of a binding), so the page can say before
 * a run what the worker would refuse. A version that cannot be bound opens
 * nothing.
 */
function summarize(
  credential: PortalCredentialRecord,
  versions: readonly PortalRecipeVersionRecord[],
): PortalCredentialSummary {
  const opensVersion: Record<string, boolean> = {};
  for (const version of versions) {
    let opens = false;
    try {
      opens = sameBinding(credential.binding, bindingOf(version.recipe));
    } catch (error) {
      // The store refuses a version it cannot bind when it is added, so a
      // stored one never throws here. If one does, it is said loudly, and the
      // page says the credential would not open for it, which is true.
      console.error(
        `[recouple] portal settings: recipe version ${version.recipeVersionId} cannot be bound ` +
          `(${className(error)})`,
      );
    }
    opensVersion[version.recipeVersionId] = opens;
  }
  return {
    credentialId: credential.credentialId,
    label: credential.label,
    storedAt: credential.createdAt,
    storedBy: credential.createdBy,
    signInOrigin: credential.binding.signInOrigin,
    opensVersion,
  };
}

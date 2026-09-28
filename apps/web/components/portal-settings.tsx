import Link from 'next/link';
import type {
  PortalConnectionRecord,
  PortalRecipeVersionRecord,
  PortalRunRecord,
} from '@recouple/portal';
import { PORTAL_LIMITS } from '@recouple/portal';
import {
  portalVersionPath,
  resolvePortalNotice,
  runInFlight,
  runWords,
  utcMinute,
  RECIPE_MAX_BYTES,
} from '../lib/portals';
import { WorkspaceShell } from './workspace-shell';
import type { Viewer } from './case-list';

/**
 * Settings → Portals, as pure functions of what the store returned (ADR 0057
 * §3, §7, §13; ADR 0062).
 *
 * Nothing here is a credential. A connection's account id is the portal
 * account's public identifier, a recipe is data an owner uploaded, and a run
 * is its outcome codes, counts and step names: React escapes all of it, and
 * nothing a portal page said is anywhere in it. The credential appears only as
 * the fact that one was entered, when, by whom, under which label and for
 * which sign-in origin — never the sealed columns, which the page never holds.
 *
 * An owner sees the forms; a member who may add documents sees the same page
 * without them; anyone else is told how many connections there are and
 * nothing about them, as Settings → Email does.
 */

/** A workspace member, as far as this page names one. */
export interface PortalMember {
  readonly userId: string;
  readonly email: string;
  readonly role: string;
}

/**
 * A connection's current credential, as far as the page may know it: never
 * the sealed columns. `opensVersion` says, per recipe version of its portal,
 * whether its binding is that version's — whether a run of that version could
 * open it (ADR 0057 §7).
 */
export interface PortalCredentialSummary {
  readonly credentialId: string;
  readonly label: string | null;
  readonly storedAt: Date;
  readonly storedBy: string;
  readonly signInOrigin: string;
  readonly opensVersion: Readonly<Record<string, boolean>>;
}

export interface PortalConnectionView {
  readonly connection: PortalConnectionRecord;
  readonly credential: PortalCredentialSummary | undefined;
  /** The promoted version in effect today, as the database's clock says. */
  readonly promoted: PortalRecipeVersionRecord | undefined;
  /** Newest first. */
  readonly runs: readonly PortalRunRecord[];
}

/** One portal key's connections and the recipe versions they share. */
export interface PortalGroup {
  readonly portalKey: string;
  /** Highest version first. */
  readonly versions: readonly PortalRecipeVersionRecord[];
  readonly connections: readonly PortalConnectionView[];
}

/** What this deployment can do, in names and never values. */
export interface PortalDeploymentView {
  readonly sealing: { readonly ready: true } | { readonly ready: false; readonly reason: string };
  readonly runsMissing: readonly string[];
}

/** How many runs each connection shows. */
export const PORTAL_RUNS_SHOWN = 10;

/** Style for a masked input, which the stylesheet does not dress as it does text inputs. */
const SECRET_INPUT_STYLE = {
  width: '100%',
  marginTop: 4,
  padding: '8px 10px',
  font: 'inherit',
  fontSize: 14,
  border: '1px solid var(--line)',
  borderRadius: 8,
  background: 'white',
} as const;

export type PortalSettingsProps =
  | {
      readonly kind: 'counts';
      readonly viewer: Viewer;
      readonly connections: number;
      readonly enabled: number;
      /** A notice key and its fragments, never a sentence: a refused POST says so here too. */
      readonly notice?: string | undefined;
      readonly about?: readonly string[];
    }
  | {
      readonly kind: 'details';
      readonly viewer: Viewer;
      readonly viewerUserId: string;
      /** An owner: may add, change and run. The database is what enforces it. */
      readonly mayManage: boolean;
      readonly deployment: PortalDeploymentView;
      readonly groups: readonly PortalGroup[];
      readonly members: readonly PortalMember[];
      /** A notice key and its fragments, never a sentence. */
      readonly notice?: string | undefined;
      readonly about?: readonly string[];
      readonly now: Date;
    };

export function PortalSettingsPage(props: PortalSettingsProps) {
  return (
    <WorkspaceShell viewer={props.viewer} section="portals">
      <main id="workspace-main" className="workspace-main">
        <div className="page-heading">
          <div>
            <p className="eyebrow">SETTINGS</p>
            <h1>Portals</h1>
            <p className="page-description">
              A payer&rsquo;s supplier portal, read by a recipe an owner promoted and never written
              to. A run signs in with a credential this app sealed and cannot open, and stops for a
              person rather than guess.
            </p>
          </div>
        </div>
        <Notice notice={props.notice} about={props.about ?? []} />
        {props.kind === 'counts' ? (
          <Counts connections={props.connections} enabled={props.enabled} />
        ) : (
          <Details {...props} />
        )}
      </main>
    </WorkspaceShell>
  );
}

function Counts({ connections, enabled }: { connections: number; enabled: number }) {
  return (
    <section className="card connection" aria-label="Portal connections">
      <h2>Portal connections</h2>
      <p className="empty">
        {connections === 0
          ? 'This workspace has no portal connection.'
          : `This workspace has ${connections} portal connection${connections === 1 ? '' : 's'}, ` +
            `${enabled} of them on. Their accounts, recipes and runs are shown to members who can ` +
            'add documents.'}
      </p>
    </section>
  );
}

/** The notice a key names, in this page's own words, or nothing at all. */
function Notice({ notice, about }: { notice: string | undefined; about: readonly string[] }) {
  const said = resolvePortalNotice(notice, about);
  return said === undefined ? null : (
    <p className={said.tone === 'good' ? 'notice sent' : 'notice bad'} role="status">
      {said.text}
    </p>
  );
}

function Details(props: Extract<PortalSettingsProps, { kind: 'details' }>) {
  const members = new Map(props.members.map((member) => [member.userId, member]));
  return (
    <>
      <DeploymentCard deployment={props.deployment} mayManage={props.mayManage} />

      {props.groups.length === 0 ? (
        <section className="card connection" aria-label="No portal connection">
          <h2>No portal connection</h2>
          <p className="empty">
            No portal is connected to this workspace.
            {props.mayManage
              ? ' Add a connection below, then upload its recipe, review and promote it, and ' +
                'enter its credential.'
              : ''}
          </p>
        </section>
      ) : (
        props.groups.map((group) => (
          <div key={group.portalKey}>
            {group.connections.map((view) => (
              <ConnectionCard
                key={view.connection.connectionId}
                view={view}
                versions={group.versions}
                members={members}
                viewerUserId={props.viewerUserId}
                mayManage={props.mayManage}
                sealingReady={props.deployment.sealing.ready}
                now={props.now}
              />
            ))}
            <VersionsCard group={group} members={members} mayManage={props.mayManage} />
          </div>
        ))
      )}

      {props.mayManage ? (
        <AddConnection />
      ) : (
        <p className="empty">
          Only an owner can add a portal connection, change its recipe or credential, or start a run.
        </p>
      )}
    </>
  );
}

function DeploymentCard({
  deployment,
  mayManage,
}: {
  deployment: PortalDeploymentView;
  mayManage: boolean;
}) {
  const sealing = deployment.sealing;
  if (sealing.ready && deployment.runsMissing.length === 0) return null;
  return (
    <section className="card connection" aria-label="Portals are not set up">
      <h2>Portal runs are not set up on this deployment</h2>
      {!mayManage ? (
        <p className="empty">
          Something this deployment needs for portal runs is not set. An owner is told what.
        </p>
      ) : (
        <>
          {sealing.ready ? null : (
            <p className="empty">
              Credentials cannot be entered here, so none is stored: {sealing.reason}.
            </p>
          )}
          {deployment.runsMissing.length === 0 ? null : (
            <p className="empty">
              Nothing can run a recipe here until these are set: {deployment.runsMissing.join(', ')}.
              A run started without them is recorded as not run.
            </p>
          )}
          <p className="empty">
            For your administrator: these are Production variables only, never Preview — see
            docs/plans/ariba-portal/README.md, steps 4 to 6.
          </p>
        </>
      )}
    </section>
  );
}

/** The versions an owner may seal a credential to or dry-run: every one not rejected, the promoted one first. */
function runnableVersions(
  versions: readonly PortalRecipeVersionRecord[],
  promoted: PortalRecipeVersionRecord | undefined,
): readonly PortalRecipeVersionRecord[] {
  const open = versions.filter((version) => version.review?.verdict !== 'rejected');
  return promoted === undefined
    ? open
    : [
        ...open.filter((version) => version.recipeVersionId === promoted.recipeVersionId),
        ...open.filter((version) => version.recipeVersionId !== promoted.recipeVersionId),
      ];
}

/** A version as an option names it: its number and where it stands. */
function versionOption(
  version: PortalRecipeVersionRecord,
  promoted: PortalRecipeVersionRecord | undefined,
): string {
  if (version.recipeVersionId === promoted?.recipeVersionId) {
    return `version ${version.version} — promoted, in effect`;
  }
  if (version.review === null) return `version ${version.version} — not reviewed, dry run only`;
  return `version ${version.version} — promoted, effective from ${version.effectiveFrom}`;
}

function actingMemberWords(member: PortalMember | undefined, viewerUserId: string): string {
  if (member === undefined) return 'a former member of this workspace';
  return `${member.email}${member.userId === viewerUserId ? ' (you)' : ''}`;
}

function ConnectionCard({
  view,
  versions,
  members,
  viewerUserId,
  mayManage,
  sealingReady,
  now,
}: {
  view: PortalConnectionView;
  versions: readonly PortalRecipeVersionRecord[];
  members: ReadonlyMap<string, PortalMember>;
  viewerUserId: string;
  mayManage: boolean;
  sealingReady: boolean;
  now: Date;
}) {
  const { connection, credential, promoted, runs } = view;
  const actingMember = members.get(connection.createdBy);
  const runnable = runnableVersions(versions, promoted);
  const capOf = (run: PortalRunRecord): number | undefined =>
    versions.find((version) => version.recipeVersionId === run.recipeVersionId)?.recipe.caps.maxRunMs;
  const inFlight = runs.find((run) => runInFlight(run, now, capOf(run)));
  const latest = runs[0];
  const refusedLast =
    !connection.enabled &&
    latest?.end?.outcome === 'needs_attention' &&
    latest.end.reason === 'credential_rejected';
  const params = Object.entries(connection.params);
  const versionNumber = new Map(versions.map((version) => [version.recipeVersionId, version.version]));

  return (
    <section className="card connection" aria-label={`Portal connection ${connection.label}`}>
      <h2>
        {connection.label}
        {connection.enabled ? '' : ' — off'}
      </h2>
      <dl className="connection">
        <div>
          <dt>Portal</dt>
          <dd className="mono">{connection.portalKey}</dd>
        </div>
        <div>
          <dt>Account id</dt>
          <dd className="mono">{connection.accountId}</dd>
        </div>
        {params.length === 0 ? null : (
          <div>
            <dt>Run parameters</dt>
            <dd className="mono">{params.map(([name, value]) => `${name}=${value}`).join(' · ')}</dd>
          </div>
        )}
        <div>
          <dt>State</dt>
          <dd>
            {connection.enabled
              ? 'On. It runs only when a run is started.'
              : 'Off. Nothing signs in to the portal.'}
          </dd>
        </div>
        <div>
          <dt>Runs as</dt>
          <dd>{actingMemberWords(actingMember, viewerUserId)}</dd>
        </div>
        <div>
          <dt>Recipe in effect</dt>
          <dd>
            {promoted === undefined
              ? 'none promoted yet'
              : `version ${promoted.version}, effective from ${promoted.effectiveFrom}`}
          </dd>
        </div>
        <div>
          <dt>Credential</dt>
          <dd>
            {credential === undefined
              ? 'none entered'
              : `entered ${utcMinute(credential.storedAt)} UTC by ` +
                `${members.get(credential.storedBy)?.email ?? 'a former member'}` +
                `${credential.label === null ? '' : `, “${credential.label}”`}; sealed for sign-in ` +
                `at ${credential.signInOrigin}`}
          </dd>
        </div>
      </dl>

      {refusedLast ? (
        <p className="notice bad" role="status">
          Turned off when the portal refused its credential. Nothing will try it again: enter the
          credential again, then turn the connection on.
        </p>
      ) : null}
      {actingMember === undefined || actingMember.role !== 'owner' ? (
        <p className="notice bad" role="status">
          Every run acts as {actingMemberWords(actingMember, viewerUserId)}, who{' '}
          {actingMember === undefined ? 'is no longer a member' : 'is no longer an owner'}, so runs
          are refused. Turn this connection off and add it again as a current owner.
        </p>
      ) : null}
      {credential !== undefined &&
      promoted !== undefined &&
      credential.opensVersion[promoted.recipeVersionId] !== true ? (
        <p className="notice bad" role="status">
          The credential was sealed for another sign-in than version {promoted.version}&rsquo;s,
          the version in effect, so a run of it would stop before opening the credential. Enter the
          credential again for version {promoted.version}.
        </p>
      ) : null}

      {mayManage ? (
        <>
          <div className="connection-actions">
            <form action="/settings/portals/switch" method="post">
              <input type="hidden" name="connectionId" value={connection.connectionId} />
              <input type="hidden" name="turn" value={connection.enabled ? 'off' : 'on'} />
              <button type="submit">{connection.enabled ? 'Turn off' : 'Turn on'}</button>
            </form>
          </div>
          <DryRunForm
            connection={connection}
            credential={credential}
            runnable={runnable}
            promoted={promoted}
            inFlight={inFlight}
          />
          <CredentialForm
            connection={connection}
            runnable={runnable}
            promoted={promoted}
            sealingReady={sealingReady}
            replacing={credential !== undefined}
          />
        </>
      ) : null}

      <h3 style={{ margin: '18px 0 6px', fontSize: 14 }}>Runs</h3>
      {runs.length === 0 ? (
        <p className="empty">No run yet.</p>
      ) : (
        <ul className="inbound-addresses">
          {runs.map((run) => (
            <RunRow
              key={run.runId}
              run={run}
              now={now}
              maxRunMs={capOf(run)}
              versionNumber={
                run.recipeVersionId === null ? undefined : versionNumber.get(run.recipeVersionId)
              }
            />
          ))}
        </ul>
      )}
      {runs.length >= PORTAL_RUNS_SHOWN ? (
        <p className="empty">The newest {PORTAL_RUNS_SHOWN} runs are shown.</p>
      ) : null}
    </section>
  );
}

function DryRunForm({
  connection,
  credential,
  runnable,
  promoted,
  inFlight,
}: {
  connection: PortalConnectionRecord;
  credential: PortalCredentialSummary | undefined;
  runnable: readonly PortalRecipeVersionRecord[];
  promoted: PortalRecipeVersionRecord | undefined;
  inFlight: PortalRunRecord | undefined;
}) {
  const why = !connection.enabled
    ? 'Turn the connection on to start a dry run.'
    : credential === undefined
      ? 'Enter a credential to start a dry run.'
      : runnable.length === 0
        ? 'Upload a recipe version to start a dry run.'
        : inFlight !== undefined
          ? `A run started at ${utcMinute(inFlight.startedAt)} UTC has not finished.`
          : undefined;
  return (
    <form action="/settings/portals/dry-run" method="post" aria-label="Start a dry run">
      <h3 style={{ margin: '18px 0 6px', fontSize: 14 }}>Dry run</h3>
      <input type="hidden" name="connectionId" value={connection.connectionId} />
      {runnable.length === 0 ? null : (
        <>
          <label htmlFor={`dry-run-version-${connection.connectionId}`}>Version to run</label>
          <select
            id={`dry-run-version-${connection.connectionId}`}
            name="recipeVersionId"
            defaultValue={runnable[0]?.recipeVersionId}
          >
            {runnable.map((version) => (
              <option key={version.recipeVersionId} value={version.recipeVersionId}>
                {versionOption(version, promoted)}
                {credential !== undefined &&
                credential.opensVersion[version.recipeVersionId] !== true
                  ? ' (the credential was sealed for another sign-in)'
                  : ''}
              </option>
            ))}
          </select>
        </>
      )}
      <p className="empty" style={{ padding: '6px 0 8px' }}>
        A dry run signs in for real and runs every step, captures and stores nothing, and records
        which steps passed. Each one is a sign-in on the portal account: press it when you mean it.
      </p>
      {why === undefined ? (
        <button type="submit">Start a dry run</button>
      ) : (
        <p className="empty">{why}</p>
      )}
    </form>
  );
}

function CredentialForm({
  connection,
  runnable,
  promoted,
  sealingReady,
  replacing,
}: {
  connection: PortalConnectionRecord;
  runnable: readonly PortalRecipeVersionRecord[];
  promoted: PortalRecipeVersionRecord | undefined;
  sealingReady: boolean;
  replacing: boolean;
}) {
  const id = connection.connectionId;
  const heading = replacing ? 'Enter the credential again' : 'Enter the credential';
  if (!sealingReady) {
    return (
      <div aria-label={heading}>
        <h3 style={{ margin: '18px 0 6px', fontSize: 14 }}>{heading}</h3>
        <p className="empty">
          This deployment cannot seal a credential, so none can be entered here and nothing is
          stored.
        </p>
      </div>
    );
  }
  if (runnable.length === 0) {
    return (
      <div aria-label={heading}>
        <h3 style={{ margin: '18px 0 6px', fontSize: 14 }}>{heading}</h3>
        <p className="empty">
          Upload a recipe version first: a credential is sealed to where a version signs in.
        </p>
      </div>
    );
  }
  return (
    <form action="/settings/portals/credential" method="post" autoComplete="off" aria-label={heading}>
      <h3 style={{ margin: '18px 0 6px', fontSize: 14 }}>{heading}</h3>
      <p className="empty" style={{ padding: '0 0 6px' }}>
        The portal&rsquo;s dedicated user, never a person&rsquo;s own sign-in. It is sealed in this
        request with a key this app may seal with and never open: only the portal worker opens it,
        and types it only where the chosen version signs in. It is never shown again.
        {replacing ? ' Entering it again replaces the one stored; it does not turn the connection on.' : ''}
      </p>
      <input type="hidden" name="connectionId" value={id} />
      <label htmlFor={`credential-version-${id}`}>Seal it for</label>
      <select
        id={`credential-version-${id}`}
        name="recipeVersionId"
        defaultValue={runnable[0]?.recipeVersionId}
      >
        {runnable.map((version) => (
          <option key={version.recipeVersionId} value={version.recipeVersionId}>
            {versionOption(version, promoted)}
          </option>
        ))}
      </select>
      <label htmlFor={`credential-username-${id}`}>Username</label>
      <input
        id={`credential-username-${id}`}
        type="text"
        name="username"
        required
        minLength={PORTAL_LIMITS.usernameMin}
        maxLength={PORTAL_LIMITS.usernameMax}
        autoComplete="off"
        spellCheck={false}
      />
      <label htmlFor={`credential-password-${id}`}>Password</label>
      <input
        id={`credential-password-${id}`}
        type="password"
        name="password"
        required
        maxLength={PORTAL_LIMITS.passwordMax}
        autoComplete="new-password"
        style={SECRET_INPUT_STYLE}
      />
      <label htmlFor={`credential-key-${id}`}>Authenticator setup key (if the portal asks for a code)</label>
      <input
        id={`credential-key-${id}`}
        type="password"
        name="totpSecret"
        autoComplete="off"
        style={SECRET_INPUT_STYLE}
      />
      <label htmlFor={`credential-label-${id}`}>Label (optional, shown here; never the username)</label>
      <input
        id={`credential-label-${id}`}
        type="text"
        name="label"
        maxLength={PORTAL_LIMITS.labelMax}
        autoComplete="off"
      />
      <button type="submit" className="primary" style={{ marginTop: 12 }}>
        Seal and store
      </button>
    </form>
  );
}

function RunRow({
  run,
  now,
  maxRunMs,
  versionNumber,
}: {
  run: PortalRunRecord;
  now: Date;
  /** Its recipe's cap, which bounds how long it can still be running; unknown is the worker's ceiling. */
  maxRunMs: number | undefined;
  versionNumber: number | undefined;
}) {
  const words = runWords(run, now, maxRunMs);
  const end = run.end;
  return (
    <li>
      <p>
        <strong>{words.headline}</strong> · {run.dryRun ? 'dry run' : 'read'}
        {versionNumber === undefined ? '' : ` of version ${versionNumber}`} · started{' '}
        {utcMinute(run.startedAt)} UTC
        {end === null ? '' : `, ended ${utcMinute(end.finishedAt)} UTC`}
        {end !== null && end.atStep !== null && end.outcome !== 'completed'
          ? ` · stopped at ${end.atStep}`
          : ''}
      </p>
      <p className="empty" style={{ padding: 0 }}>
        {words.sentence}
      </p>
      {end === null ? null : (
        <p className="empty" style={{ padding: 0 }}>
          {end.counts.pages} page{end.counts.pages === 1 ? '' : 's'} loaded ·{' '}
          {end.counts.refusals} request{end.counts.refusals === 1 ? '' : 's'} refused by the guard
        </p>
      )}
      {end === null || end.stepLog.length === 0 ? null : (
        <ol className="steps">
          {end.stepLog.map((line) => (
            <li key={line.step}>
              <span className="mono">{line.step}</span>: {line.passed ? 'passed' : 'did not pass'}
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}

function reviewWords(
  version: PortalRecipeVersionRecord,
  members: ReadonlyMap<string, PortalMember>,
): string {
  const review = version.review;
  if (review === null) return 'not reviewed';
  const by = members.get(review.reviewer)?.email ?? 'a former member';
  return `${review.verdict} by ${by} on ${review.createdAt.toISOString().slice(0, 10)}`;
}

function VersionsCard({
  group,
  members,
  mayManage,
}: {
  group: PortalGroup;
  members: ReadonlyMap<string, PortalMember>;
  mayManage: boolean;
}) {
  const inEffect = group.connections[0]?.promoted?.recipeVersionId;
  return (
    <section className="card connection" aria-label={`Recipe versions for ${group.portalKey}`}>
      <h2>
        Recipe versions · <span className="mono">{group.portalKey}</span>
      </h2>
      <p className="empty">
        A recipe is how a run reads this portal: data, versioned and never edited. A version runs
        on its own only once an owner has read it and promoted it; before that, only a dry run
        runs it.
      </p>
      {group.versions.length === 0 ? (
        <p className="empty">No version yet.</p>
      ) : (
        <table className="cases">
          <thead>
            <tr>
              <th>Version</th>
              <th>Effective from</th>
              <th>Drafted by</th>
              <th>Review</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {group.versions.map((version) => (
              <tr key={version.recipeVersionId}>
                <td>
                  {version.version}
                  {version.recipeVersionId === inEffect ? ' · in effect' : ''}
                </td>
                <td>{version.effectiveFrom}</td>
                <td>
                  {version.agentSessionId === null
                    ? (members.get(version.createdBy)?.email ?? 'a former member')
                    : 'an agent session'}
                </td>
                <td>{reviewWords(version, members)}</td>
                <td>
                  <Link href={portalVersionPath(version.recipeVersionId)}>
                    {version.review === null && mayManage ? 'Review' : 'Read'}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {mayManage ? (
        <form
          action="/settings/portals/recipe"
          method="post"
          encType="multipart/form-data"
          aria-label={`Upload a recipe version for ${group.portalKey}`}
        >
          <input type="hidden" name="portalKey" value={group.portalKey} />
          <label htmlFor={`recipe-${group.portalKey}`}>Upload a version (JSON)</label>
          <input
            id={`recipe-${group.portalKey}`}
            type="file"
            name="recipe"
            accept=".json,application/json"
            required
          />
          <p className="empty" style={{ padding: '6px 0 8px' }}>
            Up to {RECIPE_MAX_BYTES / 1024} KB. It is checked, stored as a new version and opened
            for review; nothing runs it yet.
          </p>
          <button type="submit">Upload</button>
        </form>
      ) : null}
    </section>
  );
}

function AddConnection() {
  return (
    <section className="card connection" aria-label="Add a portal connection">
      <h2>Add a portal connection</h2>
      <p className="empty">
        One account on one portal. Everything but the label is fixed once added: a different
        account or parameters is a new connection. Every run acts as you, so the connection stops
        running if you stop being an owner here.
      </p>
      <form action="/settings/portals/connect" method="post" autoComplete="off">
        <label htmlFor="portal-key">Portal key</label>
        <input
          id="portal-key"
          type="text"
          name="portalKey"
          required
          maxLength={63}
          placeholder="sap_business_network"
          spellCheck={false}
        />
        <label htmlFor="portal-label">Label</label>
        <input id="portal-label" type="text" name="label" required maxLength={PORTAL_LIMITS.labelMax} />
        <label htmlFor="portal-account">Account id (the portal account&rsquo;s public id, never the username)</label>
        <input
          id="portal-account"
          type="text"
          name="accountId"
          required
          maxLength={PORTAL_LIMITS.accountIdMax}
          spellCheck={false}
        />
        <label htmlFor="portal-params">Run parameters (optional, one name=value per line)</label>
        <textarea id="portal-params" name="params" rows={3} spellCheck={false} />
        <button type="submit" className="primary" style={{ marginTop: 12 }}>
          Add the connection
        </button>
      </form>
    </section>
  );
}

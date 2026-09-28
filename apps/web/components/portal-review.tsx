import Link from 'next/link';
import type {
  PortalBinding,
  PortalRecipeAddition,
  PortalRecipeVersionRecord,
  RecipeStep,
} from '@recouple/portal';
import { COMPARED_WITH_NONE, PORTAL_SETTINGS_PATH, resolvePortalNotice } from '../lib/portals';
import { WorkspaceShell } from './workspace-shell';
import type { Viewer } from './case-list';
import type { PortalMember } from './portal-settings';

/**
 * One recipe version, as an owner reads it before promoting it (ADR 0057 §3).
 *
 * The review screen shows, for each step, the control text and the form
 * action it was drafted against, and everything a credential is bound to:
 * the sign-in origin and paths, and the hosts. What the version adds beyond
 * the promoted version in effect — a host, a POST-as-read entry, a
 * floor-listed dismiss — is listed as the review row will name it, and an
 * agent session's draft that adds any is never offered for promotion.
 *
 * Everything here is data an owner uploaded, never text off a portal page,
 * and React escapes all of it. A pure function of what the page read.
 */

export type PortalVersionReviewProps =
  | { readonly kind: 'hidden'; readonly viewer: Viewer }
  | {
      readonly kind: 'details';
      readonly viewer: Viewer;
      /** An owner, who may promote or reject a version with no review yet. */
      readonly mayManage: boolean;
      readonly version: PortalRecipeVersionRecord;
      /** What a review now would name, for a version with no review yet. */
      readonly preview:
        | {
            readonly comparedWithVersionId: string | null;
            readonly additions: readonly PortalRecipeAddition[];
          }
        | undefined;
      /** The promoted version its additions were, or would be, counted against. */
      readonly comparedWith: PortalRecipeVersionRecord | undefined;
      /** Where a credential sealed for this version may be typed; undefined when it cannot be bound. */
      readonly binding: PortalBinding | undefined;
      /** The fixed never-click floor, which a recipe may add to and never remove from. */
      readonly floor: readonly string[];
      readonly members: readonly PortalMember[];
      readonly notice?: string | undefined;
      readonly about?: readonly string[];
    };

export function PortalVersionReviewPage(props: PortalVersionReviewProps) {
  return (
    <WorkspaceShell viewer={props.viewer} section="portals">
      <main id="workspace-main" className="workspace-main">
        <p>
          <Link className="back-link" href={PORTAL_SETTINGS_PATH}>
            ← Portals
          </Link>
        </p>
        {props.kind === 'hidden' ? (
          <section className="card connection" aria-label="Recipe version">
            <h2>Recipe version</h2>
            <p className="empty">Recipe versions are shown to members who can add documents.</p>
          </section>
        ) : (
          <Review {...props} />
        )}
      </main>
    </WorkspaceShell>
  );
}

function Review(props: Extract<PortalVersionReviewProps, { kind: 'details' }>) {
  const { version, preview, comparedWith, binding } = props;
  const recipe = version.recipe;
  const said = resolvePortalNotice(props.notice, props.about ?? []);
  const members = new Map(props.members.map((member) => [member.userId, member]));
  const additions = version.review?.additions ?? preview?.additions ?? [];
  const addedHosts = new Set(
    additions.flatMap((addition) => (addition.kind === 'host' ? [addition.host] : [])),
  );
  const byAgent = version.agentSessionId !== null;
  const unreachable = recipe.hostAllowlist.filter((host) =>
    host.toLowerCase().split(':')[0]?.endsWith('.invalid'),
  );

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">SETTINGS · PORTALS</p>
          <h1>
            Recipe version {version.version} · <span className="mono">{version.portalKey}</span>
          </h1>
          <p className="page-description">
            Effective from {version.effectiveFrom}. Added by{' '}
            {members.get(version.createdBy)?.email ?? 'a former member'} on{' '}
            {version.createdAt.toISOString().slice(0, 10)}. A version is never edited: a changed
            portal is a new version.
          </p>
        </div>
      </div>

      {said === undefined ? null : (
        <p className={said.tone === 'good' ? 'notice sent' : 'notice bad'} role="status">
          {said.text}
        </p>
      )}

      {unreachable.length === 0 ? null : (
        <p className="notice bad" role="status">
          {unreachable.join(', ')} end{unreachable.length === 1 ? 's' : ''} in .invalid, a name
          reserved never to resolve: this version cannot reach the portal. It is a draft someone
          has yet to fill in.
        </p>
      )}

      <section className="card connection" aria-label="Review">
        <h2>Review</h2>
        {version.review === null ? (
          <p className="empty">
            Not reviewed. Nothing runs this version on its own until an owner promotes it; an
            owner may dry-run it first.
          </p>
        ) : (
          <p className="empty">
            {version.review.verdict === 'promoted' ? 'Promoted' : 'Rejected'} by{' '}
            {members.get(version.review.reviewer)?.email ?? 'a former member'} on{' '}
            {version.review.createdAt.toISOString().slice(0, 10)}. A review is final.
          </p>
        )}
        <Additions additions={additions} comparedWith={comparedWith} reviewed={version.review !== null} />
        {version.review === null && props.mayManage && preview !== undefined ? (
          <form action="/settings/portals/review" method="post" aria-label="Promote or reject">
            <input type="hidden" name="recipeVersionId" value={version.recipeVersionId} />
            <input
              type="hidden"
              name="comparedWith"
              value={preview.comparedWithVersionId ?? COMPARED_WITH_NONE}
            />
            <p className="empty" style={{ padding: '8px 0' }}>
              Promote it once every step, host and path below is what the walk-through recorded.
              {byAgent && additions.length > 0
                ? ' An agent session drafted it and it adds entries above, so it can only be rejected.'
                : ''}
            </p>
            <div className="connection-actions">
              {byAgent && additions.length > 0 ? null : (
                <button type="submit" className="primary" name="verdict" value="promoted">
                  Promote version {version.version}
                </button>
              )}
              <button type="submit" name="verdict" value="rejected">
                Reject it
              </button>
            </div>
          </form>
        ) : null}
      </section>

      <section className="card connection" aria-label="Provenance">
        <h2>Who drafted it, and from what</h2>
        <dl className="connection">
          <div>
            <dt>Drafted by</dt>
            <dd>
              {recipe.provenance.draftedBy.kind === 'person'
                ? `a person: ${recipe.provenance.draftedBy.id}`
                : `an agent session: ${recipe.provenance.draftedBy.id}`}
            </dd>
          </div>
          <div>
            <dt>From</dt>
            <dd>{recipe.provenance.source}</dd>
          </div>
          <div>
            <dt>Runs under</dt>
            <dd>ADR {recipe.provenance.portalAdr}</dd>
          </div>
        </dl>
      </section>

      <section className="card connection" aria-label="Where it signs in">
        <h2>Where a credential is typed</h2>
        <p className="empty">
          A credential is sealed to these. It opens for another version only if all three are the
          same there.
        </p>
        <dl className="connection">
          <div>
            <dt>Sign-in origin</dt>
            <dd className="mono">{binding?.signInOrigin ?? recipe.signIn.origin}</dd>
          </div>
          <div>
            <dt>Sign-in form paths</dt>
            <dd className="mono">{recipe.signIn.formPaths.join(' · ')}</dd>
          </div>
          <div>
            <dt>Code form paths</dt>
            <dd className="mono">
              {recipe.signIn.mfaPaths.length === 0 ? 'none' : recipe.signIn.mfaPaths.join(' · ')}
            </dd>
          </div>
          <div>
            <dt>Sign-in return paths</dt>
            <dd className="mono">
              {recipe.signIn.acsPaths.length === 0 ? 'none' : recipe.signIn.acsPaths.join(' · ')}
            </dd>
          </div>
          <div>
            <dt>Hosts fingerprint</dt>
            <dd className="mono">{binding?.hostsHash ?? 'cannot be bound'}</dd>
          </div>
        </dl>
      </section>

      <section className="card connection" aria-label="Hosts, controls and caps">
        <h2>Hosts, controls and caps</h2>
        <dl className="connection">
          <div>
            <dt>Hosts it may visit</dt>
            <dd className="mono">
              {recipe.hostAllowlist
                .map((host) => (addedHosts.has(host.toLowerCase()) ? `${host} (added)` : host))
                .join(' · ')}
            </dd>
          </div>
          <div>
            <dt>Never clicks</dt>
            <dd>
              {recipe.neverClick.length === 0 ? 'nothing beyond the floor' : recipe.neverClick.join(' · ')}
              {`, and the fixed floor of ${props.floor.length} words: ${props.floor.join(', ')}`}
            </dd>
          </div>
          <div>
            <dt>POSTs read as reads</dt>
            <dd className="mono">
              {recipe.postAsRead.length === 0
                ? 'none'
                : recipe.postAsRead
                    .map(
                      (entry) =>
                        `${entry.step}: ${entry.path}` +
                        (entry.bodyDiscriminator === undefined
                          ? ''
                          : ` when ${entry.bodyDiscriminator.field} = ${entry.bodyDiscriminator.equals}`),
                    )
                    .join(' · ')}
            </dd>
          </div>
          <div>
            <dt>Caps</dt>
            <dd>
              {recipe.caps.maxPages} page{recipe.caps.maxPages === 1 ? '' : 's'},{' '}
              {recipe.caps.maxDownloads} download{recipe.caps.maxDownloads === 1 ? '' : 's'},{' '}
              {runTime(recipe.caps.maxRunMs)}
            </dd>
          </div>
        </dl>
      </section>

      <section className="card connection" aria-label="Steps">
        <h2>Steps</h2>
        <p className="empty">
          In order, with the control text and form action each was drafted against. A run does
          these and nothing else, and stops at the first that does not hold.
        </p>
        <table className="cases">
          <thead>
            <tr>
              <th>#</th>
              <th>Step</th>
              <th>What it does</th>
            </tr>
          </thead>
          <tbody>
            {flatten(recipe.steps).map(({ step, depth, number }) => (
              <tr key={number}>
                <td>{number}</td>
                <td className="mono">
                  {depth > 0 ? '↳ '.repeat(depth) : ''}
                  {'name' in step ? step.name : step.kind}
                </td>
                <td>{stepWords(step)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

function Additions({
  additions,
  comparedWith,
  reviewed,
}: {
  additions: readonly PortalRecipeAddition[];
  comparedWith: PortalRecipeVersionRecord | undefined;
  reviewed: boolean;
}) {
  const against =
    comparedWith === undefined
      ? 'no promoted version: it is this portal’s first, so everything counts'
      : `version ${comparedWith.version}, the promoted version in effect ${reviewed ? 'when it was reviewed' : 'now'}`;
  return (
    <>
      <p className="empty">
        What it adds beyond {against}:{' '}
        {additions.length === 0 ? 'nothing.' : `${additions.length} entr${additions.length === 1 ? 'y' : 'ies'}.`}
      </p>
      {additions.length === 0 ? null : (
        <ul className="filed-nothing-parts">
          {additions.map((addition, index) => (
            <li key={index}>{additionWords(addition)}</li>
          ))}
        </ul>
      )}
    </>
  );
}

function additionWords(addition: PortalRecipeAddition): string {
  switch (addition.kind) {
    case 'host':
      return `a host: ${addition.host}`;
    case 'post_as_read':
      return (
        `a POST read as a read, at step ${addition.step}: ${addition.path}` +
        (addition.bodyDiscriminator === null
          ? ''
          : ` when ${addition.bodyDiscriminator.field} = ${addition.bodyDiscriminator.equals}`)
      );
    case 'dismiss':
      return `a press of “${addition.label}”, a floor-listed control, at step ${addition.step}`;
  }
}

function runTime(ms: number): string {
  if (ms % 60_000 === 0) {
    const minutes = ms / 60_000;
    return `${minutes} minute${minutes === 1 ? '' : 's'} a run`;
  }
  const seconds = Math.ceil(ms / 1000);
  return `${seconds} second${seconds === 1 ? '' : 's'} a run`;
}

/** The steps in order, those inside `for_each` after it and indented, numbered as written. */
function flatten(
  steps: readonly RecipeStep[],
  depth = 0,
  counter: { next: number } = { next: 1 },
): { readonly step: RecipeStep; readonly depth: number; readonly number: number }[] {
  return steps.flatMap((step) => {
    const row = { step, depth, number: counter.next };
    counter.next += 1;
    return step.kind === 'for_each' ? [row, ...flatten(step.steps, depth + 1, counter)] : [row];
  });
}

/** What a step does, with what it was drafted against. */
export function stepWords(step: RecipeStep): string {
  switch (step.kind) {
    case 'open':
      return `opens ${step.url}`;
    case 'sign_in':
      return 'types the sealed username and password into the bound sign-in form, and submits it';
    case 'answer_mfa':
      return 'types a code made from the sealed setup key into the bound code form, and submits it';
    case 'sign_out':
      return 'signs out';
    case 'dismiss':
      return (
        `presses “${step.label}” at ${step.selector}, only while its container reads exactly ` +
        `“${step.containerText}”`
      );
    case 'follow':
      return `follows the link or tab “${step.label}”`;
    case 'search':
      return (
        `fills ${Object.entries(step.fields)
          .map(([selector, parameter]) => `${selector} with the parameter ${parameter}`)
          .join(', ')} in ${step.formSelector}, and submits it only as ${step.recordedMethod.toUpperCase()} ` +
        `to ${step.recordedAction}`
      );
    case 'wait_for':
      return `waits for ${step.selector}`;
    case 'expect':
      return (
        'expects ' +
        [
          step.selector === undefined ? undefined : `${step.selector}`,
          step.text === undefined ? undefined : `the text “${step.text}”`,
        ]
          .filter((part) => part !== undefined)
          .join(' holding ') +
        '; the run stops if it is not there'
      );
    case 'capture_page':
      return 'snapshots the page as a document (a dry run keeps nothing)';
    case 'download':
      return `presses the export “${step.label}” and keeps the file (a dry run keeps nothing)`;
    case 'for_each':
      return `repeats the steps below for each of at most ${step.maxRows} rows ${step.rowSelector}`;
    case 'next_page':
      return `follows “${step.label}” to the next page, at most ${step.maxPages} pages`;
  }
}

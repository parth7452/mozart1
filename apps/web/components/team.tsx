import type { MembershipRole, TeamMember } from '@recouple/store-postgres';
import { MEMBERSHIP_ROLES } from '@recouple/store-postgres';
import { resolveNotice } from '../lib/notices';
import { ROLE_WORDS, welcomeMessage } from '../lib/team-words';
import { WorkspaceShell } from './workspace-shell';
import type { Viewer } from './case-list';

/**
 * Settings → Team, as a person sees it (ADR 0051).
 *
 * A pure function of the member list the store returned. Everyone in the
 * workspace sees who is in it; only an owner sees the three controls, and the
 * database refuses the same three to anyone else whatever this renders.
 */

const ROLE_LABEL: Readonly<Record<MembershipRole, string>> = {
  owner: 'Owner',
  approver: 'Approver',
  analyst: 'Analyst',
  read_only: 'Read only',
  accountant_guest: 'Accountant (guest)',
};

function RoleOptions() {
  return (
    <>
      {MEMBERSHIP_ROLES.map((role) => (
        <option key={role} value={role}>
          {ROLE_LABEL[role]}
        </option>
      ))}
    </>
  );
}

function who(member: TeamMember): string {
  return member.fullName === undefined ? member.email : `${member.fullName} · ${member.email}`;
}

export function TeamPage({
  viewer,
  viewerUserId,
  members,
  mayManage,
  notice,
  invited,
  confirmRemove,
}: {
  viewer: Viewer;
  viewerUserId: string;
  members: readonly TeamMember[];
  /** An owner: may invite, change a role and remove. */
  mayManage: boolean;
  /** A notice key, never a sentence (`lib/notices.ts`). */
  notice?: string | undefined;
  /** The member just invited, for the welcome message. */
  invited?: string | undefined;
  /** The member whose removal awaits a second press. */
  confirmRemove?: string | undefined;
}) {
  const said = resolveNotice(notice);
  const welcomeFor = mayManage ? members.find((member) => member.userId === invited) : undefined;
  const removing = mayManage ? members.find((member) => member.userId === confirmRemove) : undefined;
  const writers = members.filter((member) =>
    (['owner', 'approver', 'analyst'] as readonly string[]).includes(member.role),
  );
  const approvers = members.filter((member) => member.role === 'owner' || member.role === 'approver');

  return (
    <WorkspaceShell viewer={viewer} section="team">
      <main id="workspace-main" className="workspace-main">
        <div className="page-heading">
          <div>
            <p className="eyebrow">SETTINGS</p>
            <h1>Team</h1>
            <p className="page-description">
              Who is in this workspace and what each person may do. Disputes need two people: whoever
              prepares a decision can never approve it, so a workspace needs an owner or approver
              besides the analyst who prepares.
            </p>
          </div>
        </div>

        {said === undefined ? null : (
          <p className={said.tone === 'good' ? 'notice sent' : 'notice bad'}>{said.text}</p>
        )}

        {writers.length < 2 || approvers.length === 0 ? (
          <p className="notice bad">
            {approvers.length === 0
              ? 'Nobody here can approve. Add an owner or approver before a case can be filed.'
              : 'Only one person here can write, so nothing they prepare can be approved. Add a second.'}
          </p>
        ) : null}

        {welcomeFor === undefined ? null : (
          <section className="card team" aria-label="Welcome message">
            <h2>Welcome message for {welcomeFor.fullName ?? welcomeFor.email}</h2>
            <p className="empty">
              {welcomeFor.hasSignedIn
                ? 'They can now sign in at app.mozart.financial with this address. Copy this and send it from your own email.'
                : 'Mozart sends their sign-in invitation; until it does, the sign-in form sends them nothing. Send this after it has gone.'}
            </p>
            <label htmlFor="welcome-message">Copy and send</label>
            <textarea
              id="welcome-message"
              className="welcome"
              readOnly
              value={welcomeMessage({
                workspace: viewer.orgName,
                fullName: welcomeFor.fullName,
                email: welcomeFor.email,
                role: welcomeFor.role,
                hasSignedIn: welcomeFor.hasSignedIn,
              })}
            />
          </section>
        )}

        {removing === undefined ? null : (
          <section className="card team" aria-label="Confirm removing a member">
            <h2>Remove {who(removing)}?</h2>
            <p className="empty">
              {removing.userId === viewerUserId
                ? 'This is you. You will be signed out of this workspace at once. '
                : 'Their next request is refused and they are signed out of this workspace. '}
              Nothing they did is deleted: their decisions, approvals and uploads stay on the record.
              You can add them again later.
            </p>
            <form action="/settings/team/remove" method="post">
              <input type="hidden" name="userId" value={removing.userId} />
              <input type="hidden" name="confirmed" value="yes" />
              <button type="submit">Remove them</button>
            </form>
          </section>
        )}

        <section className="card team" aria-label="Members">
          <h2>Members</h2>
          <ul className="team-members">
            {members.map((member) => (
              <li key={member.userId}>
                <p>
                  <strong>{member.fullName ?? member.email}</strong>
                  {member.userId === viewerUserId ? ' (you)' : ''}
                </p>
                <p className="empty">
                  {member.fullName === undefined ? null : <>{member.email} · </>}
                  {ROLE_LABEL[member.role]}: {ROLE_WORDS[member.role].does} ·{' '}
                  {member.hasSignedIn ? 'has signed in' : 'has not signed in yet'}
                  {member.holdsLedger ? ' · QuickBooks runs as them' : ''}
                  {member.holdsEmail ? ' · an email address acts as them' : ''}
                </p>
                {mayManage ? (
                  <div>
                    <form action="/settings/team/role" method="post">
                      <input type="hidden" name="userId" value={member.userId} />
                      <label className="sr-only" htmlFor={`role-${member.userId}`}>
                        Role for {member.email}
                      </label>
                      <select id={`role-${member.userId}`} name="role" defaultValue={member.role}>
                        <RoleOptions />
                      </select>
                      <button type="submit">Change role</button>
                    </form>
                    <form action="/settings/team/remove" method="post">
                      <input type="hidden" name="userId" value={member.userId} />
                      <button type="submit">Remove…</button>
                    </form>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </section>

        {mayManage ? (
          <section className="card team" aria-label="Add a person">
            <h2>Add a person</h2>
            <form action="/settings/team/invite" method="post">
              <label htmlFor="team-email">Work email</label>
              <input id="team-email" type="email" name="email" required maxLength={254} autoComplete="off" />
              <label htmlFor="team-name">Full name</label>
              <input id="team-name" type="text" name="fullName" maxLength={200} autoComplete="off" />
              <label htmlFor="team-role">Role</label>
              <select id="team-role" name="role" defaultValue="analyst">
                <RoleOptions />
              </select>
              <button type="submit" className="primary">
                Add to this workspace
              </button>
            </form>
            <p className="empty">
              Someone who already signs in to Mozart can sign in here at once. Anyone else gets a
              sign-in invitation from Mozart first; the page shows a welcome message to send them
              either way.
            </p>
          </section>
        ) : (
          <p className="empty">Only an owner can add, re-role or remove people.</p>
        )}
      </main>
    </WorkspaceShell>
  );
}

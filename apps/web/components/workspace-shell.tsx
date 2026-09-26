import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Viewer, WorkspaceOption } from './case-list';

export function Wordmark() {
  return (
    <span className="wordmark">
      mozart<span>.</span>
    </span>
  );
}

/** Which part of the workspace a page belongs to, for the nav and the breadcrumb. */
export type WorkspaceSection = 'deductions' | 'coverage' | 'quickbooks' | 'email' | 'team';

/**
 * The other workspaces this person belongs to, as buttons that POST to
 * `/workspace`, with the current one marked and not offered.
 *
 * Shown only to someone in more than one: for everybody else it would be a
 * control with nothing to do. What it offers is what the database answered
 * (`viewerOf`); the route checks the choice against that answer again, and
 * `requireSession` checks the cookie on every request after, so what this
 * renders is a convenience, never the guard.
 */
export function WorkspaceSwitcher({
  current,
  workspaces,
}: {
  current: string | undefined;
  workspaces: readonly WorkspaceOption[];
}) {
  if (workspaces.length < 2) return null;
  const names = workspaces.map((workspace) => workspace.name);
  // Two workspaces with one name are told apart by their slug, not by guessing.
  const label = (workspace: WorkspaceOption) =>
    names.filter((name) => name === workspace.name).length > 1
      ? `${workspace.name} (${workspace.slug})`
      : workspace.name;
  return (
    <form className="workspace-switcher" method="post" action="/workspace">
      <span className="nav-label" id="workspace-switcher-label">
        SWITCH WORKSPACE
      </span>
      <ul aria-labelledby="workspace-switcher-label">
        {workspaces.map((workspace) => (
          <li key={workspace.orgId}>
            {workspace.orgId === current ? (
              <span className="workspace-current" aria-current="true">
                {label(workspace)} <span className="workspace-current-mark">current</span>
              </span>
            ) : (
              <button type="submit" name="org_id" value={workspace.orgId}>
                {label(workspace)}
              </button>
            )}
          </li>
        ))}
      </ul>
    </form>
  );
}

/** Shared presentation only. Session resolution stays in the route. */
export function WorkspaceShell({
  viewer,
  detail = false,
  section = 'deductions',
  children,
}: {
  viewer: Viewer;
  detail?: boolean;
  section?: WorkspaceSection;
  children: ReactNode;
}) {
  return (
    <div className="workspace">
      <a className="skip-link" href="#workspace-main">
        Skip to content
      </a>
      <aside className="sidebar">
        <Link className="brand-link" href="/" aria-label="Mozart deductions">
          <Wordmark />
        </Link>
        <div className="workspace-label">YOUR WORKSPACE</div>
        <div className="organization">
          <span className="org-avatar" aria-hidden="true">
            {viewer.orgName.slice(0, 1).toUpperCase()}
          </span>
          <span>{viewer.orgName}</span>
        </div>
        <WorkspaceSwitcher current={viewer.orgId} workspaces={viewer.workspaces ?? []} />
        <nav aria-label="Workspace navigation">
          <span className="nav-label">WORKSPACE</span>
          <Link
            className={section === 'deductions' ? 'nav-item active' : 'nav-item'}
            href="/"
            aria-current={section === 'deductions' && !detail ? 'page' : undefined}
          >
            <span className="nav-grid" aria-hidden="true">
              ▦
            </span>
            Deductions<span aria-hidden="true">↗</span>
          </Link>
          <Link
            className={section === 'coverage' ? 'nav-item active' : 'nav-item'}
            href="/coverage"
            aria-current={section === 'coverage' ? 'page' : undefined}
          >
            <span className="nav-grid" aria-hidden="true">
              ◔
            </span>
            Coverage<span aria-hidden="true">↗</span>
          </Link>
          <Link
            className={section === 'quickbooks' ? 'nav-item active' : 'nav-item'}
            href="/settings/quickbooks"
            aria-current={section === 'quickbooks' ? 'page' : undefined}
          >
            <span className="nav-grid" aria-hidden="true">
              ⇄
            </span>
            QuickBooks<span aria-hidden="true">↗</span>
          </Link>
          <Link
            className={section === 'email' ? 'nav-item active' : 'nav-item'}
            href="/settings/email"
            aria-current={section === 'email' ? 'page' : undefined}
          >
            <span className="nav-grid" aria-hidden="true">
              ✉
            </span>
            Email<span aria-hidden="true">↗</span>
          </Link>
          <Link
            className={section === 'team' ? 'nav-item active' : 'nav-item'}
            href="/settings/team"
            aria-current={section === 'team' ? 'page' : undefined}
          >
            <span className="nav-grid" aria-hidden="true">
              ☺
            </span>
            Team<span aria-hidden="true">↗</span>
          </Link>
        </nav>
        <div className="sidebar-bottom">
          <div className="control-note">
            <span className="control-dot" />
            Your team stays in control.
            <p>
              Evidence first.
              <br />
              Human approval, always.
            </p>
          </div>
          <a className="site-link" href="https://mozart.financial/">
            About Mozart <span aria-hidden="true">↗</span>
          </a>
          <div className="viewer">
            <span className="viewer-avatar" aria-hidden="true">
              {viewer.email.slice(0, 1).toUpperCase()}
            </span>
            <div>
              <span className="viewer-email">{viewer.email}</span>
              <span className="viewer-role">{viewer.role.replace(/_/g, ' ')}</span>
            </div>
          </div>
          <form className="sign-out" method="post" action="/logout">
            <button type="submit">Sign out</button>
          </form>
        </div>
      </aside>
      <div className="workspace-body">
        <header className="workspace-top">
          <div>
            <span className="breadcrumb">Workspace</span>
            <span className="breadcrumb-divider">/</span>
            {section === 'quickbooks' ? (
              <>
                <span>Settings</span>
                <span className="breadcrumb-divider">/</span>
                <Link href="/settings/quickbooks">QuickBooks</Link>
              </>
            ) : section === 'email' ? (
              <>
                <span>Settings</span>
                <span className="breadcrumb-divider">/</span>
                <Link href="/settings/email">Email</Link>
              </>
            ) : section === 'team' ? (
              <>
                <span>Settings</span>
                <span className="breadcrumb-divider">/</span>
                <Link href="/settings/team">Team</Link>
              </>
            ) : section === 'coverage' ? (
              <Link href="/coverage">Coverage</Link>
            ) : (
              <Link href="/">Deductions</Link>
            )}
            {detail ? (
              <>
                <span className="breadcrumb-divider">/</span>
                <span>Case review</span>
              </>
            ) : null}
          </div>
          <span className="workspace-status">
            <span className="control-dot" />
            Evidence-led recovery
          </span>
        </header>
        {children}
      </div>
    </div>
  );
}

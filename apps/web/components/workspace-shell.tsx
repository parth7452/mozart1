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
export type WorkspaceSection =
  | 'deductions'
  | 'coverage'
  | 'books'
  | 'quickbooks'
  | 'email'
  | 'portals'
  | 'team'
  | 'reason-codes'
  | 'dispute-windows';

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

/** The three pages a person works in, which stay in the sidebar. */
const PRIMARY_NAV: readonly { section: WorkspaceSection; href: string; label: string; icon: string }[] = [
  { section: 'deductions', href: '/', label: 'Deductions', icon: '▦' },
  { section: 'coverage', href: '/coverage', label: 'Coverage', icon: '◔' },
  { section: 'reason-codes', href: '/settings/reason-codes', label: 'Reason codes', icon: '⇢' },
];

/**
 * Everything else lives in the settings panel, opened from the profile menu.
 * Each is still its own route: the panel is how the page is drawn, not a
 * second copy of it, so nothing is read for a section nobody opened.
 */
export const SETTINGS_SECTIONS: readonly { section: WorkspaceSection; href: string; label: string }[] = [
  { section: 'team', href: '/settings/team', label: 'Team' },
  { section: 'quickbooks', href: '/settings/quickbooks', label: 'QuickBooks' },
  { section: 'books', href: '/books', label: 'Books' },
  { section: 'email', href: '/settings/email', label: 'Email' },
  { section: 'portals', href: '/settings/portals', label: 'Portals' },
  { section: 'dispute-windows', href: '/settings/dispute-windows', label: 'Dispute windows' },
];

function settingsSection(section: WorkspaceSection) {
  return SETTINGS_SECTIONS.find((entry) => entry.section === section);
}

/**
 * A settings page drawn as a panel over the workspace, in the new-case
 * dialog's shape: the sections on the left, the page on the right. It is open
 * because the address is a settings page, so closing it is a link home and no
 * script is needed.
 */
function SettingsPanel({ section, children }: { section: WorkspaceSection; children: ReactNode }) {
  return (
    <div className="modal settings-panel" role="dialog" aria-modal="true" aria-label="Settings">
      <Link href="/" className="modal-backdrop" aria-label="Close settings" tabIndex={-1}></Link>
      <div className="modal-panel">
        <nav className="modal-nav settings-nav" aria-label="Settings sections">
          <p className="modal-nav-caption">Settings</p>
          <ul>
            {SETTINGS_SECTIONS.map((entry) => (
              <li key={entry.section}>
                <Link
                  href={entry.href}
                  className={entry.section === section ? 'active' : undefined}
                  aria-current={entry.section === section ? 'page' : undefined}
                >
                  {entry.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="modal-body settings-body">
          <Link href="/" className="modal-close" aria-label="Close settings">
            ×
          </Link>
          {children}
        </div>
      </div>
    </div>
  );
}

/**
 * The person signed in, as a menu: Settings and Sign out. A `<details>` so it
 * opens without script; it opens upwards, since it sits at the sidebar's foot.
 */
function ViewerMenu({ viewer, settingsOpen }: { viewer: Viewer; settingsOpen: boolean }) {
  return (
    <details className="viewer-menu">
      <summary className="viewer" aria-label={`Account: ${viewer.email}`}>
        <span className="viewer-avatar" aria-hidden="true">
          {viewer.email.slice(0, 1).toUpperCase()}
        </span>
        <div>
          <span className="viewer-email">{viewer.email}</span>
          <span className="viewer-role">{viewer.role.replace(/_/g, ' ')}</span>
        </div>
        <span className="viewer-caret" aria-hidden="true">
          ⌃
        </span>
      </summary>
      <div className="viewer-menu-items">
        <Link
          className={settingsOpen ? 'viewer-menu-item active' : 'viewer-menu-item'}
          href={SETTINGS_SECTIONS[0]!.href}
        >
          Settings
        </Link>
        <form className="sign-out" method="post" action="/logout">
          <button type="submit">Sign out</button>
        </form>
      </div>
    </details>
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
  const setting = settingsSection(section);
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
          {PRIMARY_NAV.map((item) => (
            <Link
              key={item.section}
              className={section === item.section ? 'nav-item active' : 'nav-item'}
              href={item.href}
              aria-current={section === item.section && !detail ? 'page' : undefined}
            >
              <span className="nav-grid" aria-hidden="true">
                {item.icon}
              </span>
              {item.label}
              <span aria-hidden="true">↗</span>
            </Link>
          ))}
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
          <ViewerMenu viewer={viewer} settingsOpen={setting !== undefined} />
        </div>
      </aside>
      <div className="workspace-body">
        <header className="workspace-top">
          <div>
            <span className="breadcrumb">Workspace</span>
            <span className="breadcrumb-divider">/</span>
            {setting !== undefined ? (
              <>
                <span>Settings</span>
                <span className="breadcrumb-divider">/</span>
                <Link href={setting.href}>{setting.label}</Link>
              </>
            ) : section === 'reason-codes' ? (
              <Link href="/settings/reason-codes">Reason codes</Link>
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
        {setting !== undefined ? <SettingsPanel section={section}>{children}</SettingsPanel> : children}
      </div>
    </div>
  );
}

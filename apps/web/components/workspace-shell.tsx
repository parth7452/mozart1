import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Viewer } from './case-list';

export function Wordmark() {
  return (
    <span className="wordmark">
      mozart<span>.</span>
    </span>
  );
}

/** Shared presentation only. Session resolution stays in the route. */
export function WorkspaceShell({
  viewer,
  detail = false,
  children,
}: {
  viewer: Viewer;
  detail?: boolean;
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
        <nav aria-label="Workspace navigation">
          <span className="nav-label">WORKSPACE</span>
          <Link className="nav-item active" href="/" aria-current={detail ? undefined : 'page'}>
            <span className="nav-grid" aria-hidden="true">
              ▦
            </span>
            Deductions<span aria-hidden="true">↗</span>
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
        </div>
      </aside>
      <div className="workspace-body">
        <header className="workspace-top">
          <div>
            <span className="breadcrumb">Workspace</span>
            <span className="breadcrumb-divider">/</span>
            <Link href="/">Deductions</Link>
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

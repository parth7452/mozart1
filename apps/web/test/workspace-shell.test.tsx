import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkspaceShell } from '../components/workspace-shell';
import type { Viewer } from '../components/case-list';
import { viewerOf } from '../lib/viewer';
import type { Session } from '../lib/session';

/**
 * The sidebar's two controls (pilot E4): a sign-out every member has, and a
 * workspace switcher only a member of more than one workspace sees, with the
 * one being shown marked and not offered.
 */
const ACME = { orgId: '11111111-1111-1111-1111-111111111111', slug: 'acme', name: 'Acme', role: 'owner' } as const;
const BETA = { orgId: '44444444-4444-4444-4444-444444444444', slug: 'beta', name: 'Beta', role: 'analyst' } as const;

function session(orgs: Session['orgs'], org = orgs[0]!): Session {
  return { userId: 'user-1', email: 'analyst@example.test', org, orgs };
}

/** Each workspace button the switcher renders, as its value and its label. */
function offered(html: string): Array<{ value: string; label: string }> {
  return [...html.matchAll(/<button([^>]*)>([^<]*)<\/button>/g)]
    .filter(([, attributes]) => /name="org_id"/.test(attributes!))
    .map(([, attributes, label]) => ({ value: /value="([^"]*)"/.exec(attributes!)![1]!, label: label! }));
}

/** The form that POSTs to `path`, attributes in any order. */
function formTo(path: string): RegExp {
  return new RegExp(`<form(?=[^>]*method="post")(?=[^>]*action="${path.replace('/', '\\/')}")[^>]*>`);
}

function sidebar(viewer: Viewer): string {
  return renderToStaticMarkup(
    <WorkspaceShell viewer={viewer}>
      <main />
    </WorkspaceShell>,
  );
}

describe('the sidebar', () => {
  it('always offers a sign-out that POSTs to /logout', () => {
    const html = sidebar(viewerOf(session([ACME])));
    expect(html).toMatch(formTo('/logout'));
    expect(html).toMatch(/action="\/logout"[^>]*><button type="submit">Sign out<\/button><\/form>/);
  });

  it('shows no switcher to a member of one workspace', () => {
    const html = sidebar(viewerOf(session([ACME])));
    expect(html).not.toContain('action="/workspace"');
    expect(html).not.toContain('SWITCH WORKSPACE');
  });

  it('shows no switcher when the page was rendered without the memberships', () => {
    const html = sidebar({ email: 'a@example.test', orgName: 'Acme', role: 'owner' });
    expect(html).not.toContain('action="/workspace"');
  });

  it('offers the other workspace to a member of two, with the current one marked and not a button', () => {
    const html = sidebar(viewerOf(session([ACME, BETA], BETA)));
    expect(html).toMatch(formTo('/workspace'));
    expect(offered(html)).toEqual([{ value: ACME.orgId, label: 'Acme' }]);
    expect(html).not.toContain(`value="${BETA.orgId}"`);
    expect(html).toMatch(/<span class="workspace-current" aria-current="true">Beta <span class="workspace-current-mark">current<\/span><\/span>/);
  });

  it('tells two workspaces with one name apart by their slug', () => {
    const twin = { ...BETA, name: 'Acme' };
    const html = sidebar(viewerOf(session([ACME, twin])));
    expect(offered(html)).toEqual([{ value: twin.orgId, label: 'Acme (beta)' }]);
    expect(html).toContain('Acme (acme)');
  });

  it('escapes a workspace name rather than rendering it as markup', () => {
    const odd = { ...BETA, name: '<img src=x onerror=alert(1)>' };
    const html = sidebar(viewerOf(session([ACME, odd])));
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

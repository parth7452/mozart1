import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The Supabase Auth email templates (docs/email-templates/). They live in the
 * dashboard, not in code, so nothing else reads these files: the founder pastes
 * each one into Authentication → Email Templates. What this holds is the part a
 * paste cannot fix afterwards — a template that lost its link sends an email
 * nobody can use, and one that pulls a remote image or a script is the kind of
 * content that put the default invitation in Gmail's spam folder on 2026-09-26.
 */
const DIR = fileURLToPath(new URL('../../docs/email-templates/', import.meta.url));
const TEMPLATES = ['confirm-signup.html', 'invite.html', 'magic-link.html'];
const read = (name: string) => readFileSync(DIR + name, 'utf8');

describe('the auth email templates', () => {
  it('are exactly the three the README names', () => {
    expect(readdirSync(DIR).filter((f) => f.endsWith('.html')).sort()).toEqual(TEMPLATES);
  });

  for (const name of TEMPLATES) {
    describe(name, () => {
      const html = read(name);

      it('links once, and only through the provider-built confirmation URL', () => {
        expect(html.match(/\{\{ \.ConfirmationURL \}\}/g)).toHaveLength(1);
        expect(html).toContain('href="{{ .ConfirmationURL }}"');
        // A token-hash link would need an /auth/confirm route this app does not
        // have; every email link signs in through /auth/callback (ADR 0051 §6).
        expect(html).not.toMatch(/\.TokenHash|\.Token\b|\.RedirectTo|\.SiteURL/);
      });

      it('uses only variables every Supabase email template has', () => {
        const vars = [...html.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)].map((m) => m[1]);
        for (const v of vars) expect(['.ConfirmationURL', '.Email']).toContain(v);
      });

      it('loads nothing remote and runs nothing', () => {
        expect(html).not.toMatch(/<script|<img|<link|<iframe|url\(|@import/i);
        const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
        for (const href of hrefs) {
          expect(['{{ .ConfirmationURL }}', 'https://mozart.financial']).toContain(href);
        }
      });

      it('is a whole document with a preheader and the ignore line', () => {
        expect(html.startsWith('<!doctype html>')).toBe(true);
        expect(html.trimEnd().endsWith('</html>')).toBe(true);
        expect(html).toContain('display:none');
        expect(html).toContain('If you didn’t request this email, you can safely ignore it.');
      });
    });
  }

  it('the invitation says it does not sign the person in, and names the address to type', () => {
    const html = read('invite.html');
    expect(html).toContain('you are not signed in yet');
    expect(html).toContain('{{ .Email }}');
  });

  it('the first sign-in email says it signs the person in, and the five minutes', () => {
    const html = read('confirm-signup.html');
    expect(html).toContain('signs you in');
    expect(html).toContain('within five minutes');
  });
});

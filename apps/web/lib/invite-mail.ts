import { randomUUID } from 'node:crypto';
import { AlertMailError, ONE_ADDRESS, sendThroughResend } from './alerts';
import type { NoticeKey } from './notices';
import { ROLE_WORDS, SIGN_IN_URL, firstName, welcomeEmail, type WelcomeInput } from './team-words';

/**
 * The invitation email Settings → Team sends when an owner adds someone
 * (ADR 0065): `welcomeEmail`'s words in plain text and in the branded HTML of
 * docs/email-templates/magic-link.html, sent through
 * the Resend account the failure alerts use (ADR 0052): the same send-only key,
 * from the same verified address under the name "Mozart Financial". It carries no link
 * that signs anyone in, only the address of the sign-in page, so a stolen or
 * forwarded invitation is worth nothing the page itself is not.
 *
 * Sent after the membership has committed, never instead of it: a send that
 * fails leaves the person added and says so. Logs carry ids, a class name and
 * a status — never the address, the name or the key.
 */

export type InviteMailBinding =
  | { readonly kind: 'none' }
  | { readonly kind: 'misconfigured'; readonly reason: string }
  | { readonly kind: 'configured'; readonly from: string; readonly apiKey: string };

/** Both of the alerts' sending variables, or neither. `ALERT_EMAIL_TO` is the alerts' alone. */
export function inviteMailFromEnv(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): InviteMailBinding {
  const from = (environment.ALERT_EMAIL_FROM ?? '').trim();
  const apiKey = (environment.RESEND_API_KEY ?? '').trim();
  if (from === '' && apiKey === '') return { kind: 'none' };
  if (from === '') return { kind: 'misconfigured', reason: 'ALERT_EMAIL_FROM not set, and RESEND_API_KEY is' };
  if (apiKey === '') return { kind: 'misconfigured', reason: 'RESEND_API_KEY not set, and ALERT_EMAIL_FROM is' };
  if (!ONE_ADDRESS.test(from)) {
    return { kind: 'misconfigured', reason: 'ALERT_EMAIL_FROM is not one email address' };
  }
  return { kind: 'configured', from, apiKey };
}

export interface InviteMailDeps {
  readonly binding?: InviteMailBinding;
  readonly fetch?: typeof fetch;
}

/**
 * Emails the invitation to the person just added, and answers the notice
 * the page should show: `team_invited` when it went, `team_invited_not_emailed`
 * when this deployment sends no mail, `team_invited_mail_failed` when it tried
 * and could not.
 */
export async function sendInvitation(
  welcome: WelcomeInput,
  ids: { readonly orgId: string; readonly invitedUserId: string },
  deps: InviteMailDeps = {},
): Promise<NoticeKey> {
  const binding = deps.binding ?? inviteMailFromEnv();
  const where = `org ${ids.orgId}, user ${ids.invitedUserId}`;

  if (binding.kind === 'none') {
    console.warn(`[recouple] team invitation not emailed (${where}): this deployment sends no mail`);
    return 'team_invited_not_emailed';
  }
  if (binding.kind === 'misconfigured') {
    console.error(`[recouple] team invitation not emailed (${where}): ${binding.reason}`);
    return 'team_invited_not_emailed';
  }

  const to = welcome.email.trim();
  if (!ONE_ADDRESS.test(to)) {
    console.error(`[recouple] team invitation not emailed (${where}): the address is not one bare address`);
    return 'team_invited_mail_failed';
  }

  const { subject, text } = welcomeEmail({ ...welcome, email: to });
  const html = invitationHtml({ ...welcome, email: to });
  try {
    await sendThroughResend(
      {
        apiKey: binding.apiKey,
        from: `Mozart Financial <${binding.from}>`,
        to,
        subject,
        text,
        html,
        idempotencyKey: `team-invite:${randomUUID()}`,
        userAgent: 'recouple-team-invite/1',
      },
      deps.fetch === undefined ? {} : { fetch: deps.fetch },
    );
  } catch (error) {
    const detail =
      error instanceof AlertMailError
        ? `${error.reason}${error.httpStatus === undefined ? '' : ` ${error.httpStatus}`}`
        : error instanceof Error
          ? error.name
          : typeof error;
    console.error(`[recouple] team invitation email failed (${where}): ${detail}`);
    return 'team_invited_mail_failed';
  }
  console.info(`[recouple] team invitation emailed (${where})`);
  return 'team_invited';
}

/** Every character HTML gives a meaning to, so a name an owner typed stays text. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const ACCENT = '<span style="color:#d7f56c;">.</span>';

/**
 * The invitation's HTML half: docs/email-templates/magic-link.html's layout and
 * colours, with `welcomeEmail`'s words. Inline styles in tables and
 * nothing remote, because that is what mail clients render. The one link is
 * the sign-in page; it signs nobody in. Every value that came from a person —
 * the workspace's name, theirs, the address — is escaped.
 */
export function invitationHtml(input: WelcomeInput): string {
  const workspace = escapeHtml(input.workspace);
  const email = escapeHtml(input.email);
  const first = firstName(input.fullName);
  const opening = first === undefined ? "You've" : `Hi ${escapeHtml(first)}, you've`;
  const role = escapeHtml(ROLE_WORDS[input.role].name);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Join ${workspace} on Mozart</title>
  </head>
  <body style="margin:0;padding:0;background:#f3f5f5;color:#111b30;font-family:Helvetica,'Helvetica Neue',Arial,sans-serif;">
    <div style="display:none;font-size:1px;line-height:1px;color:#f3f5f5;max-height:0;max-width:0;opacity:0;overflow:hidden;">You've been added to ${workspace} on Mozart.</div>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f3f5f5;">
      <tr><td align="center" style="padding:40px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;background:#111b30;">
          <tr><td style="padding:36px 40px 28px;border-bottom:1px solid #384256;">
            <span style="font-size:32px;font-weight:700;letter-spacing:-2px;color:#fbfcfa;">mozart${ACCENT}</span>
            <span style="display:block;margin-top:5px;font-size:10px;letter-spacing:2px;color:#afb8c8;">FINANCIAL</span>
          </td></tr>
          <tr><td style="padding:44px 40px 48px;">
            <p style="margin:0 0 20px;font-size:11px;letter-spacing:1.5px;color:#d7f56c;">YOU'RE INVITED</p>
            <h1 style="margin:0 0 20px;font-size:38px;line-height:1.12;font-weight:400;letter-spacing:-1.5px;color:#fbfcfa;">Join ${workspace} on Mozart${ACCENT}</h1>
            <p style="margin:0 0 32px;font-size:16px;line-height:1.6;color:#d4d9e2;">${opening} been added as ${role}. Sign in with <span style="color:#fbfcfa;">${email}</span> and we'll email you a secure link. There's no password.</p>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#d7f56c" style="background:#d7f56c;">
              <a href="${SIGN_IN_URL}" style="display:inline-block;padding:16px 24px;color:#111b30;font-size:15px;font-weight:700;text-decoration:none;">Sign in to Mozart &nbsp;↗</a>
            </td></tr></table>
            <p style="margin:32px 0 0;font-size:13px;line-height:1.6;color:#afb8c8;">Open the link we send in the same browser. If you weren't expecting this, you can safely ignore it.</p>
          </td></tr>
          <tr><td style="padding:22px 40px;border-top:1px solid #384256;font-size:12px;color:#afb8c8;">Mozart Financial &nbsp;·&nbsp; <a href="https://mozart.financial" style="color:#d7f56c;text-decoration:none;">mozart.financial</a></td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>
`;
}

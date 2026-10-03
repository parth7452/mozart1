import { randomUUID } from 'node:crypto';
import { AlertMailError, ONE_ADDRESS, sendThroughResend } from './alerts';
import type { NoticeKey } from './notices';
import { welcomeEmail, type WelcomeInput } from './team-words';

/**
 * The invitation email Settings → Team sends when an owner adds someone
 * (ADR 0065). It is the welcome message the page already shows, sent through
 * the Resend account the failure alerts use (ADR 0052): the same send-only key,
 * from the same verified address under the name "Mozart". It carries no link
 * that signs anyone in, only the address of the sign-in page, so a stolen or
 * forwarded invitation is worth nothing the page itself is not.
 *
 * Sent after the membership has committed, never instead of it: a send that
 * fails leaves the person added and says so, and the owner still has the
 * message to copy. Logs carry ids, a class name and a status — never the
 * address, the name or the key.
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
 * Emails the welcome message to the person just added, and answers the notice
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
  try {
    await sendThroughResend(
      {
        apiKey: binding.apiKey,
        from: `Mozart <${binding.from}>`,
        to,
        subject,
        text,
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

import type { MembershipRole } from '@recouple/store-postgres';

/**
 * Settings → Team's pure half (ADR 0051): who may manage, what a role is
 * called, and the words of the invitation email (ADR 0065). No server imports, so the
 * view and the routes share one answer.
 */

/** Adding, re-roling and removing are an owner's; the database says the same. */
export function mayManageTeam(role: string): boolean {
  return role === 'owner';
}

/** What each role may do, in the words the page and the invitation use. */
export const ROLE_WORDS: Readonly<Record<MembershipRole, { readonly name: string; readonly does: string }>> = {
  owner: {
    name: 'an owner',
    does: 'everything, including approving, managing the team, QuickBooks and email addresses',
  },
  approver: { name: 'an approver', does: 'upload, decide and approve' },
  analyst: { name: 'an analyst', does: 'upload, decide and prepare packets, but not approve' },
  read_only: { name: 'a viewer', does: 'sees everything, changes nothing' },
  accountant_guest: { name: 'a viewer (outside accountant)', does: 'sees everything, changes nothing' },
};

/** The one address people sign in at. */
export const SIGN_IN_URL = 'https://app.mozart.financial/login';

export interface WelcomeInput {
  readonly workspace: string;
  readonly fullName?: string | undefined;
  readonly email: string;
  readonly role: MembershipRole;
}

/** Their first name, or undefined when none was given. */
export function firstName(fullName: string | undefined): string | undefined {
  const first = fullName?.trim().split(/\s+/)[0];
  return first === undefined || first === '' ? undefined : first;
}

/**
 * The invitation the invite route emails (ADR 0065): its subject and its
 * plain-text part (`invitationHtml` is the HTML one). Short on purpose. Somebody who has never signed in to Mozart gets their account made
 * by the sign-in form the first time they ask for a link (ADR 0051 §6); that
 * link only works in the browser that asked for it, which is the one thing
 * here worth a sentence.
 */
export function welcomeEmail(input: WelcomeInput): { readonly subject: string; readonly text: string } {
  const first = firstName(input.fullName);
  return {
    subject: `You're invited to ${input.workspace} on Mozart`,
    text: [
      first === undefined ? 'Hi,' : `Hi ${first},`,
      '',
      `You've been added to the ${input.workspace} workspace on Mozart as ` +
        `${ROLE_WORDS[input.role].name}.`,
      '',
      `Sign in at ${SIGN_IN_URL} with ${input.email}. We'll email you a secure link; ` +
        'open it in the same browser. There is no password.',
      '',
      "If you weren't expecting this, you can ignore this email.",
    ].join('\n'),
  };
}

import type { MembershipRole } from '@recouple/store-postgres';

/**
 * Settings → Team's pure half (ADR 0051): who may manage, what a role is
 * called, and the welcome message an owner copies. No server imports, so the
 * view and the routes share one answer.
 */

/** Adding, re-roling and removing are an owner's; the database says the same. */
export function mayManageTeam(role: string): boolean {
  return role === 'owner';
}

/** What each role may do, in the words the page and the welcome message use. */
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

/**
 * The welcome message, from docs/ONBOARDING.md §2's wording, the same for
 * everyone. Somebody who has never signed in to Mozart gets their account made
 * by the sign-in form the first time they ask for a link (ADR 0051 §6), and
 * that first email asks them to confirm their address; its link signs them in.
 * Its code expires five minutes after it was sent rather than after the click
 * (supabase/auth `internal/models/flow_state.go`, `IsExpired`): a late click
 * still confirms the address, and the next link — an ordinary magic link — works.
 */
export function welcomeMessage(input: {
  readonly workspace: string;
  readonly fullName?: string | undefined;
  readonly email: string;
  readonly role: MembershipRole;
}): string {
  const first = input.fullName?.trim().split(/\s+/)[0];
  const greeting = first === undefined || first === '' ? 'Hi,' : `Hi ${first},`;
  return [
    `Subject: Your ${input.workspace} workspace on Mozart`,
    '',
    greeting,
    '',
    `You have been added to ${input.workspace}'s workspace on Mozart as ` +
      `${ROLE_WORDS[input.role].name}.`,
    '',
    `To sign in, go to ${SIGN_IN_URL}, type ${input.email} under Work email and press ` +
      '"Email me a sign-in link". Open the link in that email in the same browser. If your ' +
      'email app opens it somewhere else you will see "that link has expired"; copy it into ' +
      'the browser where you asked for it instead. There is no password.',
    '',
    'The first time, the email comes from our sign-in provider and asks you to confirm your ' +
      'address. Open it within five minutes: its link signs you in. If you are too late it says ' +
      'the link has expired, and the next link you ask for will work.',
  ].join('\n');
}

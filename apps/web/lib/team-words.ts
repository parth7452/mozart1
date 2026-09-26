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
 * The welcome message, from docs/ONBOARDING.md §2's wording.
 *
 * Two versions: someone who has signed in before can sign in now; anyone else
 * first gets an invitation from Supabase, which Mozart still sends by hand
 * (ADR 0051 §6), so the message says to expect it.
 */
export function welcomeMessage(input: {
  readonly workspace: string;
  readonly fullName?: string | undefined;
  readonly email: string;
  readonly role: MembershipRole;
  readonly hasSignedIn: boolean;
}): string {
  const first = input.fullName?.trim().split(/\s+/)[0];
  const greeting = first === undefined || first === '' ? 'Hi,' : `Hi ${first},`;
  const added =
    `You have been added to ${input.workspace}'s workspace on Mozart as ` +
    `${ROLE_WORDS[input.role].name}.`;
  const signIn = input.hasSignedIn
    ? [
        `Sign in at ${SIGN_IN_URL} with ${input.email}: type it under Work email and press ` +
          '"Email me a sign-in link". Open the link in that email in the same browser. ' +
          'There is no password.',
      ]
    : [
        'Getting in takes two emails:',
        '',
        '1. An invitation from Supabase (our sign-in provider). Click its link once. It opens ' +
          'the Mozart sign-in page, and you will not be signed in yet. That is expected: the ' +
          'link only confirms your address.',
        `2. On that page, type ${input.email} under Work email and press "Email me a sign-in ` +
          'link". Open the link in that email in the same browser. If your email app opens it ' +
          'somewhere else you will see "that link has expired"; copy it into the browser where ' +
          'you asked for it instead.',
        '',
        `From then on, sign in at ${SIGN_IN_URL} the same way (step 2). There is no password.`,
      ];
  return [
    `Subject: Your ${input.workspace} workspace on Mozart`,
    '',
    greeting,
    '',
    added,
    '',
    ...signIn,
  ].join('\n');
}

import { NextResponse } from 'next/server';
import { PostgresTeamStore, TeamChangeRefusedError, type TeamRefusal } from '@recouple/store-postgres';
import { env } from './env';
import type { NoticeKey } from './notices';

export { mayManageTeam } from './team-words';

/**
 * Settings → Team's three writes (ADR 0051), and what they share.
 *
 * Each is a POST in Settings → Email's shape — `isCrossSite`, `requireSession`,
 * the role check, `memberMayWrite` asked of the database, then the store — and
 * answers with a redirect carrying a notice key, never a sentence. The database
 * is the referee: `app.invite_member`, `app.change_member_role` and
 * `app.remove_member` refuse a non-owner and every change the page would also
 * refuse, whatever this app shows or checks first.
 *
 * Logs carry ids and a class name only: never an address or a name.
 */

export const TEAM_SETTINGS_PATH = '/settings/team';

export function teamStoreFor(identity: { readonly orgId: string; readonly userId: string }) {
  return new PostgresTeamStore({ connectionString: env.databaseUrl }, identity);
}

/**
 * Back to the page with a notice, and at most one id: the person just invited
 * (for the welcome message) or the person whose removal awaits confirmation.
 */
export function teamRedirect(
  request: Request,
  notice: NoticeKey,
  person?: { readonly param: 'invited' | 'confirm'; readonly userId: string },
): NextResponse {
  const url = new URL(TEAM_SETTINGS_PATH, request.url);
  url.searchParams.set('team', notice);
  if (person !== undefined) url.searchParams.set(person.param, person.userId);
  return NextResponse.redirect(url, { status: 303 });
}

const REFUSAL_NOTICE: Readonly<Record<TeamRefusal, NoticeKey>> = {
  not_owner: 'team_role',
  invalid: 'team_invalid',
  address_ambiguous: 'team_address_ambiguous',
  already_member: 'team_already_member',
  last_owner: 'team_last_owner',
  not_member: 'team_not_member',
  holds_ledger: 'team_holds_ledger',
  holds_email: 'team_holds_email',
  too_few_writers: 'team_too_few_writers',
};

/** A named refusal's notice, or undefined for a fault. */
export function teamRefusalNotice(error: unknown): NoticeKey | undefined {
  return error instanceof TeamChangeRefusedError ? REFUSAL_NOTICE[error.refusal] : undefined;
}

export const className = (error: unknown): string =>
  error instanceof Error ? error.name || error.constructor.name : typeof error;

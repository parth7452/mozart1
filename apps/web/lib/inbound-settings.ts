import { NextResponse } from 'next/server';
import { InboundAddressRefusedError } from '@recouple/store-postgres';
import type { NoticeKey } from './notices';

export { mayManageInboundAddresses, retireAsksFirst } from './inbound-addresses';

/**
 * Settings → Email's three writes (ADR 0047 §4), and what they share.
 *
 * Each is a POST in the upload route's shape — `isCrossSite`, `requireSession`,
 * the role check, then the store — and answers with a redirect carrying a
 * notice key, never a sentence. The database is the referee: an address is
 * issued, adopted and retired only by an owner acting as themselves, whatever
 * this app shows or checks first.
 *
 * Logs carry ids and a class name only (§13): never an address or its token.
 */

export const INBOUND_SETTINGS_PATH = '/settings/email';

export function inboundSettingsRedirect(
  request: Request,
  notice: NoticeKey,
  confirm?: string,
): NextResponse {
  const url = new URL(INBOUND_SETTINGS_PATH, request.url);
  url.searchParams.set('email', notice);
  if (confirm !== undefined) url.searchParams.set('confirm', confirm);
  return NextResponse.redirect(url, { status: 303 });
}

/** A refusal's notice: the policy's is the role's, a race's is its own. */
export function refusalNotice(error: unknown, raced: NoticeKey): NoticeKey | undefined {
  if (!(error instanceof InboundAddressRefusedError)) return undefined;
  // 23505: a second retirement of one address met the unique key.
  return error.sqlState === '23505' ? raced : 'email_role';
}

export const className = (error: unknown): string =>
  error instanceof Error ? error.name || error.constructor.name : typeof error;

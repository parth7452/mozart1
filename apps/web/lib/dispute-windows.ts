import { NextResponse } from 'next/server';
import {
  DisputeWindowRefusedError,
  PostgresDisputeWindowStore,
  type DisputeWindowRefusal,
} from '@recouple/store-postgres';
import { env } from './env';
import { DISPUTE_WINDOWS_PATH, type DisputeWindowNoticeKey } from './dispute-window-words';

export { DISPUTE_WINDOWS_PATH, mayRecordWindows } from './dispute-window-words';

/**
 * Settings → Dispute windows' server half (ADR 0071): the store, as the
 * member signed in, and the redirect its one write answers with. The database
 * is the referee: the insert policy refuses anyone but an owner or approver
 * writing as themselves. Logs carry ids and a class name only.
 */
export function disputeWindowStoreFor(identity: { readonly orgId: string; readonly userId: string }) {
  return new PostgresDisputeWindowStore({ connectionString: env.databaseUrl }, identity);
}

/** Back to the page with a notice key, never a sentence. */
export function disputeWindowsRedirect(request: Request, notice: DisputeWindowNoticeKey): NextResponse {
  const url = new URL(DISPUTE_WINDOWS_PATH, request.url);
  url.searchParams.set('windows', notice);
  return NextResponse.redirect(url, { status: 303 });
}

const REFUSAL_NOTICE: Readonly<Record<DisputeWindowRefusal, DisputeWindowNoticeKey>> = {
  invalid: 'windows_invalid',
  not_permitted: 'windows_role',
  unknown_debtor: 'windows_debtor',
  already_recorded: 'windows_already',
};

/** A named refusal's notice, or undefined for a fault. */
export function disputeWindowRefusalNotice(error: unknown): DisputeWindowNoticeKey | undefined {
  if (!(error instanceof DisputeWindowRefusedError)) return undefined;
  if (error.refusal === 'invalid' && error.field === 'effectiveTo') return 'windows_dates';
  return REFUSAL_NOTICE[error.refusal];
}

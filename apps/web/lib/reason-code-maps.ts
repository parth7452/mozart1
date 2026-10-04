import { NextResponse } from 'next/server';
import {
  PayerCodeMapRefusedError,
  PostgresPayerCodeMapStore,
  type PayerCodeMapRefusal,
} from '@recouple/store-postgres';
import { env } from './env';
import { REASON_CODES_PATH, type ReasonCodeNoticeKey } from './reason-code-words';

export { mayMapPayerCodes, REASON_CODES_PATH } from './reason-code-words';

/**
 * Settings → Reason codes' server half (ADR 0066): the store, as the member
 * signed in, and the redirect its one write answers with.
 *
 * The write is a POST in Settings → Team's shape: `isCrossSite`,
 * `requireSession`, the role check, `memberMayWrite` asked of the database,
 * then the store. The database is the referee: the insert policy refuses
 * anyone but an owner or approver writing as themselves, whatever this app
 * shows or checks first. Logs carry ids and a class name only, never a code
 * off a page.
 */
export function payerCodeMapStoreFor(identity: { readonly orgId: string; readonly userId: string }) {
  return new PostgresPayerCodeMapStore({ connectionString: env.databaseUrl }, identity);
}

/** Back to the page with a notice key, never a sentence. */
export function reasonCodesRedirect(request: Request, notice: ReasonCodeNoticeKey): NextResponse {
  const url = new URL(REASON_CODES_PATH, request.url);
  url.searchParams.set('codes', notice);
  return NextResponse.redirect(url, { status: 303 });
}

const REFUSAL_NOTICE: Readonly<Record<PayerCodeMapRefusal, ReasonCodeNoticeKey>> = {
  invalid: 'codes_invalid',
  not_permitted: 'codes_role',
  unknown_debtor: 'codes_debtor',
  already_recorded: 'codes_already',
};

/** A named refusal's notice, or undefined for a fault. */
export function payerCodeMapRefusalNotice(error: unknown): ReasonCodeNoticeKey | undefined {
  if (!(error instanceof PayerCodeMapRefusedError)) return undefined;
  if (error.refusal === 'invalid' && error.field === 'effectiveTo') return 'codes_dates';
  return REFUSAL_NOTICE[error.refusal];
}

export const className = (error: unknown): string =>
  error instanceof Error ? error.name || error.constructor.name : typeof error;

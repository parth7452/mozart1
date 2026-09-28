import { NextResponse, type NextRequest } from 'next/server';
import { REASON_FAMILIES, type ReasonFamily } from '@recouple/core-domain';
import { QboError, type LedgerAccountMap } from '@recouple/qbo';
import { AccountMapTypeError, OwnerRequiredError } from '@recouple/store-postgres';
import { requireSession } from '../../../../lib/session';
import { isCrossSite, isUuid, refuseCrossSite } from '../../../../lib/request';
import { type NoticeKey } from '../../../../lib/notices';
import { mayConnectLedger, QBO_SETTINGS_PATH } from '../../../../lib/qbo-connect';
import { qboPostingFromEnv } from '../../../../lib/qbo-posting';
import { postingStoreFor } from '../../../../lib/posting';
import { PRESS_BOUNDS } from '../../../../lib/posting-setup';

/**
 * One type check of at most `PRESS_REQUEST_TIMEOUT_MS`, the bound a setup
 * press checks its map with (`PRESS_BOUNDS`), and one token refresh on its own
 * bounds (a lock connection, 30 s; the company's lock, 15 s; Intuit, 10 s):
 * 80 s at worst. Without this the platform's default (10 s on Hobby, 15 s on
 * Pro, ADR 0021) would answer a slow QuickBooks with a gateway timeout rather
 * than `posting_map_unreadable`.
 */
export const maxDuration = 120;

/** A QuickBooks account id as the form sends it: digits, nothing else. */
const ACCOUNT_ID = /^[0-9]{1,20}$/;

/**
 * Saves a connection's account map (ADR 0060 §4): which QuickBooks accounts a
 * posting debits and credits. Owner only — the database's rule as well as
 * this route's — and each account's type is read live from QuickBooks before
 * anything is written. The form's dropdowns send ids the page read from the
 * company's chart (ADR 0063 §4); this route creates no account — only a setup
 * press does. Hidden, and refused, unless this deployment posts at all
 * (`QBO_POSTING`).
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (isCrossSite(request)) return refuseCrossSite();

  const session = await requireSession();
  const settings = new URL(QBO_SETTINGS_PATH, request.url);
  const say = (notice: NoticeKey): NextResponse => {
    settings.searchParams.set('qbo', notice);
    return NextResponse.redirect(settings, { status: 303 });
  };

  const poster = qboPostingFromEnv();
  if (poster === undefined) return say('posting_off');
  if (!mayConnectLedger(session.org.role)) return say('posting_role');

  const form = await request.formData();
  const connectionId = form.get('connectionId');
  if (!isUuid(connectionId)) return say('posting_unknown_connection');

  const account = (name: string): string | undefined => {
    const value = form.get(name);
    return typeof value === 'string' && ACCOUNT_ID.test(value.trim()) ? value.trim() : undefined;
  };
  const writeoffByFamily: Partial<Record<ReasonFamily, string>> = {};
  for (const family of REASON_FAMILIES) {
    const id = account(`writeoff_${family}`);
    if (id === undefined) return say('posting_map_invalid');
    writeoffByFamily[family] = id;
  }
  const ar = account('arAccountId');
  const receivable = account('deductionsReceivableAccountId');
  const unclassified = account('unclassifiedWriteoff');
  if (ar === undefined || receivable === undefined || unclassified === undefined) {
    return say('posting_map_invalid');
  }
  const map: LedgerAccountMap = {
    arAccountId: ar,
    deductionsReceivableAccountId: receivable,
    writeoffByFamily: writeoffByFamily as Record<ReasonFamily, string>,
    unclassifiedWriteoff: unclassified,
  };

  const identity = { orgId: session.org.orgId, userId: session.userId };
  const store = postingStoreFor(session);
  const connection = (await store.postingConnections()).find((c) => c.connectionId === connectionId);
  if (connection === undefined) return say('posting_unknown_connection');
  const readTypes = poster.accountTypesFor(identity, connection, PRESS_BOUNDS);
  if (readTypes === undefined) return say('posting_off');

  try {
    await store.saveAccountMap(connectionId, map, readTypes);
    return say('posting_map_saved');
  } catch (cause) {
    if (cause instanceof AccountMapTypeError) {
      console.warn(`[recouple] account map refused: wrong type at ${cause.fields.join(', ')}, connection ${connectionId}`);
      return say('posting_map_types');
    }
    if (cause instanceof OwnerRequiredError) return say('posting_role');
    if (cause instanceof QboError) {
      console.error(
        `[recouple] account map: QuickBooks read failed (${cause.name}), connection ${connectionId} org ${identity.orgId}`,
      );
      return say('posting_map_unreadable');
    }
    throw cause;
  }
}

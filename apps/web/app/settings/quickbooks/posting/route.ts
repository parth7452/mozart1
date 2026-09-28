import { NextResponse, type NextRequest } from 'next/server';
import {
  AccountMapRequiredError,
  OwnerRequiredError,
  PostingConnectionNotFoundError,
} from '@recouple/store-postgres';
import { requireSession } from '../../../../lib/session';
import { isCrossSite, isUuid, refuseCrossSite } from '../../../../lib/request';
import { type NoticeKey } from '../../../../lib/notices';
import { mayConnectLedger, QBO_SETTINGS_PATH } from '../../../../lib/qbo-connect';
import { qboPostingFromEnv } from '../../../../lib/qbo-posting';
import { postingStoreFor } from '../../../../lib/posting';

/**
 * The owner's switch (ADR 0060 §5): posting on or off for one connection.
 *
 * Posting is turned on here, and by a setup press (`/settings/quickbooks/setup`,
 * ADR 0063), which turns it on as its last step and never turns it off. Both
 * go through `setPostingEnabled`: owner only in the database, true only while
 * a map exists, one audit row per change. This route refuses first where it
 * can say why, and is refused outright unless this deployment posts at all
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

  if (qboPostingFromEnv() === undefined) return say('posting_off');
  if (!mayConnectLedger(session.org.role)) return say('posting_role');

  const form = await request.formData();
  const connectionId = form.get('connectionId');
  const enabled = form.get('enabled');
  if (!isUuid(connectionId) || (enabled !== 'on' && enabled !== 'off')) {
    return say('posting_unknown_connection');
  }

  const store = postingStoreFor(session);
  try {
    await store.setPostingEnabled(connectionId, enabled === 'on');
    return say(enabled === 'on' ? 'posting_enabled' : 'posting_disabled');
  } catch (cause) {
    if (cause instanceof AccountMapRequiredError) return say('posting_needs_map');
    if (cause instanceof OwnerRequiredError) return say('posting_role');
    if (cause instanceof PostingConnectionNotFoundError) return say('posting_unknown_connection');
    throw cause;
  }
}

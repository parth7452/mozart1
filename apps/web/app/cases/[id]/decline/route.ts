import { NextResponse, type NextRequest } from 'next/server';
import { isDeclineReason } from '@recouple/store-postgres';
import { requireSession, storeFor } from '../../../../lib/session';
import { mayWrite } from '../../../../lib/pipeline';

/**
 * Records a decision not to fight a case.
 *
 * This is the counterfactual log, not a delete. The case stays; a
 * `declined_candidates` row says what it was worth, what was missing and who
 * decided, because coverage is a ratio of dollars and discarding the losers
 * silently is how that ratio gets flattered (docs/STRATEGY.md, ADD-1).
 *
 * The role check here is a better error message, not the enforcement — the
 * write policy is that, and it would refuse a `read_only` member's insert
 * whatever this handler believed.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const session = await requireSession();
  const back = new URL(`/cases/${id}`, request.url);

  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.redirect(new URL('/', request.url), { status: 303 });
  }
  if (!mayWrite(session.org.role)) {
    back.searchParams.set('decline', 'your role can review cases but not decide them');
    return NextResponse.redirect(back, { status: 303 });
  }

  const form = await request.formData();
  const reason = form.get('reason');
  if (!isDeclineReason(reason)) {
    // The database would refuse it too — the enum is there. Saying so here just
    // costs a round trip less.
    back.searchParams.set('decline', 'choose a reason for declining');
    return NextResponse.redirect(back, { status: 303 });
  }

  const detail = form.get('detail');
  const missing = form
    .getAll('missing')
    .filter((value): value is string => typeof value === 'string' && value !== '');

  const store = storeFor(session);
  try {
    await store.declineCase({
      deductionId: id,
      reason,
      // Who decided, by the identity the session resolved — never a form field.
      decidedBy: session.email,
      // This route is the web app, so a case it can see arrived by upload —
      // true for every case that exists today, because nothing writes the
      // `uploads` table yet. The parameter is named `assumed` so that this
      // stops being invisible the moment email-in starts opening cases.
      assumedDiscoveredFrom: 'web_upload',
      ...(missing.length > 0 ? { missingEvidence: missing } : {}),
      ...(typeof detail === 'string' && detail.trim() !== ''
        ? { detail: detail.trim().slice(0, 2000) }
        : {}),
    });
    back.searchParams.set('decline', 'recorded: this case is logged as declined, not discarded');
    return NextResponse.redirect(back, { status: 303 });
  } finally {
    await store.close();
  }
}

import { NextResponse, type NextRequest } from 'next/server';
import { PostingStoreError } from '@recouple/store-postgres';
import { requireSession } from '../../../../lib/session';
import { mayWrite } from '../../../../lib/pipeline';
import { isCrossSite, isUuid, refuseCrossSite } from '../../../../lib/request';
import { backToCase } from '../../../../lib/workflow';
import { qboPostingFromEnv } from '../../../../lib/qbo-posting';
import { postingStoreFor, queueWriteback } from '../../../../lib/posting';

/**
 * "Check QuickBooks and retry" (ADR 0060 §3). Nothing is ever resent on its
 * own: a failed posting may have landed, so a person asks, and the job reads
 * QuickBooks back by the reference stamped on the row before it sends
 * anything — with the same request id, from the same row. A `failed` row goes
 * back to `pending` first; a `pending` one (a Payment waiting on its entry, or
 * a send that never queued) is queued as it is. A succeeded row is final.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  if (isCrossSite(request)) return refuseCrossSite();

  const { id } = await params;
  const session = await requireSession();
  if (!isUuid(id)) return NextResponse.redirect(new URL('/', request.url), { status: 303 });
  const back = (notice: Parameters<typeof backToCase>[2]): NextResponse =>
    NextResponse.redirect(backToCase(request.url, id, notice), { status: 303 });

  if (qboPostingFromEnv() === undefined) return back('posting_off');
  if (!mayWrite(session.org.role)) return back('settle_role');

  const form = await request.formData();
  const writebackId = form.get('writebackId');
  if (!isUuid(writebackId)) return back('writeback_not_retryable');

  const store = postingStoreFor(session);
  const row = (await store.postingForCase(id)).writebacks.find((w) => w.writebackId === writebackId);
  if (row === undefined || row.status === 'succeeded') return back('writeback_not_retryable');

  let connectionId: string;
  try {
    if (row.status === 'failed') {
      ({ connectionId } = await store.requeueWriteback(writebackId));
    } else {
      if (row.connectionId === undefined) return back('writeback_not_retryable');
      connectionId = row.connectionId;
    }
  } catch (cause) {
    if (cause instanceof PostingStoreError) return back('writeback_not_retryable');
    throw cause;
  }
  const queued = await queueWriteback(session, { writebackId, connectionId, retry: true });
  return back(queued ? 'writeback_retried' : 'posting_not_queued');
}

import { NextResponse, type NextRequest } from 'next/server';
import { postingReference } from '@recouple/qbo';
import { PostingStoreError, SettlementVoidRefusedError } from '@recouple/store-postgres';
import { requireSession } from '../../../../lib/session';
import { isCrossSite, isUuid, refuseCrossSite } from '../../../../lib/request';
import { backToCase, mayApprove } from '../../../../lib/workflow';
import { qboPostingFromEnv } from '../../../../lib/qbo-posting';
import { postingStoreFor } from '../../../../lib/posting';

/** Raised inside the ledger check so the route can tell "unreadable" from "holds something". */
class LedgerUnreadable extends Error {}

/**
 * "Void this posting" (ADR 0069 §3): for an approved settlement whose posting
 * provably never reached QuickBooks, one append-only event that lets the case
 * be settled again. An owner or an approver — it sets an approval's effect
 * aside — whom the database still lets write.
 *
 * The store refuses unless every recorded attempt ended before the send, and
 * this route asks QuickBooks itself, by the reference stamped on each row,
 * that it holds nothing: a run that died after sending and before recording
 * would otherwise look the same as one that never sent. An unknown outcome is
 * never voided. Nothing is sent to QuickBooks here; both calls are reads.
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

  const poster = qboPostingFromEnv();
  if (poster === undefined) return back('posting_off');
  if (!mayApprove(session.org.role)) return back('posting_void_role');

  const form = await request.formData();
  const decisionId = form.get('decisionId');
  if (!isUuid(decisionId)) return back('posting_void_refused');

  const store = postingStoreFor(session);
  if (!(await store.memberMayWrite())) return back('posting_void_role');

  // The decision is this case's, and the connection is the row's own.
  const rows = (await store.postingForCase(id)).writebacks.filter((w) => w.decisionId === decisionId);
  const connectionId = rows.find((w) => w.method === 'journal_entry')?.connectionId;
  const connection =
    connectionId === undefined
      ? undefined
      : (await store.postingConnections()).find((c) => c.connectionId === connectionId);
  if (connection === undefined) return back('posting_void_refused');
  const identity = { orgId: session.org.orgId, userId: session.userId };

  try {
    await store.voidSettlementPosting({
      decisionId,
      ledgerHoldsNothing: async (asked) => {
        const client = poster.clientFor(identity, connection);
        if (client === undefined) throw new LedgerUnreadable();
        for (const row of asked) {
          let found: readonly unknown[];
          try {
            found = await client.findByReference(
              row.method === 'journal_entry' ? 'JournalEntry' : 'Payment',
              postingReference(row.writebackId),
            );
          } catch (error) {
            const name = error instanceof Error ? error.name : typeof error;
            console.error(
              `[recouple] void-posting: ledger not read (${name}), writeback ${row.writebackId} org ${identity.orgId}`,
            );
            throw new LedgerUnreadable();
          }
          if (found.length > 0) return false;
        }
        return true;
      },
    });
  } catch (cause) {
    if (cause instanceof LedgerUnreadable) return back('posting_void_unreadable');
    if (cause instanceof SettlementVoidRefusedError) {
      console.error(`[recouple] void-posting: refused ${cause.reason}, decision ${decisionId} case ${id}`);
      return back(
        cause.reason === 'maybe_sent' || cause.reason === 'posted'
          ? 'posting_void_maybe_sent'
          : cause.reason === 'in_ledger'
            ? 'posting_void_in_ledger'
            : 'posting_void_refused',
      );
    }
    if (cause instanceof PostingStoreError) return back('posting_void_refused');
    throw cause;
  }
  console.log(`[recouple] void-posting: voided, decision ${decisionId} case ${id}`);
  return back('posting_voided');
}

import { NextResponse, type NextRequest } from 'next/server';
import { REASON_FAMILIES, parseMoneyToCents, type Cents, type ReasonFamily } from '@recouple/core-domain';
import {
  PostingStoreError,
  SETTLEMENT_OUTCOMES,
  SettlementApprovalRefusedError,
  type SettlementOutcome,
} from '@recouple/store-postgres';
import { requireSession } from '../../../../lib/session';
import { mayWrite } from '../../../../lib/pipeline';
import { isCrossSite, isUuid, refuseCrossSite } from '../../../../lib/request';
import { backToCase, mayApprove } from '../../../../lib/workflow';
import { qboPostingFromEnv } from '../../../../lib/qbo-posting';
import { postingStoreFor, queueDecisionPostings } from '../../../../lib/posting';

const LEDGER_ID = /^[0-9]{1,20}$/;

function isOutcome(value: unknown): value is SettlementOutcome {
  return typeof value === 'string' && (SETTLEMENT_OUTCOMES as readonly string[]).includes(value);
}

function isFamily(value: unknown): value is ReasonFamily {
  return typeof value === 'string' && (REASON_FAMILIES as readonly string[]).includes(value);
}

/**
 * Moment 2 (ADR 0060 §2): how a case settled, in the books.
 *
 * `intent=prepare` records a person's schema `S` decision — the outcome, what
 * was recovered, the family, and the ledger invoice. `intent=approve` is a
 * second person's approval of it (never the preparer: the database's
 * separation of duties, unchanged), a `writeback` approval and a `writeoff`
 * one when the entry writes anything off, and then the rows and the queue.
 * Nothing here computes an amount the store does not check against
 * `draftEntries`.
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

  const form = await request.formData();
  const intent = form.get('intent');
  const store = postingStoreFor(session);

  if (intent === 'prepare') {
    if (!mayWrite(session.org.role)) return back('settle_role');
    const outcome = form.get('outcome');
    const family = form.get('family');
    const invoiceId = form.get('invoiceId');
    const recovered = form.get('recovered');
    if (!isOutcome(outcome) || typeof invoiceId !== 'string' || !LEDGER_ID.test(invoiceId.trim())) {
      return back('settle_invalid');
    }
    if (family !== null && family !== '' && !isFamily(family)) return back('settle_invalid');
    let recoveredCents: Cents;
    try {
      recoveredCents =
        typeof recovered === 'string' && recovered.trim() !== ''
          ? parseMoneyToCents(recovered.trim())
          : (0 as Cents);
    } catch {
      // A figure the money parser will not read is a refusal, said as one.
      return back('settle_invalid');
    }
    try {
      await store.prepareSettlementDecision({
        deductionId: id,
        preparedBy: session.userId,
        outcome,
        recoveredCents,
        family: isFamily(family) ? family : undefined,
        invoiceId: invoiceId.trim(),
      });
    } catch (cause) {
      if (cause instanceof PostingStoreError || cause instanceof RangeError) return back('settle_invalid');
      throw cause;
    }
    return back('settle_prepared');
  }

  if (intent === 'approve') {
    if (!mayApprove(session.org.role)) return back('settle_role');
    const decisionId = form.get('decisionId');
    if (!isUuid(decisionId)) return back('settle_invalid');
    const ready = await store.postingForCase(id);
    if (
      ready.settlement?.decisionId !== decisionId ||
      ready.connection === undefined ||
      !ready.connection.postingEnabled ||
      !ready.connection.hasMap
    ) {
      return back('posting_off');
    }
    let writeoffCents: Cents;
    try {
      ({ writeoffCents } = await store.approveSettlement(decisionId));
    } catch (cause) {
      if (cause instanceof SettlementApprovalRefusedError) {
        return back(
          cause.reason === 'preparer'
            ? 'settle_is_preparer'
            : cause.reason === 'role'
              ? 'settle_role'
              : 'settle_duplicate',
        );
      }
      throw cause;
    }
    let queued = false;
    try {
      if (writeoffCents > 0) await store.insertWriteoff({ decisionId, amountCents: writeoffCents });
      queued = await queueDecisionPostings(session, store, {
        decisionId,
        connectionId: ready.connection.connectionId,
        withPayment: ready.settlement.outcome === 'declined',
      });
    } catch (cause) {
      if (!(cause instanceof PostingStoreError)) throw cause;
      console.error(`[recouple] settle: posting not queued (${cause.name}), decision ${decisionId}`);
    }
    return back(queued ? 'settle_approved' : 'posting_not_queued');
  }

  return back('settle_invalid');
}

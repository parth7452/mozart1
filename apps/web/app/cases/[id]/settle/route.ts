import { NextResponse, type NextRequest } from 'next/server';
import { JournalInputError, MoneyError, type Cents, type SettlementLineProblem } from '@recouple/core-domain';
import {
  PostingStoreError,
  SettlementAlreadyApprovedError,
  SettlementApprovalRefusedError,
  SettlementInvoiceRefusedError,
  SettlementLinesRefusedError,
} from '@recouple/store-postgres';
import { requireSession } from '../../../../lib/session';
import { mayWrite } from '../../../../lib/pipeline';
import { isCrossSite, isUuid, refuseCrossSite } from '../../../../lib/request';
import { backToCase, mayApprove } from '../../../../lib/workflow';
import { qboPostingFromEnv } from '../../../../lib/qbo-posting';
import { postingStoreFor, queueDecisionPostings } from '../../../../lib/posting';
import {
  SettlementChartUnreadableError,
  SettlementInvoiceUnreadableError,
  postedLinesFrom,
  settlementChartReader,
  settlementChoiceFrom,
  settlementEditorPath,
  settlementInvoiceLookup,
} from '../../../../lib/settlement-editor';

/**
 * Moment 2 (ADR 0060 §2): how a case settled, in the books.
 *
 * `intent=prepare` records a person's schema `S` decision — the outcome, what
 * was recovered, the family, the ledger invoice (looked up in the company by
 * id or printed number and stored as its internal id, ADR 0069), and the journal lines the
 * form carried (ADR 0068): amounts read by `parseMoneyToCents`, accounts
 * checked by the store against a chart it reads live, so an account id a
 * form was tampered with is refused like any other the chart does not
 * report. A refused form goes back to the editor with its accounts and
 * amounts echoed and its memos left out of the address. `intent=approve` is
 * a second person's approval of the case's latest settlement (never the
 * preparer: the database's separation of duties, unchanged), a `writeback`
 * approval and a `writeoff` one when the outcome writes anything off, and
 * then the rows and the queue. Nothing here computes an amount the store
 * does not check.
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
    // A figure the money parser will not read is a refusal, said as one.
    const choice = settlementChoiceFrom({
      outcome: form.get('outcome'),
      recovered: form.get('recovered'),
      family: form.get('family'),
      invoiceId: form.get('invoiceId'),
    });
    if (choice === undefined || choice === 'invalid') return back('settle_invalid');

    // The connection is the workspace's, never the form's.
    const ready = await store.postingForCase(id);
    const connection =
      ready.connection === undefined || !ready.connection.postingEnabled || !ready.connection.hasMap
        ? undefined
        : (await store.postingConnections()).find((c) => c.connectionId === ready.connection?.connectionId);
    if (connection === undefined) return back('posting_off');

    const posted = postedLinesFrom(form);
    // Back to the form with what was entered: accounts and cents, never a memo.
    const backToEditor = (problems: readonly SettlementLineProblem[]): NextResponse =>
      NextResponse.redirect(
        new URL(
          settlementEditorPath(id, choice, {
            lines: posted.echo,
            problems,
            notice: 'settle_lines_refused',
          }),
          request.url,
        ),
        { status: 303 },
      );
    // A read of QuickBooks may refresh the company's token, which the
    // database stores only for a member it lets write.
    const mayRefresh = await store.memberMayWrite();
    if (posted.unreadable.length > 0) {
      return backToEditor(posted.unreadable.map((lineNo) => ({ code: 'not_integer_cents', lineNo })));
    }
    try {
      await store.prepareSettlementDecision({
        deductionId: id,
        preparedBy: session.userId,
        outcome: choice.outcome,
        recoveredCents: choice.recoveredCents,
        family: choice.family,
        invoiceId: choice.invoiceId,
        // The invoice is resolved against the company to its internal id:
        // what a person typed, or a document printed, is never used as one.
        // No lookup at all for a member the database would not let write:
        // it has no read that cannot refresh, and they could prepare nothing.
        findInvoice: mayRefresh
          ? settlementInvoiceLookup({ orgId: session.org.orgId, userId: session.userId }, connection)
          : async () => {
              throw new SettlementInvoiceUnreadableError('may_not_write');
            },
        lines: {
          connectionId: connection.connectionId,
          lines: posted.lines,
          // A token refresh this read causes is stored only for a member the
          // database lets write; for anyone else the read refuses to refresh.
          readChart: settlementChartReader(
            { orgId: session.org.orgId, userId: session.userId },
            connection,
            { mayRefresh },
          ),
        },
      });
    } catch (cause) {
      if (cause instanceof SettlementLinesRefusedError) return backToEditor(cause.problems);
      if (cause instanceof SettlementChartUnreadableError) return back('settle_chart_unreadable');
      if (cause instanceof SettlementInvoiceUnreadableError) {
        return back(cause.reason === 'may_not_write' ? 'settle_role' : 'settle_invoice_unreadable');
      }
      if (cause instanceof SettlementInvoiceRefusedError) {
        return back(
          cause.reason === 'invoice_ambiguous' ? 'settle_invoice_ambiguous' : 'settle_invoice_not_found',
        );
      }
      if (cause instanceof SettlementAlreadyApprovedError) return back('settle_already_approved');
      if (
        cause instanceof PostingStoreError ||
        cause instanceof RangeError ||
        cause instanceof JournalInputError ||
        cause instanceof MoneyError
      ) {
        return back('settle_invalid');
      }
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
              : cause.reason === 'superseded'
                ? 'settle_superseded'
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

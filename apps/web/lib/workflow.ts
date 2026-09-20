import { NextResponse } from 'next/server';
import type { CaseWorkflowStore } from '@recouple/pipeline';
import { storeFor, type Session } from './session';
import type { TenantStore } from './store';

/**
 * The Phase 3 workflow, as this request's tenant may walk it.
 *
 * It is the same `PostgresStore` every other read and write goes through — the
 * same connection, the same `app_rw` role, the same claims set
 * transaction-locally — seen through the port that Phase 3 is written against
 * (`CaseWorkflowStore`, ADR 0020 §6). There is no second store, no service
 * role and no second answer to "what may this member see": a workflow read is
 * a read like any other, and RLS is what decides it.
 *
 * Typed as the intersection rather than the port alone because a route still
 * has to `close()` what it opened, and because the case page reads a case, its
 * fields and its workflow from one store rather than opening two. The store's
 * own type is carried through rather than narrowed, the way `pipelineDepsFor`
 * carries it: a caller that has more keeps it.
 */
export type WorkflowStore = TenantStore & CaseWorkflowStore;

export function workflowStoreFor(session: Session): WorkflowStore {
  return storeFor(session);
}

/**
 * Roles that may approve a packet for submission.
 *
 * `analyst` is deliberately absent: an analyst prepares and assembles, and a
 * second person authorises. This is a better error message and a button that is
 * not shown — the enforcement is `app.enforce_separation_of_duties()`, which
 * refuses an approval by anyone but an `owner` or `approver` whatever this
 * function believes (migration 0005, ADR 0020 §5).
 */
const APPROVERS: ReadonlySet<string> = new Set(['owner', 'approver']);

export function mayApprove(role: string): boolean {
  return APPROVERS.has(role);
}

/**
 * The one place the new actions' notices are named.
 *
 * Every Phase 3 route answers on the case page it came from, carrying what
 * happened in `?action=` — the same shape the decline route has used since it
 * was written, so the page renders one notice the same way whichever action
 * produced it. A redirect rather than a rendered error because a POST that
 * re-renders is a POST a refresh repeats, and every one of these writes to a
 * money path.
 */
export const NOTICE_PARAM = 'action';

/** A 303 back to the case, saying what happened. */
export function backToCase(requestUrl: string, deductionId: string, notice: string): URL {
  const back = new URL(`/cases/${deductionId}`, requestUrl);
  back.searchParams.set(NOTICE_PARAM, notice);
  return back;
}

/**
 * The answer for a case this session cannot see.
 *
 * `CaseNotVisibleError` is RLS working: another tenant's case is *absent*, and
 * the store says so by name rather than letting a route render it as a fault.
 * A 404 with no body is the only honest reply — a redirect back to the case
 * would 404 on the next render anyway, and a 403 would confirm the case exists
 * somewhere, which is none of this tenant's business.
 */
export function caseNotFound(): NextResponse {
  return new NextResponse('not found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

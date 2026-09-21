import { NextResponse } from 'next/server';
import type { PostgresStore } from '@recouple/store-postgres';
import { storeFor, type Session } from './session';
import { NOTICE_ABOUT_PARAM, type NoticeKey } from './notices';

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
 * Typed as the store rather than as the port alone because a route still has to
 * `close()` what it opened, and because the case page reads a case, its fields
 * and its workflow from one store rather than opening two. The store's own type
 * is carried through rather than narrowed, the way `pipelineDepsFor` carries
 * it: a caller that has more keeps it.
 */
export type WorkflowStore = PostgresStore;

export function workflowStoreFor(session: Session): WorkflowStore {
  return storeFor(session);
}

/**
 * Whether two ids name the same case.
 *
 * Case-insensitively, because one of them comes out of Postgres — which prints
 * a `uuid` in lower case — and the other out of a URL, where `isUuid` accepts
 * either. Comparing them literally would tell a reviewer who reached the page
 * through an upper-case link that their approval had landed somewhere else,
 * send them to the same case again, and say the form had been out of date.
 * Hex is hex; folding the case is what makes the comparison about the id.
 */
export function sameCase(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
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
 *
 * What travels is a key out of `lib/notices.ts` and never a sentence: the query
 * string is a thing anybody can type, and an app that repeats it is an app a
 * link can put words into. Anything the key cannot say on its own — a hash, a
 * state, a count — follows as `about`, one validated fragment per `{n}`.
 */
export const NOTICE_PARAM = 'action';

/**
 * A 303 back to a case, saying what happened.
 *
 * Not necessarily the case the POST was addressed to. `approve` and
 * `recordSubmission` act on the *decision's* case and answer with which one
 * that was, so when a stale form names another of this tenant's cases the
 * reviewer is sent to the case the write landed on and told so — rather than to
 * the path's case, where nothing happened, or to the list, where they would
 * have to find it.
 */
export function backToCase(
  requestUrl: string,
  deductionId: string,
  notice: NoticeKey,
  ...about: readonly string[]
): URL {
  const back = new URL(`/cases/${deductionId}`, requestUrl);
  back.searchParams.set(NOTICE_PARAM, notice);
  for (const fragment of about) back.searchParams.append(NOTICE_ABOUT_PARAM, fragment);
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

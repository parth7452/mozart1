import { NextResponse, type NextRequest } from 'next/server';
import {
  CaseNotVisibleError,
  DuplicateVerdictAlreadyRecordedError,
  NoSuchDuplicatePairError,
  WrongRoleError,
  type DuplicateVerdict,
} from '@recouple/pipeline';
import { requireSession } from '../../../../lib/session';
import { mayWrite } from '../../../../lib/pipeline';
import { isCrossSite, isUuid, refuseCrossSite } from '../../../../lib/request';
import { NOTICE_ABOUT_PARAM, type NoticeKey } from '../../../../lib/notices';
import { backToCase, caseNotFound, NOTICE_PARAM, workflowStoreFor } from '../../../../lib/workflow';

/**
 * Records what a person concluded about a pair identity resolution refused to
 * merge (ADR 0032).
 *
 * The matcher merges on an exact identifier match and nothing else; a probable
 * one opens the second case and names the first, because a second case is
 * visible and a wrong merge is not (ADR 0025 §6). Nobody could answer that
 * until now.
 *
 * **This does not merge anything.** It writes one append-only event on each
 * case saying what was concluded. Neither case changes state, neither is
 * hidden, and no identifier moves — which append-only plus the per-source
 * unique constraint make impossible anyway. So there is no way for this handler
 * to make an exact match happen: the next arrival resolves against exactly the
 * identifiers it would have resolved against before.
 *
 * The role check here is a better error message, not the enforcement. Three
 * things enforce underneath it: `app.member_may_write()` asked of the database
 * before anything is written, the same function again in the insert policy, and
 * RLS deciding whether this tenant can see either case at all.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  // First, before the session is even looked up: this writes to two cases, and
  // a write another site can trigger is one nobody asked for. `SameSite=Lax`
  // stops it too; this does not depend on that being true in a file it does not
  // own.
  if (isCrossSite(request)) return refuseCrossSite();

  const { id } = await params;
  const session = await requireSession();

  // A real UUID, not thirty-six characters shaped like one: anything else
  // reaches Postgres as a 22P02 and comes back to the reviewer as a 500.
  if (!isUuid(id)) {
    return NextResponse.redirect(new URL('/', request.url), { status: 303 });
  }

  const form = await request.formData();
  const other = form.get('other');
  const from = form.get('from');
  // Where the answer was given, so the reviewer lands back on it. A value that
  // is not one of the two is treated as the case page — the conservative
  // reading of a field anybody can post, and the page the path already names.
  const back = (notice: NoticeKey, ...about: readonly string[]): NextResponse => {
    if (from === 'list') {
      const list = new URL('/', request.url);
      list.searchParams.set(NOTICE_PARAM, notice);
      for (const fragment of about) list.searchParams.append(NOTICE_ABOUT_PARAM, fragment);
      return NextResponse.redirect(list, { status: 303 });
    }
    return NextResponse.redirect(backToCase(request.url, id, notice, ...about), { status: 303 });
  };

  if (!mayWrite(session.org.role)) {
    return back('duplicate_role');
  }
  // The other half of the pair, checked the same way as the path's id and for
  // the same reason. A missing or malformed one is a form this app did not
  // draw, and the pair it would name does not exist.
  if (!isUuid(other)) {
    return back('duplicate_unknown_pair');
  }

  const said = form.get('verdict');
  if (said !== 'same' && said !== 'different') {
    return back('duplicate_verdict');
  }
  const verdict: DuplicateVerdict = said;

  const store = workflowStoreFor(session);
  try {
    // The database's answer, not this app's, and asked before anything is
    // written: the store asks it again by taking a row lock the update policy
    // gates, and the insert policy asks a third time. A refusal here is the one
    // a reviewer can read.
    if (!(await store.memberMayWrite({ orgId: session.org.orgId, userId: session.userId }))) {
      return back('duplicate_role');
    }

    await store.recordDuplicateVerdict({
      deductionId: id,
      otherDeductionId: other,
      verdict,
      // Who said so, by the identity the session resolved — never a form field.
      // The store refuses anyone else outright.
      recordedBy: session.userId,
    });
    return back(verdict === 'same' ? 'duplicate_confirmed' : 'duplicate_dismissed');
  } catch (cause) {
    // RLS working, not a fault: a case of another tenant's is absent, and so is
    // the far half of a pair that reaches across tenants. A 404 says nothing
    // about whether it exists somewhere else, which is none of this tenant's
    // business.
    if (cause instanceof CaseNotVisibleError) return caseNotFound();
    if (cause instanceof NoSuchDuplicatePairError) {
      // A stale page, or a pair somebody else answered and this reader has not
      // reloaded past. Nothing was written.
      return back('duplicate_unknown_pair');
    }
    if (cause instanceof DuplicateVerdictAlreadyRecordedError) {
      // Not a fault: a second submit of a form that is still on screen, or the
      // other reviewer answering first. The first answer stands, because
      // `deduction_events` is append-only and a second one would make the pair
      // list depend on which event it read first.
      return back('duplicate_already');
    }
    if (cause instanceof WrongRoleError) {
      return back('duplicate_role');
    }
    // Fail loud. An answer that did not happen must not redirect back looking
    // like one that did — the events are append-only, so a missing pair of rows
    // is not something a later write repairs, and a reviewer who believes a
    // pair is resolved will not look at it again.
    throw cause;
  } finally {
    await store.close();
  }
}

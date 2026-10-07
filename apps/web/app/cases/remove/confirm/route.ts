import { NextResponse, type NextRequest } from 'next/server';
import { CaseNotVisibleError, CaseRemovalRefusedError, WrongRoleError } from '@recouple/pipeline';
import { requireSession, storeFor } from '../../../../lib/session';
import { mayApprove } from '../../../../lib/workflow';
import { isCrossSite, refuseCrossSite } from '../../../../lib/request';
import { NOTICE_ABOUT_PARAM, type NoticeKey } from '../../../../lib/notices';
import { REMOVE_REASON_MAX_LENGTH, removalIdsFrom } from '../../../../lib/remove-cases';

/**
 * Removes cases opened in error (ADR 0072): the confirmation page's POST.
 *
 * Not a delete. Each case gets a `case.removed` event naming this member, then
 * moves to `removed`, in one transaction for every id or for none; the
 * database (`app.removal_is_guarded()`) refuses anyone but an owner or an
 * approver, any case past a filing and any move back out. The role check here
 * is a better answer, not the enforcement.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  // First, before the session is looked up: a removal another site can
  // trigger is one nobody asked for.
  if (isCrossSite(request)) return refuseCrossSite();

  const session = await requireSession();
  const form = await request.formData();
  const selection = removalIdsFrom(form.getAll('id'));

  // Back to the confirmation page with what was selected and a notice key —
  // never a sentence (`lib/notices.ts`).
  const back = (notice: NoticeKey): NextResponse => {
    const url = new URL('/cases/remove', request.url);
    if ('ids' in selection) for (const id of selection.ids) url.searchParams.append('id', id);
    url.searchParams.set('notice', notice);
    return NextResponse.redirect(url, { status: 303 });
  };

  if (!mayApprove(session.org.role)) return back('remove_role');
  if ('refused' in selection) return back('remove_none');

  const reasonField = form.get('reason');
  const reason = typeof reasonField === 'string' ? reasonField.trim() : '';
  // Refused, not cut: the reason rides on an append-only event.
  if (reason.length > REMOVE_REASON_MAX_LENGTH) return back('remove_reason_too_long');

  const store = storeFor(session);
  try {
    // A signed session says who; the database says whether they may write now.
    if (!(await store.memberMayWrite({ orgId: session.org.orgId, userId: session.userId }))) return back('remove_role');
    const removed = await store.removeCases(selection.ids, reason === '' ? undefined : reason);
    const done = new URL('/', request.url);
    done.searchParams.set('action', 'cases_removed');
    done.searchParams.set(NOTICE_ABOUT_PARAM, String(removed.length));
    return NextResponse.redirect(done, { status: 303 });
  } catch (cause) {
    if (cause instanceof CaseRemovalRefusedError) {
      return back(cause.reason === 'not_owner_or_approver' ? 'remove_role' : 'remove_refused');
    }
    if (cause instanceof WrongRoleError) return back('remove_role');
    if (cause instanceof CaseNotVisibleError) return back('remove_refused');
    throw cause;
  } finally {
    await store.close();
  }
}

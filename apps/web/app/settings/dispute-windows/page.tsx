import { requireSession } from '../../../lib/session';
import { disputeWindowStoreFor, mayRecordWindows } from '../../../lib/dispute-windows';
import { payerCodeMapStoreFor } from '../../../lib/reason-code-maps';
import { windowPrefillFrom } from '../../../lib/dispute-window-words';
import { viewerOf } from '../../../lib/viewer';
import { DisputeWindowsPage } from '../../../components/dispute-windows';

export const dynamic = 'force-dynamic';

/**
 * Settings → Dispute windows: resolve the member, read, render (ADR 0071).
 * Every read is this tenant's through RLS; every member sees the page and only
 * an owner or approver is shown the form. The query string can choose the
 * form's payer and nothing more.
 */
export default async function DisputeWindowsSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ windows?: string; debtor?: string | string[] }>;
}) {
  const session = await requireSession();
  const { windows, debtor } = await searchParams;
  const identity = { orgId: session.org.orgId, userId: session.userId };
  const store = disputeWindowStoreFor(identity);
  const today = new Date().toISOString().slice(0, 10);
  const [current, debtors, without] = await Promise.all([
    store.currentDisputeWindows(today),
    // The tenant's payers, through the code-map store's one read of them.
    payerCodeMapStoreFor(identity).mappableDebtors(),
    store.payersWithoutWindow(today),
  ]);
  return (
    <DisputeWindowsPage
      viewer={viewerOf(session)}
      current={current}
      debtors={debtors}
      without={without}
      mayRecord={mayRecordWindows(session.org.role)}
      prefill={windowPrefillFrom({ debtor })}
      today={today}
      notice={windows}
    />
  );
}

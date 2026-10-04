import { requireSession, storeFor } from '../../../lib/session';
import { mayMapPayerCodes, payerCodeMapStoreFor } from '../../../lib/reason-code-maps';
import { prefillFrom } from '../../../lib/reason-code-words';
import { viewerOf } from '../../../lib/viewer';
import { ReasonCodesPage } from '../../../components/reason-code-maps';

export const dynamic = 'force-dynamic';

/**
 * Settings → Reason codes: resolve the member, read, render (ADR 0066).
 *
 * Every read is this tenant's through RLS, as the member signed in, and every
 * member sees the page; only an owner or approver is shown the form, and the
 * database refuses the write to anyone else. The query string can prefill the
 * form's payer and code and nothing more (`prefillFrom` validates both), and a
 * notice arrives as a key.
 */
export default async function ReasonCodesSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ codes?: string; debtor?: string | string[]; code?: string | string[] }>;
}) {
  const session = await requireSession();
  const { codes, debtor, code } = await searchParams;
  const identity = { orgId: session.org.orgId, userId: session.userId };
  const maps = payerCodeMapStoreFor(identity);
  const today = new Date().toISOString().slice(0, 10);
  const cases = storeFor(session);
  try {
    const [current, debtors, unmapped] = await Promise.all([
      maps.allCurrentPayerCodeMaps(today),
      maps.mappableDebtors(),
      // The derived half of a case's code is `payerTermsForCases`', the one
      // matcher, asked through the same member's store.
      maps.unmappedPayerCodes(cases),
    ]);
    return (
      <ReasonCodesPage
        viewer={viewerOf(session)}
        current={current}
        debtors={debtors}
        unmapped={unmapped}
        mayMap={mayMapPayerCodes(session.org.role)}
        prefill={prefillFrom({ debtor, code })}
        today={today}
        notice={codes}
      />
    );
  } finally {
    await cases.close();
  }
}

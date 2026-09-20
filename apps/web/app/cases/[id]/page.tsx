import { notFound } from 'next/navigation';
import { reconcileCase } from '@recouple/pipeline';
import { requireSession, storeFor } from '../../../lib/session';
import { mayWrite } from '../../../lib/pipeline';
import { isUuid } from '../../../lib/request';
import { CaseReview } from '../../../components/case-review';

export const dynamic = 'force-dynamic';

/**
 * The review route: resolve the reviewer, read the case, render it.
 *
 * Reconciliation runs over what is already stored. The reader ports it is handed
 * throw, because a review page must not be able to spend money or call a model —
 * looking at a case is not a reason to read a document again.
 */
export default async function CasePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  // Both actions redirect back here with what happened, so the outcome survives
  // the POST rather than being lost to a full page load.
  searchParams: Promise<{ decline?: string; upload?: string }>;
}) {
  const { id } = await params;
  const { decline, upload } = await searchParams;
  // The strict pattern, the same one the decline route and the upload route
  // use. `[0-9a-f-]{36}` accepts `------------------------------------`, which
  // is not a UUID and reaches Postgres as a 500 rather than a 404.
  if (!isUuid(id)) notFound();

  const session = await requireSession();
  const store = storeFor(session);
  try {
    // Through listCases, so the case is one RLS already agreed this tenant has.
    const summary = (await store.listCases()).find((row) => row.deductionId === id);
    if (summary === undefined) notFound();

    const [fields, costMicros, reconciliation] = await Promise.all([
      store.fieldsForCase(id),
      store.costForCase(id),
      reconcileCase(id, {
        store,
        scanner: {
          name: 'none',
          async scan() {
            throw new Error('a review page does not scan');
          },
        },
        classifier: {
          async classify() {
            throw new Error('a review page does not classify');
          },
        },
        extractor: {
          name: 'none',
          async extract() {
            throw new Error('a review page does not extract');
          },
        },
        now: () => new Date(),
      }),
    ]);

    return (
      <CaseReview
        viewer={{ email: session.email, orgName: session.org.name, role: session.org.role }}
        summary={summary}
        fields={fields}
        reconciliation={reconciliation}
        costMicros={costMicros}
        today={new Date()}
        mayAct={mayWrite(session.org.role)}
        notice={decline ?? upload}
      />
    );
  } finally {
    await store.close();
  }
}

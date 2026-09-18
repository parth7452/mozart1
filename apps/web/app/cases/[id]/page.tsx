import { notFound } from 'next/navigation';
import { reconcileCase } from '@recouple/pipeline';
import { requireSession, storeFor } from '../../../lib/session';
import { CaseReview } from '../../../components/case-review';

export const dynamic = 'force-dynamic';

/**
 * The review route: resolve the reviewer, read the case, render it.
 *
 * Reconciliation runs over what is already stored. The reader ports it is handed
 * throw, because a review page must not be able to spend money or call a model —
 * looking at a case is not a reason to read a document again.
 */
export default async function CasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

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
      />
    );
  } finally {
    await store.close();
  }
}

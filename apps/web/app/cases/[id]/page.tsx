import { notFound } from 'next/navigation';
import { reconcileCase } from '@recouple/pipeline';
import { requireSession } from '../../../lib/session';
import { mayWrite } from '../../../lib/pipeline';
import { isUuid } from '../../../lib/request';
import { aboutFrom } from '../../../lib/notices';
import { mayApprove, workflowStoreFor } from '../../../lib/workflow';
import { CaseReview } from '../../../components/case-review';

export const dynamic = 'force-dynamic';

/**
 * The review route: resolve the reviewer, read the case, render it.
 *
 * Reconciliation runs over what is already stored. The reader ports it is handed
 * throw, because a review page must not be able to spend money or call a model —
 * looking at a case is not a reason to read a document again.
 *
 * The workflow — the decision, the packet, the approval, the filing, the
 * outcome — is one more read on the same store, through the same claims as
 * everything else. What a member may *do* with it is decided here, from the
 * role the session resolved, and passed to the view as two booleans: the view
 * renders, it does not ask who anybody is.
 */
export default async function CasePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  // Every action redirects back here with what happened, so the outcome
  // survives the POST rather than being lost to a full page load. What travels
  // is a notice *key* and, for the few notices that name something, one or more
  // validated `about` fragments — never the sentence itself, which would make
  // this page a place a link can put words into (`lib/notices.ts`).
  searchParams: Promise<{
    decline?: string;
    upload?: string;
    action?: string;
    about?: string | string[];
  }>;
}) {
  const { id } = await params;
  const { decline, upload, action, about } = await searchParams;
  // The strict pattern, the same one every route here uses. `[0-9a-f-]{36}`
  // accepts `------------------------------------`, which is not a UUID and
  // reaches Postgres as a 500 rather than a 404.
  if (!isUuid(id)) notFound();

  const session = await requireSession();
  const store = workflowStoreFor(session);
  try {
    // Through listCases, so the case is one RLS already agreed this tenant has.
    const summary = (await store.listCases()).find((row) => row.deductionId === id);
    if (summary === undefined) notFound();

    const [fields, costMicros, reconciliation, workflow, duplicates] = await Promise.all([
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
      store.getWorkflow(id),
      // Whether this case is one half of a pair identity resolution refused to
      // merge (ADR 0032). Asked for every reader, not only for a member who may
      // answer it: deciding what to do about a deduction is exactly where
      // knowing that another case may be the same one matters, and a reader who
      // cannot answer still should not assemble a packet for it twice.
      store.possibleDuplicates({ deductionId: id }),
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
        mayApprove={mayApprove(session.org.role)}
        viewerUserId={session.userId}
        workflow={workflow}
        duplicates={duplicates}
        notice={decline ?? upload ?? action}
        noticeAbout={aboutFrom(about)}
      />
    );
  } finally {
    await store.close();
  }
}

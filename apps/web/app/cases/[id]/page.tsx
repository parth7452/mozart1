import { notFound } from 'next/navigation';
import { isClosed } from '@recouple/core-domain';
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
    // By id, through RLS, so the case is one the database agreed this tenant
    // has — and the 404 for one it did not, another tenant's included, is the
    // same as for a case that does not exist (ADR 0014, ADR 0015). Not found in
    // `listCases`, whose newest hundred left every older case a 404 here.
    const summary = await store.caseSummary(id);
    if (summary === undefined) notFound();

    const mayAct = mayWrite(session.org.role);
    const [documents, fields, costMicros, reconciliation, workflow, duplicates, merges, attachable] =
      await Promise.all([
        // The case's documents by their links, and their fields by the same
        // links: a remittance's read and a held notice's belong to no case, and a
        // ledger extract has no fields at all, but each is on this case.
        store.caseDocuments(id),
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
        // What this case was merged into, or absorbed, and the confirmed pairs
        // that could not be merged and why (ADR 0042).
        store.mergesFor(id),
        // The documents read and on no case, to file here without reading them
        // again. From this end because the case list's picker stops at
        // `ATTACH_TARGETS_LIMIT`: a case past it is reached from its own page.
        // Asked only where the card that offers them is drawn — a member who
        // may write, on a case still open (a merged-away one is closed).
        mayAct && !isClosed(summary.state) ? store.unattachedDocuments() : undefined,
      ]);

    return (
      <CaseReview
        viewer={{ email: session.email, orgName: session.org.name, role: session.org.role }}
        summary={summary}
        documents={documents}
        fields={fields}
        reconciliation={reconciliation}
        costMicros={costMicros}
        today={new Date()}
        mayAct={mayAct}
        mayApprove={mayApprove(session.org.role)}
        viewerUserId={session.userId}
        workflow={workflow}
        duplicates={duplicates}
        merges={merges}
        attachable={attachable}
        notice={decline ?? upload ?? action}
        noticeAbout={aboutFrom(about)}
      />
    );
  } finally {
    await store.close();
  }
}

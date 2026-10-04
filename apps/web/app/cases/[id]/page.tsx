import { notFound } from 'next/navigation';
import { evidenceChecklist, isClosed } from '@recouple/core-domain';
import { evidenceOfDocuments } from '@recouple/extraction';
import { reconcileCase } from '@recouple/pipeline';
import { requireSession } from '../../../lib/session';
import { mayWrite } from '../../../lib/pipeline';
import { isUuid } from '../../../lib/request';
import { aboutFrom } from '../../../lib/notices';
import { mayApprove, workflowStoreFor } from '../../../lib/workflow';
import { CaseReview } from '../../../components/case-review';
import { viewerOf } from '../../../lib/viewer';
import { reviewPipelineDeps } from '../../../lib/review-deps';
import { isSpreadsheetMime } from '@recouple/ingest';
import { sheetExtractFor } from '../../../lib/sheet-extract-load';
import { qboPostingFromEnv } from '../../../lib/qbo-posting';
import { postingStoreFor } from '../../../lib/posting';
import { unattachedWithSuggestions } from '../../../lib/document-suggestions';

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
    const [documents, fields, costMicros, reconciliation, workflow, duplicates, merges, attachable, payerTerms] =
      await Promise.all([
        // The case's documents by their links, and their fields by the same
        // links: a remittance's read and a held notice's belong to no case, and a
        // ledger extract has no fields at all, but each is on this case.
        store.caseDocuments(id),
        store.fieldsForCase(id),
        store.costForCase(id),
        reconcileCase(id, reviewPipelineDeps(store)),
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
        // Each carries the cases suggested for it, so the ones that match this
        // case are listed first and say what agreed.
        mayAct && !isClosed(summary.state) ? unattachedWithSuggestions(store) : undefined,
        // The payer's reason code and reference, derived from the notices and
        // remittances linked to this case when it printed none of its own.
        store.payerTermsForCase(id),
      ]);
    // Read only where the deployment posts at all (`QBO_POSTING`, ADR 0060 §5):
    // elsewhere the card, the retry and the posting approve label do not exist.
    const posting = qboPostingFromEnv() === undefined ? undefined : await postingStoreFor(session).postingForCase(id);

    // Computed, never stored (ADR 0059). The first set starts 2000-01-01, so
    // a decision's own date always resolves one.
    const evidence = workflow?.decision
      ? evidenceChecklist({
          reason: workflow.decision.reason,
          onDate: workflow.decision.decidedAt.toISOString().slice(0, 10),
          present: evidenceOfDocuments(documents),
        })
      : undefined;

    // A spreadsheet notice is drawn from its cells rather than embedded
    // (ADR 0056); its bytes come through the same scan gate as a download.
    const primary = documents.find((d) => d.role === 'notice');
    const sheetExtract =
      primary !== undefined && primary.servingRefusal === null && isSpreadsheetMime(primary.mimeType)
        ? await sheetExtractFor(store, session.org.orgId, primary.documentId, fields, summary.deductionAmountCents)
        : undefined;

    return (
      <CaseReview
        {...(sheetExtract !== undefined ? { sheetExtract } : {})}
        viewer={viewerOf(session)}
        summary={summary}
        payerTerms={payerTerms}
        evidenceChecklist={evidence}
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
        posting={posting}
      />
    );
  } finally {
    await store.close();
  }
}

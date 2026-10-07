import { notFound } from 'next/navigation';
import { cents, evidenceChecklist, familyOf, isClosed } from '@recouple/core-domain';
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
import { payerCodeMapStoreFor } from '../../../lib/reason-code-maps';
import { disputeWindowStoreFor } from '../../../lib/dispute-windows';
import { unattachedWithSuggestions } from '../../../lib/document-suggestions';
import {
  settlementChartReader,
  settlementEditorFor,
  type SettlementDefaults,
  type SettlementEditor,
} from '../../../lib/settlement-editor';

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
    // The settlement editor's own parameters (`SETTLE_PARAMS`): how the case
    // settled, and the lines a refused form sent back. Each is validated
    // where it is read, and none of them is ever a memo.
    so?: string | string[];
    sr?: string | string[];
    sf?: string | string[];
    si?: string | string[];
    sl?: string | string[];
    sp?: string | string[];
    se?: string | string[];
  }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const { decline, upload, action, about } = query;
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

    // A removed case (ADR 0072) is kept for audit and offers no action at all.
    const removal = summary.state === 'removed' ? await store.caseRemoval(id) : undefined;
    const mayAct = mayWrite(session.org.role) && summary.state !== 'removed';
    const [documents, fields, costMicros, reconciliation, workflow, duplicates, merges, attachable, payerTerms, manualEntry] =
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
        // What a person typed, for a case opened by hand (ADR 0070); none otherwise.
        store.manualEntryFor(id),
      ]);
    // What the payer's code maps to in this workspace's own mappings, on the
    // day the deduction was taken (ADR 0067). After the terms, because a case
    // with no code of its own takes the one its documents agree on.
    const identity = { orgId: session.org.orgId, userId: session.userId };
    // And the payer's dispute window on the deduction date (ADR 0071), which
    // the deadline form offers when the case has none.
    const [payerCodeMapping, disputeWindow] = await Promise.all([
      payerCodeMapStoreFor(identity).payerCodeMappingForCase(id, payerTerms),
      disputeWindowStoreFor(identity).disputeWindowForCase(id),
    ]);
    // Read only where the deployment posts at all (`QBO_POSTING`, ADR 0060 §5):
    // elsewhere the card, the retry and the posting approve label do not exist.
    const postingStore = qboPostingFromEnv() === undefined ? undefined : postingStoreFor(session);
    const posting = postingStore === undefined ? undefined : await postingStore.postingForCase(id);

    // The settlement entry's prepare form (ADR 0068 §7): for a member who may
    // write, where posting is live and the settlement is not yet approved.
    // The chart of accounts is read only once somebody has said how the case
    // settled — never on an ordinary view of the page — and a refresh that
    // read causes is allowed only for a member the database lets write.
    let settlementEditor: SettlementEditor | undefined;
    if (
      postingStore !== undefined &&
      posting?.connection !== undefined &&
      posting.connection.postingEnabled &&
      posting.connection.hasMap &&
      // An approved settlement whose posting was voided is set aside: the
      // case takes a new one (ADR 0069 §3).
      (posting.settlement?.approved !== true || posting.settlement.voided === true) &&
      mayAct
    ) {
      const connectionId = posting.connection.connectionId;
      const connection = (await postingStore.postingConnections()).find((c) => c.connectionId === connectionId);
      const declined = summary.declined === true || workflow?.decline !== undefined;
      const voided = posting.settlement?.voided === true ? posting.settlement : undefined;
      const prepared = voided === undefined ? posting.settlement : undefined;
      const defaults: SettlementDefaults =
        voided !== undefined
          ? {
              outcome: voided.outcome,
              recoveredCents: voided.recoveredCents,
              family: voided.family,
              // Never the voided settlement's invoice: it may be why it failed.
              invoiceId: posting.ledgerInvoiceId,
            }
          : prepared !== undefined
          ? {
              outcome: prepared.outcome,
              recoveredCents: prepared.recoveredCents,
              family: prepared.family,
              invoiceId: prepared.invoiceNumber ?? prepared.invoiceId,
            }
          : {
              outcome: declined ? 'declined' : workflow?.outcome?.outcome,
              recoveredCents: declined
                ? cents(0)
                : workflow?.outcome === undefined
                  ? undefined
                  : cents(workflow.outcome.recoveredCents),
              family: workflow?.decision ? familyOf(workflow.decision.reason) : undefined,
              invoiceId: posting.ledgerInvoiceId,
            };
      settlementEditor = await settlementEditorFor({
        deductionId: id,
        amountCents: summary.deductionAmountCents,
        params: query,
        defaults,
        settlement: prepared,
        connection,
        mayAct,
        readChartFor: (c) => async () =>
          settlementChartReader({ orgId: session.org.orgId, userId: session.userId }, c, {
            mayRefresh: await postingStore.memberMayWrite(),
          })(),
      });
    }

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
        payerCodeMapping={payerCodeMapping}
        disputeWindow={disputeWindow}
        evidenceChecklist={evidence}
        documents={documents}
        fields={fields}
        reconciliation={reconciliation}
        costMicros={costMicros}
        today={new Date()}
        mayAct={mayAct}
        mayApprove={mayApprove(session.org.role) && summary.state !== 'removed'}
        {...(removal !== undefined ? { removal } : {})}
        viewerUserId={session.userId}
        workflow={workflow}
        duplicates={duplicates}
        merges={merges}
        attachable={attachable}
        notice={decline ?? upload ?? action}
        noticeAbout={aboutFrom(about)}
        posting={posting}
        settlementEditor={settlementEditor}
        {...(manualEntry !== undefined ? { manualEntry } : {})}
      />
    );
  } finally {
    await store.close();
  }
}

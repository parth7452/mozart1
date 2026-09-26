import type {
  PossibleDuplicatePair,
  UnattachedDocument,
  UnreadDocument,
} from '@recouple/pipeline';
import { DUE_SOON_DAYS } from '@recouple/core-domain';
import {
  ATTACH_TARGETS_LIMIT,
  type AttachTargets,
  type CaseStateTally,
  type CaseSummary,
  type FiledNothingByAddress,
  type ReviewQueueRead,
} from '@recouple/store-postgres';
import { money } from '../lib/format';
import {
  caseMetrics,
  isFiltered,
  ledgerListing,
  type LedgerFilter,
} from '../lib/case-presentation';
import { WorkspaceShell } from './workspace-shell';
import { CaseTable } from './case-table';
import { browserUploadNotices, resolveNotice } from '../lib/notices';
import { MultiUpload } from './multi-upload';
import { UnreadDocuments } from './unread-documents';
import { UnattachedDocuments } from './unattached-documents';
import { PossibleDuplicates } from './possible-duplicates';
import { EmailThatFiledNothing } from './inbound-email';
import { WorkQueue, type QueueViewer } from './work-queue';

export interface Viewer {
  readonly email: string;
  readonly orgName: string;
  readonly role: string;
  /** The tenant this page is showing, when the switcher needs to mark it. */
  readonly orgId?: string;
  /** Every tenant the database says this person belongs to (`viewerOf`). */
  readonly workspaces?: readonly WorkspaceOption[];
}

export interface WorkspaceOption {
  readonly orgId: string;
  readonly name: string;
  readonly slug: string;
}

/**
 * The case list, as a pure function of what the database said.
 *
 * The route reads; this renders. Keeping them apart is what makes the rendering
 * testable without a signed-in browser — and the parts worth testing are the ones
 * a reviewer acts on: the money, the deadline, and the fact that text which came
 * out of somebody else's document is text and not markup.
 */
export function CaseList({
  viewer,
  cases,
  ledger,
  tally,
  queue,
  today,
  mayUpload,
  unread,
  unattached,
  attachTargets,
  duplicates,
  filedNothing,
  inboundDomain,
  notice,
  noticeAbout,
}: {
  viewer: Viewer;
  /**
   * The ledger's rows: the newest cases answering to `ledger.filter`, as many
   * as the store was asked for (`searchCases`).
   */
  cases: readonly CaseSummary[];
  /**
   * What the ledger was searched for, and how many cases answered however many
   * `cases` holds. With no filter, that is every case.
   */
  ledger: { readonly filter: LedgerFilter; readonly matching: number };
  /**
   * Every case the tenant has, counted by state, which is what the figures
   * are over. `cases` stops at the newest hundred; a figure summed from it
   * undercounted past that and did not say so.
   */
  tally: readonly CaseStateTally[];
  /**
   * What to work on next (ADR 0043): every case a person can act on now, most
   * urgent first, with who is asking so an approval the viewer may not give
   * says so. Shown to every member, `read_only` included — it is a reading of
   * the cases they can already see, and it offers no action of its own.
   */
  queue: { readonly read: ReviewQueueRead; readonly viewer: QueueViewer };
  today: Date;
  /** Whether this member's role may add a document; the database decides too. */
  mayUpload: boolean;
  /**
   * Documents that were stored and scanned clean and never read.
   *
   * Shown only to a member who may write, because the only thing to do about
   * one is ask for it to be read — and a reader who cannot ask would be looking
   * at a list of things they are not allowed to fix.
   */
  unread?: readonly UnreadDocument[] | undefined;
  /**
   * Documents that were read and that no case holds — evidence uploaded from
   * this list, which opens nothing of its own.
   *
   * Shown only to a member who may write, for `unread`'s reason: the only thing
   * to do about one is attach it, and a reader who cannot would be looking at a
   * list of things they are not allowed to file.
   */
  unattached?: readonly UnattachedDocument[] | undefined;
  /**
   * The open cases a document in `unattached` can be attached to, most urgent
   * first — the store's own read of every open case, not `cases`, which stops
   * at the newest hundred and which a search narrows: filing evidence on a
   * case should not depend on what was last typed into the ledger's search box.
   */
  attachTargets?: AttachTargets | undefined;
  /**
   * The pairs the matcher called possible duplicates and nobody has answered
   * (ADR 0032).
   *
   * Shown, like the unread documents, only to a member who may answer one — the
   * database refuses the rest, and a list of things you are not allowed to
   * resolve is not a list worth drawing. Nothing here merges two cases; the
   * section says so in its own words.
   */
  duplicates?: readonly PossibleDuplicatePair[] | undefined;
  /**
   * The emails that filed nothing over the last 30 days, per address (ADR
   * 0047 §11). Shown, like the lists beside it, only to a member who may add
   * documents: its rows name the address, and an address writes into this
   * workspace.
   */
  filedNothing?: readonly FiledNothingByAddress[] | undefined;
  /** This deployment's inbound domain, when it receives email. */
  inboundDomain?: string | undefined;
  /**
   * What happened to the last upload, as a notice *key* — never the sentence
   * itself, which arrives in a query string anybody can write
   * (`lib/notices.ts`). A key this app does not know shows nothing at all.
   */
  notice?: string | undefined;
  /** The validated fragments the key's text names, in order. */
  noticeAbout?: readonly string[] | undefined;
}) {
  const metrics = caseMetrics(tally);
  const total = metrics.totalCents;
  const caseCount = metrics.caseCount.toLocaleString('en-US');
  const plural = metrics.caseCount === 1 ? '' : 's';
  const said = resolveNotice(notice, noticeAbout ?? []);
  const searched = isFiltered(ledger.filter);
  const listing = ledgerListing(ledger.filter, cases.length, ledger.matching, metrics.caseCount);

  return (
    <WorkspaceShell viewer={viewer}>
      <main id="workspace-main" className="workspace-main dashboard-main">
        <div className="page-heading dashboard-heading">
          <div>
            <p className="eyebrow">YOUR WORKSPACE</p>
            <h1>Deductions</h1>
            <p className="page-description">
              {queue.read.total === 0
                ? 'No cases need attention right now.'
                : `${queue.read.total.toLocaleString('en-US')} case${queue.read.total === 1 ? '' : 's'} need attention.`}
            </p>
            <nav className="dashboard-jump" aria-label="On this page">
              <a href="#work-queue-title">Review queue</a>
              <a href="#ledger">All deductions</a>
              {mayUpload ? <a href="#documents">Documents</a> : null}
            </nav>
          </div>
          {mayUpload ? (
            <a className="button-link" href="#add-document">
              <span aria-hidden="true">＋</span> Add a document
            </a>
          ) : null}
        </div>
        {said === undefined ? null : (
          <p className={said.tone === 'good' ? 'notice sent' : 'notice bad'}>{said.text}</p>
        )}
        <WorkQueue queue={queue.read} today={today} viewer={queue.viewer} />
        <section className="metrics" aria-label="Deduction overview">
          <div className="metric featured">
            <span className="metric-label">TOTAL DEDUCTED</span>
            <strong>{money(total)}</strong>
            <span className="metric-note">
              Across {caseCount} recorded case{plural}
            </span>
          </div>
          <div className="metric">
            <span className="metric-label">OPEN CASES</span>
            <strong>{metrics.openCount.toLocaleString('en-US')}</strong>
            <span className="metric-note">Working toward an outcome</span>
          </div>
          <div className="metric">
            <span className="metric-label">APPROVAL STAGE</span>
            <strong>{metrics.approvalStageCount.toLocaleString('en-US')}</strong>
            <span className="metric-note">Review and submission</span>
          </div>
          <div className="metric">
            <span className="metric-label">KNOWN DEADLINES TO WATCH</span>
            <strong>
              {metrics.deadlineCount.toLocaleString('en-US')}
              <span className="metric-dot" aria-hidden="true" />
            </strong>
            <span className="metric-note">Due within {DUE_SOON_DAYS} days or overdue · unfiled</span>
          </div>
        </section>
        <section id="ledger" className="card ledger" aria-label="Deduction ledger">
          <div className="ledger-heading">
            <div>
              <h2>Deduction ledger</h2>
              <p className="ledger-summary">
                {metrics.caseCount === 0
                  ? 'No cases yet'
                  : `${caseCount} case${plural} · ${money(total)} deducted` +
                    // The figures are over every case; the table is the newest
                    // of them, or the newest of what a search matched.
                    (listing === '' ? '' : ` · ${listing}`)}
              </p>
            </div>
            <span className="ledger-tag">{searched ? 'SEARCH RESULTS' : 'ALL DEDUCTIONS'}</span>
          </div>
          {cases.length === 0 && !searched ? (
            <p className="empty">
              A case opens when a deduction notice arrives — by upload, or by email to this
              workspace&rsquo;s inbound address. Nothing is submitted anywhere until a person
              approves it.
            </p>
          ) : (
            <CaseTable
              cases={cases}
              matching={ledger.matching}
              filter={ledger.filter}
              todayISO={today.toISOString()}
            />
          )}
        </section>
        {mayUpload ? (
          <section id="documents" className="documents-area" aria-labelledby="documents-title">
            <div className="documents-heading">
              <div>
                <p className="eyebrow">FILE AND ORGANIZE</p>
                <h2 id="documents-title">Documents</h2>
              </div>
              <p>{(unattached ?? []).length.toLocaleString('en-US')} awaiting a case</p>
            </div>
            <MultiUpload
              formId="add-document"
              className="card upload"
              inputId="file"
              buttonLabel="Read them"
              notices={browserUploadNotices()}
            >
              <label htmlFor="file">
                <strong>Add documents</strong>
                <span>
                  A deduction notice opens a case. Anything else is read and waits for a case to be
                  attached to. Nothing is submitted anywhere either way.
                </span>
              </label>
            </MultiUpload>
            <PossibleDuplicates pairs={duplicates ?? []} />
            <UnattachedDocuments
              documents={unattached ?? []}
              targets={attachTargets ?? { rows: [], total: 0, limit: ATTACH_TARGETS_LIMIT }}
            />
            <EmailThatFiledNothing groups={filedNothing ?? []} domain={inboundDomain} />
            <UnreadDocuments documents={unread ?? []} />
          </section>
        ) : null}
        <footer className="workspace-footer">
          <span>YOUR REVENUE. ORCHESTRATED.</span>
          <span>mozart.</span>
        </footer>
      </main>
    </WorkspaceShell>
  );
}

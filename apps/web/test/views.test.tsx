import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CASE_STATES, MAX_RATIONALE_LENGTH, cents } from '@recouple/core-domain';
import { DECLINE_REASONS } from '@recouple/store-postgres';
import type { AttachTargets, CaseDocument, CaseSummary, StoredField } from '@recouple/store-postgres';
import { isCanonicalReasonCode } from '@recouple/core-domain';
import type {
  CaseWorkflow,
  DocumentHold,
  PossibleDuplicatePair,
  UnattachedDocument,
  UnreadDocument,
} from '@recouple/pipeline';
import { CaseList, type Viewer } from '../components/case-list';
import { UnreadDocuments, waiting } from '../components/unread-documents';
import {
  caseLabel,
  holdLine,
  mayOpenFrom,
  offeredLine,
  UnattachedDocuments,
} from '../components/unattached-documents';
import { CaseReview } from '../components/case-review';
import {
  basisSentence,
  CaseMergeNotes,
  MERGE_REFUSAL_SENTENCES,
  PossibleDuplicates,
} from '../components/possible-duplicates';
import { DISPUTE_REASONS } from '../components/case-actions';
import { confidencePercent, deadline, fieldLabel, money } from '../lib/format';
import { displaysInline } from '../lib/document-types';
import { tallyOf } from './case-tally';

const viewer: Viewer = { email: 'ap@harborline.test', orgName: 'Harborline Foods', role: 'analyst' };
/** An empty review queue, for the tests about the rest of the list. */
const NO_QUEUE = {
  read: { rows: [], total: 0, waitingOnRetailer: 0, limit: 500 },
  viewer: { userId: 'aaaaaaaa-1111-2222-3333-444444444444', mayApprove: false },
} as const;
const today = new Date('2026-09-18T12:00:00Z');

type CaseListProps = Parameters<typeof CaseList>[0];

/**
 * The list for a tenant whose every case is in `cases`, with the figures the
 * store would tally for them, so a test's rows and its figures describe one
 * tenant. Unsearched unless a test says otherwise, and the attach control
 * offers the same rows, as the page reads them. The tests about figures that
 * reach past the rows render `CaseList`.
 */
function EveryCaseList(
  props: Omit<CaseListProps, 'tally' | 'ledger'> & Partial<Pick<CaseListProps, 'ledger'>>,
) {
  return (
    <CaseList
      {...props}
      ledger={props.ledger ?? { filter: {}, matching: props.cases.length }}
      tally={tallyOf(props.cases, props.today)}
    />
  );
}

/**
 * A case summary for a test. An override of `undefined` drops the key rather
 * than setting it: under `exactOptionalPropertyTypes` those are different
 * types, and "this case has no debtor" is the absence, not the value.
 */
function summary(
  overrides: { [K in keyof CaseSummary]?: CaseSummary[K] | undefined } = {},
): CaseSummary {
  const merged: Record<string, unknown> = {
    deductionId: '11111111-2222-3333-4444-555555555555',
    state: 'classified',
    claimId: 'APDP-99812',
    deductionAmountCents: 312_000,
    disputeDeadline: '2026-12-07',
    debtorName: 'Walmart (APDP)',
    retailerKey: 'walmart_apdp',
    // The column's default, and what every case opened before ADR 0028 is.
    discoveredVia: 'notice',
    documentCount: 4,
    createdAt: '2026-09-10T00:00:00Z',
    ...overrides,
  };
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) delete merged[key];
  }
  return merged as unknown as CaseSummary;
}

/** The people in these tests: who prepared, who approves, who else is looking. */
const PREPARER = 'aaaaaaaa-1111-2222-3333-444444444444';
const APPROVER = 'bbbbbbbb-1111-2222-3333-444444444444';
const SECOND_ANALYST = 'cccccccc-1111-2222-3333-444444444444';
const NOTICE_DOC = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

/**
 * One `getWorkflow` read, at whichever point in the workflow a test needs.
 *
 * Built up rather than switched on: a case that has an approval has a packet,
 * and a case that has a packet has a decision. Assembling it any other way
 * would let a test assert a page state the store can never produce.
 */
function workflow(
  overrides: {
    state?: CaseWorkflow['state'];
    rationale?: string;
    note?: string;
    /** Whether a second person has approved the packet yet. */
    approved?: boolean;
  } = {},
): CaseWorkflow {
  const state = overrides.state ?? 'awaiting_approval';
  const decision = {
    decisionId: '99999999-1111-2222-3333-444444444444',
    deductionId: '11111111-2222-3333-4444-555555555555',
    reason: 'shortage_quantity',
    rationale: overrides.rationale ?? 'The signed BOL shows all 30 cases delivered.',
    preparedBy: PREPARER,
    decidedAt: new Date('2026-09-19T14:02:00Z'),
  } as const;
  const packet = {
    packetId: '88888888-1111-2222-3333-444444444444',
    decisionId: decision.decisionId,
    contentHash: 'f00dcafe1234deadbeef5678f00dcafe1234deadbeef5678f00dcafe12345678',
    narrative: '# Dispute cover sheet\n\nWalmart (APDP) · $3,120.00 deducted',
    fileDocumentIds: [NOTICE_DOC, '77777777-1111-2222-3333-444444444444'],
    assembledBy: PREPARER,
    assembledAt: new Date('2026-09-19T14:05:00Z'),
  } as const;
  const approval = {
    approvalId: '66666666-1111-2222-3333-444444444444',
    decisionId: decision.decisionId,
    approverId: APPROVER,
    packetHash: packet.contentHash,
    ...(overrides.note === undefined ? {} : { note: overrides.note }),
    approvedAt: new Date('2026-09-19T15:00:00Z'),
  } as const;
  const submission = {
    submissionId: '55555555-1111-2222-3333-444444444444',
    decisionId: decision.decisionId,
    channel: 'manual_portal',
    packetHash: packet.contentHash,
    confirmationNumber: 'WM-DISPUTE-99812',
    submittedAt: new Date('2026-09-19T16:00:00Z'),
  } as const;

  const base = { deductionId: decision.deductionId, state };
  if (state === 'classified') return base;
  if (state === 'analyst_review') return { ...base, decision };
  if (state === 'awaiting_approval') {
    return overrides.approved === true
      ? { ...base, decision, packet, approval }
      : { ...base, decision, packet };
  }
  return { ...base, decision, packet, approval, submission };
}

function field(overrides: Partial<StoredField> = {}): StoredField {
  return {
    documentId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    filename: 'walmart-apdp-notice.pdf',
    mimeType: 'application/pdf',
    docType: 'deduction_notice',
    fieldPath: 'claim_id',
    value: 'APDP-99812',
    confidence: 0.99,
    sourcePage: 1,
    sourceQuote: 'Claim ID: APDP-99812',
    sourceBbox: null,
    quoteVerified: true,
    ...overrides,
  };
}

/**
 * A document on the case, as `caseDocuments` lists it. The defaults are the
 * document `field()` names: the case's notice, read for this case.
 */
function document(overrides: Partial<CaseDocument> = {}): CaseDocument {
  return {
    documentId: NOTICE_DOC,
    filename: 'walmart-apdp-notice.pdf',
    mimeType: 'application/pdf',
    docType: 'deduction_notice',
    role: 'notice',
    read: true,
    readForCase: true,
    ...overrides,
  };
}

/**
 * The page itself, without the workspace shell around it. The sidebar carries
 * a Sign out form on every page (pilot E4), which is not an action on a case;
 * "no way to act on this case" is a claim about what the page offers.
 */
function pageContent(html: string): string {
  const main = /<main\b[\s\S]*<\/main>/.exec(html)?.[0];
  if (main === undefined) throw new Error('expected the page to render a <main>');
  return main;
}

describe('money and deadlines', () => {
  it('renders integer cents without ever holding a float', () => {
    expect(money(312_000)).toBe('$3,120.00');
    expect(money(5)).toBe('$0.05');
    expect(money(0)).toBe('$0.00');
    expect(money(-12_345)).toBe('-$123.45');
    expect(money(123_456_789)).toBe('$1,234,567.89');
  });

  it('says how long is left, not a date the reader has to subtract', () => {
    expect(deadline('2026-12-07', today)?.label).toBe('80d left');
    expect(deadline('2026-12-07', today)?.tone).toBe('ok');
    expect(deadline('2026-09-25', today)?.tone).toBe('due-soon');
    expect(deadline('2026-09-18', today)).toEqual({ label: 'due today', tone: 'overdue' });
    expect(deadline('2026-09-11', today)).toEqual({ label: '7d overdue', tone: 'overdue' });
    expect(deadline(undefined, today)).toBeUndefined();
  });

  it('turns a schema path into something a person reads', () => {
    expect(fieldLabel('claim_id')).toBe('claim id');
    expect(fieldLabel('lines[0].qty_received')).toBe('lines 1 · qty received');
  });
});

describe('the case list', () => {
  it('totals the deductions and links each case', () => {
    const html = renderToStaticMarkup(
      <EveryCaseList queue={NO_QUEUE} mayUpload viewer={viewer} cases={[summary(), summary({
        deductionId: '99999999-8888-7777-6666-555555555555',
        claimId: 'KS-40112',
        deductionAmountCents: 88_450,
        debtorName: 'KeHE',
        disputeDeadline: '2026-09-11',
        documentCount: 1,
      })]} today={today} />,
    );
    expect(html).toContain('2 cases · $4,004.50 deducted');
    expect(html).toContain('href="/cases/11111111-2222-3333-4444-555555555555"');
    expect(html).toContain('7d overdue');
    expect(html).toContain('1 doc<');
    expect(html).toContain('4 docs');
  });

  it('takes its figures from every case, and says the table holds only the newest', () => {
    // A tenant with 240 cases, of which the store listed the newest two. The
    // figures are the tally's; before, they were summed from the two rows.
    const html = renderToStaticMarkup(
      <CaseList
        queue={NO_QUEUE}
        mayUpload
        viewer={viewer}
        cases={[summary(), summary({ deductionId: '99999999-8888-7777-6666-555555555555' })]}
        ledger={{ filter: {}, matching: 240 }}
        tally={[
          { state: 'classified', cases: 150, deductedCents: 15_000_000, dueSoonOrPast: 12 },
          { state: 'awaiting_approval', cases: 4, deductedCents: 400_000, dueSoonOrPast: 3 },
          { state: 'submitted', cases: 6, deductedCents: 600_000, dueSoonOrPast: 6 },
          { state: 'won', cases: 79, deductedCents: 7_900_000, dueSoonOrPast: 79 },
          { state: 'merged', cases: 1, deductedCents: 100_000, dueSoonOrPast: 1 },
        ]}
        today={today}
      />,
    );
    expect(html).toContain('Across 240 recorded cases');
    expect(html).toContain('$239,000.00');
    expect(html).toContain('240 cases · $239,000.00 deducted · the newest 2 listed below');
    const figure = (label: string) =>
      new RegExp(`${label}</span><strong>(\\d+)`).exec(html)?.[1];
    expect(figure('OPEN CASES')).toBe('160');
    expect(figure('APPROVAL STAGE')).toBe('4');
    expect(figure('DEADLINES TO WATCH')).toBe('15');
    // The table is still the rows the store listed, and says of how many.
    expect(html).toContain('2 of 240 cases');
  });

  it('says nothing about the newest when the table holds every case', () => {
    const html = renderToStaticMarkup(
      <EveryCaseList queue={NO_QUEUE} mayUpload viewer={viewer} cases={[summary()]} today={today} />,
    );
    expect(html).toContain('Across 1 recorded case<');
    expect(html).not.toContain('listed below');
  });

  it('shows the name a notice printed when no debtor answers to it, and says so', () => {
    // The whole point of ADR 0019: a case whose retailer did not resolve is not
    // a case with no retailer. It reads as printed, marked unmatched, because an
    // unmatched retailer has no playbook and no routing behind it.
    const html = renderToStaticMarkup(
      <EveryCaseList
        queue={NO_QUEUE}
        mayUpload
        viewer={viewer}
        cases={[
          summary({
            debtorName: undefined,
            retailerKey: undefined,
            retailerNameAsPrinted: 'WALMART STORES, INC.',
          }),
        ]}
        today={today}
      />,
    );
    expect(html).toContain('WALMART STORES, INC.');
    expect(html).toContain('not matched');
  });

  it('shows a dash when nothing was read, not an invented retailer', () => {
    const html = renderToStaticMarkup(
      <EveryCaseList
        queue={NO_QUEUE}
        mayUpload
        viewer={viewer}
        cases={[summary({ debtorName: undefined, retailerKey: undefined })]}
        today={today}
      />,
    );
    expect(html).toContain('—');
    expect(html).not.toContain('not matched');
  });

  it('prefers the debtor over the printed name once one has matched', () => {
    const html = renderToStaticMarkup(
      <EveryCaseList
        queue={NO_QUEUE}
        mayUpload
        viewer={viewer}
        cases={[summary({ retailerNameAsPrinted: 'WALMART STORES, INC.' })]}
        today={today}
      />,
    );
    expect(html).toContain('Walmart (APDP)');
    expect(html).not.toContain('WALMART STORES, INC.');
    expect(html).not.toContain('not matched');
  });

  it('shows the invoice a remittance-originated case was opened against', () => {
    // A case a remittance line opened has no claim anybody filed: its claim id
    // is the advice's own payment reference and invoice number (ADR 0028 §7),
    // which is not what a person looks a case up by. The invoice is.
    const html = renderToStaticMarkup(
      <EveryCaseList
        queue={NO_QUEUE}
        mayUpload
        viewer={viewer}
        cases={[
          summary({
            discoveredVia: 'remittance_line',
            claimId: 'ACH-CW-880412:INV-271003',
            invoiceNumber: 'INV-271003',
            reasonCodeAsPrinted: 'SHORT',
          }),
        ]}
        today={today}
      />,
    );
    expect(html).toContain('invoice INV-271003');
  });

  it('says nothing about an invoice for a case that has none', () => {
    const html = renderToStaticMarkup(
      <EveryCaseList queue={NO_QUEUE} mayUpload viewer={viewer} cases={[summary()]} today={today} />,
    );
    // The rows, not the page: the search box says it searches invoices.
    const rows = html.slice(html.indexOf('<tbody>'), html.indexOf('</tbody>'));
    expect(rows).toContain('APDP-99812');
    expect(rows).not.toContain('invoice');
  });

  it('searches every case with a GET form to this page, not the rows already here', () => {
    // The table used to filter the newest hundred in the browser, so an older
    // case could not be found at all, and its states were only those present.
    const html = renderToStaticMarkup(
      <EveryCaseList queue={NO_QUEUE} mayUpload viewer={viewer} cases={[summary()]} today={today} />,
    );
    const form = /<form[^>]*role="search"[^>]*>/.exec(html)?.[0] ?? '';
    expect(form).toContain('method="get"');
    expect(form).toContain('action="/#ledger"');
    expect(html).toContain('id="ledger"');
    expect(html).toContain('name="q"');
    expect(html).toContain('placeholder="Search claim, invoice or customer…"');
    expect(html).toContain('name="state"');
    // Every state, from `CASE_STATES`, though the one row here is `classified`.
    for (const state of CASE_STATES) {
      expect(html).toContain(`<option value="${state}">${state.replace(/_/g, ' ')}</option>`);
    }
    expect(html).toContain('<option value="" selected="">All states</option>');
    expect(html).toContain('ALL DEDUCTIONS');
    expect(html).not.toContain('>Clear<');
  });

  it('says what a search matched, keeps what was asked in the form, and offers to clear it', () => {
    const html = renderToStaticMarkup(
      <EveryCaseList
        queue={NO_QUEUE}
        mayUpload
        viewer={viewer}
        cases={[summary({ state: 'awaiting_approval' })]}
        ledger={{ filter: { query: 'walmart', state: 'awaiting_approval' }, matching: 1 }}
        today={today}
      />,
    );
    expect(html).toContain('1 case · $3,120.00 deducted · 1 case matches “walmart” in awaiting approval');
    expect(html).toContain('SEARCH RESULTS');
    expect(html).toContain('value="walmart"');
    expect(html).toContain('<option value="awaiting_approval" selected="">awaiting approval</option>');
    expect(html).toContain('href="/#ledger"');
    expect(html).toContain('1 of 1 case<');
  });

  it('says when a search matched more than the table lists', () => {
    // A tenant of 5,000 cases, 1,204 of them Walmart's: the table is the
    // newest hundred of those, and the figures are still every case.
    const rows = Array.from({ length: 100 }, (_, n) =>
      summary({ deductionId: `11111111-2222-3333-4444-${String(n).padStart(12, '0')}` }),
    );
    const html = renderToStaticMarkup(
      <CaseList
        queue={NO_QUEUE}
        mayUpload
        viewer={viewer}
        cases={rows}
        ledger={{ filter: { query: 'walmart' }, matching: 1_204 }}
        tally={[{ state: 'classified', cases: 5_000, deductedCents: 50_000_000, dueSoonOrPast: 0 }]}
        today={today}
      />,
    );
    expect(html).toContain(
      '5,000 cases · $500,000.00 deducted · 1,204 cases match “walmart”, the newest 100 listed below',
    );
    expect(html).toContain('100 of 1,204 cases');
  });

  it('shows the search, not the first-run text, when a search matched nothing', () => {
    const html = renderToStaticMarkup(
      <CaseList
        queue={NO_QUEUE}
        mayUpload
        viewer={viewer}
        cases={[]}
        ledger={{ filter: { query: 'no-such-claim' }, matching: 0 }}
        tally={[{ state: 'classified', cases: 240, deductedCents: 2_400_000, dueSoonOrPast: 0 }]}
        today={today}
      />,
    );
    expect(html).toContain('240 cases · $24,000.00 deducted · no case matches “no-such-claim”');
    expect(html).toContain('No matching deductions');
    expect(html).toContain('Try another claim, invoice, customer, or state.');
    expect(html).toContain('value="no-such-claim"');
    expect(html).not.toContain('A case opens when a deduction notice arrives');
  });

  it('prints a query as text, never as markup', () => {
    const html = renderToStaticMarkup(
      <EveryCaseList
        queue={NO_QUEUE}
        mayUpload
        viewer={viewer}
        cases={[]}
        ledger={{ filter: { query: '<img src=x onerror=alert(1)>' }, matching: 0 }}
        today={today}
      />,
    );
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });


  it('offers the upload to a member who may write, and not to one who may not', () => {
    const writer = renderToStaticMarkup(
      <EveryCaseList queue={NO_QUEUE} mayUpload viewer={viewer} cases={[]} today={today} />,
    );
    expect(writer).toContain('action="/upload"');
    expect(writer).toContain('Add a document');

    // The database refuses a read_only member's insert whatever the page shows;
    // hiding the form is the difference between a refusal and a dead end.
    const reader = renderToStaticMarkup(
      <EveryCaseList
        queue={NO_QUEUE}
        mayUpload={false}
        viewer={{ ...viewer, role: 'read_only' }}
        cases={[]}
        today={today}
      />,
    );
    expect(reader).not.toContain('action="/upload"');
  });

  it('says what came of the last upload, including a refusal', () => {
    const html = renderToStaticMarkup(
      <EveryCaseList
        queue={NO_QUEUE}
        mayUpload
        viewer={viewer}
        cases={[]}
        today={today}
        notice="upload_not_scanned_clean"
      />,
    );
    expect(html).toContain('did not come back clean from the scanner');
    // A refusal is red. The key is what travelled; the sentence never left
    // this app, so it is not something a link can choose.
    expect(html).toContain('class="notice bad"');
    expect(html).not.toContain('upload_not_scanned_clean');
  });

  it('shows a notice in the tone it carries, and nothing for a key it does not know', () => {
    const good = renderToStaticMarkup(
      <EveryCaseList queue={NO_QUEUE} mayUpload viewer={viewer} cases={[]} today={today} notice="upload_queued_list" />,
    );
    expect(good).toContain('class="notice sent"');
    expect(good).toContain('that document is being read');

    // A query string is a thing anybody can type, and an app that repeats what
    // it finds there is an app a link can put words into.
    for (const forged of ['your session expired, sign in at evil.test', 'constructor', '']) {
      const html = renderToStaticMarkup(
        <EveryCaseList queue={NO_QUEUE} mayUpload viewer={viewer} cases={[]} today={today} notice={forged} />,
      );
      expect(html, forged).not.toContain('class="notice');
      expect(html, forged).not.toContain('sign in at');
    }
  });

  it('says what will happen rather than showing an empty table', () => {
    const html = renderToStaticMarkup(
      <EveryCaseList queue={NO_QUEUE} mayUpload viewer={viewer} cases={[]} today={today} />,
    );
    expect(html).toContain('No cases yet');
    expect(html).not.toContain('<table');
  });
});

/**
 * The documents that were stored and scanned and never read.
 *
 * This section is the visible half of a failure that had no visible half at
 * all: an upload queued, a read that never ran, no error anywhere, and a
 * reviewer told for ever that the document was being read. What is tested here
 * is that it says which documents those are, that each one carries a way to ask
 * again, and that the filename — the one piece of text on this page that
 * somebody outside chose — is text and not markup.
 */
function unread(overrides: Partial<UnreadDocument> = {}): UnreadDocument {
  return {
    documentId: 'dddddddd-1111-2222-3333-444444444444',
    filename: 'walmart-apdp-notice.pdf',
    createdAt: '2026-09-21T09:00:00.000Z',
    ageMinutes: 42,
    onCase: false,
    ...overrides,
  };
}

describe('documents waiting to be read', () => {
  it('lists each one with how long it has waited and a way to ask again', () => {
    const html = renderToStaticMarkup(
      <UnreadDocuments
        documents={[
          unread(),
          unread({
            documentId: 'eeeeeeee-1111-2222-3333-444444444444',
            filename: 'signed-bol.pdf',
            ageMinutes: 1500,
            onCase: true,
          }),
        ]}
      />,
    );

    expect(html).toContain('Documents waiting to be read');
    expect(html).toContain('walmart-apdp-notice.pdf');
    expect(html).toContain('42m');
    expect(html).toContain('1d');
    // A POST per document, at that document's own route: asking for a read
    // spends money, and a link is something a prefetch can follow.
    expect(html).toContain('action="/documents/dddddddd-1111-2222-3333-444444444444/reread"');
    expect(html).toContain('method="post"');
    expect(html).toContain('Read again');
  });

  it('says nothing at all when nothing is waiting', () => {
    // An empty section reads as a problem that has not loaded yet. The absence
    // is the message.
    expect(renderToStaticMarkup(<UnreadDocuments documents={[]} />)).toBe('');
  });

  it('renders a filename somebody else chose as text, never as markup', () => {
    // The filename comes off an upload, which means it comes from outside. It
    // is the only untrusted string on this page and it is rendered, not built
    // into anything (invariant 4).
    const html = renderToStaticMarkup(
      <UnreadDocuments
        documents={[
          unread({
            filename: '<img src=x onerror="alert(1)">.pdf',
          }),
        ]}
      />,
    );
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('onerror="alert(1)"');
    // Present, but as text.
    expect(html).toContain('&lt;img src=x onerror=');
  });

  it('shows a dash for a document whose row kept no name', () => {
    const html = renderToStaticMarkup(<UnreadDocuments documents={[unread({ filename: '' })]} />);
    expect(html).toContain('—');
  });

  it('reads the wait in the largest unit that is still honest', () => {
    expect(waiting(0)).toBe('0m');
    expect(waiting(59)).toBe('59m');
    expect(waiting(60)).toBe('1h');
    expect(waiting(1439)).toBe('23h');
    expect(waiting(1440)).toBe('1d');
  });

  it('is on the case list for a writer, and not for a reader', () => {
    // A reader cannot ask for a read, so a list of documents they are not
    // allowed to fix is worse than no list.
    const writer = renderToStaticMarkup(
      <EveryCaseList queue={NO_QUEUE} mayUpload viewer={viewer} cases={[]} today={today} unread={[unread()]} />,
    );
    expect(writer).toContain('Documents waiting to be read');

    const reader = renderToStaticMarkup(
      <EveryCaseList
        queue={NO_QUEUE}
        mayUpload={false}
        viewer={{ ...viewer, role: 'read_only' }}
        cases={[]}
        today={today}
        unread={[unread()]}
      />,
    );
    expect(reader).not.toContain('Documents waiting to be read');
  });

  it('is absent from a case list with nothing waiting', () => {
    const html = renderToStaticMarkup(
      <EveryCaseList queue={NO_QUEUE} mayUpload viewer={viewer} cases={[]} today={today} />,
    );
    expect(html).not.toContain('Documents waiting to be read');
  });
});

describe('documents that were read and that no case holds', () => {
  function loose(overrides: Partial<UnattachedDocument> = {}): UnattachedDocument {
    return {
      documentId: 'eeeeeeee-1111-2222-3333-444444444444',
      filename: '08_log-202.jpg',
      createdAt: '2026-09-23T15:56:16.000Z',
      docType: 'pod',
      // Required since ADR 0044: the classification's own confidence.
      confidence: 0.98,
      ...overrides,
    };
  }

  /** What `attachTargets` answers for a tenant whose every open case is in `rows`. */
  function offered(rows: readonly CaseSummary[], total = rows.length): AttachTargets {
    return { rows, total, limit: 250 };
  }

  it('says what each one was read as, and offers the open cases to attach it to', () => {
    const open = summary({ claimId: 'LOG-202', debtorName: undefined, retailerNameAsPrinted: 'Westhaven Paper Supply' });
    const closed = summary({
      deductionId: '99999999-2222-3333-4444-555555555555',
      claimId: 'CLOSED-1',
      state: 'won',
    });
    const html = renderToStaticMarkup(
      <UnattachedDocuments documents={[loose()]} targets={offered([open, closed])} />,
    );

    expect(html).toContain('Read, not on a case');
    expect(html).toContain('08_log-202.jpg');
    expect(html).toContain('proof of delivery');
    // A POST to the document's own route, carrying the case chosen.
    expect(html).toContain('action="/documents/eeeeeeee-1111-2222-3333-444444444444/attach"');
    expect(html).toContain('method="post"');
    expect(html).toContain('name="caseId"');
    expect(html).toContain(caseLabel(open));
    // A closed case is not somewhere evidence goes.
    expect(html).not.toContain('CLOSED-1');
    // And it says the thing a reviewer would otherwise have to find out.
    expect(html).toContain('not read again');
  });

  it('labels a case by its claim, who took the money and how much', () => {
    expect(
      caseLabel(summary({ claimId: 'LOG-202', debtorName: undefined, retailerNameAsPrinted: 'Westhaven Paper Supply' })),
    ).toBe('LOG-202 · Westhaven Paper Supply · $3,120.00');
    // A case the ledger or a remittance opened has no claim: it is named by the
    // invoice that was paid short, which is what a reviewer would look for.
    expect(
      caseLabel(
        summary({
          claimId: undefined,
          invoiceNumber: '1007',
          debtorName: undefined,
          retailerNameAsPrinted: 'John Melton',
          deductionAmountCents: 45_000,
        }),
      ),
    ).toBe('invoice 1007 · John Melton · $450.00');
    // And only when there is nothing to name it by does it say so.
    expect(caseLabel(summary({ claimId: undefined, debtorName: undefined }))).toBe(
      'no claim id · retailer unknown · $3,120.00',
    );
  });

  it('says there is nowhere to attach it yet when no case is open', () => {
    const html = renderToStaticMarkup(
      <UnattachedDocuments documents={[loose()]} targets={offered([summary({ state: 'lost' })])} />,
    );
    expect(html).toContain('No open case yet');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('Open cases are listed');
  });

  it('offers the open cases the store read for it, not the newest the ledger lists', () => {
    // The control used to be handed the ledger's rows — the newest hundred — so
    // an older open case was never offered, however urgent. Here the ledger
    // lists one new case, and the store's read of open cases puts an old,
    // overdue one first.
    const newest = summary({ deductionId: '99999999-8888-7777-6666-555555555555', claimId: 'NEW-1' });
    const oldUrgent = summary({
      deductionId: '00000000-1111-2222-3333-444444444444',
      claimId: 'OLD-7',
      disputeDeadline: '2026-09-17',
      createdAt: '2025-09-01T09:00:00Z',
    });
    const html = renderToStaticMarkup(
      <EveryCaseList
        queue={NO_QUEUE}
        mayUpload
        viewer={viewer}
        cases={[newest]}
        today={today}
        unattached={[loose()]}
        attachTargets={offered([oldUrgent])}
      />,
    );

    expect(html).toContain(`<option value="${oldUrgent.deductionId}">${caseLabel(oldUrgent)}</option>`);
    // A case is offered because the store's read holds it, not because the
    // ledger lists it.
    expect(html).not.toContain(`<option value="${newest.deductionId}"`);
    expect(html).toContain('Open cases are listed most urgent first, as the review queue orders them.');
  });

  it('keeps the store’s order', () => {
    const first = summary({ deductionId: '00000000-1111-2222-3333-444444444444', claimId: 'FIRST-1' });
    const second = summary({ deductionId: '00000000-5555-2222-3333-444444444444', claimId: 'SECOND-2' });
    const html = renderToStaticMarkup(
      <UnattachedDocuments documents={[loose()]} targets={offered([second, first])} />,
    );
    expect(html.indexOf(caseLabel(second))).toBeGreaterThan(-1);
    expect(html.indexOf(caseLabel(second))).toBeLessThan(html.indexOf(caseLabel(first)));
  });

  it('says how many open cases it is not listing when the store cut the list', () => {
    const rows = Array.from({ length: 250 }, (_, i) =>
      summary({ deductionId: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`, claimId: `C-${i}` }),
    );
    expect(offeredLine(250, offered(rows, 1_612))).toBe(
      'Open cases are listed most urgent first, as the review queue orders them. This workspace ' +
        'has 1,612: the first 250 are listed, and the other 1,362 are not. Any open case can ' +
        'take one of these from its own page.',
    );
    // Nothing about a cut when there was none.
    expect(offeredLine(250, offered(rows))).toBe(
      'Open cases are listed most urgent first, as the review queue orders them.',
    );

    const html = renderToStaticMarkup(
      <UnattachedDocuments documents={[loose()]} targets={offered(rows, 1_612)} />,
    );
    expect(html).toContain('This workspace has 1,612: the first 250 are listed, and the other 1,362 are not.');
    expect(html.match(/<option value="0/g)).toHaveLength(250);
  });

  it('renders a filename as text, never as markup', () => {
    const html = renderToStaticMarkup(
      <UnattachedDocuments
        documents={[loose({ filename: '<img src=x onerror=alert(1)>.jpg' })]}
        targets={offered([summary()])}
      />,
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('says how sure the classifier was for a document nobody held', () => {
    const html = renderToStaticMarkup(
      <UnattachedDocuments documents={[loose({ confidence: 0.98 })]} targets={offered([summary()])} />,
    );
    expect(html).toContain('read at 98%');
    expect(html).not.toContain('Held:');
    expect(html).not.toContain('/open-case');
  });

  describe('a document a read held for a person (ADR 0044)', () => {
    function hold(overrides: Partial<DocumentHold> = {}): DocumentHold {
      return {
        documentId: 'eeeeeeee-1111-2222-3333-444444444444',
        orgId: 'ffffffff-1111-2222-3333-444444444444',
        docType: 'remittance_advice',
        confidence: 0.75,
        floor: 0.95,
        reason: 'below_floor',
        ...overrides,
      };
    }
    const heldRow = (h: DocumentHold, extra: Partial<UnattachedDocument> = {}) =>
      loose({ docType: h.docType, confidence: 0.75, hold: h, ...extra });

    it('says it was read below the floor, by how much, and offers to open the case', () => {
      const html = renderToStaticMarkup(
        <UnattachedDocuments documents={[heldRow(hold())]} targets={offered([summary()])} />,
      );

      expect(html).toContain(
        'Held: read as a remittance advice at 75% confidence; this workspace opens a case on its ' +
          'own at 95% or above.',
      );
      // A POST to the document's own route, which reads nothing.
      expect(html).toContain(
        'action="/documents/eeeeeeee-1111-2222-3333-444444444444/open-case"',
      );
      expect(html).toContain('Open a case from it');
      // And it can still be attached as evidence instead.
      expect(html).toContain('/attach"');
    });

    it('names the fields a misfit notice is missing, and still offers to open it with them empty', () => {
      // A notice one field short opens with that field empty, the way it always
      // did on its own (ADR 0044); the line says so, and attaching stays offered.
      const h = hold({
        docType: 'deduction_notice',
        confidence: 0.99,
        reason: 'type_did_not_fit',
        fields: ['deduction_date', 'lines[0].reason_code'],
      });
      const html = renderToStaticMarkup(
        <UnattachedDocuments documents={[heldRow(h)]} targets={offered([summary()])} />,
      );

      expect(html).toContain(
        'Held: read as a deduction notice, but the reading does not fit that type (missing: ' +
          'deduction date, lines 1 · reason code). Opening a case from it opens one with what was ' +
          'read, and the missing fields stay empty; or attach it to a case as evidence.',
      );
      expect(html).toContain('action="/documents/eeeeeeee-1111-2222-3333-444444444444/open-case"');
      expect(html).toContain('/attach"');
    });

    it('offers no open for a remittance with no lines, and says why', () => {
      const noLines = hold({ reason: 'type_did_not_fit', confidence: 0.99, fields: ['lines'] });
      expect(mayOpenFrom(noLines)).toBe(false);
      expect(holdLine(noLines)).toBe(
        'Held: read as a remittance advice, but the reading does not fit that type (missing: ' +
          'lines). With no lines there is nothing to open a case from — attach it to a case as ' +
          'evidence instead.',
      );
      const html = renderToStaticMarkup(
        <UnattachedDocuments documents={[heldRow(noLines)]} targets={offered([summary()])} />,
      );
      expect(html).not.toContain('/open-case');
      expect(html).toContain('/attach"');

      // Doubted *and* no lines: the same answer, after the doubt.
      expect(holdLine(hold({ fields: ['lines'] }))).toBe(
        'Held: read as a remittance advice at 75% confidence; this workspace opens a case on its ' +
          'own at 95% or above. Also, the reading does not fit that type (missing: lines). With no ' +
          'lines there is nothing to open a case from — attach it to a case as evidence instead.',
      );
      expect(mayOpenFrom(hold({ fields: ['lines'] }))).toBe(false);
    });

    it('says an emailed notice is held because it came by email, and still offers to open it', () => {
      // ADR 0047 §7: however sure the reading, no email opens a case by itself.
      const byEmail = hold({ docType: 'deduction_notice', confidence: 0.99, reason: 'by_email' });
      expect(holdLine(byEmail)).toBe(
        'Held: read as a deduction notice, and it arrived by email. No email opens a case on its ' +
          'own — a person decides each time.',
      );
      expect(mayOpenFrom(byEmail)).toBe(true);
      const html = renderToStaticMarkup(
        <UnattachedDocuments documents={[heldRow(byEmail)]} targets={offered([summary()])} />,
      );
      expect(html).toContain('/open-case"');
    });

    it('offers open for every other hold, doubted, misfit or both', () => {
      expect(mayOpenFrom(hold())).toBe(true);
      expect(mayOpenFrom(hold({ fields: ['lines[0].invoice_number'] }))).toBe(true);
      expect(mayOpenFrom(hold({ reason: 'type_did_not_fit', fields: [] }))).toBe(true);
      expect(
        mayOpenFrom(hold({ docType: 'deduction_notice', reason: 'type_did_not_fit', fields: ['lines'] })),
      ).toBe(true);
      expect(holdLine(hold({ docType: 'deduction_notice', fields: ['deduction_date'] }))).toBe(
        'Held: read as a deduction notice at 75% confidence; this workspace opens a case on its ' +
          'own at 95% or above. Also, the reading does not fit that type (missing: deduction date). ' +
          'Opening a case from it opens one with what was read, and the missing fields stay ' +
          'empty; or attach it to a case as evidence.',
      );
      // A misfit the schema could name no field of is still a misfit, and says so.
      expect(holdLine(hold({ reason: 'type_did_not_fit', fields: [] }))).toBe(
        'Held: read as a remittance advice, but the reading does not fit that type. Opening a ' +
          'case from it opens one with what was read, and the missing fields stay empty; or ' +
          'attach it to a case as evidence.',
      );
    });

    it('never rounds a doubted reading up to the floor it missed', () => {
      expect(confidencePercent(0.94995)).toBe('94.99%');
      expect(confidencePercent(0.9499)).toBe('94.99%');
      expect(confidencePercent(0.95)).toBe('95%');
      expect(confidencePercent(0.92)).toBe('92%');
      expect(confidencePercent(0.975)).toBe('97.5%');
      expect(confidencePercent(1)).toBe('100%');
      expect(confidencePercent(0)).toBe('0%');
      expect(holdLine(hold({ confidence: 0.94995 }))).toContain('at 94.99% confidence');
    });

    it('renders a held document’s filename as text, never as markup', () => {
      const html = renderToStaticMarkup(
        <UnattachedDocuments
          documents={[heldRow(hold(), { filename: '<img src=x onerror=alert(1)>.pdf' })]}
          targets={offered([summary()])}
        />,
      );
      expect(html).not.toContain('<img');
      expect(html).toContain('&lt;img');
      expect(html).toContain('Held: read as a remittance advice');
    });
  });

  it('draws nothing when there is nothing loose', () => {
    expect(renderToStaticMarkup(<UnattachedDocuments documents={[]} targets={offered([summary()])} />)).toBe('');
  });

  it('is on the case list for a writer, and not for a reader', () => {
    const writer = renderToStaticMarkup(
      <EveryCaseList queue={NO_QUEUE} mayUpload viewer={viewer} cases={[summary()]} today={today} unattached={[loose()]} />,
    );
    expect(writer).toContain('Read, not on a case');

    const reader = renderToStaticMarkup(
      <EveryCaseList
        queue={NO_QUEUE}
        mayUpload={false}
        viewer={{ ...viewer, role: 'read_only' }}
        cases={[summary()]}
        today={today}
        unattached={[loose()]}
      />,
    );
    expect(reader).not.toContain('Read, not on a case');
  });

  it('offers the attach control its own cases, not what the ledger was searched for', () => {
    // Filing evidence on a case should not depend on what was last typed into
    // the ledger's search box.
    const searched = summary({ claimId: 'KS-40112', deductionId: 'aaaaaaaa-0000-0000-0000-000000000001' });
    const other = summary({ claimId: 'APDP-77001', deductionId: 'aaaaaaaa-0000-0000-0000-000000000002' });
    const html = renderToStaticMarkup(
      <EveryCaseList
        queue={NO_QUEUE}
        mayUpload
        viewer={viewer}
        cases={[searched]}
        ledger={{ filter: { query: 'KS-40112' }, matching: 1 }}
        attachTargets={offered([searched, other])}
        today={today}
        unattached={[loose()]}
      />,
    );
    const attach = html.slice(html.indexOf('Read, not on a case'));
    expect(attach).toContain('APDP-77001');
    expect(attach).toContain('KS-40112');
  });

  it('is where the queued-upload notice points, instead of promising a case', () => {
    // The notice used to say "the case will appear here when it is" whatever
    // the document turned out to be. A delivery receipt read that way opened
    // nothing, and the reviewer waited for a case that was never coming.
    const html = renderToStaticMarkup(
      <EveryCaseList queue={NO_QUEUE} mayUpload viewer={viewer} cases={[]} today={today} notice="upload_queued_list" />,
    );
    expect(html).toContain('Read, not on a case');
    expect(html).not.toContain('the case will appear here when it is');
  });
});

describe('the review page', () => {
  it('shows every field with the page and quote it came from', () => {
    const html = renderToStaticMarkup(
      <CaseReview documents={[document()]} mayAct={false}
        viewer={viewer}
        summary={summary()}
        fields={[field(), field({ fieldPath: 'lines[0].qty_received', value: 25, sourceQuote: 'Qty Received 25' })]}
        reconciliation={undefined}
        costMicros={140_000}
        today={today}
      />,
    );
    expect(html).toContain('Claim ID: APDP-99812');
    expect(html).toContain('lines 1 · qty received');
    expect(html).toContain('p1:');
    expect(html).toContain('quote found');
  });

  it('heads the page with the printed retailer when no debtor matched', () => {
    const html = renderToStaticMarkup(
      <CaseReview documents={[document()]}
        mayAct={false}
        viewer={viewer}
        summary={summary({
          debtorName: undefined,
          retailerKey: undefined,
          retailerNameAsPrinted: 'WALMART STORES, INC.',
        })}
        fields={[field()]}
        reconciliation={undefined}
        costMicros={0}
        today={today}
      />,
    );
    expect(html).toContain('WALMART STORES, INC.');
    expect(html).toContain('not matched to a debtor');
    expect(html).not.toContain('Retailer unknown');
  });

  it('heads a remittance-originated case with its invoice and the code as printed', () => {
    const html = renderToStaticMarkup(
      <CaseReview documents={[document()]}
        mayAct={false}
        viewer={viewer}
        summary={summary({
          discoveredVia: 'remittance_line',
          invoiceNumber: 'INV-271003',
          reasonCodeAsPrinted: 'OT-UNAUTH',
        })}
        fields={[field()]}
        reconciliation={undefined}
        costMicros={0}
        today={today}
      />,
    );
    expect(html).toContain('invoice INV-271003');
    // As printed, never mapped: turning a payer's code into a canonical one is
    // versioned playbook data with provenance, not a view's job.
    expect(html).toContain('code OT-UNAUTH');
  });

  it('escapes an invoice number and a reason code the way it escapes every other printed string', () => {
    const html = renderToStaticMarkup(
      <CaseReview documents={[document()]}
        mayAct={false}
        viewer={viewer}
        summary={summary({
          discoveredVia: 'remittance_line',
          invoiceNumber: '<script>alert(1)</script>',
          reasonCodeAsPrinted: '<img src=x onerror=1>',
        })}
        fields={[field()]}
        reconciliation={undefined}
        costMicros={0}
        today={today}
      />,
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;');
  });

  it('still says "Retailer unknown" when the notice named nobody', () => {
    // The old behaviour, now reserved for the one case it was ever true of.
    const html = renderToStaticMarkup(
      <CaseReview documents={[document()]}
        mayAct={false}
        viewer={viewer}
        summary={summary({ debtorName: undefined, retailerKey: undefined })}
        fields={[field()]}
        reconciliation={undefined}
        costMicros={0}
        today={today}
      />,
    );
    expect(html).toContain('Retailer unknown');
    expect(html).not.toContain('not matched to a debtor');
  });

  it('tells a reviewer which kind of check each field got', () => {
    const html = renderToStaticMarkup(
      <CaseReview documents={[document()]} mayAct={false}
        viewer={viewer}
        summary={summary()}
        fields={[
          field({ fieldPath: 'claim_id', quoteVerified: true }),
          field({ fieldPath: 'po_number', quoteVerified: false }),
          field({ fieldPath: 'vendor_number', quoteVerified: null }),
        ]}
        reconciliation={undefined}
        costMicros={0}
        today={today}
      />,
    );
    // Unverifiable and contradicted are different claims, and the page makes the
    // difference visible rather than collapsing both into "unverified".
    expect(html).toContain('quote found');
    expect(html).toContain('quote not found');
    expect(html).toContain('not checked');
  });

  it('says of a refused money field that its amount is not on the page', () => {
    const html = renderToStaticMarkup(
      <CaseReview documents={[document()]} mayAct={false}
        viewer={viewer}
        summary={summary()}
        fields={[
          field({ fieldPath: 'deduction_total', quoteVerified: true }),
          field({ fieldPath: 'lines[0].unit_cost', quoteVerified: false }),
        ]}
        reconciliation={undefined}
        costMicros={0}
        today={today}
      />,
    );
    // A label quoted for an amount is on the page; the amount is what has to be.
    expect(html).toContain('amount not on page');
    expect(html).not.toContain('quote not found');
    // A stored pass cannot say its amount was looked for: rows read before
    // ADR 0050 passed on their quote alone.
    expect(html).toContain('quote found');
    expect(html).not.toContain('amount found');
  });

  it('offers no approve button, because approving is not a thing this page can do', () => {
    const html = renderToStaticMarkup(
      <CaseReview documents={[document()]} mayAct={false}
        viewer={viewer}
        summary={summary()}
        fields={[field()]}
        reconciliation={undefined}
        costMicros={0}
        today={today}
      />,
    );
    expect(pageContent(html)).not.toContain('<button');
    expect(pageContent(html)).not.toMatch(/<form/i);
    // The same claim the page has always made, in the words it makes it in now
    // that the actions exist: this app files nothing, and a filing without an
    // approval for that exact decision is refused by the database.
    expect(html).toContain('Nothing leaves this app');
    expect(html).toContain('refuses a submission that has no approval row');
  });

  it('escapes text that came out of somebody else’s document', () => {
    // A retailer's notice is not a trusted document. This is the same class of
    // hole the review prototype had: extracted text reaching a page as markup.
    const attack = '<img src=x onerror="alert(1)">';
    const html = renderToStaticMarkup(
      <CaseReview documents={[document()]} mayAct={false}
        viewer={viewer}
        summary={summary({
          debtorName: undefined,
          retailerNameAsPrinted: attack,
          claimId: attack,
        })}
        fields={[field({ value: attack, sourceQuote: attack, filename: attack })]}
        reconciliation={{
          claimedTotalCents: cents(312_000),
          lineSumCents: cents(312_000),
          internallyConsistent: true,
          lines: [],
          findings: [{ code: 'shortage_unsupported', severity: 'warning', message: attack }],
        }}
        costMicros={0}
        today={today}
      />,
    );
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('onerror="alert(1)"');
    // Present, but as text.
    expect(html).toContain('&lt;img src=x onerror=');
  });

  it('shows a document with its own type, not always as a PDF', () => {
    // A notice that arrived in an email body is text. Embedding it as a PDF
    // shows a broken-document icon where the notice should be.
    const html = renderToStaticMarkup(
      <CaseReview
        documents={[
          document({ mimeType: 'text/plain', filename: 'Deduction APDP-99812 (email body).txt' }),
        ]}
        mayAct={false}
        viewer={viewer}
        summary={summary()}
        fields={[field({ mimeType: 'text/plain', filename: 'Deduction APDP-99812 (email body).txt' })]}
        reconciliation={undefined}
        costMicros={0}
        today={today}
      />,
    );
    expect(html).toContain('type="text/plain"');
    expect(html).not.toContain('type="application/pdf"');
  });

  it('shows what the documents say together, when they disagree', () => {
    const html = renderToStaticMarkup(
      <CaseReview documents={[document()]} mayAct={false}
        viewer={viewer}
        summary={summary()}
        fields={[field()]}
        reconciliation={{
          claimedTotalCents: cents(312_000),
          lineSumCents: cents(312_000),
          internallyConsistent: true,
          lines: [],
          findings: [
            {
              code: 'delivery_confirms_shortage',
              severity: 'supports_dispute',
              message: 'The signed BOL confirms 25 of 30 cases delivered.',
            },
          ],
        }}
        costMicros={0}
        today={today}
      />,
    );
    expect(html).toContain('The signed BOL confirms 25 of 30 cases delivered.');
    expect(html).toContain('supports dispute');
  });

  it('shows two findings that share a code, both of them', () => {
    // The text-PDF reading of LOG-001's approved reschedule reports two
    // commitments that each move an appointment, so reconcile says
    // `appointment_superseded` twice. The list was keyed by code; server
    // markup does not check keys, so this pins that both are rendered and the
    // key is the component's own business.
    const html = renderToStaticMarkup(
      <CaseReview documents={[document()]} mayAct={false}
        viewer={viewer}
        summary={summary()}
        fields={[field()]}
        reconciliation={{
          claimedTotalCents: cents(60_000),
          lineSumCents: cents(60_000),
          internallyConsistent: true,
          lines: [],
          findings: [
            { code: 'appointment_superseded', severity: 'supports_dispute', message: 'first move' },
            { code: 'appointment_superseded', severity: 'supports_dispute', message: 'second move' },
          ],
        }}
        costMicros={0}
        today={today}
      />,
    );
    expect(html).toContain('first move');
    expect(html).toContain('second move');
  });
});

/**
 * A case a remittance line opened (ADR 0028): the remittance is its notice by
 * the link, its read belongs to no one case, and the line it was opened from is
 * the claim. Running the LOG-001 demo on 2026-09-23 showed none of it — no
 * fields, the carrier invoice embedded as the original, the remittance named
 * "document 1" in the packet.
 */
describe('the review page for a case a remittance line opened', () => {
  const REMITTANCE_DOC = 'dddddddd-1111-2222-3333-444444444444';
  const INVOICE_DOC = 'eeeeeeee-1111-2222-3333-444444444444';
  const remittanceField = (fieldPath: string, value: string) =>
    field({
      documentId: REMITTANCE_DOC,
      filename: '01_short_pay_remittance.pdf',
      docType: 'remittance_advice',
      fieldPath,
      value,
      sourceQuote: value,
    });
  const fields: readonly StoredField[] = [
    // The store lists the notice first; the view must not depend on it.
    field({
      documentId: INVOICE_DOC,
      filename: '02_carrier_invoice.pdf',
      docType: 'invoice',
      fieldPath: 'invoice_number',
      value: 'INV-AFS-260814',
    }),
    remittanceField('payment_reference', 'ACH-91844'),
    remittanceField('lines[0].invoice_number', 'INV-AFS-260814'),
    remittanceField('lines[0].deduction_amount', '$600.00'),
    remittanceField('lines[1].invoice_number', 'INV-AFS-260901'),
    remittanceField('lines[1].deduction_amount', '$75.00'),
    remittanceField('lines[2].invoice_number', 'INV-AFS-260902'),
  ];
  const documents: readonly CaseDocument[] = [
    document({
      documentId: REMITTANCE_DOC,
      filename: '01_short_pay_remittance.pdf',
      docType: 'remittance_advice',
      // One read, many cases (ADR 0028): its spend is no one case's.
      readForCase: false,
    }),
    document({
      documentId: INVOICE_DOC,
      filename: '02_carrier_invoice.pdf',
      docType: 'invoice',
      role: 'evidence',
    }),
  ];
  const remittanceCase = summary({
    claimId: 'ACH-91844:INV-AFS-260814',
    deductionAmountCents: 60_000,
    discoveredVia: 'remittance_line',
    invoiceNumber: 'INV-AFS-260814',
    reasonCodeAsPrinted: 'LATE-DEL',
    documentCount: 2,
  });
  const matches = {
    claimedTotalCents: cents(60_000),
    lineSumCents: cents(60_000),
    internallyConsistent: true,
    lines: [
      {
        sku: 'INV-AFS-260814',
        reasonCode: 'LATE-DEL',
        claimedCents: cents(60_000),
        expectedShortageCents: cents(60_000),
        deltaCents: cents(0),
        verdict: 'matches' as const,
        grossCents: cents(480_000),
        netCents: cents(420_000),
      },
    ],
    findings: [],
  };

  function render(props: Partial<Parameters<typeof CaseReview>[0]> = {}): string {
    return renderToStaticMarkup(
      <CaseReview
        mayAct={false}
        viewer={viewer}
        summary={remittanceCase}
        documents={documents}
        fields={fields}
        reconciliation={matches}
        costMicros={210_000}
        today={today}
        {...props}
      />,
    );
  }

  it('embeds the remittance as the original document, not the evidence', () => {
    const html = render();
    expect(html).toContain(`src="/api/document/${REMITTANCE_DOC}"`);
    expect(html).not.toContain(`src="/api/document/${INVOICE_DOC}"`);
    expect(html).not.toContain('No document has been read');
  });

  it('shows the line that opened the case, with its quotes, and not the other invoices', () => {
    const html = render();
    expect(html).toContain('lines 1 · deduction amount');
    expect(html).toContain('$600.00');
    expect(html).toContain('quote found');
    expect(html).toContain('payment reference');
    expect(html).not.toContain('INV-AFS-260901');
    expect(html).not.toContain('$75.00');
    expect(html).toContain('2 other lines are other invoices');
  });

  it('shows every line when the case’s own cannot be placed', () => {
    // Two lines answering to one invoice, or none: hiding a line we could not
    // place is worse than showing one too many.
    const html = render({ summary: { ...remittanceCase, invoiceNumber: 'INV-NOT-HERE' } });
    expect(html).toContain('INV-AFS-260901');
    expect(html).not.toContain('other lines are other invoices');
  });

  it('says the line adds up: gross less paid against what it says was deducted', () => {
    const html = render();
    expect(html).toContain('What the documents say together');
    expect(html).toContain(
      'INV-AFS-260814: $4,800.00 gross less $4,200.00 paid is $600.00 withheld, and the line ' +
        'says $600.00 was deducted',
    );
    expect(html).toContain('>matches<');
  });

  it('says so when the line does not add up', () => {
    const html = render({
      reconciliation: {
        ...matches,
        lines: [
          {
            ...matches.lines[0]!,
            claimedCents: cents(65_000),
            deltaCents: cents(5_000),
            verdict: 'differs' as const,
          },
        ],
      },
    });
    expect(html).toContain('the line says $650.00 was deducted');
    expect(html).toContain('class="mark unverified">differs<');
  });

  it('counts the remittance among the documents, and not in the spend', () => {
    const html = render();
    expect(html).toContain(
      'Read so far: 7 fields from 2 documents on this case, and $0.21 of model spend recorded ' +
        'against it. One of them was read before it was on this case, so that read is not in ' +
        'the figure.',
    );
  });

  it('names the remittance in the packet, not "document 1"', () => {
    const html = render({
      mayAct: true,
      summary: { ...remittanceCase, state: 'awaiting_approval' },
      workflow: {
        ...workflow({ state: 'awaiting_approval' }),
        packet: {
          ...workflow({ state: 'awaiting_approval' }).packet!,
          fileDocumentIds: [REMITTANCE_DOC, INVOICE_DOC],
        },
      },
    });
    expect(html).toContain('>01_short_pay_remittance.pdf</a>');
    expect(html).toContain('>02_carrier_invoice.pdf</a>');
    expect(html).not.toContain('document 1');
  });

  it('says the spend covers every document when every read was this case’s', () => {
    const html = renderToStaticMarkup(
      <CaseReview documents={[document()]}
        mayAct={false}
        viewer={viewer}
        summary={summary()}
        fields={[field()]}
        reconciliation={undefined}
        costMicros={140_000}
        today={today}
      />,
    );
    expect(html).toContain(
      'Read so far: 1 field from 1 document on this case, and $0.14 of model spend recorded ' +
        'against it.',
    );
    expect(html).not.toContain('not in the figure');
  });

  it('never shows evidence as the original, even when no document on the case is the notice', () => {
    const html = render({
      documents: documents.filter((d) => d.documentId === INVOICE_DOC),
      fields: fields.filter((f) => f.documentId === INVOICE_DOC),
    });
    expect(html).not.toContain('<embed');
    expect(html).toContain('This case has no record of the document it was opened from.');
  });
});

/**
 * A case the ledger sync opened (ADR 0029): its notice is the ledger extract,
 * canonical JSON of a short-paid invoice and the ledger rows behind it. No model
 * reads it, so it has no fields — and a page that found its documents through
 * their fields showed the case no original document, and named the extract
 * "document 1" in the packet.
 */
describe('the review page for a case the ledger sync opened', () => {
  const EXTRACT_DOC = 'ffffffff-1111-2222-3333-444444444444';
  const extract = document({
    documentId: EXTRACT_DOC,
    filename: 'ledger-extract-INV-1001.json',
    mimeType: 'application/json',
    docType: null,
    read: false,
    readForCase: false,
  });
  const ledgerCase = summary({
    claimId: undefined,
    deductionAmountCents: 80_000,
    retailerNameAsPrinted: 'Sysco Baltimore, LLC',
    debtorName: undefined,
    retailerKey: undefined,
    disputeDeadline: undefined,
    invoiceNumber: 'INV-1001',
    documentCount: 1,
  });

  function render(props: Partial<Parameters<typeof CaseReview>[0]> = {}): string {
    return renderToStaticMarkup(
      <CaseReview
        mayAct={false}
        viewer={viewer}
        summary={ledgerCase}
        documents={[extract]}
        fields={[]}
        reconciliation={undefined}
        costMicros={0}
        today={today}
        {...props}
      />,
    );
  }

  it('embeds the extract as the original document, as the JSON it is', () => {
    const html = render();
    expect(html).toContain(`src="/api/document/${EXTRACT_DOC}"`);
    expect(html).toContain('type="application/json"');
    expect(html).not.toContain('No document is on this case');
  });

  it('still embeds the extract, not the evidence, once evidence is attached', () => {
    const html = render({
      documents: [
        extract,
        document({ documentId: NOTICE_DOC, role: 'evidence', docType: 'invoice' }),
      ],
      fields: [field({ docType: 'invoice', fieldPath: 'invoice_number', value: 'INV-1001' })],
    });
    expect(html).toContain(`src="/api/document/${EXTRACT_DOC}"`);
    expect(html).not.toContain(`src="/api/document/${NOTICE_DOC}"`);
  });

  it('says the extract cost nothing to read, rather than that its read is missing', () => {
    const html = render();
    expect(html).toContain(
      'Read so far: 0 fields from 1 document on this case, and $0.00 of model spend recorded ' +
        'against it.',
    );
    expect(html).not.toContain('not in the figure');
  });

  it('names the extract in the packet, not "document 1"', () => {
    const html = render({
      mayAct: true,
      summary: { ...ledgerCase, state: 'awaiting_approval' },
      workflow: {
        ...workflow({ state: 'awaiting_approval' }),
        packet: {
          ...workflow({ state: 'awaiting_approval' }).packet!,
          fileDocumentIds: [EXTRACT_DOC],
        },
      },
    });
    expect(html).toContain('>ledger-extract-INV-1001.json</a>');
    expect(html).not.toContain('document 1');
  });

  it('links an original it cannot show in place, instead of embedding a download', () => {
    const html = render({
      documents: [document({ mimeType: 'application/zip', filename: 'claims.zip' })],
    });
    expect(html).not.toContain('<embed');
    expect(html).toContain(`href="/api/document/${NOTICE_DOC}">claims.zip</a>`);
  });

  it('says so when nothing is on the case at all', () => {
    const html = render({ documents: [] });
    expect(html).not.toContain('<embed');
    expect(html).toContain('No document is on this case yet.');
  });
});

describe('which documents a page may show in place', () => {
  it('is the list the document route serves inline, JSON included', () => {
    expect(displaysInline('application/json')).toBe(true);
    expect(displaysInline('application/pdf')).toBe(true);
    expect(displaysInline('text/plain')).toBe(true);
    // Everything else downloads, and so is never embedded.
    expect(displaysInline('text/html')).toBe(false);
    expect(displaysInline('image/svg+xml')).toBe(false);
    expect(displaysInline('application/octet-stream')).toBe(false);
  });
});

describe('what a reviewer can do with a case', () => {
  const props = {
    documents: [document()],
    viewer,
    summary: summary(),
    fields: [field()],
    reconciliation: undefined,
    costMicros: 0,
    today,
  };

  it('offers no way to act to a member whose role may not', () => {
    // The write policies are the enforcement; this is about not showing someone
    // a button that the database is going to refuse.
    const html = renderToStaticMarkup(<CaseReview {...props} mayAct={false} />);
    expect(html).not.toContain('Attach to this case');
    expect(html).not.toContain('Record this decline');
    expect(html).not.toContain('/decline');
  });

  it('lets a member who may act attach evidence to this case', () => {
    const html = renderToStaticMarkup(<CaseReview {...props} mayAct={true} />);
    expect(html).toContain('Attach to this case');
    expect(html).toContain('action="/upload"');
    // The case travels with the file. Without this the document is read and
    // then belongs to nothing, which is the thing that sits unread forever.
    expect(html).toContain(`name="attachToCase" value="${props.summary.deductionId}"`);
  });

  it('posts a decline to this case, with the reasons the enum allows', () => {
    const html = renderToStaticMarkup(<CaseReview {...props} mayAct={true} />);
    expect(html).toContain(`action="/cases/${props.summary.deductionId}/decline"`);
    // Every reason the database will accept is offered, so the UI cannot drift
    // from the enum and quietly stop offering one.
    for (const reason of DECLINE_REASONS) {
      expect(html, reason).toContain(`value="${reason}"`);
    }
  });

  it('says a decline is recorded rather than deleted', () => {
    // If this wording goes, so does the reason anyone would use it instead of
    // closing the tab: coverage has no numerator without the row.
    const html = renderToStaticMarkup(<CaseReview {...props} mayAct={true} />);
    expect(html).toMatch(/not a delete/i);
  });

  it('shows the outcome of an action it was sent back with', () => {
    const html = renderToStaticMarkup(<CaseReview {...props} mayAct={true} notice="declined" />);
    expect(html).toContain('recorded: this case is logged as declined, not discarded');
    // Recorded is not a refusal. A page that paints every answer red teaches a
    // reviewer to stop reading them.
    expect(html).toContain('class="notice sent"');
  });

  it('paints a refusal red and a thing that worked green', () => {
    const bad = renderToStaticMarkup(
      <CaseReview {...props} mayAct={true} notice="decide_rationale" />,
    );
    expect(bad).toContain('class="notice bad"');
    expect(bad).toContain('say in one line why');

    const good = renderToStaticMarkup(
      <CaseReview
        {...props}
        mayAct={true}
        notice="packet_assembled"
        noticeAbout={['2', 'f00dcafe1234']}
      />,
    );
    expect(good).toContain('class="notice sent"');
    expect(good).toContain('packet assembled: 2 documents under f00dcafe1234');
  });

  it('says nothing at all for a notice this app did not send', () => {
    // The upload route used to redirect here carrying the claim id a second
    // notice printed, as prose, which made this page a place a link could put
    // words into. Now the claim travels as a validated fragment and a sentence
    // is not a notice at all — stronger than escaping it, because there is
    // nothing left to escape.
    for (const forged of [
      'claim <script>alert(1)</script> is already this case',
      'upload_duplicate_case',
      'toString',
      '',
    ]) {
      const html = renderToStaticMarkup(<CaseReview {...props} mayAct={true} notice={forged} />);
      expect(html, forged).not.toContain('class="notice');
      expect(html, forged).not.toContain('<script>');
      expect(html, forged).not.toContain('is already this case');
    }
  });

  it('shows a claim id that is one, and no notice at all for one that is not', () => {
    const real = renderToStaticMarkup(
      <CaseReview
        {...props}
        mayAct={true}
        notice="upload_duplicate_case"
        noticeAbout={['APDP-99812']}
      />,
    );
    expect(real).toContain('claim APDP-99812 is already this case');

    // A claim id is read off somebody else's document. The shape is the check.
    for (const forged of ['<script>alert(1)</script>', 'x'.repeat(200), '" onload="']) {
      const html = renderToStaticMarkup(
        <CaseReview
          {...props}
          mayAct={true}
          notice="upload_duplicate_case"
          noticeAbout={[forged]}
        />,
      );
      expect(html, forged).not.toContain('class="notice');
      expect(html, forged).not.toContain('<script>');
      expect(html, forged).not.toContain('onload=');
    }
  });

  it('still has no approve button for a member who may act but may not approve', () => {
    // Approving is a recorded act the database gates, and an analyst is not on
    // the list. Not even on a case that is waiting for exactly that: a button
    // that only looked like one would be worse than none.
    const html = renderToStaticMarkup(
      <CaseReview
        {...props}
        summary={summary({ state: 'awaiting_approval' })}
        workflow={workflow({ state: 'awaiting_approval' })}
        viewerUserId={SECOND_ANALYST}
        mayAct={true}
        mayApprove={false}
      />,
    );
    expect(html).not.toMatch(/<button[^>]*>\s*Approve for submission/);
    expect(html).toContain('Waiting on an owner or an approver');
  });
});

/**
 * One card per state, shown only to a member whose role may take that action.
 *
 * None of this is the enforcement — the database refuses an approval by the
 * preparer, a submission with no approval and a write by a `read_only` member
 * whatever is rendered. What these assert is that a reviewer is never shown a
 * button the database is going to refuse, and is told why when the action is
 * somebody else's.
 */
describe('the Phase 3 action cards', () => {
  const base = {
    documents: [document()],
    viewer,
    fields: [field()],
    reconciliation: undefined,
    costMicros: 0,
    today,
  };

  function render(
    props: Partial<Parameters<typeof CaseReview>[0]> & { summary: CaseSummary },
  ): string {
    return renderToStaticMarkup(
      <CaseReview {...base} mayAct={true} viewerUserId={SECOND_ANALYST} {...props} />,
    );
  }

  it('offers the decision, and the decline beside it, only from classified', () => {
    const html = render({ summary: summary({ state: 'classified' }) });
    expect(html).toContain('action="/cases/11111111-2222-3333-4444-555555555555/decide"');
    expect(html).toContain('Decide to dispute');
    // The two answers to one question, offered together.
    expect(html).toContain('/decline');

    // And nothing else yet.
    expect(html).not.toContain('/packet"');
    expect(html).not.toContain('Approve for submission');
    expect(html).not.toContain('/submit"');
    expect(html).not.toContain('/outcome"');
  });

  it('offers no decision, and no decline, once one has been made', () => {
    // Fighting and declining are mutually exclusive: a case somebody decided to
    // dispute is not one to offer a decline on, and the state has moved anyway.
    const html = render({
      summary: summary({ state: 'analyst_review' }),
      workflow: workflow({ state: 'analyst_review' }),
    });
    expect(html).not.toContain('/decide"');
    expect(html).not.toContain('/decline"');
  });

  it('offers every reason as a canonical code, so the taxonomy cannot drift', () => {
    const html = render({ summary: summary({ state: 'classified' }) });
    for (const [code, label] of DISPUTE_REASONS) {
      expect(isCanonicalReasonCode(code), code).toBe(true);
      expect(html, code).toContain(`value="${code}"`);
      expect(html, code).toContain(label);
    }
  });

  it('offers the packet only from analyst_review, with the decision it is for', () => {
    const html = render({
      summary: summary({ state: 'analyst_review' }),
      workflow: workflow({ state: 'analyst_review' }),
    });
    expect(html).toContain('action="/cases/11111111-2222-3333-4444-555555555555/packet"');
    expect(html).toContain('name="decisionId" value="99999999-1111-2222-3333-444444444444"');
    expect(html).toContain('Assemble the packet');
  });

  it('shows the packet it assembled: the narrative, the hash and every file', () => {
    const html = render({
      summary: summary({ state: 'awaiting_approval' }),
      workflow: workflow({ state: 'awaiting_approval' }),
    });
    // The short hash is what a person compares; the whole one is in the record.
    expect(html).toContain('f00dcafe1234');
    expect(html).toContain('Dispute cover sheet');
    expect(html).toContain(`href="/api/document/${NOTICE_DOC}"`);
    expect(html).toContain('walmart-apdp-notice.pdf');
    // The letter to print, the enclosures as one download, and the letter as
    // text — each of them this packet.
    expect(html).toContain(
      'href="/cases/11111111-2222-3333-4444-555555555555/packet/letter">Printable letter',
    );
    expect(html).toContain(
      'href="/cases/11111111-2222-3333-4444-555555555555/packet/enclosures">All enclosures (.zip)',
    );
    expect(html).toContain(
      'href="/cases/11111111-2222-3333-4444-555555555555/packet">Letter as text',
    );
  });

  // Evidence attached after the first assembly has to be able to get in, so a
  // writer is offered the assembly again for as long as nothing is approved —
  // and only then, because after an approval the store refuses it
  // (`PacketAfterApprovalError`).
  it('offers to assemble again while the packet waits, to writers, until it is approved', () => {
    const packetForm = 'action="/cases/11111111-2222-3333-4444-555555555555/packet"';
    const waiting = render({
      summary: summary({ state: 'awaiting_approval' }),
      workflow: workflow({ state: 'awaiting_approval' }),
    });
    expect(waiting).toContain(packetForm);
    expect(waiting).toContain('Assemble the packet again');
    expect(waiting).toMatch(/<button[^>]*>Assemble again<\/button>/);
    expect(waiting).toContain('name="decisionId" value="99999999-1111-2222-3333-444444444444"');

    const reader = render({
      summary: summary({ state: 'awaiting_approval' }),
      workflow: workflow({ state: 'awaiting_approval' }),
      mayAct: false,
    });
    expect(reader).not.toContain(packetForm);

    const approved = render({
      summary: summary({ state: 'awaiting_approval' }),
      workflow: workflow({ state: 'awaiting_approval', approved: true }),
    });
    expect(approved).not.toContain(packetForm);
    expect(approved).not.toContain('Assemble again');
  });

  it('offers the approve button to an approver who did not prepare the decision', () => {
    const html = render({
      summary: summary({ state: 'awaiting_approval' }),
      workflow: workflow({ state: 'awaiting_approval' }),
      viewer: { ...viewer, role: 'approver' },
      mayApprove: true,
      viewerUserId: APPROVER,
    });
    expect(html).toContain('action="/cases/11111111-2222-3333-4444-555555555555/approve"');
    expect(html).toMatch(/<button[^>]*>Approve for submission<\/button>/);
    expect(html).toContain('name="packetId" value="88888888-1111-2222-3333-444444444444"');
    // What is being approved, and that approving is a second person's act.
    expect(html).toContain('f00dcafe1234');
    expect(html).toContain('recorded act by a second person');
  });

  it('offers it to an owner who did not prepare the decision either', () => {
    // `owner` is on both lists: they may write, and they may approve. The one
    // thing that stops them is having prepared this decision themselves, and
    // this one did not.
    const html = render({
      summary: summary({ state: 'awaiting_approval' }),
      workflow: workflow({ state: 'awaiting_approval' }),
      viewer: { ...viewer, role: 'owner' },
      mayApprove: true,
      viewerUserId: APPROVER,
    });
    expect(html).toMatch(/<button[^>]*>Approve for submission<\/button>/);
    expect(html).toContain('action="/cases/11111111-2222-3333-4444-555555555555/approve"');
  });

  it('tells a read_only member whose approval is awaited, not what an analyst may do', () => {
    // A `read_only` member can see the case and do nothing with it. The
    // analyst's sentence — "your role can prepare a case and assemble its
    // packet" — sends them off to press buttons the write policies refuse and
    // this page does not render.
    const html = renderToStaticMarkup(
      <CaseReview
        {...base}
        viewer={{ ...viewer, role: 'read_only' }}
        summary={summary({ state: 'awaiting_approval' })}
        workflow={workflow({ state: 'awaiting_approval' })}
        mayAct={false}
        mayApprove={false}
        viewerUserId={SECOND_ANALYST}
      />,
    );
    expect(html).toContain('Waiting on an owner or an approver');
    expect(html).toContain('read this case but not act on it');
    expect(html).not.toContain('assemble its packet');
    // And still no way to act on it.
    expect(pageContent(html)).not.toMatch(/<form/i);
    expect(pageContent(html)).not.toMatch(/<button/i);
  });

  it('caps the rationale at the length the cover sheet holds, not a number of its own', () => {
    // The browser stopping somewhere other than `MAX_RATIONALE_LENGTH` would
    // be this form disagreeing with the store that refuses on it — either
    // cutting a rationale the packet had room for, or letting one through that
    // the append-only `decisions` row could not then be packeted from.
    const html = render({ summary: summary({ state: 'classified' }) });
    expect(html).toContain(`maxLength="${MAX_RATIONALE_LENGTH}"`);
    expect(html).toContain('In one line, for whoever approves it');
  });

  it('does not offer it to the preparer on their own decision, and says why', () => {
    // Separation of duties, which the database enforces. The page saying why
    // is the difference between a refusal and a button that mysteriously fails.
    const html = render({
      summary: summary({ state: 'awaiting_approval' }),
      workflow: workflow({ state: 'awaiting_approval' }),
      viewer: { ...viewer, role: 'owner' },
      mayApprove: true,
      viewerUserId: PREPARER,
    });
    expect(html).not.toMatch(/<button[^>]*>Approve for submission/);
    expect(html).toContain('You prepared this decision');
  });

  it('offers the filing form only once there is an approval', () => {
    const waiting = render({
      summary: summary({ state: 'awaiting_approval' }),
      workflow: workflow({ state: 'awaiting_approval' }),
    });
    expect(waiting).not.toContain('/submit"');

    const approved = render({
      summary: summary({ state: 'awaiting_approval' }),
      workflow: workflow({ state: 'awaiting_approval', approved: true }),
    });
    expect(approved).toContain('action="/cases/11111111-2222-3333-4444-555555555555/submit"');
    expect(approved).toContain('name="approvalId" value="66666666-1111-2222-3333-444444444444"');
    // The channel is fixed and not a choice, and the instructions are plain.
    expect(approved).toContain('manual portal');
    expect(approved).toContain('Attach the dispute letter');
    // A retailer's own rules are data, not code: the page says to follow the
    // routing guide rather than naming a portal it does not know.
    expect(approved).toContain('playbook data this app does not hold yet');
  });

  it('offers the outcome form only once the case was filed', () => {
    const filed = render({
      summary: summary({ state: 'submitted' }),
      workflow: workflow({ state: 'submitted' }),
    });
    expect(filed).toContain('action="/cases/11111111-2222-3333-4444-555555555555/outcome"');
    expect(filed).toContain('value="partial"');
    expect(filed).toContain('Dollars and cents, as written');
    expect(filed).not.toContain('/approve"');
  });

  it('offers no card at all to a member who may not write', () => {
    for (const state of [
      'classified',
      'analyst_review',
      'awaiting_approval',
      'submitted',
    ] as const) {
      const html = renderToStaticMarkup(
        <CaseReview
          {...base}
          viewer={{ ...viewer, role: 'read_only' }}
          summary={summary({ state })}
          workflow={workflow({ state, approved: true })}
          mayAct={false}
          mayApprove={false}
          viewerUserId={SECOND_ANALYST}
        />,
      );
      expect(pageContent(html), state).not.toMatch(/<form/i);
      expect(pageContent(html), state).not.toMatch(/<button/i);
    }
  });
});

describe('the timeline', () => {
  const base = {
    documents: [document()],
    viewer,
    fields: [field()],
    reconciliation: undefined,
    costMicros: 0,
    today,
    mayAct: false,
  };

  it('says nothing has been done when nothing has', () => {
    const html = renderToStaticMarkup(
      <CaseReview {...base} summary={summary()} viewerUserId={SECOND_ANALYST} />,
    );
    expect(html).toContain('This case has been read and nothing else');
  });

  it('records each act with who did it and when, in UTC', () => {
    const html = renderToStaticMarkup(
      <CaseReview
        {...base}
        summary={summary({ state: 'submitted' })}
        workflow={workflow({ state: 'submitted', note: 'Checked the BOL myself.' })}
        viewerUserId={APPROVER}
      />,
    );
    expect(html).toContain('Decided to dispute');
    expect(html).toContain('shortage_quantity');
    expect(html).toContain('2026-09-19 14:02 UTC');
    expect(html).toContain('Packet assembled');
    expect(html).toContain('Approved for submission');
    // The approver is the one looking, so the page says so rather than showing
    // them their own id.
    expect(html).toContain('you · 2026-09-19 15:00 UTC');
    expect(html).toContain('Checked the BOL myself.');
    expect(html).toContain('Filed');
    expect(html).toContain('WM-DISPUTE-99812');
    // Somebody else is an id, honestly, because the port carries no names.
    expect(html).toContain(PREPARER.slice(0, 8));
  });

  it('escapes the rationale, the note and the narrative, which are not markup', () => {
    // A rationale is typed by a person and a narrative quotes somebody else's
    // document. Both reach this page as text or not at all.
    const attack = '<img src=x onerror="alert(1)">';
    const html = renderToStaticMarkup(
      <CaseReview
        {...base}
        summary={summary({ state: 'submitted' })}
        workflow={workflow({ state: 'submitted', rationale: attack, note: attack })}
        viewerUserId={SECOND_ANALYST}
      />,
    );
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('onerror="alert(1)"');
    expect(html).toContain('&lt;img src=x onerror=');
  });

  it('shows a recovered amount as money made of integer cents', () => {
    const paid = workflow({ state: 'submitted' });
    const html = renderToStaticMarkup(
      <CaseReview
        {...base}
        summary={summary({ state: 'partial' })}
        workflow={{
          ...paid,
          state: 'partial',
          outcome: {
            eventId: '44444444-1111-2222-3333-444444444444',
            deductionId: paid.deductionId,
            outcome: 'partial',
            recoveredCents: 180_000,
            recordedBy: SECOND_ANALYST,
            recordedAt: new Date('2026-09-25T10:00:00Z'),
          },
        }}
        viewerUserId={SECOND_ANALYST}
      />,
    );
    expect(html).toContain('Outcome: partial');
    expect(html).toContain('$1,800.00 recovered');
    expect(html).toContain('you · 2026-09-25 10:00 UTC');
  });
});

/**
 * A pair the matcher would not merge, as the store hands one back (ADR 0032).
 *
 * The older side is the case we already held; the newer one is the arrival that
 * agreed with it on everything but an identifier.
 */
function duplicatePair(
  overrides: { olderClaim?: string; newerClaim?: string; basis?: readonly string[] } = {},
): PossibleDuplicatePair {
  const side = (deductionId: string, claimId: string, openedAt: string) => ({
    deductionId,
    state: 'discovered' as const,
    claimId,
    invoiceNumber: 'INV-77812',
    retailer: 'Walmart (APDP)',
    retailerMatched: true,
    deductionAmountCents: 42_150,
    deductionDate: '2026-07-02',
    openedAt,
  });
  return {
    noticedAt: '2026-09-21T09:00:00.000Z',
    basis: overrides.basis ?? ['invoice_number', 'amount_cents', 'deduction_date'],
    older: side(
      'aaaaaaaa-1111-2222-3333-444444444444',
      overrides.olderClaim ?? 'APDP-99812',
      '2026-09-01T09:00:00.000Z',
    ),
    newer: side(
      'bbbbbbbb-1111-2222-3333-444444444444',
      overrides.newerClaim ?? 'CM-40021',
      '2026-09-20T09:00:00.000Z',
    ),
  };
}

describe('the pairs identity resolution would not merge', () => {
  it('shows both cases side by side, with what agreed and the two answers', () => {
    const html = renderToStaticMarkup(<PossibleDuplicates pairs={[duplicatePair()]} />);

    expect(html).toContain('Possible duplicates');
    expect(html).toContain('APDP-99812');
    expect(html).toContain('CM-40021');
    expect(html).toContain('$421.50');
    // What agreed, in a person's words rather than a field path.
    expect(html).toContain('the same invoice');
    expect(html).toContain('a deduction date within a week');
    // Both answers, posted to the case the pair names, with the other half of
    // the pair travelling in the form.
    expect(html).toContain('action="/cases/aaaaaaaa-1111-2222-3333-444444444444/duplicate"');
    expect(html).toContain('value="bbbbbbbb-1111-2222-3333-444444444444"');
    expect(html).toContain('value="same"');
    expect(html).toContain('value="different"');
  });

  it('says the pair is not merged yet, and that "same" is what merges it', () => {
    // A pair on this list was opened twice and joined by nothing; the button
    // that answers "same" is the one that merges (ADR 0042 §7), and it says so
    // rather than looking like a note that changes nothing.
    const html = renderToStaticMarkup(<PossibleDuplicates pairs={[duplicatePair()]} />);
    expect(html).toMatch(/neither was merged/);
    expect(html).toContain('Same deduction — merge them');
    expect(html).toMatch(/can be put back/);
  });

  it('renders nothing at all when there is nothing to answer', () => {
    expect(renderToStaticMarkup(<PossibleDuplicates pairs={[]} />)).toBe('');
  });

  it('escapes a claim id that came off somebody else’s document', () => {
    const html = renderToStaticMarkup(
      <PossibleDuplicates
        pairs={[duplicatePair({ newerClaim: '<img src=x onerror="alert(1)">' })]}
      />,
    );
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=');
  });

  it('says what agreed without ever saying what it said', () => {
    expect(basisSentence(['invoice_number'])).toBe('the same invoice');
    expect(basisSentence(['invoice_number', 'amount_cents'])).toBe(
      'the same invoice and the same amount',
    );
    // A basis this page has no words for is still named rather than dropped.
    expect(basisSentence(['something_new'])).toBe('something new');
    expect(basisSentence([])).toBe('nothing this page can name');
  });
});

describe('a case that may already be a case', () => {
  const base = {
    documents: [document()],
    viewer,
    summary: summary({ deductionId: 'aaaaaaaa-1111-2222-3333-444444444444' }),
    fields: [field()],
    reconciliation: undefined,
    costMicros: 0,
    today,
  };

  it('tells a reviewer on the case page, and offers both answers', () => {
    const html = renderToStaticMarkup(
      <CaseReview {...base} mayAct={true} duplicates={[duplicatePair()]} />,
    );

    expect(html).toContain('This may already be a case');
    // The *other* case, whichever side of the pair this one is.
    expect(html).toContain('CM-40021');
    expect(html).toContain('action="/cases/aaaaaaaa-1111-2222-3333-444444444444/duplicate"');
    expect(html).toContain('Same deduction');
    expect(html).toContain('Different deductions');
    // And it says what "same" does before anybody presses it.
    expect(html).toMatch(/Saying they are the same merges them/);
    expect(html).toMatch(/can be put back/);
  });

  it('tells a reader who may not act as well, without offering the buttons', () => {
    // Knowing another case may be this same deduction matters before anybody
    // decides anything about it; answering is what the role gates.
    const html = renderToStaticMarkup(
      <CaseReview {...base} mayAct={false} duplicates={[duplicatePair()]} />,
    );
    expect(html).toContain('This may already be a case');
    expect(html).not.toContain('Same deduction');
    expect(html).not.toContain('/duplicate"');
  });

  it('says nothing when the case is in no unanswered pair', () => {
    const html = renderToStaticMarkup(<CaseReview {...base} mayAct={true} duplicates={[]} />);
    expect(html).not.toContain('This may already be a case');
  });
});

describe('a merged pair, on either case (ADR 0042)', () => {
  const loser = 'bbbbbbbb-1111-2222-3333-444444444444';
  const survivor = 'aaaaaaaa-1111-2222-3333-444444444444';
  const base = {
    documents: [document()],
    viewer,
    fields: [field()],
    reconciliation: undefined,
    costMicros: 0,
    today,
  };
  const mergedInto = {
    deductionId: survivor,
    claimId: 'APDP-99812',
    deductionAmountCents: 42_150,
    state: 'classified' as const,
    mergeId: 'cccccccc-1111-2222-3333-444444444444',
    mergedAt: '2026-09-23T10:00:00.000Z',
    mergedBy: 'dddddddd-1111-2222-3333-444444444444',
  };

  it('tells a merged case where it went, and offers a writer the undo', () => {
    const html = renderToStaticMarkup(
      <CaseReview
        {...base}
        summary={summary({ deductionId: loser, state: 'merged' })}
        mayAct={true}
        merges={{ mergedInto, absorbed: [], confirmedNotMerged: [] }}
      />,
    );
    expect(html).toContain('Merged into another case');
    expect(html).toContain(`href="/cases/${survivor}"`);
    expect(html).toContain('APDP-99812');
    expect(html).toContain(`action="/cases/${loser}/unmerge"`);
    // Evidence goes on the survivor: the database refuses a link to this one
    // after the read would have been paid for.
    expect(html).not.toContain('Add evidence');
    expect(html).not.toContain('name="attachToCase"');
  });

  it('shows a reader the banner and no undo', () => {
    const html = renderToStaticMarkup(
      <CaseReview
        {...base}
        summary={summary({ deductionId: loser, state: 'merged' })}
        mayAct={false}
        merges={{ mergedInto, absorbed: [], confirmedNotMerged: [] }}
      />,
    );
    expect(html).toContain('Merged into another case');
    expect(html).not.toContain('/unmerge"');
  });

  it('lists what was merged into the survivor, which still takes evidence', () => {
    const html = renderToStaticMarkup(
      <CaseReview
        {...base}
        summary={summary({ deductionId: survivor, state: 'classified' })}
        mayAct={true}
        merges={{
          absorbed: [
            {
              deductionId: loser,
              claimId: 'CM-40021',
              deductionAmountCents: 42_150,
              state: 'merged',
              mergeId: mergedInto.mergeId,
              mergedAt: mergedInto.mergedAt,
            },
          ],
          confirmedNotMerged: [],
        }}
      />,
    );
    expect(html).toContain('Merged into this case');
    expect(html).toContain(`href="/cases/${loser}"`);
    expect(html).toContain('CM-40021');
    expect(html).toContain('Add evidence');
  });

  it('says why a confirmed pair is not merged, and offers Merge only when it would work', () => {
    const refused = renderToStaticMarkup(
      <CaseMergeNotes
        deductionId={survivor}
        mayAct={true}
        merges={{
          absorbed: [],
          confirmedNotMerged: [
            {
              deductionId: loser,
              claimId: 'CM-40021',
              deductionAmountCents: 42_149,
              state: 'classified',
              refusal: 'amounts_disagree',
            },
          ],
        }}
      />,
    );
    expect(refused).toContain('The same deduction, not merged');
    expect(refused).toContain(MERGE_REFUSAL_SENTENCES.amounts_disagree);
    expect(refused).not.toContain('/merge"');
    expect(refused).toMatch(/coverage counts this deduction twice/);

    const allowed = renderToStaticMarkup(
      <CaseMergeNotes
        deductionId={survivor}
        mayAct={true}
        merges={{
          absorbed: [],
          confirmedNotMerged: [
            { deductionId: loser, deductionAmountCents: 42_150, state: 'classified' },
          ],
        }}
      />,
    );
    expect(allowed).toContain(`action="/cases/${survivor}/merge"`);
    expect(allowed).toContain(`value="${loser}"`);

    const reader = renderToStaticMarkup(
      <CaseMergeNotes
        deductionId={survivor}
        mayAct={false}
        merges={{
          absorbed: [],
          confirmedNotMerged: [
            { deductionId: loser, deductionAmountCents: 42_150, state: 'classified' },
          ],
        }}
      />,
    );
    expect(reader).not.toContain('/merge"');
  });

  it('says nothing when there is nothing to say, and escapes a claim id', () => {
    expect(
      renderToStaticMarkup(
        <CaseMergeNotes
          deductionId={survivor}
          mayAct={true}
          merges={{ absorbed: [], confirmedNotMerged: [] }}
        />,
      ),
    ).toBe('');
    const html = renderToStaticMarkup(
      <CaseMergeNotes
        deductionId={loser}
        mayAct={true}
        merges={{
          mergedInto: { ...mergedInto, claimId: '<img src=x onerror="alert(1)">' },
          absorbed: [],
          confirmedNotMerged: [],
        }}
      />,
    );
    expect(html).not.toContain('<img src=x');
  });

  it('has a sentence for every reason the database can give', () => {
    for (const sentence of Object.values(MERGE_REFUSAL_SENTENCES)) {
      expect(sentence.trim()).not.toBe('');
    }
  });
});

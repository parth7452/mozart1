import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MAX_RATIONALE_LENGTH, cents } from '@recouple/core-domain';
import { DECLINE_REASONS } from '@recouple/store-postgres';
import type { CaseSummary, StoredField } from '@recouple/store-postgres';
import { isCanonicalReasonCode } from '@recouple/core-domain';
import type {
  CaseWorkflow,
  PossibleDuplicatePair,
  UnattachedDocument,
  UnreadDocument,
} from '@recouple/pipeline';
import { CaseList, type Viewer } from '../components/case-list';
import { UnreadDocuments, waiting } from '../components/unread-documents';
import { caseLabel, UnattachedDocuments } from '../components/unattached-documents';
import { CaseReview } from '../components/case-review';
import {
  basisSentence,
  CaseMergeNotes,
  MERGE_REFUSAL_SENTENCES,
  PossibleDuplicates,
} from '../components/possible-duplicates';
import { DISPUTE_REASONS } from '../components/case-actions';
import { deadline, fieldLabel, money } from '../lib/format';

const viewer: Viewer = { email: 'ap@harborline.test', orgName: 'Harborline Foods', role: 'analyst' };
/** An empty review queue, for the tests about the rest of the list. */
const NO_QUEUE = {
  read: { rows: [], total: 0, waitingOnRetailer: 0, limit: 500 },
  viewer: { userId: 'aaaaaaaa-1111-2222-3333-444444444444', mayApprove: false },
} as const;
const today = new Date('2026-09-18T12:00:00Z');

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
      <CaseList queue={NO_QUEUE} mayUpload viewer={viewer} cases={[summary(), summary({
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

  it('shows the name a notice printed when no debtor answers to it, and says so', () => {
    // The whole point of ADR 0019: a case whose retailer did not resolve is not
    // a case with no retailer. It reads as printed, marked unmatched, because an
    // unmatched retailer has no playbook and no routing behind it.
    const html = renderToStaticMarkup(
      <CaseList
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
      <CaseList
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
      <CaseList
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
      <CaseList
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
      <CaseList queue={NO_QUEUE} mayUpload viewer={viewer} cases={[summary()]} today={today} />,
    );
    expect(html).not.toContain('invoice');
  });

  it('offers the upload to a member who may write, and not to one who may not', () => {
    const writer = renderToStaticMarkup(
      <CaseList queue={NO_QUEUE} mayUpload viewer={viewer} cases={[]} today={today} />,
    );
    expect(writer).toContain('action="/upload"');
    expect(writer).toContain('Add a document');

    // The database refuses a read_only member's insert whatever the page shows;
    // hiding the form is the difference between a refusal and a dead end.
    const reader = renderToStaticMarkup(
      <CaseList
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
      <CaseList
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
      <CaseList queue={NO_QUEUE} mayUpload viewer={viewer} cases={[]} today={today} notice="upload_queued_list" />,
    );
    expect(good).toContain('class="notice sent"');
    expect(good).toContain('that document is being read');

    // A query string is a thing anybody can type, and an app that repeats what
    // it finds there is an app a link can put words into.
    for (const forged of ['your session expired, sign in at evil.test', 'constructor', '']) {
      const html = renderToStaticMarkup(
        <CaseList queue={NO_QUEUE} mayUpload viewer={viewer} cases={[]} today={today} notice={forged} />,
      );
      expect(html, forged).not.toContain('class="notice');
      expect(html, forged).not.toContain('sign in at');
    }
  });

  it('says what will happen rather than showing an empty table', () => {
    const html = renderToStaticMarkup(
      <CaseList queue={NO_QUEUE} mayUpload viewer={viewer} cases={[]} today={today} />,
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
      <CaseList queue={NO_QUEUE} mayUpload viewer={viewer} cases={[]} today={today} unread={[unread()]} />,
    );
    expect(writer).toContain('Documents waiting to be read');

    const reader = renderToStaticMarkup(
      <CaseList
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
      <CaseList queue={NO_QUEUE} mayUpload viewer={viewer} cases={[]} today={today} />,
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
      ...overrides,
    };
  }

  it('says what each one was read as, and offers the open cases to attach it to', () => {
    const open = summary({ claimId: 'LOG-202', debtorName: undefined, retailerNameAsPrinted: 'Westhaven Paper Supply' });
    const closed = summary({
      deductionId: '99999999-2222-3333-4444-555555555555',
      claimId: 'CLOSED-1',
      state: 'won',
    });
    const html = renderToStaticMarkup(
      <UnattachedDocuments documents={[loose()]} cases={[open, closed]} />,
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
      <UnattachedDocuments documents={[loose()]} cases={[summary({ state: 'lost' })]} />,
    );
    expect(html).toContain('No open case yet');
    expect(html).not.toContain('<form');
  });

  it('renders a filename as text, never as markup', () => {
    const html = renderToStaticMarkup(
      <UnattachedDocuments
        documents={[loose({ filename: '<img src=x onerror=alert(1)>.jpg' })]}
        cases={[summary()]}
      />,
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('draws nothing when there is nothing loose', () => {
    expect(renderToStaticMarkup(<UnattachedDocuments documents={[]} cases={[summary()]} />)).toBe('');
  });

  it('is on the case list for a writer, and not for a reader', () => {
    const writer = renderToStaticMarkup(
      <CaseList queue={NO_QUEUE} mayUpload viewer={viewer} cases={[summary()]} today={today} unattached={[loose()]} />,
    );
    expect(writer).toContain('Read, not on a case');

    const reader = renderToStaticMarkup(
      <CaseList
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

  it('is where the queued-upload notice points, instead of promising a case', () => {
    // The notice used to say "the case will appear here when it is" whatever
    // the document turned out to be. A delivery receipt read that way opened
    // nothing, and the reviewer waited for a case that was never coming.
    const html = renderToStaticMarkup(
      <CaseList queue={NO_QUEUE} mayUpload viewer={viewer} cases={[]} today={today} notice="upload_queued_list" />,
    );
    expect(html).toContain('Read, not on a case');
    expect(html).not.toContain('the case will appear here when it is');
  });
});

describe('the review page', () => {
  it('shows every field with the page and quote it came from', () => {
    const html = renderToStaticMarkup(
      <CaseReview mayAct={false}
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
      <CaseReview
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
      <CaseReview
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
      <CaseReview
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
      <CaseReview
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
      <CaseReview mayAct={false}
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

  it('offers no approve button, because approving is not a thing this page can do', () => {
    const html = renderToStaticMarkup(
      <CaseReview mayAct={false}
        viewer={viewer}
        summary={summary()}
        fields={[field()]}
        reconciliation={undefined}
        costMicros={0}
        today={today}
      />,
    );
    expect(html).not.toContain('<button');
    expect(html).not.toMatch(/<form/i);
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
      <CaseReview mayAct={false}
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
      <CaseReview mayAct={false}
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
      <CaseReview mayAct={false}
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
      <CaseReview mayAct={false}
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

describe('what a reviewer can do with a case', () => {
  const props = {
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
    expect(html).toContain(
      'href="/cases/11111111-2222-3333-4444-555555555555/packet">Download cover sheet',
    );
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
    expect(html).not.toMatch(/<form/i);
    expect(html).not.toMatch(/<button/i);
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
    expect(approved).toContain('Attach the cover sheet');
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
      expect(html, state).not.toMatch(/<form/i);
      expect(html, state).not.toMatch(/<button/i);
    }
  });
});

describe('the timeline', () => {
  const base = {
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

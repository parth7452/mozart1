import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { cents } from '@recouple/core-domain';
import { DECLINE_REASONS } from '@recouple/store-postgres';
import type { CaseSummary, StoredField } from '@recouple/store-postgres';
import { isCanonicalReasonCode } from '@recouple/core-domain';
import type { CaseWorkflow } from '@recouple/pipeline';
import { CaseList, type Viewer } from '../components/case-list';
import { CaseReview } from '../components/case-review';
import { DISPUTE_REASONS } from '../components/case-actions';
import { deadline, fieldLabel, money } from '../lib/format';

const viewer: Viewer = { email: 'ap@harborline.test', orgName: 'Harborline Foods', role: 'analyst' };
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
      <CaseList mayUpload viewer={viewer} cases={[summary(), summary({
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

  it('offers the upload to a member who may write, and not to one who may not', () => {
    const writer = renderToStaticMarkup(
      <CaseList mayUpload viewer={viewer} cases={[]} today={today} />,
    );
    expect(writer).toContain('action="/upload"');
    expect(writer).toContain('Add a document');

    // The database refuses a read_only member's insert whatever the page shows;
    // hiding the form is the difference between a refusal and a dead end.
    const reader = renderToStaticMarkup(
      <CaseList
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
        mayUpload
        viewer={viewer}
        cases={[]}
        today={today}
        notice="not scanned clean: error (none)"
      />,
    );
    expect(html).toContain('not scanned clean: error (none)');
  });

  it('says what will happen rather than showing an empty table', () => {
    const html = renderToStaticMarkup(
      <CaseList mayUpload viewer={viewer} cases={[]} today={today} />,
    );
    expect(html).toContain('No cases yet');
    expect(html).not.toContain('<table');
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
    const html = renderToStaticMarkup(
      <CaseReview {...props} mayAct={true} notice="recorded: this case is logged as declined" />,
    );
    expect(html).toContain('recorded: this case is logged as declined');
  });

  it('says why an upload landed on a case it did not open, and escapes what it quotes', () => {
    // The upload route redirects here when a second notice names a claim that
    // is already a case. The message quotes the claim id, which was read off
    // somebody else's document, so it is escaped like every other value here.
    const html = renderToStaticMarkup(
      <CaseReview
        {...props}
        mayAct={true}
        notice={'claim <script>alert(1)</script> is already this case'}
      />,
    );
    expect(html).toContain('class="notice bad"');
    expect(html).toContain('is already this case');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
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

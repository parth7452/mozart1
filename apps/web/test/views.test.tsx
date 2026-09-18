import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { cents } from '@recouple/core-domain';
import type { CaseSummary, StoredField } from '@recouple/store-postgres';
import { CaseList, type Viewer } from '../components/case-list';
import { CaseReview } from '../components/case-review';
import { deadline, fieldLabel, money } from '../lib/format';

const viewer: Viewer = { email: 'ap@harborline.test', orgName: 'Harborline Foods', role: 'analyst' };
const today = new Date('2026-09-18T12:00:00Z');

function summary(overrides: Partial<CaseSummary> = {}): CaseSummary {
  return {
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
      <CaseReview
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

  it('tells a reviewer which kind of check each field got', () => {
    const html = renderToStaticMarkup(
      <CaseReview
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
      <CaseReview
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
    expect(html).toContain('Nothing has been sent anywhere');
  });

  it('escapes text that came out of somebody else’s document', () => {
    // A retailer's notice is not a trusted document. This is the same class of
    // hole the review prototype had: extracted text reaching a page as markup.
    const attack = '<img src=x onerror="alert(1)">';
    const html = renderToStaticMarkup(
      <CaseReview
        viewer={viewer}
        summary={summary({ debtorName: attack, claimId: attack })}
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
      <CaseReview
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

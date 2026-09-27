import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PayerTermsAnswer } from '@recouple/core-domain';
import type { CaseDocument, CaseSummary } from '@recouple/store-postgres';
import { CaseReview } from '../components/case-review';
import type { Viewer } from '../components/case-list';

/** The payer's reason code on a case, as the case page shows it (build-now 01). */

const viewer: Viewer = { email: 'ap@harborline.test', orgName: 'Harborline Foods', role: 'analyst' };
const today = new Date('2026-09-18T12:00:00Z');
const EXTRACT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const NOTICE = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER = 'cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee';

function summary(own?: string): CaseSummary {
  return {
    deductionId: '11111111-2222-3333-4444-555555555555',
    state: 'classified',
    claimId: 'QBO-INV-1001',
    deductionAmountCents: 80_000,
    debtorName: 'Sysco Baltimore',
    discoveredVia: 'ledger',
    documentCount: 2,
    createdAt: '2026-09-10T00:00:00Z',
    ...(own === undefined ? {} : { reasonCodeAsPrinted: own }),
  } as unknown as CaseSummary;
}

function doc(documentId: string, filename: string, role: CaseDocument['role']): CaseDocument {
  return {
    documentId,
    filename,
    mimeType: 'application/pdf',
    docType: role === 'notice' ? null : 'deduction_notice',
    role,
    read: role !== 'notice',
    readForCase: false,
    servingRefusal: null,
  } as CaseDocument;
}

const documents = [
  doc(EXTRACT, 'ledger-extract-INV-1001.json', 'notice'),
  doc(NOTICE, 'sysco-notice.pdf', 'evidence'),
  doc(OTHER, 'sysco-remit.pdf', 'evidence'),
];

function render(payerTerms: PayerTermsAnswer | undefined, own?: string): string {
  return renderToStaticMarkup(
    <CaseReview
      viewer={viewer}
      summary={summary(own)}
      documents={documents}
      fields={[]}
      reconciliation={undefined}
      costMicros={0}
      today={today}
      mayAct={false}
      {...(payerTerms === undefined ? {} : { payerTerms })}
    />,
  );
}

describe('the payer terms on a case page', () => {
  it('shows a derived code, its reference and a link to the document it came from', () => {
    const html = render({
      kind: 'derived',
      terms: {
        reasonCode: 'SHORT-QTY',
        deductionReference: 'CB-77',
        documentId: NOTICE,
        fieldPath: 'lines[0].reason_code',
        quoteVerified: true,
      },
    });
    expect(html).toContain('Reason code: SHORT-QTY');
    expect(html).toContain(`<a href="/api/document/${NOTICE}">sysco-notice.pdf</a>`);
    expect(html).toContain('Deduction ref: CB-77');
    expect(html).toContain('quote found');
  });

  it('says the payer documents disagree and lists each candidate', () => {
    const html = render({
      kind: 'conflicting',
      candidates: [
        { reasonCode: 'A1', documentId: NOTICE, fieldPath: 'lines[0].reason_code', quoteVerified: true },
        { reasonCode: 'B2', documentId: OTHER, fieldPath: 'lines[1].reason_code', quoteVerified: null },
      ],
    });
    expect(html).toContain('Payer documents disagree');
    expect(html).toContain('code A1');
    expect(html).toContain('code B2');
    expect(html).toContain('sysco-remit.pdf');
    expect(html).not.toContain('Reason code:');
  });

  it('renders a case with its own code exactly as before', () => {
    expect(render({ kind: 'own' }, 'PRINTED')).toBe(render(undefined, 'PRINTED'));
    expect(render(undefined, 'PRINTED')).toContain('code PRINTED');
    expect(render({ kind: 'none' })).toBe(render(undefined));
  });
});

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { evidenceChecklist } from '@recouple/core-domain';
import type { CaseDocument } from '@recouple/store-postgres';
import { EvidenceChecklistPanel } from '../components/evidence-checklist';

const BOL = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const MSG = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';
const documents = [
  { documentId: BOL, filename: 'bol.pdf', mimeType: 'application/pdf', docType: 'bol' },
  { documentId: MSG, filename: 'reschedule.eml', mimeType: 'text/plain', docType: 'correspondence' },
] as unknown as CaseDocument[];

describe('EvidenceChecklistPanel', () => {
  it('prompts for a reason when none is chosen', () => {
    const html = renderToStaticMarkup(<EvidenceChecklistPanel documents={[]} />);
    expect(html).toContain('No reason chosen yet. Choose a reason under Decide to see the evidence it needs.');
  });

  it('shows have, possible and missing rows', () => {
    const checklist = evidenceChecklist({
      reason: 'compliance_late_delivery',
      onDate: '2026-09-21',
      present: [
        { documentId: BOL, evidenceType: 'carrier_signed_bol', strength: 'have' },
        { documentId: MSG, evidenceType: 'buyer_approval_email', strength: 'possible' },
      ],
    });
    const html = renderToStaticMarkup(<EvidenceChecklistPanel checklist={checklist} documents={documents} />);
    expect(html).toContain('Evidence for ');
    expect(html).toContain(`<a href="/api/document/${BOL}">bol.pdf</a>`);
    expect(html).toContain('Possible — check content');
    expect(html).toContain(`<a href="/api/document/${MSG}">reschedule.eml</a>`);
    expect(html).toContain('whether it is the buyer&#x27;s approval is not checked');
    expect(html).toContain('Missing');
    expect(html).toContain('Required');
    expect(html).toContain('Helpful');
    expect(html).toContain('Checklist version 2026-09-27.1.');
    expect(html).toContain('receiving report');
  });
});

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ManualEntrySummary } from '@recouple/store-postgres';
import { ManualEntryCard } from '../components/case-review';

const entry = (evidenceCount: number): ManualEntrySummary => ({
  deductionId: '11111111-2222-3333-4444-555555555555',
  enteredBy: '22222222-2222-4222-8222-222222222222',
  invoiceNumbers: ['INV-1', 'INV-2'],
  poNumber: 'PO-7',
  disputeAmountCents: 50_000,
  notes: [{ note: 'line one\nline two', by: 'x', at: '2026-10-07T00:00:00Z' }],
  evidenceCount,
});

describe('a case entered by hand (ADR 0070)', () => {
  it('says it is incomplete until a document is attached', () => {
    const html = renderToStaticMarkup(<ManualEntryCard entry={entry(0)} caseAmountCents={125_000} />);
    expect(html).toContain('Incomplete — no documents attached');
    expect(html).toContain('INV-1, INV-2');
    expect(html).toContain('(partial)');
    expect(html).toContain('line one\nline two');
  });

  it('drops the banner once one is', () => {
    const html = renderToStaticMarkup(<ManualEntryCard entry={entry(1)} caseAmountCents={50_000} />);
    expect(html).not.toContain('Incomplete');
    expect(html).not.toContain('(partial)');
  });
});

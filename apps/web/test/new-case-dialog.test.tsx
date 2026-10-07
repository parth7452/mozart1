import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NewCaseDialog } from '../components/new-case';

const VIEWER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const SYSCO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function render(props: Partial<Parameters<typeof NewCaseDialog>[0]> = {}): string {
  return renderToStaticMarkup(
    <NewCaseDialog
      debtors={[
        { debtorId: SYSCO, displayName: 'Sysco Baltimore' },
        { debtorId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', displayName: 'US Foods' },
      ]}
      members={[
        { userId: OTHER, email: 'ana@example.test', fullName: 'Ana' },
        { userId: VIEWER, email: 'me@example.test' },
      ]}
      prefill={{}}
      viewerUserId={VIEWER}
      today="2026-10-07"
      {...props}
    />,
  );
}

describe('the open-a-case dialog (ADR 0070)', () => {
  it('is a :target dialog with close links that clear the fragment', () => {
    const html = render();
    expect(html).toContain('id="new-case"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html.match(/href="#"/g)?.length).toBeGreaterThanOrEqual(3);
    expect(html).not.toContain('<details');
  });

  it('requires what identifies the deduction', () => {
    const html = render();
    for (const name of ['debtorId', 'deductionReference', 'amount', 'deductionDate', 'reasonCode']) {
      expect(html).toMatch(new RegExp(`id="nc-${name}"[^>]*required`));
    }
    expect(html).toMatch(/<textarea[^>]*name="invoiceNumbers"[^>]*required/);
    expect(html).toContain('max="2026-10-07"');
    expect(html).not.toMatch(/id="nc-poNumber"[^>]*required/);
  });

  it('draws every section and its sidebar label', () => {
    const html = render();
    for (const title of ['Deduction', 'Reason &amp; invoices', 'References', 'Dispute', 'Ownership &amp; notes', 'Add a payer']) {
      expect(html).toContain(`>${title}</h3>`);
      expect(html).toContain(`>${title}</label>`);
    }
  });

  it('applies the prefill and marks the refused field', () => {
    const html = render({
      prefill: { debtorId: SYSCO, deductionReference: 'CB-9', amount: '12.00' },
      invalidField: 'amount',
    });
    expect(html).toMatch(new RegExp(`<option value="${SYSCO}" selected="">Sysco Baltimore`));
    expect(html).toContain('value="CB-9"');
    expect(html).toMatch(/id="nc-amount"[^>]*aria-invalid="true"/);
  });

  it('defaults the owner to the viewer', () => {
    expect(render()).toMatch(new RegExp(`<option value="${VIEWER}" selected="">me@example.test`));
  });

  it('adds a payer in its own form, carrying the typing as hidden fields', () => {
    const html = render({ prefill: { amount: '12.00', debtorId: SYSCO } });
    expect(html).toContain('action="/cases/new/payer"');
    expect(html).toContain('action="/cases/new/open"');
    expect(html).toContain('<input type="hidden" name="amount" value="12.00"/>');
    expect(html).not.toContain(`type="hidden" name="debtorId"`);
  });
});

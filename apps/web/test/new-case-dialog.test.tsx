import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NewCaseDialog } from '../components/new-case';
import { newCaseAnswerOf, planSubmit } from '../components/new-case-submit';
import { UPLOAD_ACCEPT } from '../lib/upload-limits';

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
    for (const title of ['Deduction', 'Reason &amp; invoices', 'References', 'Dispute', 'Ownership &amp; notes', 'Documents', 'Add a payer']) {
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

  it('offers documents in a Documents section whose input no plain submit sends', () => {
    const html = render();
    expect(html).toContain('>Documents</h3>');
    expect(html).toContain('<label for="nc-files">Documents</label>');
    expect(html).toContain('<label for="nc-files">Attach documents');
    const input = html.match(/<input[^>]*id="nc-files"[^>]*>/)?.[0] ?? '';
    expect(input).toContain('type="file"');
    expect(input).toContain('multiple');
    expect(input).toContain('form="nc-files-holder"');
    expect(input).toContain(`accept="${UPLOAD_ACCEPT}"`);
    expect(html).toMatch(/<form id="nc-files-holder" hidden=""><\/form>/);
    expect(html).not.toContain('once the case is open you can attach');
    const main = html.match(/<form[^>]*action="\/cases\/new\/open"[^>]*>/)?.[0] ?? '';
    expect(main).toContain('method="post"');
    expect(main.toLowerCase()).not.toContain('enctype');
    expect(html).not.toContain('multipart');
  });
});

describe('planSubmit', () => {
  it('leaves a submit with no documents to the browser', () => {
    expect(planSubmit(0)).toBe('native');
  });
  it('opens the case first and then files documents when some were chosen', () => {
    expect(planSubmit(1)).toBe('open_then_attach');
    expect(planSubmit(3)).toBe('open_then_attach');
  });
});

describe('newCaseAnswerOf', () => {
  it('takes only the route\'s two shapes, with local paths', () => {
    expect(newCaseAnswerOf({ ok: true, deductionId: 'x', caseUrl: '/cases/x' })).toEqual({
      ok: true,
      deductionId: 'x',
      caseUrl: '/cases/x',
    });
    expect(newCaseAnswerOf({ ok: false, redirect: '/?nc=nc_role#new-case' })).toEqual({
      ok: false,
      redirect: '/?nc=nc_role#new-case',
    });
    expect(newCaseAnswerOf({ ok: false, redirect: 'https://evil.example/' })).toBeUndefined();
    expect(newCaseAnswerOf({ ok: false, redirect: '//evil.example/' })).toBeUndefined();
    expect(newCaseAnswerOf({ ok: true, caseUrl: '/cases/x' })).toBeUndefined();
    expect(newCaseAnswerOf('<html>')).toBeUndefined();
  });
});

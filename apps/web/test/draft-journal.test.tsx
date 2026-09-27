import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DraftJournal } from '../components/draft-journal';

describe('DraftJournal', () => {
  it('shows found and both previews on an open case, labelled as a draft', () => {
    const html = renderToStaticMarkup(<DraftJournal amountCents={120_000} declined={false} />);
    expect(html).toContain('Draft — not posted');
    expect(html).toContain('Deduction found');
    expect(html).toContain('If won');
    expect(html).toContain('If lost');
    expect(html).toContain('The expense account is chosen once a reason is decided.');
    expect(html).not.toMatch(/<form|<button|<a /);
  });

  it('a partial shows three entries at R and A - R', () => {
    const html = renderToStaticMarkup(
      <DraftJournal amountCents={100_000} outcome="partial" recoveredCents={30_000} declined={false} family="freight" />,
    );
    expect(html).toContain('Draft — not posted');
    expect(html.match(/<table/g)).toHaveLength(3);
    expect(html).toContain('$300.00');
    expect(html).toContain('$700.00');
    expect(html).toContain('Freight Deductions Expense');
    expect(html).not.toContain('If won');
    expect(html).not.toMatch(/<form|<button/);
  });

  it('shows invalid input as an alert rather than throwing', () => {
    const html = renderToStaticMarkup(
      <DraftJournal amountCents={100_000} outcome="won" recoveredCents={10} declined={false} />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('Cannot draft entries');
    expect(html).toContain('Draft — not posted');
  });
});

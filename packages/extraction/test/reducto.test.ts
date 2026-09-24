import { describe, expect, it } from 'vitest';
import { withoutInlineMarkup } from '../src/markup';
import { locateQuote } from '../src/ocr';
import { ReductoOcr } from '../src/reducto';
import { checkQuote } from '../src/verify';
import type { DocumentPayload } from '../src/ports';

const payload: DocumentPayload = {
  documentId: 'd1',
  orgId: 'o1',
  filename: '05_remittance.pdf',
  mimeType: 'application/pdf',
  base64: 'JVBERi0=',
  byteSize: 8,
};

/**
 * A text PDF as Reducto parsed it on 2026-09-23: LOG-001's remittance, bold
 * values wrapped in `<b>`. No network — the fetch is the response.
 */
function reductoReturning(blocks: ReadonlyArray<{ content: string; top: number }>): ReductoOcr {
  const fetchImpl = (async (url: string | URL | Request) => {
    const path = String(url);
    if (path.endsWith('/upload')) return Response.json({ file_id: 'reducto://f1' });
    return Response.json({
      job_id: 'j1',
      usage: { num_pages: 1, credits: 1 },
      result: {
        chunks: [
          {
            content: blocks.map((b) => b.content).join('\n'),
            blocks: blocks.map((b) => ({
              type: 'Text',
              content: b.content,
              bbox: { left: 0.05, top: b.top, width: 0.5, height: 0.03, page: 1 },
              confidence: 'high',
            })),
          },
        ],
      },
    });
  }) as typeof fetch;
  return new ReductoOcr({ apiKey: 'test', fetchImpl });
}

const LOG_001_REMITTANCE = [
  { content: 'Invoice: <b>INV-AFS-260814</b>', top: 0.1 },
  { content: 'Gross invoice: <b>$4,800.00</b>', top: 0.2 },
  { content: 'Deduction: LATE-DEL: <b>$600.00</b>', top: 0.3 },
  { content: 'Payer: Brookfield &amp; Sons', top: 0.4 },
];

describe('a Reducto parse with bold runs', () => {
  it('stores a text layer and blocks with no markup in them', async () => {
    const result = await reductoReturning(LOG_001_REMITTANCE).ocr(payload);
    expect(result.pages).toEqual([
      {
        page: 1,
        text:
          'Invoice: INV-AFS-260814\nGross invoice: $4,800.00\n' +
          'Deduction: LATE-DEL: $600.00\nPayer: Brookfield & Sons',
      },
    ]);
    expect(result.blocks.map((b) => b.text).join('')).not.toMatch(/<\/?b>|&amp;/);
  });

  it('verifies the quotes the model reports, and boxes the bold value', async () => {
    const result = await reductoReturning(LOG_001_REMITTANCE).ocr(payload);
    const pages = result.pages.map((p) => p.text);
    // As the model quoted them on the live run: read off the page, no markup.
    for (const quote of [
      'Invoice: INV-AFS-260814',
      'Gross invoice $4,800.00',
      'LATE-DEL: $600.00',
      'Brookfield & Sons',
    ]) {
      expect(checkQuote(quote, 1, pages).verified, quote).toBe(true);
    }
    expect(checkQuote('Invoice: INV-AFS-260814', 1, pages).matchedBy).toBe('exact');
    expect(locateQuote('Gross invoice: $4,800.00', 1, result.blocks)?.bbox).toEqual([
      0.05, 0.2, 0.55, 0.23,
    ]);
  });

  it('still catches an invented value', async () => {
    const result = await reductoReturning(LOG_001_REMITTANCE).ocr(payload);
    const pages = result.pages.map((p) => p.text);
    expect(checkQuote('Gross invoice $5,800.00', 1, pages).verified).toBe(false);
    expect(checkQuote('Deduction: LATE-DEL: $6,000.00', 1, pages).verified).toBe(false);
    // With the tag left in, the glyph fold read its `b` as an 8 and verified this.
    expect(checkQuote('$84,800.00', 1, pages).verified).toBe(false);
  });
});

describe('a text layer stored before the adapter removed markup', () => {
  // Rows already in document_pages keep their tags (invariant 2); a later read
  // of that document checks its quotes against them.
  const stored = ['Invoice: <b>INV-AFS-260814</b>\nGross invoice: <b>$4,800.00</b>'];

  it('verifies what is printed there', () => {
    expect(checkQuote('Gross invoice $4,800.00', 1, stored).verified).toBe(true);
    expect(checkQuote('Invoice: INV-AFS-260814', 1, stored).matchedBy).toBe('exact');
  });

  it('no longer verifies an invented value through the tag’s letters', () => {
    expect(checkQuote('$84,800.00', 1, stored).verified).toBe(false);
    expect(checkQuote('Gross invoice $4,900.00', 1, stored).verified).toBe(false);
  });
});

describe('what counts as markup', () => {
  it('removes inline formatting, in any case and with attributes', () => {
    expect(withoutInlineMarkup('<B>Total</B> <strong>due</strong> <em>now</em> <i>x</i><u>y</u>')).toBe(
      'Total due now xy',
    );
    expect(withoutInlineMarkup('<span class="hl">$600.00</span> 1<sup>st</sup>')).toBe('$600.00 1st');
  });

  it('keeps a line break as whitespace', () => {
    expect(withoutInlineMarkup('Gross<br>invoice<br />total')).toBe('Gross\ninvoice\ntotal');
  });

  it('leaves structure and anything else in angle brackets alone', () => {
    const table = '<table><tr><td>INV-1</td><td>$4,800.00</td></tr></table>';
    expect(withoutInlineMarkup(table)).toBe(table);
    const header = 'From: Alder Freight <dispatch@alderfreight.example>, <b@example.com>';
    expect(withoutInlineMarkup(header)).toBe(header);
    expect(withoutInlineMarkup('<bold>x</bold>')).toBe('<bold>x</bold>');
  });

  it('decodes the escapes a serialiser writes, once, and guesses at nothing else', () => {
    expect(withoutInlineMarkup('AT&amp;T &lt;&gt; &quot;a&quot; it&#x27;s &#36;5')).toBe(
      'AT&T <> "a" it\'s $5',
    );
    // The page printing "<b>" is text, not a tag.
    expect(withoutInlineMarkup('&lt;b&gt;')).toBe('<b>');
    expect(withoutInlineMarkup('&amp;lt;')).toBe('&lt;');
    expect(withoutInlineMarkup('&rsquo; &#0; &#xD800; & P&G;')).toBe('&rsquo; &#0; &#xD800; & P&G;');
  });
});

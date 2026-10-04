import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { UnattachedDocument } from '@recouple/pipeline';
import type { AttachTargets, CaseSummary, SuggestedCase } from '@recouple/store-postgres';
import { AttachReadDocuments, UnattachedDocuments } from '../components/unattached-documents';
import {
  SUGGESTIONS_SHOWN,
  basisWords,
  groupByPayer,
  unattachedWithSuggestions,
  withSuggestions,
  type UnattachedDocumentWithSuggestions,
} from '../lib/document-suggestions';

/**
 * A document read and on no case, shown with the case it probably belongs on.
 *
 * The views are pure functions of what the store returned, so what is asserted
 * here is what a person is shown and what the button posts: the suggestion
 * first and labelled with its strength, one press per suggestion whatever the
 * strength, the picker still there, the list grouped by payer with "Unmatched"
 * last — and that an identifier off a page is rendered as text.
 */

let n = 0;
function aCase(overrides: Partial<CaseSummary> = {}): CaseSummary {
  n += 1;
  return {
    deductionId: `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`,
    state: 'classified',
    claimId: `DN-${n}`,
    deductionAmountCents: 12_345,
    discoveredVia: 'notice',
    documentCount: 1,
    createdAt: '2026-09-20T09:00:00Z',
    ...overrides,
  };
}

function aDocument(filename: string, suggestions?: readonly SuggestedCase[]): UnattachedDocumentWithSuggestions {
  n += 1;
  return {
    documentId: `eeeeeeee-0000-4000-8000-${String(n).padStart(12, '0')}`,
    filename,
    createdAt: '2026-09-23T15:56:16.000Z',
    docType: 'invoice',
    confidence: 0.98,
    ...(suggestions !== undefined ? { suggestions } : {}),
  };
}

const exactOn = (summary: CaseSummary, value = '44817'): SuggestedCase => ({
  caseId: summary.deductionId,
  strength: 'exact',
  basis: [{ kind: 'invoice_number', field: 'invoice_number', value }],
  case: summary,
});

const offered = (rows: readonly CaseSummary[]): AttachTargets => ({ rows, total: rows.length, limit: 250 });

describe('a suggested case on the list of documents read and on no case', () => {
  it('says which case, on what and how strongly, with one button that files it there', () => {
    const target = aCase({ claimId: 'DN-2609-003', debtorName: 'Kroger' });
    const document = aDocument('invoice-44817.pdf', [exactOn(target)]);
    const html = renderToStaticMarkup(
      <UnattachedDocuments documents={[document]} targets={offered([target])} />,
    );

    expect(html).toContain(
      `Matches case <a href="/cases/${target.deductionId}">DN-2609-003</a> on invoice 44817 (exact)`,
    );
    // The existing attach route, the case preselected, and the kinds that agreed.
    expect(html).toContain(
      `<form action="/documents/${document.documentId}/attach" method="post">` +
        `<input type="hidden" name="caseId" value="${target.deductionId}"/>` +
        '<input type="hidden" name="basis" value="invoice_number"/>' +
        '<button type="submit">Attach to this case',
    );
    // The full picker stays, second.
    expect(html).toContain('or pick another case');
    expect(html).toContain('Choose a case');
    expect(html.indexOf('Attach to this case')).toBeLessThan(html.indexOf('or pick another case'));
  });

  it('labels an ambiguous and a probable suggestion as such, each with the same press', () => {
    const one = aCase({ claimId: 'A-1' });
    const two = aCase({ claimId: 'A-2' });
    const maybe = aCase({ claimId: 'P-1' });
    const ambiguous = (summary: CaseSummary): SuggestedCase => ({
      caseId: summary.deductionId,
      strength: 'ambiguous',
      basis: [{ kind: 'po_number', field: 'po_number', value: 'PO-771' }],
      case: summary,
    });
    const probable: SuggestedCase = {
      caseId: maybe.deductionId,
      strength: 'probable',
      basis: [
        { kind: 'payer', field: 'customer_name' },
        { kind: 'amount_cents', field: 'invoice_total' },
      ],
      case: maybe,
    };
    const html = renderToStaticMarkup(
      <UnattachedDocuments
        documents={[aDocument('pod.jpg', [ambiguous(one), ambiguous(two), probable])]}
        targets={offered([one, two, maybe])}
      />,
    );

    expect(html).toContain('>A-1</a> on purchase order PO-771 — 2 open cases carry it (ambiguous)');
    expect(html).toContain('>A-2</a> on purchase order PO-771 — 2 open cases carry it (ambiguous)');
    expect(html).toContain('>P-1</a> on the same payer and the same amount (probable)');
    expect(html.match(/May match case/g)).toHaveLength(2);
    expect(html.match(/Possibly case/g)).toHaveLength(1);
    expect(html).not.toContain('Matches case');
    expect(html.match(/Attach to this case/g)).toHaveLength(3);
    expect(html).toContain('name="basis" value="payer,amount_cents"');
  });

  it('draws the strongest few and counts the rest', () => {
    const cases = Array.from({ length: SUGGESTIONS_SHOWN + 2 }, () => aCase());
    const html = renderToStaticMarkup(
      <UnattachedDocuments
        documents={[
          aDocument(
            'many.pdf',
            cases.map((summary) => ({ ...exactOn(summary), strength: 'ambiguous' as const })),
          ),
        ]}
        targets={offered(cases)}
      />,
    );
    expect(html.match(/Attach to this case/g)).toHaveLength(SUGGESTIONS_SHOWN);
    expect(html).toContain('and 2 more possible cases — pick from the list');
    expect(html).toContain(`${SUGGESTIONS_SHOWN + 2} open cases carry it (ambiguous)`);
  });

  it('names a case with no claim id by its invoice, else by when it was opened', () => {
    const unclaimed = (summary: CaseSummary): CaseSummary => {
      const { claimId: _claimId, ...rest } = summary;
      return rest;
    };
    const ledger = unclaimed(aCase({ invoiceNumber: 'INV-9' }));
    const bare = unclaimed(aCase());
    const html = renderToStaticMarkup(
      <UnattachedDocuments
        documents={[aDocument('a.pdf', [exactOn(ledger)]), aDocument('b.pdf', [exactOn(bare)])]}
        targets={offered([ledger, bare])}
      />,
    );
    expect(html).toContain('>for invoice INV-9</a>');
    expect(html).toContain('>opened 2026-09-20</a>');
  });

  it('renders an identifier off the page as text, never as markup', () => {
    const target = aCase();
    const html = renderToStaticMarkup(
      <UnattachedDocuments
        documents={[aDocument('x.pdf', [exactOn(target, '<img src=x onerror=alert(1)>')])]}
        targets={offered([target])}
      />,
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    // And it is not what the form posts: the kinds are.
    expect(html).toContain('name="basis" value="invoice_number"');
  });

  it('groups the list by the suggested case’s payer, with the unmatched last', () => {
    const kroger = aCase({ debtorName: 'Kroger', retailerKey: 'kroger' });
    const krogerPrinted = aCase({ retailerNameAsPrinted: 'KROGER CO.' });
    const walmart = aCase({ retailerNameAsPrinted: 'Walmart Stores, Inc.' });
    const nameless = aCase();
    const html = renderToStaticMarkup(
      <UnattachedDocuments
        documents={[
          aDocument('loose.pdf', []),
          aDocument('walmart.pdf', [exactOn(walmart)]),
          aDocument('kroger-printed.pdf', [exactOn(krogerPrinted)]),
          aDocument('nameless.pdf', [exactOn(nameless)]),
          aDocument('kroger.pdf', [exactOn(kroger)]),
        ]}
        targets={offered([kroger, krogerPrinted, walmart, nameless])}
      />,
    );

    const headings = [...html.matchAll(/<h3 class="unattached-group-heading">([^<]*)/g)].map((m) =>
      m[1]?.trim(),
    );
    // One Kroger heading for the debtor and the folded printed name, under the
    // name a person gave it; payers in name order; then the two tails.
    expect(headings).toEqual(['Kroger', 'Walmart Stores, Inc.', 'Payer not named on the case', 'Unmatched']);
    expect(html).toContain('aria-label="Kroger"');
    const at = (text: string) => html.indexOf(text);
    expect(at('kroger-printed.pdf')).toBeLessThan(at('kroger.pdf'));
    expect(at('kroger.pdf')).toBeLessThan(at('walmart.pdf'));
    expect(at('walmart.pdf')).toBeLessThan(at('nameless.pdf'));
    expect(at('nameless.pdf')).toBeLessThan(at('loose.pdf'));
    expect(html).toContain('No open case was suggested for these.');
  });

  it('stays one flat list, with no headings, when nothing was suggested', () => {
    const target = aCase();
    for (const documents of [
      [aDocument('a.pdf'), aDocument('b.pdf')],
      [aDocument('a.pdf', []), aDocument('b.pdf', [])],
    ]) {
      const html = renderToStaticMarkup(
        <UnattachedDocuments documents={documents} targets={offered([target])} />,
      );
      expect(html).not.toContain('unattached-group');
      expect(html).not.toContain('Unmatched');
      expect(html).not.toContain('or pick another case');
      expect(html.match(/<ul class="unattached-list">/g)).toHaveLength(1);
      expect(html.match(/class="unattached-row"/g)).toHaveLength(2);
    }
  });
});

describe('a suggested document on a case’s own page', () => {
  it('lists the documents suggested for this case first, each saying what agreed', () => {
    const here = aCase({ claimId: 'HERE' });
    const elsewhere = aCase({ claimId: 'ELSEWHERE' });
    const loose = aDocument('loose.pdf', []);
    const other = aDocument('other-case.pdf', [exactOn(elsewhere)]);
    const mine = aDocument('mine.pdf', [exactOn(here, 'INV-7')]);
    const html = renderToStaticMarkup(
      <AttachReadDocuments deductionId={here.deductionId} documents={[loose, other, mine]} />,
    );

    expect(html.indexOf('mine.pdf')).toBeLessThan(html.indexOf('loose.pdf'));
    expect(html.indexOf('loose.pdf')).toBeLessThan(html.indexOf('other-case.pdf'));
    expect(html).toContain('Matches this case on invoice INV-7 (exact)');
    // Only the suggested one posts a basis; every one posts this case.
    expect(html.match(/name="basis"/g)).toHaveLength(1);
    expect(html.match(new RegExp(`name="caseId" value="${here.deductionId}"`, 'g'))).toHaveLength(3);
    // A suggestion for another case is not shown as one for this case.
    expect(html).not.toContain('ELSEWHERE');
  });

  it('is unchanged for documents that carry no suggestions', () => {
    const plain: UnattachedDocument = aDocument('plain.pdf');
    const html = renderToStaticMarkup(
      <AttachReadDocuments deductionId="aaaaaaaa-0000-4000-8000-999999999999" documents={[plain]} />,
    );
    expect(html).toContain('plain.pdf');
    expect(html).not.toContain('name="basis"');
    expect(html).not.toContain('this case on');
  });
});

describe('putting suggestions on documents', () => {
  it('matches by document id, gives none to a document not mentioned, and drops the rest', () => {
    const target = aCase();
    const a = aDocument('a.pdf');
    const b = aDocument('b.pdf');
    const got = withSuggestions(
      [a, b],
      [
        { documentId: b.documentId, suggestions: [exactOn(target)] },
        { documentId: 'eeeeeeee-0000-4000-8000-ffffffffffff', suggestions: [exactOn(target)] },
      ],
    );
    expect(got.map((d) => [d.documentId, d.suggestions?.length])).toEqual([
      [a.documentId, 0],
      [b.documentId, 1],
    ]);
  });

  it('asks for suggestions only when something is waiting, with the list’s limit', async () => {
    const calls: [string, number | undefined][] = [];
    const store = (documents: readonly UnattachedDocument[]) => ({
      async unattachedDocuments(limit?: number) {
        calls.push(['documents', limit]);
        return documents;
      },
      async suggestionsForUnattached(limit?: number) {
        calls.push(['suggestions', limit]);
        return [];
      },
    });

    expect(await unattachedWithSuggestions(store([]), 50)).toEqual([]);
    expect(calls).toEqual([['documents', 50]]);

    calls.length = 0;
    const one = aDocument('one.pdf');
    expect(await unattachedWithSuggestions(store([one]), 50)).toEqual([{ ...one, suggestions: [] }]);
    expect(calls).toEqual([
      ['documents', 50],
      ['suggestions', 50],
    ]);
  });

  it('has nothing to group by when no document has a suggestion', () => {
    expect(groupByPayer([aDocument('a.pdf'), aDocument('b.pdf', [])])).toBeUndefined();
  });

  it('says what agreed in words, in a fixed order', () => {
    expect(
      basisWords([
        { kind: 'bol_number', field: 'document_number', value: ' BOL 12 ' },
        { kind: 'po_number', field: 'po_number', value: 'PO-771' },
        { kind: 'claim_id', field: 'claim_id', value: 'DN-1' },
      ]),
    ).toBe('claim DN-1, purchase order PO-771 and shipment number BOL 12');
    expect(basisWords([{ kind: 'reference', field: 'references[0].value', value: '44817' }])).toBe(
      'a reference it names, 44817',
    );
  });
});

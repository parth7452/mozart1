import { describe, expect, it } from 'vitest';
import { everyDocument } from '@recouple/fixtures';
import { DOC_TYPES } from '../src/ports';
import { CLASSIFY_SYSTEM } from '../src/prompt';

/**
 * The classifier's prompt is not something a unit test can grade: whether a
 * definition classifies a page correctly is an API call, and only a recording
 * answers it (`pnpm record:cassettes`, then `pnpm eval`). What can be asserted
 * here is the shape the prompt has to keep for the recordings to mean anything.
 */

/** `type → definition`, read off the `Types:` list the model is given. */
function definitions(): Map<string, string> {
  const list = CLASSIFY_SYSTEM.split('Types:\n')[1]?.split('\n\n')[0];
  if (list === undefined) throw new Error('CLASSIFY_SYSTEM has no Types: list');
  const found = new Map<string, string>();
  for (const line of list.split('\n')) {
    const match = /^- ([a-z_]+): (.+)$/.exec(line);
    if (match === null) throw new Error(`not a definition: ${line}`);
    const [, name, definition] = match as unknown as [string, string, string];
    if (found.has(name)) throw new Error(`${name} is defined twice`);
    found.set(name, definition);
  }
  return found;
}

const words = (text: string) => text.replace(/\s+/g, ' ');

describe('the classifier prompt', () => {
  it('defines every document type the reader can return, once, and nothing else', () => {
    // A type the model is allowed to answer with but was never told about is
    // one it can only guess at. `ClassificationSchema` takes its enum from
    // DOC_TYPES, so the list and the definitions drifting apart is silent.
    expect([...definitions().keys()].sort()).toEqual([...DOC_TYPES].sort());
  });

  it('tells an agreement that sets rates from an order for quantities', () => {
    // The rule a recorded above-floor miss was fixed with: a staffing service
    // order that set bill rates read as a po at 0.95, so the agreed rates were
    // extracted against a schema that has nowhere to put a rate. Removing the
    // rule is allowed; doing it without this failing is not.
    const defs = definitions();
    expect(defs.get('po')).toMatch(/quantities/);
    expect(defs.get('price_agreement')).toMatch(/sets the prices or rates/);
    expect(defs.get('price_agreement')).toMatch(/service order/);
    expect(defs.get('price_agreement')).toMatch(/statement of work/);
    const prompt = words(CLASSIFY_SYSTEM);
    expect(prompt).toContain('Setting prices is not ordering.');
    expect(prompt).toContain('A PO number on the page never decides the type');
    // The widened price_agreement must not take what promo_agreement is for.
    expect(prompt).toContain('Promotional allowances and deal terms are promo_agreement.');
  });

  it('asks an agreement to name a price, and sends a dated page with none to other', () => {
    // The rules added after a one-time check of scanned office papers
    // (docs/audits/rvl-cdip-classification/): five of ten product
    // specifications read as price_agreement at 0.75–0.85 on an effective date
    // and "supersedes" alone, with no price on the page, and three of ten
    // budgets, one a media buy schedule, read as promo_agreement or
    // price_agreement. Neither type opens a case; the cost is a page extracted
    // as the wrong kind of evidence. Removing a rule is allowed; doing it
    // without this failing is not.
    const defs = definitions();
    const prompt = words(CLASSIFY_SYSTEM);

    // A price agreement names a price.
    expect(defs.get('price_agreement')).toMatch(
      /It must fix at least one price, rate, fee, discount or allowance that one party will charge or pay another; a document that names none is not one/,
    );
    // A specification with only an effective date on it is other.
    expect(prompt).toContain(
      'An effective date, a revision number or "supersedes" does not make a document an agreement: a product or technical specification carries them too, and is other.',
    );
    expect(prompt).toContain(
      'A budget, an internal cost plan, or a schedule of costs that is not an agreement between two parties is other as well, even when every line has an amount',
    );
    // A media buy plan is not a promo agreement, which a seller and its buyer
    // or retailer agree between them.
    expect(defs.get('promo_agreement')).toMatch(
      /^an agreement between a seller and a buyer or retailer about a promotion, deal or allowance/,
    );
    expect(defs.get('promo_agreement')).toMatch(
      /An advertising or media buy plan, or a marketing budget, is not one/,
    );
    // The tightening must not push out an agreement nobody signed: a published
    // price list or rate sheet fixes a price for whoever buys under it.
    expect(defs.get('price_agreement')).toMatch(/a price list/);
    expect(prompt).toContain('A price list or rate sheet is a price_agreement, signed or not');
  });

  it('expects an agreement only of a fixture whose page prints a price', () => {
    // The corpus has to say what the prompt says, or the eval grades the
    // prompt against answers it forbids. Only a page with a text layer can be
    // read here, so a scan or a photograph is not checked by this.
    const printed = everyDocument().filter(
      (d) =>
        (d.docType === 'price_agreement' || d.docType === 'promo_agreement') &&
        d.pageText.some((t) => t.trim() !== ''),
    );
    expect(printed.length).toBeGreaterThan(0);
    const price = /[$€£]\s?\d|\d\s?¢/;
    const priceless = printed.filter((d) => !price.test(d.pageText.join('\n'))).map((d) => d.key);
    expect(priceless).toEqual([]);
  });

  it('is written as rules, not as the fixtures it was corrected against', () => {
    // A definition that names a fixture's party, identifier or amount passes the
    // eval by remembering the answer. It says nothing about the next page, and
    // it makes the eval measure the prompt's memory instead of the classifier.
    const prompt = CLASSIFY_SYSTEM.toLowerCase();
    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const appears = (needle: string) =>
      new RegExp(`(^|[^a-z0-9])${escape(needle.toLowerCase())}($|[^a-z0-9])`).test(prompt);

    const PARTY_FIELDS = new Set([
      'buyer_name',
      'counterparty',
      'customer_name',
      'payer_name',
      'recipient',
      'retailer_name',
      'sender',
      'sender_organisation',
      'signed_by',
    ]);

    const leaks: string[] = [];
    for (const document of everyDocument()) {
      const needles = [document.key, document.filename.replace(/\.[a-z]+$/, '')];
      for (const [fieldPath, expectation] of Object.entries(document.truth)) {
        if (expectation.kind !== 'text') continue;
        const value = String(expectation.value);
        const leaf = fieldPath.split('.').at(-1) ?? fieldPath;
        // Party names, and any identifier or date — a value with a digit in
        // it. Bare words ("PD", "SHORT") are left out: they are vocabulary the
        // prompt may legitimately share with a page.
        if (PARTY_FIELDS.has(leaf) || (/\d/.test(value) && value.length >= 5)) {
          needles.push(value);
        }
      }
      for (const needle of needles) {
        if (appears(needle)) leaks.push(`${document.key}: ${needle}`);
      }
    }
    expect(leaks).toEqual([]);
    // No amount at all: nothing in a definition of a type needs one.
    expect(CLASSIFY_SYSTEM).not.toMatch(/[$€£]\s?\d/);
  });
});

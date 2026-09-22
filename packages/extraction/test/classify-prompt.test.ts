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

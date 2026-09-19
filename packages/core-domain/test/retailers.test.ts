import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { resolveDebtorId, retailerMatchKey } from '../src/retailers';

describe('retailerMatchKey', () => {
  it('folds case, punctuation and whitespace', () => {
    expect(retailerMatchKey('WALMART STORES, INC.')).toBe('walmart stores');
    expect(retailerMatchKey('  Walmart   Stores Inc  ')).toBe('walmart stores');
    expect(retailerMatchKey('Walmart')).toBe('walmart');
    expect(retailerMatchKey('walmart_stores')).toBe('walmart stores');
  });

  it('does not decide that "Walmart Stores" is Walmart — that is an alias a human adds', () => {
    expect(retailerMatchKey('WALMART STORES, INC.')).not.toBe(retailerMatchKey('Walmart'));
  });

  it('strips every trailing legal form, but never the only word left', () => {
    expect(retailerMatchKey('Acme Holdings Co., Ltd.')).toBe('acme holdings');
    expect(retailerMatchKey('Target Corporation')).toBe('target');
    expect(retailerMatchKey('Kroger Co.')).toBe('kroger');
    expect(retailerMatchKey('Inc')).toBe('inc');
    expect(retailerMatchKey('Co.')).toBe('co');
  });

  it('has no key for a name with nothing in it', () => {
    expect(retailerMatchKey('')).toBe('');
    expect(retailerMatchKey('  ,. -- ')).toBe('');
  });

  it('ignores accents, so a scan that drops one still matches', () => {
    expect(retailerMatchKey('Carrefour Société')).toBe(retailerMatchKey('CARREFOUR SOCIETE'));
  });

  it('is idempotent and case-insensitive for any name', () => {
    // Latin-script names only: a case fold is not a round trip in every script
    // (German ß upper-cases to SS), and a retailer name on a US notice is not
    // the place to find out.
    const latinName = fc
      .array(fc.constantFrom(...'AaBbZz09 .,&-_éÉ'.split('')), { maxLength: 24 })
      .map((chars) => chars.join(''));
    fc.assert(
      fc.property(latinName, (name) => {
        const key = retailerMatchKey(name);
        expect(retailerMatchKey(key)).toBe(key);
        expect(retailerMatchKey(name.toUpperCase())).toBe(key);
        expect(retailerMatchKey(`  ${name} `)).toBe(key);
        expect(key).not.toMatch(/^\s|\s$|\s\s/);
      }),
    );
  });
});

describe('resolveDebtorId', () => {
  const walmart = { debtorId: 'd-walmart', names: ['Walmart', 'walmart'] };
  const target = { debtorId: 'd-target', names: ['Target Corporation', 'target'] };

  it('resolves on a display name, whatever the spelling on the page', () => {
    expect(resolveDebtorId('WALMART, INC.', [walmart, target])).toBe('d-walmart');
    expect(resolveDebtorId('  target corp ', [walmart, target])).toBe('d-target');
  });

  it('resolves through an alias a human added, which is the point of aliases', () => {
    const withAlias = { ...walmart, names: [...walmart.names, 'WALMART STORES, INC.'] };
    expect(resolveDebtorId('Walmart Stores Inc', [withAlias, target])).toBe('d-walmart');
  });

  it('does not resolve a name nobody has claimed', () => {
    expect(resolveDebtorId('WALMART STORES, INC.', [walmart, target])).toBeUndefined();
    expect(resolveDebtorId('Costco', [walmart, target])).toBeUndefined();
  });

  it('refuses to choose when two debtors answer to the same name', () => {
    const twin = { debtorId: 'd-twin', names: ['Walmart Inc'] };
    expect(resolveDebtorId('Walmart', [walmart, twin])).toBeUndefined();
  });

  it('treats a name with no key as no match, never as a match on everything', () => {
    const empty = { debtorId: 'd-empty', names: ['', '   '] };
    expect(resolveDebtorId('', [empty])).toBeUndefined();
    expect(resolveDebtorId('  ,. ', [empty])).toBeUndefined();
    expect(resolveDebtorId('Walmart', [empty])).toBeUndefined();
  });

  it('resolves to nothing when there are no debtors at all', () => {
    expect(resolveDebtorId('Walmart', [])).toBeUndefined();
  });

  it('only ever returns a debtor it was given', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.array(
          fc.record({
            debtorId: fc.string({ minLength: 1 }),
            names: fc.array(fc.string(), { maxLength: 3 }),
          }),
          { maxLength: 5 },
        ),
        (printed, candidates) => {
          const resolved = resolveDebtorId(printed, candidates);
          if (resolved !== undefined) {
            expect(candidates.map((c) => c.debtorId)).toContain(resolved);
          }
        },
      ),
    );
  });
});

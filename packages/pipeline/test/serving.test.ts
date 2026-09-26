import { describe, expect, it } from 'vitest';
import { UPLOAD_SOURCES, servingRefusal } from '../src';

/**
 * What may be handed to a browser: a clean verdict, or a ledger extract our own
 * code wrote and nothing scanned. Everything else is refused, and says why.
 */
describe('whether a document’s bytes may be served', () => {
  it('serves a clean document from any door, or none recorded', () => {
    for (const source of [...UPLOAD_SOURCES, null]) {
      expect(servingRefusal({ scan: 'clean', source })).toBeUndefined();
    }
  });

  it('refuses an infected document from any door, a ledger extract included', () => {
    for (const source of [...UPLOAD_SOURCES, null]) {
      expect(servingRefusal({ scan: 'infected', source })).toBe('infected');
    }
  });

  it('refuses a document with no verdict, or a scanner error, from every door but the ledger', () => {
    for (const source of [...UPLOAD_SOURCES.filter((s) => s !== 'erp_sync'), null]) {
      expect(servingRefusal({ scan: null, source })).toBe('unscanned');
      expect(servingRefusal({ scan: 'error', source })).toBe('unscanned');
    }
  });

  it('serves a ledger extract nothing scanned, and refuses one a scanner could not clear', () => {
    expect(servingRefusal({ scan: null, source: 'erp_sync' })).toBeUndefined();
    expect(servingRefusal({ scan: 'error', source: 'erp_sync' })).toBe('unscanned');
  });
});

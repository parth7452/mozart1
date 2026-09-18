import { describe, expect, it } from 'vitest';
import { inlineJsonSafely } from '../src/review';

describe('embedding document-derived data in a page', () => {
  it('stops a document closing the script element it is embedded in', () => {
    // A supplier's PDF whose OCR text carries this, or a model quote copying it
    // verbatim, would otherwise become live markup in the reviewer's browser.
    const payload = '</script><img src=x onerror=alert(document.domain)>';
    const hostile = JSON.stringify({ quote: payload });
    expect(hostile).toContain('</script>');

    const safe = inlineJsonSafely(hostile);
    expect(safe).not.toContain('</script');
    expect(safe).not.toContain('<');
    // Still valid JSON carrying the same value: escaped, not mangled.
    expect(JSON.parse(safe).quote).toBe(payload);
  });

  it('escapes the separators that terminate a JavaScript string literal', () => {
    const separators = String.fromCodePoint(0x2028) + String.fromCodePoint(0x2029);
    const safe = inlineJsonSafely(JSON.stringify({ text: `a${separators}b` }));
    expect(safe).not.toContain(String.fromCodePoint(0x2028));
    expect(safe).not.toContain(String.fromCodePoint(0x2029));
    expect(JSON.parse(safe).text).toBe(`a${separators}b`);
  });

  it('leaves ordinary content alone', () => {
    const json = JSON.stringify({ value: '$3,120.00', quote: 'Total Deduction: $3,120.00' });
    expect(inlineJsonSafely(json)).toBe(json);
  });
});

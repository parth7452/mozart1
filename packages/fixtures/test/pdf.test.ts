import { describe, expect, it } from 'vitest';
import { FIXTURE_CASES, allFixtureDocuments, renderTextPdf } from '../src/index';

describe('the fixture PDFs', () => {
  it('are byte-identical across runs, so a hash is a stable cassette key', () => {
    const first = renderTextPdf([['Claim ID: X-1', 'Total: $1.00']]);
    const second = renderTextPdf([['Claim ID: X-1', 'Total: $1.00']]);
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
  });

  it('carry the text they claim to carry', () => {
    for (const document of allFixtureDocuments()) {
      const raw = Buffer.from(document.bytes).toString('latin1');
      for (const page of document.pageText) {
        for (const line of page.split('\n').filter((l) => l.trim() !== '')) {
          // The generator escapes these; checking a distinctive substring is
          // enough to prove the line reached the content stream.
          const probe = line.replace(/[()\\]/g, '').slice(0, 24);
          expect(raw, `${document.key}: ${line}`).toContain(probe);
        }
      }
    }
  });

  it('refuses to render nothing', () => {
    expect(() => renderTextPdf([])).toThrow(/at least one page/);
  });

  it('cover a worked dispute, a rejected-evidence case and an invalid deduction', () => {
    expect(FIXTURE_CASES).toHaveLength(3);
    for (const fixture of FIXTURE_CASES) {
      expect(fixture.documents.length, fixture.key).toBeGreaterThan(0);
      expect(fixture.expectedOutcome.length, fixture.key).toBeGreaterThan(40);
    }
  });
});

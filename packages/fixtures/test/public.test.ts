import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOC_TYPES, describeFields, schemaFor, templatePath, type DocType } from '@recouple/extraction';
import { publicDocuments } from '../src/public';

/**
 * The `public` and `public_scanned` suites (`packages/fixtures/public/`).
 *
 * Their ground truth came from ExtractBench's verified answers through
 * `scripts/import-extractbench.py`. These tests hold the committed files to
 * what that import promised, so a hand edit to `truth.json` — a value nobody
 * verified — cannot slip in unnoticed.
 */

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const REVISION = 'f6180e917a050a84582e6366cff85b7dc1e84e58';

const squash = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();

function moneyForms(cents: number): string[] {
  const units = Math.abs(cents) / 100;
  const plain = units.toFixed(2);
  const grouped = units.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return Number.isInteger(units)
    ? [plain, grouped, units.toLocaleString('en-US')]
    : [plain, grouped];
}

const byKey = new Map(publicDocuments().map((d) => [d.key, d] as const));
const clean = publicDocuments().filter((d) => d.suite === 'public');
const scanned = publicDocuments().filter((d) => d.suite === 'public_scanned');

describe('the public suites', () => {
  it('holds ten documents with a text layer and ten read through OCR', () => {
    expect(clean).toHaveLength(10);
    expect(scanned).toHaveLength(10);
    expect(new Set(publicDocuments().map((d) => d.key)).size).toBe(20);
  });

  it('is every document of the pinned ExtractBench revision it says it is', () => {
    for (const document of publicDocuments()) {
      expect(document.source.dataset).toBe('llamaindex/ExtractBench');
      expect(document.source.revision).toBe(REVISION);
      expect(document.source.id.startsWith('short/')).toBe(true);
      expect(document.source.tags).toContain('source:real');
    }
    // Apache 2.0 asks for the license to travel with the files.
    expect(existsSync(path.join(dir, 'LICENSE-ExtractBench.txt'))).toBe(true);
  });

  it('is a PDF of a type the reader knows', () => {
    for (const document of publicDocuments()) {
      expect(Buffer.from(document.bytes.subarray(0, 5)).toString('latin1'), document.key).toBe('%PDF-');
      expect(DOC_TYPES as readonly string[]).toContain(document.docType);
    }
  });

  it('hands the recorder a text layer for `public` and none for `public_scanned`', () => {
    for (const document of clean) {
      expect(document.pageText.length, document.key).toBeGreaterThan(0);
      expect(document.pageText.join('').trim().length, document.key).toBeGreaterThan(200);
    }
    // No text layer, so the recorder OCRs them as production OCRs an upload.
    for (const document of scanned) expect(document.pageText, document.key).toEqual([]);
  });

  it('asserts only fields the document’s own type has', () => {
    for (const document of publicDocuments()) {
      const known = new Set(describeFields(schemaFor(document.docType as DocType)).map((f) => f.path));
      for (const fieldPath of Object.keys(document.truth)) {
        expect(known.has(templatePath(fieldPath)), `${document.key}: ${fieldPath}`).toBe(true);
      }
    }
  });

  it('asserts only text that is on the page, and amounts as they are printed', () => {
    for (const document of clean) {
      const page = squash(document.pageText.join('\n'));
      const compact = document.pageText.join('\n').replace(/ /g, '');
      for (const [fieldPath, expectation] of Object.entries(document.truth)) {
        if (expectation.kind === 'text' || expectation.kind === 'date') {
          expect(page.includes(squash(expectation.value)), `${document.key}: ${fieldPath}`).toBe(true);
        } else if (expectation.kind === 'money_cents') {
          expect(
            moneyForms(expectation.value).some((form) => compact.includes(form)),
            `${document.key}: ${fieldPath} = ${expectation.value}¢`,
          ).toBe(true);
        }
      }
    }
  });

  it('gives a degraded copy exactly its clean twin’s ground truth', () => {
    const degraded = scanned.filter((d) => d.key.endsWith('-degraded'));
    expect(degraded).toHaveLength(6);
    for (const document of degraded) {
      const twin = byKey.get(document.key.replace(/-degraded$/, ''));
      expect(twin, document.key).toBeDefined();
      expect(document.docType).toBe(twin?.docType);
      expect(document.truth, document.key).toEqual(twin?.truth);
    }
  });

  it('says why each field their answer had and ours does not carry was left out', () => {
    // A skipped field is reported, never silently absent: the README's rules
    // are the only reasons allowed.
    for (const document of publicDocuments()) {
      for (const reason of document.skippedTruth) {
        expect(reason, document.key).toMatch(
          /is not in the page text|is not printed on the page|has no page text|not printed in exactly one spelling|payments on one advice|names no date/,
        );
      }
    }
  });

  it('includes every public document in everyDocument()', async () => {
    const { everyDocument } = await import('../src/corpus');
    const keys = new Set(everyDocument().map((d) => d.key));
    for (const document of publicDocuments()) expect(keys.has(document.key), document.key).toBe(true);
  });

  it('matches the manifest’s own page count for every document', () => {
    const manifest = JSON.parse(readFileSync(path.join(dir, 'pages.json'), 'utf8')) as Record<
      string,
      { pageText: readonly string[] }
    >;
    for (const document of clean) {
      expect(document.pageText).toEqual(manifest[document.key]?.pageText);
    }
  });
});

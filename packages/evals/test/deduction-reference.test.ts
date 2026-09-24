import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractionIsCurrent, modelFor, type Cassette } from '@recouple/extraction';
import { everyDocument } from '@recouple/fixtures';

/**
 * What the recorded notices say about a deduction's own number.
 *
 * The eval scores text by containment, so "CB-203 / PREMIUM-NOAUTH" would pass
 * as both the reason code and the reference, and a field no truth mentions is
 * not scored at all. These read the cassettes directly: the one notice that
 * prints a number beside its reason must split the two exactly, and no notice
 * may pass off another number it prints as the deduction's own.
 */
const cassetteDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'cassettes',
);

type Line = Record<string, { value: unknown } | undefined>;

function cassette(key: string): Cassette {
  return JSON.parse(readFileSync(path.join(cassetteDir, `${key}.json`), 'utf8')) as Cassette;
}

const value = (field: { value: unknown } | undefined): string | undefined =>
  typeof field?.value === 'string' ? field.value : undefined;

const notices = everyDocument()
  .filter((d) => d.docType === 'deduction_notice')
  .map((d) => ({ key: d.key, recorded: cassette(d.key) }));

describe('the recorded notices and a deduction’s own number', () => {
  it('were all read under this checkout’s notice schema and instruction', () => {
    // A re-read that died halfway would leave some notices on the old reading,
    // with no score to show it.
    expect(notices.length).toBeGreaterThanOrEqual(17);
    const stale = notices
      .filter(({ recorded }) => !extractionIsCurrent(recorded, modelFor('extract')))
      .map(({ key }) => key);
    expect(stale).toEqual([]);
  });

  it('splits "CB-203 / PREMIUM-NOAUTH" into the reference and the reason, exactly', () => {
    const document = cassette('stf-203-short-payment-notice').document as { lines: Line[] };
    expect(value(document.lines[0]?.reason_code)).toBe('PREMIUM-NOAUTH');
    expect(value(document.lines[0]?.deduction_reference)).toBe('CB-203');
  });

  it('never gives a line’s reason code, invoice, order or payment as its reference', () => {
    for (const { key, recorded } of notices) {
      const document = recorded.document as Record<string, { value: unknown } | undefined> & {
        lines: Line[];
      };
      const others = new Set(
        ['invoice_number', 'po_number', 'remittance_or_check', 'vendor_number']
          .map((field) => value(document[field]))
          .filter((v): v is string => v !== undefined),
      );
      document.lines.forEach((line, index) => {
        const reference = value(line.deduction_reference);
        if (reference === undefined) return;
        expect(reference, `${key} lines[${index}]`).not.toBe(value(line.reason_code));
        expect(others.has(reference), `${key} lines[${index}]: ${reference}`).toBe(false);
      });
    }
  });
});

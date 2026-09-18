/**
 * A minimal, deterministic PDF writer.
 *
 * Fixtures are generated, not committed as binaries: the document text and its
 * ground truth live in the same file, so they cannot drift apart, and a reviewer
 * can read the fixture in a diff. The output is a real PDF — it goes through the
 * same upload hardening and the same vision model as a customer's file.
 */

const FONT_SIZE = 10;
const LEADING = 14;
const MARGIN_X = 54;
const PAGE_WIDTH = 612; // US Letter at 72 dpi
const PAGE_HEIGHT = 792;

function escapeText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function contentStream(lines: readonly string[]): string {
  const body = lines
    .map((line, index) =>
      index === 0
        ? `(${escapeText(line)}) Tj`
        : `T*\n(${escapeText(line)}) Tj`,
    )
    .join('\n');
  return [
    'BT',
    `/F1 ${FONT_SIZE} Tf`,
    `${LEADING} TL`,
    `${MARGIN_X} ${PAGE_HEIGHT - 72} Td`,
    body,
    'ET',
  ].join('\n');
}

/**
 * Renders one page per array of lines. Everything is uncompressed and free of
 * active content, so a fixture passes the same ingest checks as a real upload
 * rather than needing an exemption.
 */
export function renderTextPdf(pages: readonly (readonly string[])[]): Uint8Array {
  if (pages.length === 0) throw new Error('a PDF needs at least one page');

  const objects: string[] = [];
  const pageObjectNumbers: number[] = [];

  // 1: catalog, 2: page tree, 3: font, then (page, content) pairs.
  const firstPageObject = 4;
  pages.forEach((_, index) => pageObjectNumbers.push(firstPageObject + index * 2));

  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(
    `<< /Type /Pages /Kids [${pageObjectNumbers.map((n) => `${n} 0 R`).join(' ')}] /Count ${pages.length} >>`,
  );
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  pages.forEach((lines, index) => {
    const pageNumber = pageObjectNumbers[index] as number;
    const contentNumber = pageNumber + 1;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNumber} 0 R >>`,
    );
    const stream = contentStream(lines);
    objects.push(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
  });

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}

export const PDF_PAGE_WIDTH = PAGE_WIDTH;
export const PDF_PAGE_HEIGHT = PAGE_HEIGHT;

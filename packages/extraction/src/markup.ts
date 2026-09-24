/**
 * The text a page prints, without the markup an OCR provider drew it with.
 *
 * Reducto began wrapping bold runs in text PDFs in `<b>…</b>` (2026-09-23). The
 * reader model reads the page itself and quotes it without markup, so every
 * bolded value failed its quote check — and the fallbacks made it worse, not
 * better: the `b` of the tag stayed in the letters-and-digits comparison, and
 * the glyph fold reads a `b` as an `8`, so a bold "$4,800.00" verified an
 * invented "$84,800.00".
 *
 * Deliberately narrow, in two ways. Only the named inline formatting elements
 * are removed — how a run is drawn, never what it says — so table structure
 * stays (the classifier reads it, and it is layout rather than formatting) and
 * so does anything else in angle brackets, such as `<dispatch@carrier.example>`
 * printed in an email header. And only the escapes an HTML serialiser writes
 * are decoded; an entity name not in the table is left exactly as it came,
 * rather than guessed at.
 *
 * Tags go first, then entities, in one pass each: `&lt;b&gt;` is the page
 * printing "<b>", and it stays as text.
 */

/** Inline formatting: removing the tag leaves the words exactly as drawn. */
const FORMATTING_TAG =
  /<\/?(?:b|strong|i|em|u|ins|s|strike|del|mark|sub|sup|small|span|font)(?:\s[^<>]*)?>/gi;

/** A line break is whitespace, not nothing: "Gross<br>invoice" is two words. */
const LINE_BREAK = /<br\s*\/?>/gi;

const ENTITY = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos|nbsp));/g;

const NAMED: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function codePoint(value: number, reference: string): string {
  const printable =
    value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff);
  return printable ? String.fromCodePoint(value) : reference;
}

export function withoutInlineMarkup(text: string): string {
  return text
    .replace(FORMATTING_TAG, '')
    .replace(LINE_BREAK, '\n')
    .replace(ENTITY, (reference, decimal?: string, hex?: string, name?: string) => {
      if (decimal !== undefined) return codePoint(Number.parseInt(decimal, 10), reference);
      if (hex !== undefined) return codePoint(Number.parseInt(hex, 16), reference);
      return NAMED[name as string] ?? reference;
    });
}

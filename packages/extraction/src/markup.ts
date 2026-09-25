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

/**
 * A column rule, whichever glyph drew it: `|`.
 *
 * A camera page prints its columns separated by a vertical rule, and neither
 * reader draws it the same way twice. Reducto writes `|`, `I` or nothing; the
 * model, reading the pixels, writes `|` or `I`, sometimes both in one quote.
 * So a value quoted exactly as printed failed its check on nothing but the
 * rule — twelve of the STF-201 camera pages' quotes, every one of them right.
 *
 * Only a token that is nothing but a rule glyph is rewritten: a whitespace-
 * bounded `|`, `I`, `l`, `!`, `¦` or `│`. Nothing inside a longer token
 * changes, no digit is ever rewritten, and `1` is never a rule, so a quote
 * that differs from the page by a digit still differs. What is lost is only
 * whether a lone token was a pipe, a capital I or a lower-case l.
 */
export function withColumnRules(text: string): string {
  // Twice, because adjacent rules share the whitespace between them.
  return text.replace(COLUMN_RULE, '$1|').replace(COLUMN_RULE, '$1|');
}

const COLUMN_RULE = /(^|\s)[|Il!¦│](?=\s|$)/g;

/**
 * A table's cell and row boundaries, as the space they print as.
 *
 * Reducto writes a table as HTML — `<tr><td>2</td><td>EACH</td><td>$448.00</td>`
 * — and the model, reading the page, quotes a row as the words it sees there,
 * with spaces between them. `withoutInlineMarkup` keeps table markup on
 * purpose (the classifier reads it), so every quote of more than one cell
 * failed its check on nothing but the tags. A cell boundary is a column rule
 * drawn as markup, and this does for it what `withColumnRules` does for a
 * rule drawn as a glyph.
 *
 * A row boundary is a space too, not a hard break: it is the table's line
 * break, and a line break is whitespace everywhere else in the check. Reducto
 * also splits one cell's wrapped text across rows — a part number printed on
 * three lines of one cell comes back as three rows — and two rows' words can
 * only join where they sit next to each other in reading order, exactly as two
 * lines of plain text do. A quote that takes cells from rows that are not
 * adjacent is still not on the page.
 *
 * Each tag becomes one space, never nothing, so two cells' words are never
 * joined into one token. Only the table's own elements are rewritten; anything
 * else in angle brackets stays, as it does in `withoutInlineMarkup`.
 */
export function withTableCellsAsSpaces(text: string): string {
  return text.replace(TABLE_TAG, ' ');
}

const TABLE_TAG =
  /<\/?(?:table|caption|colgroup|col|thead|tbody|tfoot|tr|th|td)(?:\s[^<>]*)?\/?>/gi;

/**
 * Every dash as a hyphen: `-`.
 *
 * A dash is drawn several ways and read back several more. The model reading
 * the Illinois rate card wrote "Sedan – compact" with an en dash where the OCR
 * of the same page wrote a hyphen, and a typeset minus sign is U+2212, not the
 * `-` a keyboard types. Folded for matching only: the hyphen, non-breaking
 * hyphen, figure dash, en dash, em dash, horizontal bar, minus sign and their
 * small and full-width forms.
 *
 * A minus sign stays in front of its number, so folding it keeps the sign
 * where the check reads it: "−80.00" folds to "-80.00", never to "80.00".
 */
export function withDashesAsHyphens(text: string): string {
  return text.replace(DASHES, '-');
}

/** Whether a character is a dash `withDashesAsHyphens` folds, or the hyphen-minus itself. */
export function isDash(char: string | undefined): boolean {
  return char !== undefined && ONE_DASH.test(char);
}

const DASH_CLASS = '[-\\u2010-\\u2015\\u2212\\uFE58\\uFE63\\uFF0D]';
const DASHES = new RegExp(DASH_CLASS, 'g');
const ONE_DASH = new RegExp(`^${DASH_CLASS}$`);

/**
 * A page as it is laid out, for matching: table cells and rows as spaces,
 * column rules as one glyph, dashes as hyphens. `checkQuote` reads a page this
 * way from its `separator` tier on, and `locateQuote` boxes by it.
 */
export function asLaidOut(text: string): string {
  // Cells first: a lone `I` in a cell of its own is a rule once the cell's
  // tags are spaces, on the page exactly as in a quote of it.
  return withDashesAsHyphens(withColumnRules(withTableCellsAsSpaces(text)));
}

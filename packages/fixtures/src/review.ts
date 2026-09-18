/**
 * Embedding document-derived data in a page.
 *
 * The review bundle carries text copied out of untrusted documents: OCR output,
 * the model's verbatim quotes, the supplier's own filename. `JSON.stringify`
 * escapes quotes and backslashes but not `<`, and an HTML parser ends a script
 * element at the first `</script` wherever it appears — inside a string literal
 * included. So a document containing that sequence becomes markup.
 *
 * The page carries the bundle in an inert `<script type="application/json">`
 * block, and this escaping is the second layer.
 *
 * Written as a code-point walk rather than a regex so the separators it guards
 * against never appear literally in this file: U+2028 and U+2029 are valid JSON
 * but terminate a JavaScript string literal, and a source file carrying one is
 * itself the bug.
 */
const LINE_SEPARATOR = 0x2028;
const PARAGRAPH_SEPARATOR = 0x2029;

export function inlineJsonSafely(json: string): string {
  let out = '';
  for (const character of json) {
    const code = character.codePointAt(0);
    if (character === '<') {
      out += '\\u003c';
    } else if (code === LINE_SEPARATOR) {
      out += '\\u2028';
    } else if (code === PARAGRAPH_SEPARATOR) {
      out += '\\u2029';
    } else {
      out += character;
    }
  }
  return out;
}

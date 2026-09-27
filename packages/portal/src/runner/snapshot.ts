// A captured page is stored as a document (ADR 0057 §9), so what survives is
// an allowlist: text and table/list/heading structure, colspan and rowspan.
// No script, link, form, input, handler or URL gets through. Pure, in-house
// tokenizer: no HTML library was added for this.
export const SNAPSHOT_RULE_VERSION = 1;

const KEEP = new Set(['table', 'thead', 'tbody', 'tr', 'th', 'td', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p']);
/** Elements whose contents are never text a person reads. */
const DROP_WITH_CONTENT = new Set(['script', 'style', 'template', 'noscript', 'iframe', 'object', 'embed', 'svg', 'math', 'head', 'title', 'textarea', 'select', 'button']);
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

function escapeText(s: string): string {
  return s.replace(/&(?!(?:[a-z]+|#\d+|#x[0-9a-f]+);)/gi, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function spanAttrs(attrs: string): string {
  let out = '';
  for (const m of attrs.matchAll(/\b(colspan|rowspan)\s*=\s*["']?(\d{1,3})["']?/gi)) {
    out += ` ${m[1]!.toLowerCase()}="${m[2]}"`;
  }
  return out;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function serialiseSnapshot(html: string, username: string): string {
  const token = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<![^>]*>|<\?[^>]*>|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let out = '';
  let skipping: string | null = null;
  let depth = 0;
  let last = 0;
  for (const m of html.matchAll(token)) {
    const text = html.slice(last, m.index);
    last = m.index + m[0].length;
    if (skipping === null && text.length > 0) out += escapeText(text);
    const tag = m[2]?.toLowerCase();
    if (tag === undefined) continue; // comment, doctype, CDATA, PI
    const closing = m[1] === '/';
    if (skipping !== null) {
      if (tag === skipping) depth += closing ? -1 : (VOID.has(tag) ? 0 : 1);
      if (depth === 0) skipping = null;
      continue;
    }
    if (DROP_WITH_CONTENT.has(tag)) {
      if (!closing && !/\/\s*$/.test(m[3] ?? '')) { skipping = tag; depth = 1; }
      continue;
    }
    if (KEEP.has(tag)) out += closing ? `</${tag}>` : `<${tag}${spanAttrs(m[3] ?? '')}>`;
    else if (tag === 'br' || tag === 'div' || tag === 'tr') out += ' ';
  }
  if (skipping === null) out += escapeText(html.slice(last));
  out = out.replace(/\s+/g, ' ').trim();
  if (username.length > 0) {
    out = out.split(escapeHtml(username)).join('[portal-user]').split(username).join('[portal-user]');
  }
  return `<!doctype html>\n<html><body>${out}</body></html>\n`;
}

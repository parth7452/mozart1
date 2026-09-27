/**
 * A deliberately small XML tokenizer for the parts of an XLSX package. It
 * refuses any `<!` (DOCTYPE, ENTITY, CDATA, comments) so no entity expansion
 * or external reference can ever be reached, and decodes only the five named
 * entities and numeric character references.
 */
export class XmlDtdRefusedError extends Error {
  constructor(message = 'XML declares a DTD or markup declaration') {
    super(message);
    this.name = 'XmlDtdRefusedError';
  }
}

export type XmlToken =
  | { kind: 'open'; name: string; attrs: Record<string, string>; selfClosing: boolean }
  | { kind: 'close'; name: string }
  | { kind: 'text'; text: string };

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXmlText(raw: string): string {
  return raw.replace(/&([^;&\s]*);?/g, (whole, name: string) => {
    if (!whole.endsWith(';')) throw new Error('malformed entity reference');
    if (name in NAMED) return NAMED[name]!;
    let code: number | undefined;
    if (/^#[0-9]+$/.test(name)) code = parseInt(name.slice(1), 10);
    else if (/^#x[0-9a-fA-F]+$/.test(name)) code = parseInt(name.slice(2), 16);
    if (code === undefined) throw new Error(`unknown entity &${name};`);
    if (code > 0x10ffff) throw new Error('character reference out of range');
    return String.fromCodePoint(code);
  });
}

const NAME = /^[A-Za-z_][\w.:-]*/;

export function tokenizeXml(xml: string): XmlToken[] {
  if (xml.includes('<!')) throw new XmlDtdRefusedError();
  const tokens: XmlToken[] = [];
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) {
      pushText(tokens, xml.slice(i));
      break;
    }
    if (lt > i) pushText(tokens, xml.slice(i, lt));
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      if (end === -1) throw new Error('unterminated processing instruction');
      i = end + 2;
      continue;
    }
    const gt = findTagEnd(xml, lt + 1);
    const inner = xml.slice(lt + 1, gt);
    i = gt + 1;
    if (inner.startsWith('/')) {
      const m = NAME.exec(inner.slice(1).trim());
      if (!m) throw new Error('malformed closing tag');
      tokens.push({ kind: 'close', name: m[0] });
      continue;
    }
    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const m = NAME.exec(body);
    if (!m) throw new Error('malformed tag');
    tokens.push({ kind: 'open', name: m[0], attrs: parseAttrs(body.slice(m[0].length)), selfClosing });
  }
  return tokens;
}

function pushText(tokens: XmlToken[], raw: string): void {
  tokens.push({ kind: 'text', text: decodeXmlText(raw) });
}

function findTagEnd(xml: string, from: number): number {
  let quote: string | null = null;
  for (let j = from; j < xml.length; j++) {
    const c = xml[j]!;
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '<') throw new Error('malformed tag');
    else if (c === '>') return j;
  }
  throw new Error('unterminated tag');
}

function parseAttrs(src: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /\s*([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/y;
  let pos = 0;
  while (pos < src.length) {
    if (/^\s*$/.test(src.slice(pos))) break;
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m) throw new Error('malformed attribute');
    if (m[1]! in attrs) throw new Error('duplicate attribute');
    attrs[m[1]!] = decodeXmlText(m[3] ?? m[4] ?? '');
    pos = re.lastIndex;
  }
  return attrs;
}

/**
 * A PDF's names, read where a reader reads them.
 *
 * `inspectPdf` refuses a PDF that carries a key which makes it act rather than
 * show (`/JavaScript`, `/AA`, …). Matching those names over the raw bytes of
 * the whole file had two faults. It refused real scans for bytes that are not
 * names at all: an image's or a font's compressed data is random-like, and
 * `/AA` or `/JS` followed by a delimiter turns up in it about 0.0075 times per
 * megabyte, so roughly one 20 MB scan in seven. And it never saw a dictionary
 * inside a Flate-compressed object stream, which is where a modern writer puts
 * most of them.
 *
 * So this reads the file as a tokenizer: a name counts when it is a token of
 * the file body or of an object stream's decoded contents, and never when it
 * is inside a literal string, a hex string, a comment or stream data. Where it
 * cannot account for the file it says so and gives a reason, and the caller
 * falls back to the raw scan: stricter over the file's own bytes, and as blind
 * to compressed object streams as it always was.
 *
 * Skipping strings, comments and stream data is only safe while a reader never
 * starts parsing inside one of them. A reader does not read a file front to
 * back as this does: it jumps to the offsets the cross-reference table gives,
 * or, repairing a broken file, to any line that looks like an object header.
 * An object header or a trailer inside skipped bytes is where such a jump would
 * land, so finding one sends the whole file to the raw scan (`HiddenCheck`). A
 * visible `obj` keyword must follow two integers with nothing but whitespace
 * between them, because a comment there is how a header half inside a comment
 * would be written. An object stream's own offsets are checked the same way.
 */

import { constants as zlibConstants, inflateRawSync } from 'node:zlib';

// --- Characters and tokens ----------------------------------------------------

const REGULAR_CHAR = 0;
const WHITESPACE = 1;
const DELIMITER = 2;

/**
 * ISO 32000-1 §7.2.2's whitespace and delimiters, plus `0xFF`, which PDFium
 * reads as whitespace: a byte one reader splits a token on and we do not is a
 * key that reader runs and we never saw. The same set as `PDF_NAME` in
 * `sniff.ts`.
 */
const CHAR_CLASS = new Uint8Array(256);
for (const code of [0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20, 0xff]) CHAR_CLASS[code] = WHITESPACE;
for (const ch of '()<>[]{}/%') CHAR_CLASS[ch.charCodeAt(0)] = DELIMITER;

export const TOKEN = {
  eof: 0,
  name: 1,
  /** A run of regular characters: a number or a keyword (`obj`, `R`, `null`, …). */
  regular: 2,
  dictOpen: 3,
  dictClose: 4,
  arrayOpen: 5,
  arrayClose: 6,
  string: 7,
  hexString: 8,
  /** `{`, `}`, or a `)` or `>` with nothing open. */
  other: 9,
  unterminated: 10,
} as const;
export type Token = (typeof TOKEN)[keyof typeof TOKEN];

export type HiddenKind = 'a comment' | 'a literal string' | 'a hex string' | 'stream data';

/**
 * PDF's lexical rules over a latin1 string, one token at a time.
 *
 * It skips whitespace and comments between tokens and reports every stretch a
 * reader does not read as tokens — a comment, a string, a hex string — to
 * `onHidden`. It allocates nothing per token: `start` and `end` say where the
 * token is.
 */
export class PdfLexer {
  pos: number;
  start = 0;
  end = 0;
  /** A comment lay between the previous token and this one. */
  commentBefore = false;
  /** What was left open when `next()` returned `TOKEN.unterminated`. */
  unterminated = '';

  constructor(
    readonly text: string,
    from: number,
    readonly limit: number,
    private readonly onHidden?: (kind: HiddenKind, from: number, to: number) => void,
  ) {
    this.pos = from;
  }

  slice(): string {
    return this.text.slice(this.start, this.end);
  }

  /** Whether the current token is exactly `word`. */
  is(word: string): boolean {
    return this.end - this.start === word.length && this.text.startsWith(word, this.start);
  }

  next(): Token {
    const s = this.text;
    const limit = this.limit;
    let i = this.pos;
    this.commentBefore = false;
    for (;;) {
      if (i >= limit) {
        this.start = this.end = this.pos = limit;
        return TOKEN.eof;
      }
      const c = s.charCodeAt(i);
      if (CHAR_CLASS[c] === WHITESPACE) {
        i += 1;
        continue;
      }
      if (c === 0x25) {
        // `%` to the end of the line. A comment that reaches the end of the
        // file is closed by it: nothing can follow it for it to hide, and a
        // file whose last line is `%%EOF` with no newline is ordinary.
        let j = i + 1;
        while (j < limit) {
          const d = s.charCodeAt(j);
          if (d === 0x0a || d === 0x0d) break;
          j += 1;
        }
        this.onHidden?.('a comment', i, j);
        this.commentBefore = true;
        i = j;
        continue;
      }
      break;
    }

    this.start = i;
    const c = s.charCodeAt(i);
    let token: Token;
    switch (c) {
      case 0x2f: {
        // A name runs to the next whitespace or delimiter (§7.3.5).
        let j = i + 1;
        while (j < limit && CHAR_CLASS[s.charCodeAt(j)] === REGULAR_CHAR) j += 1;
        this.end = j;
        token = TOKEN.name;
        break;
      }
      case 0x28: {
        // A literal string: balanced parentheses, and a backslash escapes the
        // character after it, so `\(` and `\)` do not count (§7.3.4.2).
        let depth = 1;
        let j = i + 1;
        while (j < limit) {
          const d = s.charCodeAt(j);
          if (d === 0x5c) {
            j += 2;
            continue;
          }
          if (d === 0x28) depth += 1;
          else if (d === 0x29) {
            depth -= 1;
            if (depth === 0) break;
          }
          j += 1;
        }
        if (depth !== 0 || j >= limit) return this.fail(i, 'literal string');
        this.end = j + 1;
        this.onHidden?.('a literal string', i, this.end);
        token = TOKEN.string;
        break;
      }
      case 0x3c: {
        if (i + 1 < limit && s.charCodeAt(i + 1) === 0x3c) {
          this.end = i + 2;
          token = TOKEN.dictOpen;
          break;
        }
        // A hex string runs to the first `>`; every reader skips what is not
        // a hex digit rather than ending there.
        const j = s.indexOf('>', i + 1);
        if (j === -1 || j >= limit) return this.fail(i, 'hex string');
        this.end = j + 1;
        this.onHidden?.('a hex string', i, this.end);
        token = TOKEN.hexString;
        break;
      }
      case 0x3e:
        if (i + 1 < limit && s.charCodeAt(i + 1) === 0x3e) {
          this.end = i + 2;
          token = TOKEN.dictClose;
        } else {
          this.end = i + 1;
          token = TOKEN.other;
        }
        break;
      case 0x5b:
        this.end = i + 1;
        token = TOKEN.arrayOpen;
        break;
      case 0x5d:
        this.end = i + 1;
        token = TOKEN.arrayClose;
        break;
      case 0x29:
      case 0x7b:
      case 0x7d:
        this.end = i + 1;
        token = TOKEN.other;
        break;
      default: {
        let j = i + 1;
        while (j < limit && CHAR_CLASS[s.charCodeAt(j)] === REGULAR_CHAR) j += 1;
        this.end = j;
        token = TOKEN.regular;
      }
    }
    this.pos = this.end;
    return token;
  }

  private fail(at: number, what: string): Token {
    this.unterminated = what;
    this.start = at;
    this.end = this.pos = this.limit;
    return TOKEN.unterminated;
  }
}

function hexValue(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x37;
  if (code >= 0x61 && code <= 0x66) return code - 0x57;
  return -1;
}

/**
 * `#` and two hex digits stand for one character inside a name (§7.3.5); a
 * `#` without them stays a `#`, as pdf.js, MuPDF and PDFium read it. The same
 * rule as `activeContentOf` in `sniff.ts`, written as a loop because a file
 * can hold millions of names.
 */
export function decodeName(raw: string): string {
  let hash = raw.indexOf('#');
  if (hash === -1) return raw;
  let out = '';
  let from = 0;
  while (hash !== -1) {
    const high = hexValue(raw.charCodeAt(hash + 1));
    const low = high === -1 ? -1 : hexValue(raw.charCodeAt(hash + 2));
    if (low === -1) {
      hash = raw.indexOf('#', hash + 1);
      continue;
    }
    out += raw.slice(from, hash) + String.fromCharCode(high * 16 + low);
    from = hash + 3;
    hash = raw.indexOf('#', from);
  }
  return out + raw.slice(from);
}

/** No stream dictionary key this file reads is longer than this. */
const LONGEST_NAME_OF_INTEREST = 16;

/**
 * The decoded name at `[start, end)`, or `''` for a name no stream dictionary
 * key could be — long, and with no `#` to shorten it — without copying it.
 */
function nameAt(s: string, start: number, end: number): string {
  if (end - start > LONGEST_NAME_OF_INTEREST) {
    let hash = false;
    for (let i = start; i < end; i += 1) {
      if (s.charCodeAt(i) === 0x23) {
        hash = true;
        break;
      }
    }
    if (!hash) return '';
  }
  return decodeName(s.slice(start, end));
}

export function isDigits(s: string, start = 0, end = s.length): boolean {
  if (end <= start) return false;
  for (let i = start; i < end; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 0x30 || c > 0x39) return false;
  }
  return true;
}

// --- What the scan returns ----------------------------------------------------

/** Where a key's value begins, in the text it was found in. */
export interface ValueSite {
  readonly text: string;
  readonly at: number;
  readonly limit: number;
  readonly inObjectStream: boolean;
}

/** A visible `N G obj`, and where its value starts. */
export interface ObjectHeader {
  readonly number: string;
  readonly generation: string;
  readonly valueAt: number;
}

export interface TokenizedNames {
  readonly mode: 'tokenized';
  /** The names asked for that appear as tokens, decoded. */
  readonly found: ReadonlySet<string>;
  /** Every place a name in `valued` appears as a token, with its value's start. */
  readonly sites: readonly ValueSite[];
  readonly body: string;
  readonly headers: readonly ObjectHeader[];
  readonly objectStreams: number;
  readonly inflatedBytes: number;
}

export interface RawFallback {
  readonly mode: 'raw';
  readonly reason: string;
}

export type NameScan = TokenizedNames | RawFallback;

export interface NameScanOptions {
  /** The names to report, decoded (`/JS`, not `/J#53`). */
  readonly wanted: ReadonlySet<string>;
  /** Names whose values the caller will judge; each must also be in `wanted`. */
  readonly valued: ReadonlySet<string>;
  /** Bytes the object streams may inflate to, in total. */
  readonly inflateBudget: number;
}

/** Past this many valued sites, judging each one is not worth it. */
export const MAX_VALUE_SITES = 64;

/**
 * Past this many object streams the file goes to the raw scan. A real 50 MB
 * PDF has a few hundred; each one costs a dictionary, an inflate and a scan.
 */
export const MAX_OBJECT_STREAMS = 10_000;

/** Arrays and dictionaries nested deeper than this are not a document, and not worth a stack. */
export const MAX_NESTING = 512;

/** Tokenizing could not account for the file; `reason` says where. */
class CannotAccount extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

// --- Skipped bytes a reader could start inside ----------------------------------

/**
 * Whether the text before the `obj` at `p`, no further back than `floor`,
 * reads as `num gen` — an object header a reader could jump to.
 *
 * Generous on purpose: a number is any run of digits, `.`, `+` and `-`, and a
 * line break with a `%` anywhere on the line before it counts as a header,
 * because a comment may sit between a header's tokens and which `%` on a line
 * starts the comment depends on strings this does not track. Compressed data
 * matches this about once in 10^13 bytes.
 */
function looksLikeHeader(s: string, p: number, floor: number): boolean {
  let i = p - 1;
  // Between the generation and `obj`: any whitespace, or none (`0obj` is two
  // tokens to pdf.js).
  let gap = skipBack(s, i, floor);
  if (gap < -1) return true;
  i = gap;
  const generation = numberBack(s, i, floor);
  if (generation === i) return false;
  i = generation;
  gap = skipBack(s, i, floor);
  if (gap < -1) return true;
  if (gap === i) return false;
  i = gap;
  return numberBack(s, i, floor) !== i;
}

/** Back over whitespace from `i`; `-2` when a line break follows a line with a `%`. */
function skipBack(s: string, i: number, floor: number): number {
  while (i >= floor) {
    const c = s.charCodeAt(i);
    if (CHAR_CLASS[c] !== WHITESPACE) break;
    if (c === 0x0a || c === 0x0d) {
      for (let j = i - 1; j >= floor; j -= 1) {
        const d = s.charCodeAt(j);
        if (d === 0x0a || d === 0x0d) break;
        if (d === 0x25) return -2;
      }
    }
    i -= 1;
  }
  return i;
}

function numberBack(s: string, i: number, floor: number): number {
  while (i >= floor) {
    const c = s.charCodeAt(i);
    if ((c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2d || c === 0x2e) i -= 1;
    else break;
  }
  return i;
}

/** `trailer` followed by a dictionary, or by a comment that could lead to one. */
function trailerOpens(s: string, i: number): boolean {
  while (i < s.length && CHAR_CLASS[s.charCodeAt(i)] === WHITESPACE) i += 1;
  const c = s.charCodeAt(i);
  return c === 0x3c || c === 0x25;
}

/**
 * Looks inside every stretch the body scan skips for a place a reader could
 * start parsing: an object header or a trailer. Regions arrive in file order,
 * so each needle's next occurrence is cached and the whole file is searched
 * once per needle, not once per region.
 */
class HiddenCheck {
  reason: string | undefined;
  private readonly next = new Map<string, number>();

  constructor(private readonly s: string) {}

  check(kind: HiddenKind, from: number, to: number): void {
    if (this.reason !== undefined) return;
    for (let p = this.find('obj', from); p !== -1 && p < to; p = this.find('obj', p + 1)) {
      if (looksLikeHeader(this.s, p, from)) {
        this.reason = `an object header inside ${kind}`;
        return;
      }
    }
    for (let p = this.find('trailer', from); p !== -1 && p < to; p = this.find('trailer', p + 1)) {
      if (trailerOpens(this.s, p + 'trailer'.length)) {
        this.reason = `a trailer inside ${kind}`;
        return;
      }
    }
  }

  private find(needle: string, from: number): number {
    const cached = this.next.get(needle);
    if (cached !== undefined && (cached === -1 || cached >= from)) return cached;
    const found = this.s.indexOf(needle, from);
    this.next.set(needle, found);
    return found;
  }
}

// --- A stream's dictionary ------------------------------------------------------

type DictValue =
  | { readonly kind: 'scalar'; readonly tokens: readonly string[] }
  | { readonly kind: 'name'; readonly name: string }
  | { readonly kind: 'array'; readonly items: readonly string[]; readonly plain: boolean }
  | { readonly kind: 'other' };

/**
 * The top-level keys of a dictionary an `obj` opened and a `stream` followed,
 * fed one token at a time, so the stream knows its `/Length` and whether it is
 * an object stream. Anything it cannot place — a value in a key's position, a key given
 * twice — makes it `unreadable`, and then nothing it holds is trusted.
 */
class StreamDict {
  /** Arrays and dictionaries open inside this one. */
  level = 0;
  unreadable = false;
  /** `/ObjStm` or `/First` appears anywhere in it. pdf.js reads an object stream by `/First` and `/N` and never checks `/Type`. */
  mentionsObjectStream = false;
  readonly entries = new Map<string, DictValue>();
  private key: string | undefined;
  private pending: string[] = [];
  private arrayItems: string[] | undefined;
  private arrayPlain = true;

  /** A name token; `''` for one nothing here asks about. */
  name(name: string): void {
    if (name === '/ObjStm' || name === '/First') this.mentionsObjectStream = true;
    if (this.level > 0) {
      if (this.level === 1) this.arrayItems?.push(name);
      return;
    }
    if (this.key === undefined) {
      this.key = name;
      this.pending = [];
    } else if (this.pending.length === 0) {
      this.set(this.key, { kind: 'name', name });
      this.key = undefined;
    } else {
      this.settle(this.key);
      this.key = name;
      this.pending = [];
    }
  }

  /** A number or keyword. Up to three make one value: `5 0 R`. */
  regular(text: string): void {
    if (this.level > 0) {
      if (this.level === 1) this.arrayItems?.push(text);
      return;
    }
    if (this.key === undefined) {
      this.unreadable = true;
      return;
    }
    this.pending.push(text);
    if (this.pending.length > 3) this.unreadable = true;
  }

  /** A string, a hex string, or a stray delimiter. */
  other(): void {
    if (this.level > 0) {
      if (this.level === 1 && this.arrayItems !== undefined) this.arrayPlain = false;
      return;
    }
    if (this.key === undefined || this.pending.length > 0) {
      this.unreadable = true;
      return;
    }
    this.set(this.key, { kind: 'other' });
    this.key = undefined;
  }

  open(isArray: boolean): void {
    if (this.level === 0) {
      if (this.key === undefined || this.pending.length > 0) this.unreadable = true;
      this.arrayItems = isArray ? [] : undefined;
      this.arrayPlain = true;
    } else if (this.level === 1 && this.arrayItems !== undefined) {
      this.arrayPlain = false;
    }
    this.level += 1;
  }

  close(): void {
    this.level -= 1;
    if (this.level === 0) {
      if (this.key !== undefined) {
        this.set(
          this.key,
          this.arrayItems !== undefined
            ? { kind: 'array', items: this.arrayItems, plain: this.arrayPlain }
            : { kind: 'other' },
        );
      }
      this.key = undefined;
      this.arrayItems = undefined;
    }
  }

  /** The dictionary's own `>>`. */
  finish(): void {
    if (this.key !== undefined) {
      if (this.pending.length > 0) this.settle(this.key);
      else this.unreadable = true;
    }
    this.key = undefined;
  }

  /** The key's value, when it is one integer written in place. */
  directInteger(key: string): number | undefined {
    if (this.unreadable) return undefined;
    const value = this.entries.get(key);
    if (value?.kind !== 'scalar' || value.tokens.length !== 1) return undefined;
    const [token] = value.tokens;
    return token !== undefined && isDigits(token) ? Number(token) : undefined;
  }

  private settle(key: string): void {
    this.set(key, { kind: 'scalar', tokens: this.pending });
  }

  private set(key: string, value: DictValue): void {
    if (key === '') return;
    if (this.entries.has(key)) this.unreadable = true;
    this.entries.set(key, value);
  }
}

// --- The scan -------------------------------------------------------------------

class Scan {
  readonly found = new Set<string>();
  readonly sites: ValueSite[] = [];
  readonly headers: ObjectHeader[] = [];
  objectStreams = 0;
  inflatedBytes = 0;
  /** The character after the `/` of every wanted name, and `#`, which could spell any of them. */
  private readonly initials = new Set<number>([0x23]);
  private readonly longest: number;

  constructor(
    readonly bytes: Uint8Array,
    readonly body: string,
    readonly options: NameScanOptions,
  ) {
    let longest = 0;
    for (const name of options.wanted) {
      this.initials.add(name.charCodeAt(1));
      longest = Math.max(longest, name.length);
    }
    this.longest = longest;
  }

  /** The name token at `[start, end)` of `text`, if it is one asked for. */
  token(text: string, start: number, end: number, inObjectStream: boolean): void {
    // Most names in a file are fonts, keys and values nobody asked about:
    // turn them away on their first character before copying anything.
    if (end - start < 2 || !this.initials.has(text.charCodeAt(start + 1))) return;
    if (end - start > this.longest) {
      let hash = false;
      for (let i = start; i < end && !hash; i += 1) hash = text.charCodeAt(i) === 0x23;
      if (!hash) return;
    }
    this.name(decodeName(text.slice(start, end)), text, end, inObjectStream);
  }

  private name(name: string, text: string, end: number, inObjectStream: boolean): void {
    if (!this.options.wanted.has(name)) return;
    this.found.add(name);
    if (this.options.valued.has(name)) {
      if (this.sites.length >= MAX_VALUE_SITES) {
        throw new CannotAccount(`more than ${MAX_VALUE_SITES} ${name} keys`);
      }
      this.sites.push({ text, at: end, limit: text.length, inObjectStream });
    }
  }
}

/**
 * The names a reader would read in this PDF, or the reason it cannot say.
 *
 * `body` is `bytes` as latin1, one character per byte, so an offset into one is
 * an offset into the other.
 */
export function scanPdfNames(bytes: Uint8Array, body: string, options: NameScanOptions): NameScan {
  const scan = new Scan(bytes, body, options);
  try {
    scanBody(scan);
  } catch (error) {
    if (error instanceof CannotAccount) return { mode: 'raw', reason: error.reason };
    // Fail closed: whatever broke, the raw scan still runs.
    return { mode: 'raw', reason: `the tokenizer failed (${error instanceof Error ? error.name : typeof error})` };
  }
  return {
    mode: 'tokenized',
    found: scan.found,
    sites: scan.sites,
    body,
    headers: scan.headers,
    objectStreams: scan.objectStreams,
    inflatedBytes: scan.inflatedBytes,
  };
}

function scanBody(scan: Scan): void {
  const s = scan.body;
  const n = s.length;
  const hidden = new HiddenCheck(s);
  const lexer = new PdfLexer(s, 0, n, (kind, from, to) => hidden.check(kind, from, to));

  /** Open `<<` and `[`, innermost last: `true` for a dictionary. */
  const open: boolean[] = [];
  /** Where the dictionary an `obj` opened starts, while it is open; else -1. */
  let dictStart = -1;
  /** `[start, end)` of that dictionary, when the token just read was its `>>`. */
  let closedFrom = -1;
  let closedTo = -1;
  // The two tokens before this one, for checking an object header.
  let t1: Token = TOKEN.eof;
  let t1Start = 0;
  let t1End = 0;
  let t1Comment = false;
  let t2: Token = TOKEN.eof;
  let t2Start = 0;
  let t2End = 0;
  let afterObj = false;

  for (;;) {
    const token = lexer.next();
    if (hidden.reason !== undefined) throw new CannotAccount(hidden.reason);
    if (token === TOKEN.eof) break;
    if (token === TOKEN.unterminated) throw new CannotAccount(`an unterminated ${lexer.unterminated}`);

    let justClosed = false;
    let isObj = false;
    switch (token) {
      case TOKEN.name:
        scan.token(s, lexer.start, lexer.end, false);
        break;
      case TOKEN.regular:
        if (lexer.is('obj')) {
          isObj = true;
          // `num gen obj`, whitespace between and nothing else. A comment there
          // is how a header begun inside a comment, which this skipped, would
          // end in plain sight.
          if (
            t1 !== TOKEN.regular ||
            t2 !== TOKEN.regular ||
            t1Comment ||
            lexer.commentBefore ||
            !isDigits(s, t1Start, t1End) ||
            !isDigits(s, t2Start, t2End)
          ) {
            throw new CannotAccount('an obj keyword that does not follow an object number and generation');
          }
          scan.headers.push({
            number: s.slice(t2Start, t2End),
            generation: s.slice(t1Start, t1End),
            valueAt: lexer.end,
          });
        } else if (closedFrom !== -1 && lexer.is('stream')) {
          // Only now is the dictionary worth reading key by key.
          const dict = streamDictionary(s, closedFrom, closedTo);
          lexer.pos = streamData(scan, hidden, lexer.end, dict);
          if (hidden.reason !== undefined) throw new CannotAccount(hidden.reason);
        }
        break;
      case TOKEN.dictOpen:
        if (open.length >= MAX_NESTING) throw new CannotAccount(`nesting deeper than ${MAX_NESTING}`);
        if (open.length === 0 && afterObj) dictStart = lexer.start;
        open.push(true);
        break;
      case TOKEN.dictClose:
        if (open.pop() !== true) throw new CannotAccount('a >> that closes no dictionary');
        if (open.length === 0 && dictStart !== -1) {
          closedFrom = dictStart;
          closedTo = lexer.end;
          dictStart = -1;
          justClosed = true;
        }
        break;
      case TOKEN.arrayOpen:
        if (open.length >= MAX_NESTING) throw new CannotAccount(`nesting deeper than ${MAX_NESTING}`);
        open.push(false);
        break;
      case TOKEN.arrayClose:
        if (open.pop() !== false) throw new CannotAccount('a ] that closes no array');
        break;
    }

    if (!justClosed) closedFrom = closedTo = -1;
    afterObj = isObj;
    t2 = t1;
    t2Start = t1Start;
    t2End = t1End;
    t1 = token;
    t1Start = lexer.start;
    t1End = lexer.end;
    t1Comment = lexer.commentBefore;
  }

  if (open.length > 0) {
    throw new CannotAccount(open[open.length - 1] ? 'an unterminated dictionary' : 'an unterminated array');
  }
}

/**
 * The top-level keys of the dictionary at `[from, to)`, which the body scan
 * has already read as tokens and checked for hidden headers.
 */
function streamDictionary(s: string, from: number, to: number): StreamDict {
  const dict = new StreamDict();
  const lexer = new PdfLexer(s, from, to);
  lexer.next(); // its own `<<`
  for (;;) {
    const token = lexer.next();
    switch (token) {
      case TOKEN.name:
        dict.name(nameAt(s, lexer.start, lexer.end));
        break;
      case TOKEN.regular:
        dict.regular(lexer.slice());
        break;
      case TOKEN.dictOpen:
        dict.open(false);
        break;
      case TOKEN.arrayOpen:
        dict.open(true);
        break;
      case TOKEN.arrayClose:
        dict.close();
        break;
      case TOKEN.dictClose:
        if (dict.level === 0) {
          dict.finish();
          return dict;
        }
        dict.close();
        break;
      case TOKEN.eof:
      case TOKEN.unterminated:
        // Cannot happen for bytes the body scan balanced; if it does, trust nothing in it.
        dict.unreadable = true;
        return dict;
      default:
        dict.other();
    }
  }
}

/**
 * Skips the data of the stream whose `stream` keyword ends at `keywordEnd`,
 * inspects it if it is an object stream, and returns where tokens resume.
 */
function streamData(scan: Scan, hidden: HiddenCheck, keywordEnd: number, dict: StreamDict): number {
  const s = scan.body;
  // The data starts after the keyword's end of line (§7.3.8.1).
  let dataStart = keywordEnd;
  if (s.charCodeAt(dataStart) === 0x0d) dataStart += 1;
  if (s.charCodeAt(dataStart) === 0x0a) dataStart += 1;

  let dataEnd = -1;
  const length = dict.directInteger('/Length');
  if (length !== undefined && dataStart + length <= s.length) {
    let q = dataStart + length;
    while (q < s.length && CHAR_CLASS[s.charCodeAt(q)] === WHITESPACE) q += 1;
    if (s.startsWith('endstream', q)) dataEnd = dataStart + length;
  }
  if (dataEnd === -1) {
    // No usable `/Length` — indirect, missing, or wrong — so the data runs to
    // the first `endstream`, as pdf.js reads it. That cannot hide a key: a
    // reader that honours a `/Length` ends the data at an `endstream` too, and
    // the first one is no later than any, so every byte a reader parses as
    // body is a byte this parses as body. It may read some of a reader's data
    // as tokens, which can only refuse more. A reader that ends the data
    // earlier (PDFium stops at an `endobj`) meets the rest as bytes after a
    // finished object, which it only ever parses by jumping to an object
    // header or a trailer, and one of those in these bytes sends the file to
    // the raw scan below.
    dataEnd = s.indexOf('endstream', keywordEnd);
    if (dataEnd === -1) throw new CannotAccount('a stream with no endstream');
  }

  hidden.check('stream data', keywordEnd, dataEnd);
  if (hidden.reason === undefined && dict.mentionsObjectStream) {
    objectStream(scan, dict, dataStart, Math.max(dataStart, dataEnd));
  }
  return dataEnd;
}

/** Decodes an object stream and reads its names, or refuses to account for it. */
function objectStream(scan: Scan, dict: StreamDict, from: number, to: number): void {
  if (dict.unreadable) throw new CannotAccount('an object stream whose dictionary could not be read');
  const filter = dict.entries.get('/Filter');
  let flate: boolean;
  if (filter === undefined) flate = false;
  else if (filter.kind === 'name' && filter.name === '/FlateDecode') flate = true;
  else if (
    filter.kind === 'array' &&
    filter.plain &&
    filter.items.length === 1 &&
    filter.items[0] === '/FlateDecode'
  ) {
    flate = true;
  } else throw new CannotAccount('an object stream with a filter other than /FlateDecode');
  for (const key of ['/DecodeParms', '/DP', '/F', '/FFilter']) {
    if (dict.entries.has(key)) throw new CannotAccount(`an object stream with ${key}`);
  }
  const count = dict.directInteger('/N');
  const first = dict.directInteger('/First');
  if (count === undefined || first === undefined) {
    throw new CannotAccount('an object stream without a direct /N and /First');
  }

  scan.objectStreams += 1;
  if (scan.objectStreams > MAX_OBJECT_STREAMS) {
    throw new CannotAccount(`more than ${MAX_OBJECT_STREAMS} object streams`);
  }

  let text: string;
  if (flate) {
    const data = scan.bytes.subarray(from, to);
    const cmf = data[0] ?? 0;
    const flg = data[1] ?? 0;
    // pdf.js's own checks on a zlib header. The Adler-32 at the end is not
    // checked, by pdf.js or here, and a stream cut short gives what it has:
    // raw inflate with a sync flush reads it the way pdf.js does.
    if (data.length < 2 || (cmf & 0x0f) !== 8 || ((cmf << 8) | flg) % 31 !== 0 || (flg & 0x20) !== 0) {
      throw new CannotAccount('an object stream that will not inflate');
    }
    const remaining = scan.options.inflateBudget - scan.inflatedBytes;
    if (remaining <= 0) throw new CannotAccount('object streams past the inflate budget');
    let inflated: Buffer;
    try {
      inflated = inflateRawSync(data.subarray(2), {
        finishFlush: zlibConstants.Z_SYNC_FLUSH,
        maxOutputLength: remaining,
      });
    } catch (error) {
      throw new CannotAccount(
        (error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE'
          ? 'object streams past the inflate budget'
          : 'an object stream that will not inflate',
      );
    }
    scan.inflatedBytes += inflated.byteLength;
    text = inflated.toString('latin1');
  } else {
    text = scan.body.slice(from, to);
  }
  objectStreamNames(scan, text, count, first);
}

/**
 * The names in an object stream's decoded text: every token of it, header
 * included, the same way as the body. There are no headers or streams inside
 * one, but a reader starts each object at the offset the header gives, so an
 * offset inside a string or a comment is a place it reads what this skipped.
 */
function objectStreamNames(scan: Scan, text: string, count: number, first: number): void {
  if (first > text.length) throw new CannotAccount('an object stream shorter than its /First');

  const offsets: number[] = [];
  const header = new PdfLexer(text, 0, first);
  for (let i = 0; i < count; i += 1) {
    if (header.next() !== TOKEN.regular || !isDigits(text, header.start, header.end)) {
      throw new CannotAccount('an object stream whose header is not pairs of integers');
    }
    if (header.next() !== TOKEN.regular || !isDigits(text, header.start, header.end)) {
      throw new CannotAccount('an object stream whose header is not pairs of integers');
    }
    offsets.push(first + Number(header.slice()));
  }

  const hiddenFrom: number[] = [];
  const hiddenTo: number[] = [];
  const lexer = new PdfLexer(text, 0, text.length, (_kind, from, to) => {
    hiddenFrom.push(from);
    hiddenTo.push(to);
  });
  for (;;) {
    const token = lexer.next();
    if (token === TOKEN.eof) break;
    if (token === TOKEN.unterminated) {
      throw new CannotAccount(`an unterminated ${lexer.unterminated} in an object stream`);
    }
    if (token === TOKEN.name) scan.token(text, lexer.start, lexer.end, true);
  }

  for (const offset of offsets) {
    if (offset > text.length) throw new CannotAccount('an object stream offset past its end');
    // The last hidden stretch that starts before this object.
    let lo = 0;
    let hi = hiddenFrom.length - 1;
    let k = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((hiddenFrom[mid] ?? 0) < offset) {
        k = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (k >= 0 && offset < (hiddenTo[k] ?? 0)) {
      throw new CannotAccount('an object stream object that starts inside a string or a comment');
    }
  }
}

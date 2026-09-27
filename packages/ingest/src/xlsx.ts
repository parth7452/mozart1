/**
 * The XLSX door (ADR 0056). A workbook is a zip of XML parts; this inflates
 * every part, counting the bytes it actually produces rather than the sizes
 * the zip declares, and refuses what this app does not open: macros, external
 * links, embedded objects, ActiveX, any DTD, and anything past the limits.
 * No formula is evaluated and no part is kept.
 */
import { Unzip, UnzipInflate, UnzipPassThrough, type UnzipFile } from 'fflate';
import { RejectedUploadError } from './sniff-errors';
import { DEFAULT_SHEET_LIMITS, type SheetLimits } from './sheet-limits';
import { tokenizeXml, XmlDtdRefusedError, type XmlToken } from './sheet-xml';

const SHEET_MAIN = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';

class BombStop extends Error {}

/** Every entry of the package, inflated, bounded by real output bytes. */
export function unzipBounded(bytes: Uint8Array, limits: SheetLimits): Map<string, Uint8Array> {
  const entries = new Map<string, Uint8Array>();
  const names: string[] = [];
  let total = 0;
  let failure: Error | undefined;
  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);
  unzip.onfile = (file: UnzipFile) => {
    names.push(file.name);
    if (names.length > limits.zipMaxEntries) {
      failure ??= new RejectedUploadError('malformed_spreadsheet', 'too many entries in the package');
      throw new BombStop();
    }
    checkEntryName(file.name);
    const compressed = Math.max(file.size ?? 0, 1);
    const chunks: Uint8Array[] = [];
    let out = 0;
    file.ondata = (err, chunk, final) => {
      if (err) {
        failure ??= new RejectedUploadError('malformed_spreadsheet', 'a package entry will not inflate');
        throw new BombStop();
      }
      out += chunk.length;
      total += chunk.length;
      if (total > limits.zipMaxInflatedBytes || out / compressed > limits.zipMaxEntryRatio && out > 64 * 1024) {
        failure ??= new RejectedUploadError('decompression_bomb', 'the package inflates past its budget');
        file.terminate();
        throw new BombStop();
      }
      chunks.push(chunk);
      if (final) entries.set(file.name, concat(chunks, out));
    };
    file.start();
  };
  try {
    unzip.push(bytes, true);
  } catch (e) {
    if (failure) throw failure;
    if (e instanceof RejectedUploadError) throw e;
    throw new RejectedUploadError('malformed_spreadsheet', 'the package is not a readable zip');
  }
  if (failure) throw failure;
  if (names.length === 0) throw new RejectedUploadError('malformed_spreadsheet', 'the package is empty');
  if (entries.size !== new Set(names).size) {
    throw new RejectedUploadError('malformed_spreadsheet', 'a package entry is incomplete or repeated');
  }
  return entries;
}

function concat(chunks: Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

function checkEntryName(name: string): void {
  const bad =
    name.startsWith('/') ||
    name.startsWith('\\') ||
    /^[A-Za-z]:/.test(name) ||
    name.split(/[\\/]/).includes('..');
  if (bad) throw new RejectedUploadError('malformed_spreadsheet', 'a package entry names a path outside it');
  if (/\.(zip|jar|xlsx)$/i.test(name)) {
    throw new RejectedUploadError('malformed_spreadsheet', 'the package nests another archive');
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

function xmlOf(name: string, data: Uint8Array): XmlToken[] {
  let text: string;
  try {
    text = utf8.decode(data);
  } catch {
    throw new RejectedUploadError('malformed_spreadsheet', `${name} is not UTF-8`);
  }
  try {
    return tokenizeXml(text);
  } catch (e) {
    if (e instanceof XmlDtdRefusedError) throw new RejectedUploadError('xml_dtd_refused', `${name} declares a DTD`);
    throw new RejectedUploadError('malformed_spreadsheet', `${name} is not well-formed`);
  }
}

/** Throws `RejectedUploadError` for anything the XLSX door refuses; returns for a workbook it accepts. */
export function inspectXlsx(bytes: Uint8Array, limits: SheetLimits = DEFAULT_SHEET_LIMITS): void {
  const entries = unzipBounded(bytes, limits);
  const xml = new Map<string, XmlToken[]>();
  for (const [name, data] of entries) {
    if (/\.(xml|rels)$/i.test(name)) xml.set(name, xmlOf(name, data));
  }

  const types = xml.get('[Content_Types].xml');
  const contentTypes = (types ?? [])
    .filter((t): t is Extract<XmlToken, { kind: 'open' }> => t.kind === 'open')
    .map((t) => t.attrs.ContentType ?? '');
  const names = [...entries.keys()];
  if (
    contentTypes.some((c) => /macroEnabled/i.test(c)) ||
    names.some((n) => /vbaProject\.bin$/i.test(n) || /^xl\/workbook\.bin$/i.test(n))
  ) {
    throw new RejectedUploadError('macro_enabled_spreadsheet', 'the workbook carries macros or is binary');
  }
  if (names.some((n) => /^xl\/externalLinks\//i.test(n) || /^xl\/embeddings\//i.test(n) || /(^|\/)activeX\//i.test(n))) {
    throw new RejectedUploadError('active_content_spreadsheet', 'the workbook carries links or embedded content');
  }
  for (const [name, tokens] of xml) {
    if (!/\.rels$/i.test(name)) continue;
    if (tokens.some((t) => t.kind === 'open' && t.attrs.TargetMode === 'External')) {
      throw new RejectedUploadError('active_content_spreadsheet', 'the workbook references something outside it');
    }
  }
  if (!contentTypes.includes(SHEET_MAIN)) {
    throw new RejectedUploadError('content_does_not_match_type', 'the package is not a spreadsheet workbook');
  }

  const workbook = xml.get('xl/workbook.xml');
  if (!workbook) throw new RejectedUploadError('malformed_spreadsheet', 'the package has no workbook');
  const sheets = workbook.filter((t) => t.kind === 'open' && t.name === 'sheet').length;
  if (sheets > limits.maxSheets) throw tooLarge('sheets');

  const shared = xml.get('xl/sharedStrings.xml');
  if (shared) checkTextLengths(shared, limits);
  for (const [name, tokens] of xml) {
    if (!/^xl\/worksheets\/[^/]+\.xml$/i.test(name)) continue;
    let rows = 0;
    for (const t of tokens) {
      if (t.kind !== 'open') continue;
      if (t.name === 'row' && ++rows > limits.maxRows) throw tooLarge('rows');
      if (t.name === 'c' && t.attrs.r !== undefined) {
        const col = columnOf(t.attrs.r);
        if (col === undefined) throw new RejectedUploadError('malformed_spreadsheet', 'a cell reference is malformed');
        if (col > limits.maxColumns) throw tooLarge('columns');
      }
    }
    checkTextLengths(tokens, limits);
  }
}

function tooLarge(what: string): RejectedUploadError {
  return new RejectedUploadError('spreadsheet_too_large', `the workbook has too many ${what}`);
}

function checkTextLengths(tokens: XmlToken[], limits: SheetLimits): void {
  for (const t of tokens) {
    if (t.kind === 'text' && t.text.length > limits.cellMaxChars) {
      throw new RejectedUploadError('spreadsheet_too_large', 'a cell holds too much text');
    }
  }
}

/** 1-based column of an A1 reference (`AB12` → 28), or undefined if it is not one. */
export function columnOf(ref: string): number | undefined {
  const m = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(ref);
  if (!m) return undefined;
  let col = 0;
  for (const ch of m[1]!) col = col * 26 + (ch.charCodeAt(0) - 64);
  return col;
}

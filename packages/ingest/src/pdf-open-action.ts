/**
 * The one `/OpenAction` the upload door lets through: a plain destination.
 *
 * `/OpenAction` is what a viewer does when the file opens. Most often a
 * scanner writes `/OpenAction [1 0 R /Fit]` — show the first page whole — and
 * refusing that refused ordinary scans (the two Hingham invoices in
 * `packages/fixtures/public/` were stored with theirs removed for exactly that
 * reason). The founder approved allowing that form and nothing else:
 *
 * - an explicit destination array (ISO 32000-1 §12.3.2.2): a page, as `N G R`
 *   or a non-negative page index, then a view and exactly as many numbers or
 *   `null`s as that view takes;
 * - or an indirect reference to an object that is one, found as `N G obj …
 *   endobj` in the file body.
 *
 * Everything else is refused as before: an action dictionary whatever its `/S`
 * (a `/GoTo` included — it is still an action), a named destination, a
 * reference that does not resolve here, and any `/OpenAction` the tokenizer
 * could not read, which only the raw scan saw.
 *
 * This file judges values; it never decides that a file has no other active
 * content. `inspectPdf` still refuses every other marker wherever it appears.
 */

import { PdfLexer, TOKEN, decodeName, isDigits, type TokenizedNames, type ValueSite } from './pdf-names';

/** Each explicit destination's view, and how many parameters follow it (Table 149). */
export const DESTINATION_VIEWS: Readonly<Record<string, number>> = {
  '/XYZ': 3,
  '/Fit': 0,
  '/FitH': 1,
  '/FitV': 1,
  '/FitR': 4,
  '/FitB': 0,
  '/FitBH': 1,
  '/FitBV': 1,
};

export type OpenActionVerdict =
  | { readonly allowed: true; readonly destination: string }
  | { readonly allowed: false; readonly reason: string };

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;

/** No destination has more than seven items: `N G R /FitR l b r t`. */
const MAX_DESTINATION_ITEMS = 8;

interface Item {
  readonly name: boolean;
  readonly text: string;
}

/**
 * The explicit destination array whose `[` the lexer has just read, written
 * out, or why it is not one.
 */
function destinationArray(lexer: PdfLexer): { ok: true; text: string } | { ok: false; reason: string } {
  const items: Item[] = [];
  for (;;) {
    const token = lexer.next();
    if (token === TOKEN.arrayClose) break;
    if (token === TOKEN.name) items.push({ name: true, text: decodeName(lexer.slice()) });
    else if (token === TOKEN.regular) items.push({ name: false, text: lexer.slice() });
    else return { ok: false, reason: 'an array holding something other than numbers, names and null' };
    if (items.length > MAX_DESTINATION_ITEMS) return { ok: false, reason: 'an array too long to be a destination' };
  }

  const at = (i: number): Item | undefined => items[i];
  let i: number;
  let page: string;
  const a = at(0);
  const b = at(1);
  const r = at(2);
  if (a && !a.name && isDigits(a.text) && b && !b.name && isDigits(b.text) && r && !r.name && r.text === 'R') {
    page = `${a.text} ${b.text} R`;
    i = 3;
  } else if (a && !a.name && isDigits(a.text)) {
    page = a.text;
    i = 1;
  } else {
    return { ok: false, reason: 'a destination that does not start with a page' };
  }

  const view = at(i);
  const arity = view?.name ? DESTINATION_VIEWS[view.text] : undefined;
  if (view === undefined || arity === undefined) {
    return { ok: false, reason: 'a destination without a view it names' };
  }
  const parameters = items.slice(i + 1);
  if (parameters.length !== arity) {
    return { ok: false, reason: `${view.text} with ${parameters.length} parameters, not ${arity}` };
  }
  for (const parameter of parameters) {
    if (parameter.name || (parameter.text !== 'null' && !NUMBER.test(parameter.text))) {
      return { ok: false, reason: `${view.text} with a parameter that is not a number or null` };
    }
  }
  return { ok: true, text: `[${[page, view.text, ...parameters.map((p) => p.text)].join(' ')}]` };
}

/** Whether some suffix of `digits` reads as `target`: `12` and `012` both end in `2`. */
function mayReadAs(digits: string, target: number): boolean {
  for (let k = 0; k < digits.length; k += 1) {
    if (Number(digits.slice(k)) === target) return true;
  }
  return false;
}

/**
 * The value an `obj` holds, if it is a destination array and nothing but one:
 * `N G obj [ … ] endobj`.
 */
function destinationObject(body: string, valueAt: number): { ok: true; text: string } | { ok: false; reason: string } {
  const lexer = new PdfLexer(body, valueAt, body.length);
  if (lexer.next() !== TOKEN.arrayOpen) return { ok: false, reason: 'it is not an array' };
  const destination = destinationArray(lexer);
  if (!destination.ok) return destination;
  if (lexer.next() !== TOKEN.regular || !lexer.is('endobj')) {
    return { ok: false, reason: 'the array is not the whole object' };
  }
  return destination;
}

/**
 * An indirect destination, resolved in the file body.
 *
 * A reader finds the object by its cross-reference entry, not by searching,
 * and two ways that entry could land somewhere this does not look are shut
 * here rather than trusted away:
 *
 * - An entry may point into the middle of a header's number, so `12 0 obj`
 *   reads as object 2. Every header whose number ends in the digits asked for
 *   must hold a destination, and at least one must be the object exactly.
 * - pdf.js takes an object from an object stream by the slot the
 *   cross-reference stream names, not by the number the object stream labels
 *   it with, so a label proves nothing. A file with any object stream does not
 *   get an indirect destination at all.
 */
function resolve(scan: TokenizedNames, number: string, generation: string): OpenActionVerdict {
  const target = Number(number);
  const reference = `${number} ${generation} R`;
  if (scan.objectStreams > 0) {
    return { allowed: false, reason: `${reference} in a file with object streams, where it cannot be resolved` };
  }
  let exact = 0;
  let destination = '';
  for (const header of scan.headers) {
    if (!mayReadAs(header.number, target)) continue;
    const value = destinationObject(scan.body, header.valueAt);
    if (!value.ok) {
      return {
        allowed: false,
        reason: `${reference} could read object ${header.number} ${header.generation}, and ${value.reason}`,
      };
    }
    if (Number(header.number) === target && Number(header.generation) === Number(generation)) {
      exact += 1;
      destination = value.text;
    }
  }
  if (exact === 0) return { allowed: false, reason: `${reference} does not resolve in the file body` };
  return { allowed: true, destination: `${reference} → ${destination}` };
}

/** Judges the value of one `/OpenAction` the tokenizer read. */
export function judgeOpenAction(site: ValueSite, scan: TokenizedNames): OpenActionVerdict {
  const lexer = new PdfLexer(site.text, site.at, site.limit);
  const token = lexer.next();
  if (token === TOKEN.arrayOpen) {
    const destination = destinationArray(lexer);
    return destination.ok
      ? { allowed: true, destination: destination.text }
      : { allowed: false, reason: destination.reason };
  }
  if (token === TOKEN.regular && isDigits(lexer.text, lexer.start, lexer.end)) {
    const number = lexer.slice();
    const second = lexer.next();
    const generation = lexer.slice();
    if (second === TOKEN.regular && isDigits(generation) && lexer.next() === TOKEN.regular && lexer.is('R')) {
      return resolve(scan, number, generation);
    }
    return { allowed: false, reason: 'a number that is not a reference' };
  }
  const what: Partial<Record<number, string>> = {
    [TOKEN.dictOpen]: 'an action dictionary',
    [TOKEN.name]: 'a named destination',
    [TOKEN.string]: 'a named destination',
    [TOKEN.hexString]: 'a named destination',
  };
  return { allowed: false, reason: what[token] ?? 'a value that is not a destination' };
}

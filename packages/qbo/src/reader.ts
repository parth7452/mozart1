/**
 * Reading Intuit's JSON without trusting its shape.
 *
 * QBO's responses are `unknown` until proven otherwise. Every accessor here
 * names the path it was reading when it gave up (`Invoice[2].CustomerRef.value`)
 * so a failure says which field of which row was unreadable, rather than
 * "cannot read properties of undefined".
 *
 * Nothing here substitutes a default for a missing value. The port's required
 * fields are required: a `LedgerInvoice` with `invoiceNumber: ''` would
 * reconcile against nothing and nobody would notice for a quarter, so an absent
 * `DocNumber` is a loud failure instead.
 */

import { DateParseError, parsePrintedDate } from '@recouple/core-domain';
import { QboMalformedResponse } from './errors';

/** A short, safe rendering of a value for an error message. */
export function describe(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'function') return 'a function';
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return typeof value;
    return text.length > 80 ? `${text.slice(0, 77)}...` : text;
  } catch {
    return typeof value;
  }
}

export type JsonObject = Readonly<Record<string, unknown>>;

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readObject(value: unknown, path: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new QboMalformedResponse(`expected an object at ${path}, got ${describe(value)}`, path);
  }
  return value;
}

/** An absent key reads as an empty list; a present non-list is a failure. */
export function readArray(value: unknown, path: string): readonly unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new QboMalformedResponse(`expected an array at ${path}, got ${describe(value)}`, path);
  }
  return value;
}

export function readString(source: JsonObject, key: string, path: string): string {
  const value = source[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new QboMalformedResponse(
      `expected a non-empty string at ${path}.${key}, got ${describe(value)}`,
      `${path}.${key}`,
    );
  }
  return value;
}

/**
 * An optional string. Absent, null and empty all read as "not there" — QBO
 * returns `""` for an untouched `PrivateNote`, and an empty memo is the absence
 * of a memo, not a memo that says nothing.
 */
export function readOptionalString(source: JsonObject, key: string, path: string): string | undefined {
  const value = source[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new QboMalformedResponse(
      `expected a string or nothing at ${path}.${key}, got ${describe(value)}`,
      `${path}.${key}`,
    );
  }
  return value;
}

/**
 * A QBO date field. QBO documents `TxnDate` and `DueDate` as `YYYY-MM-DD`, so
 * that is the only shape accepted — and it is then run through core-domain's
 * `parsePrintedDate`, which is what rejects `2026-02-31`. One date validator in
 * this system, not two.
 */
export function readIsoDate(source: JsonObject, key: string, path: string): string {
  const value = readString(source, key, path);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new QboMalformedResponse(
      `expected YYYY-MM-DD at ${path}.${key}, got ${describe(value)}`,
      `${path}.${key}`,
    );
  }
  try {
    return parsePrintedDate(value);
  } catch (error) {
    if (error instanceof DateParseError) {
      throw new QboMalformedResponse(
        `date at ${path}.${key} is not a calendar day: ${error.message}`,
        `${path}.${key}`,
      );
    }
    throw error;
  }
}

/** The same, for a field QBO may legitimately omit (an invoice with no due date). */
export function readOptionalIsoDate(
  source: JsonObject,
  key: string,
  path: string,
): string | undefined {
  const value = source[key];
  if (value === undefined || value === null || value === '') return undefined;
  return readIsoDate(source, key, path);
}

/** A nested ref object: `CustomerRef`, `CurrencyRef`. */
export function readRef(source: JsonObject, key: string, path: string): JsonObject {
  const value = source[key];
  if (value === undefined) {
    throw new QboMalformedResponse(`expected ${path}.${key} to be present`, `${path}.${key}`);
  }
  return readObject(value, `${path}.${key}`);
}

// What the worker writes to its own output: one JSON object per line, with
// ids, outcome codes, counts and recipe step names, and nothing else (ADR 0057
// §7). A credential, a TOTP secret or code, a cookie, a URL, a request body,
// page text and an error's message never reach a line. An error is named by
// its class alone, because a message off this path can quote a page, a URL or
// a value typed, and a `JSON.parse` of a decrypted payload quotes the payload.
import { PORTAL_LIMITS } from './portal';

/** A value a log line may carry: an id, a code, a count, a step name. */
export type LogValue = string | number | boolean | null;

/** A line's fields. `at` and `event` are the logger's. */
export type LogFields = Readonly<Record<string, LogValue>> & { readonly at?: never; readonly event?: never };

export type WorkerLog = (event: string, fields?: LogFields) => void;

/** A logger writing one JSON line per event to `stream`. */
export function jsonLines(stream: { write(line: string): unknown }): WorkerLog {
  return (event, fields = {}) => {
    stream.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`);
  };
}

/** A class name as the contract's `errorClass` takes one: an identifier, never a message. */
const ERROR_CLASS = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** `name` when it is a class name the contract's `errorClass` would take, else `fallback`. */
export function classNameOr(name: string, fallback: string): string {
  return ERROR_CLASS.test(name) && name.length <= PORTAL_LIMITS.errorClassMax ? name : fallback;
}

/** An error's class name, for a log line or a run's end. Anything that is not an identifier is `Error`. */
export function errorClassOf(e: unknown): string {
  return e instanceof Error ? classNameOr(e.name, 'Error') : 'Error';
}

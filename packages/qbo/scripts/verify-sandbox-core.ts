/**
 * The parts of `pnpm qbo:verify` that can be checked without an Intuit sandbox:
 * reading the five settings out of a parsed `.env`, rewriting the rotated
 * refresh token back into that file, saving that file atomically, and redacting
 * a recorded response.
 *
 * They live in their own `.ts` file rather than inside `verify-sandbox.mts` for
 * one reason: a test can import them. `packages/qbo/test/verify-sandbox.test.ts`
 * covers exactly these, and nothing here opens a socket or looks at
 * `process.env` — the script hands them what it read.
 *
 * Nothing in this directory is a production path. It is an operator's script,
 * run from a laptop against an Intuit *sandbox*.
 */

import { chmodSync, existsSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

/** The five settings the script needs, plus the optional sixth. */
export interface SandboxSettings {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly realmId: string;
  readonly refreshToken: string;
  /** Absent unless `.env` carries a `QBO_ACCESS_TOKEN=` line. */
  readonly accessToken?: string;
}

/**
 * Something about `.env` is wrong and the person running the script has to fix
 * it. The message is the whole report, in plain sentences, already laid out for
 * printing — there is nothing for the caller to add.
 */
export class SandboxSettingsProblem extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxSettingsProblem';
  }
}

/** Where each setting comes from, for the message a missing one produces. */
const WHERE_IT_COMES_FROM: Readonly<Record<string, string>> = {
  QBO_ENVIRONMENT: 'Write `QBO_ENVIRONMENT=sandbox`. This script only ever talks to a sandbox.',
  QBO_CLIENT_ID:
    'Intuit developer portal -> your app -> Keys & credentials -> the Development tab. ' +
    'It is the value labelled "Client ID".',
  QBO_CLIENT_SECRET:
    'Intuit developer portal -> your app -> Keys & credentials -> the Development tab. ' +
    'It is the value labelled "Client Secret", next to the Client ID.',
  QBO_REALM_ID:
    'The OAuth 2.0 Playground (Intuit developer portal -> your app -> the Playground link). ' +
    'After you connect the sandbox company it shows a "Realm ID" — that is your company id.',
  QBO_REFRESH_TOKEN:
    'The same OAuth 2.0 Playground screen. Step 2 gives you a refresh token; copy it whole.',
};

/** Exactly the value `QBO_ENVIRONMENT` has to hold for this script to run. */
export const SANDBOX = 'sandbox';

/**
 * The settings, or a `SandboxSettingsProblem` explaining what to fix.
 *
 * `values` is the parsed `.env` file, not `process.env`: the script rewrites
 * that file, so the file is what it has to read. Every missing setting is
 * reported at once — sending someone back to the Intuit portal five times over
 * is not a kindness.
 */
export function readSandboxSettings(
  values: Readonly<Record<string, string | undefined>>,
): SandboxSettings {
  const given = (name: string): string | undefined => {
    const value = values[name];
    return value === undefined || value.trim() === '' ? undefined : value.trim();
  };

  const missing = Object.keys(WHERE_IT_COMES_FROM).filter((name) => given(name) === undefined);
  if (missing.length > 0) {
    const lines = missing.map((name) => `  ${name}\n    ${WHERE_IT_COMES_FROM[name] ?? ''}`);
    throw new SandboxSettingsProblem(
      `${missing.length === 1 ? 'One setting is' : `${missing.length} settings are`} ` +
        'missing from the .env file at the top of this repository.\n\n' +
        `What to do: open .env in a text editor and add ${
          missing.length === 1 ? 'this line' : 'these lines'
        }, one per line, in the form NAME=value.\n\n` +
        `${lines.join('\n\n')}\n\n` +
        'Then run the command again. The .env file is never committed to git.',
    );
  }

  // Case-folded: "Sandbox" is the same answer as "sandbox", and refusing it
  // would be pedantry aimed at the one person this script is written for.
  const environment = (given('QBO_ENVIRONMENT') as string).toLowerCase();
  if (environment === 'production') {
    throw new SandboxSettingsProblem(
      'QBO_ENVIRONMENT is set to production, and this script refuses to run against ' +
        "production. It reads a real company's ledger and it rewrites the refresh token " +
        'in .env, which would disconnect whatever else is using that connection.\n\n' +
        'What to do: set QBO_ENVIRONMENT=sandbox in .env, with the sandbox company\'s own ' +
        'client id, client secret, realm id and refresh token from the Development tab of ' +
        'the Intuit developer portal.',
    );
  }
  if (environment !== SANDBOX) {
    throw new SandboxSettingsProblem(
      `QBO_ENVIRONMENT is set to "${environment}", which is not a value this script ` +
        'understands.\n\nWhat to do: set QBO_ENVIRONMENT=sandbox in .env and run the ' +
        'command again.',
    );
  }

  const accessToken = given('QBO_ACCESS_TOKEN');
  const settings: SandboxSettings = {
    clientId: given('QBO_CLIENT_ID') as string,
    clientSecret: given('QBO_CLIENT_SECRET') as string,
    realmId: given('QBO_REALM_ID') as string,
    refreshToken: given('QBO_REFRESH_TOKEN') as string,
  };
  // `exactOptionalPropertyTypes` is on: an absent access token is an absent key,
  // not a key holding `undefined`.
  return accessToken === undefined ? settings : { ...settings, accessToken };
}

export interface EnvRewrite {
  /** The whole file, with the named lines' values replaced and nothing else touched. */
  readonly text: string;
  /** Keys whose line was found and whose value is now different. */
  readonly changed: readonly string[];
  /** Keys with no line in the file. Nothing is appended for them. */
  readonly absent: readonly string[];
}

/**
 * Replaces the value of specific `KEY=` lines and leaves the rest of the file
 * byte for byte as it was.
 *
 * This runs on a file a person maintains by hand, so comments, blank lines,
 * ordering, CRLF endings and a missing final newline all have to survive. It
 * rewrites a line in place and never appends: a key with no line is reported as
 * `absent` and the script says so out loud, because a value that reached us from
 * a shell variable rather than from this file cannot be saved here — dotenv
 * would not read the line back anyway while the shell variable exists.
 */
export function rewriteEnvLines(text: string, updates: ReadonlyMap<string, string>): EnvRewrite {
  const changed: string[] = [];
  const seen = new Set<string>();

  // Each piece keeps its own newline, so joining them is the original file.
  const pieces = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

  const rewritten = pieces.map((piece) => {
    const newline = piece.endsWith('\n') ? '\n' : '';
    const line = newline === '' ? piece : piece.slice(0, -1);
    // A trailing `\r` belongs to the line ending, not to the value.
    const carriage = line.endsWith('\r') ? '\r' : '';
    const bare = carriage === '' ? line : line.slice(0, -1);

    const match = /^(\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=)(.*)$/.exec(bare);
    if (match === null) return piece;

    const [, prefix, key, oldValue] = match as unknown as [string, string, string, string];
    const replacement = updates.get(key);
    if (replacement === undefined) return piece;

    seen.add(key);
    const nextValue = quotedLike(oldValue, replacement);
    if (nextValue === oldValue) return piece;
    changed.push(key);
    return `${prefix}${nextValue}${carriage}${newline}`;
  });

  return {
    text: rewritten.join(''),
    changed,
    absent: [...updates.keys()].filter((key) => !seen.has(key)),
  };
}

/**
 * The new value, quoted the way the old one was.
 *
 * Intuit's tokens need no quoting, but a person may have quoted the line, and a
 * rewrite that drops their quotes is a rewrite that changed something it was not
 * asked to change.
 */
function quotedLike(oldValue: string, replacement: string): string {
  const trimmed = oldValue.trim();
  for (const quote of ['"', "'"]) {
    if (trimmed.length >= 2 && trimmed.startsWith(quote) && trimmed.endsWith(quote)) {
      return `${quote}${replacement}${quote}`;
    }
  }
  return replacement;
}

/**
 * The save did not happen. `completeFileAt` names a file that holds the whole
 * new `.env` when there is one — which is the difference between "rename this
 * over .env yourself" and "nothing was written", and the script says whichever
 * is true rather than a sentence that covers both.
 */
export class EnvSaveFailed extends Error {
  constructor(
    message: string,
    readonly completeFileAt: string | undefined,
    readonly reason: unknown,
  ) {
    super(message);
    this.name = 'EnvSaveFailed';
  }
}

/**
 * Writes `.env` by writing a temporary file beside it and renaming it over the
 * top, keeping the original's permissions.
 *
 * `.env` is the only copy of a refresh token Intuit has already replaced, so a
 * half-written one is a connection nobody can recover. `rename` within a
 * directory is atomic, so a reader sees the old file or the new one.
 */
export function saveEnvFileAtomically(envPath: string, text: string): void {
  const temporary = path.join(path.dirname(envPath), `.env.${randomUUID()}.tmp`);

  try {
    writeFileSync(temporary, text, 'utf8');
    chmodSync(temporary, statSync(envPath).mode & 0o777);
  } catch (reason) {
    // What is in the temporary file is not known to be complete, so it is
    // removed rather than offered as a repair.
    try {
      if (existsSync(temporary)) unlinkSync(temporary);
    } catch {
      // Nothing we can do about it, and the failure below is the real one.
    }
    throw new EnvSaveFailed(`could not write a new copy of ${envPath}`, undefined, reason);
  }

  try {
    renameSync(temporary, envPath);
  } catch (reason) {
    throw new EnvSaveFailed(
      `could not move the new copy over ${envPath}`,
      temporary,
      reason,
    );
  }
}

/** What a redacted value is replaced with, so a reader can see it was removed. */
export const REDACTED = '__REDACTED__';

/**
 * A secret shorter than this is not replaced.
 *
 * Nothing Intuit issues is this short, and blanket-replacing a two-character
 * string would shred a fixture rather than redact it. Reported by the caller
 * rather than passed over silently.
 */
export const MIN_REDACTABLE_LENGTH = 4;

/**
 * Keys whose value is a credential whatever it looks like.
 *
 * Named exactly rather than by substring, because QuickBooks puts a `SyncToken`
 * on every row and that is a version number, not a credential: redacting it
 * would cost the fixture a field it is supposed to record.
 */
const SECRET_KEY =
  /^(access_token|refresh_token|id_token|token|client_id|client_secret|password|authorization)$/i;

/** Every occurrence of every secret, replaced. */
export function redactText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of redactable(secrets)) out = out.split(secret).join(REDACTED);
  return out;
}

/**
 * The same, over parsed JSON: a string value under a key that names a
 * credential goes whatever it holds, and every other string still has the known
 * secrets cut out of it.
 *
 * Both halves are needed. The key pass catches the rotated tokens in a refresh
 * response, which the script has never seen before and so cannot list as
 * secrets; the substring pass catches the realm id and the client id, which
 * appear in URLs and messages under keys that look innocent.
 */
export function redactJson(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactJson(item, secrets));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) && typeof item === 'string' ? REDACTED : redactJson(item, secrets);
    }
    return out;
  }
  return value;
}

/** The secrets long enough to replace safely. */
export function redactable(secrets: readonly string[]): readonly string[] {
  return secrets.filter((secret) => secret.length >= MIN_REDACTABLE_LENGTH);
}

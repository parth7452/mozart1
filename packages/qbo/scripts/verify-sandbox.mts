/**
 * Proves the read-only QuickBooks adapter works against a real Intuit sandbox
 * (ADR 0026).
 *
 *   pnpm qbo:verify            # read the sandbox ledger and report
 *   pnpm qbo:verify --record   # the same, and save the responses as fixtures
 *
 * A laptop-only script. It reads its settings from the `.env` file at the top of
 * this repository, talks to `sandbox-quickbooks.api.intuit.com` and nowhere
 * else, and refuses to run when `QBO_ENVIRONMENT` says production. It prints
 * counts and a two-row sample; it never prints a token, a secret or the realm
 * id, including inside an error message.
 *
 * It also **writes the rotated refresh token back into `.env`**. Intuit replaces
 * the refresh token on every refresh and kills the old one immediately, so a
 * script that read the ledger and then forgot the new token would leave the
 * connection stranded and the repair is going back through the OAuth Playground.
 * The write-back happens even when a read fails part way, because by then the
 * rotation has already happened.
 *
 * Every failure here ends in a sentence saying what to do next. The person
 * running it is not expected to read this file.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseEnvFile } from 'dotenv';
import type { LedgerWindow } from '@recouple/adapters';
import { formatCents, type Cents } from '@recouple/core-domain';
import {
  QBO_SANDBOX_BASE_URL,
  QboAccountingSource,
  QboAuthError,
  QboError,
  QboInvalidWindow,
  QboMalformedResponse,
  QboRateLimited,
  QboRequestFailed,
  type FetchLike,
  type QboTokens,
} from '@recouple/qbo';
// `@recouple/qbo/testing` is deliberately out of reach of production code, and
// this is not production code: it is an operator's script under `scripts/`,
// holding one sandbox connection for the length of one process and persisting
// the rotation to `.env` itself. A tenant's real tokens belong in KMS-backed
// storage (ADR 0026, CLAUDE.md), and nothing under `apps/` or `packages/*/src`
// imports this file.
import { InMemoryQboTokenStore } from '@recouple/qbo/testing';
import {
  EnvSaveFailed,
  readSandboxSettings,
  redactJson,
  redactText,
  rewriteEnvLines,
  SandboxSettingsProblem,
  saveEnvFileAtomically,
  type SandboxSettings,
} from './verify-sandbox-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const envPath = path.join(repoRoot, '.env');
const fixtureDir = path.join(here, '..', 'test', 'fixtures');

/** Ninety calendar days, and the window is inclusive at both ends. */
const WINDOW_DAYS = 90;

/** Seeded when `.env` names no access token, so the adapter refreshes first. */
const NO_ACCESS_TOKEN = 'no-access-token-in-env-refresh-before-the-first-read';

/** Intuit's documented refresh-token lifetime, used only because we cannot know the real one. */
const REFRESH_TOKEN_DAYS = 100;

const say = (line = ''): void => {
  console.log(line);
};

function stop(report: string): never {
  console.error(`\n${report}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------- arguments

const args = process.argv.slice(2);
const recording = args.includes('--record');
const unknownArgs = args.filter((arg) => arg !== '--record');
if (unknownArgs.length > 0) {
  console.error(
    `This script does not understand ${unknownArgs.map((a) => `"${a}"`).join(', ')}.\n\n` +
      '  pnpm qbo:verify            read the sandbox ledger and report\n' +
      '  pnpm qbo:verify --record   the same, and save the responses as fixtures\n',
  );
  process.exit(2);
}

// ------------------------------------------------------------------ settings

say('Checking the QuickBooks sandbox connection.');
say();

if (!existsSync(envPath)) {
  stop(
    `There is no .env file at ${envPath}, and that file is where this script reads ` +
      'its QuickBooks settings from.\n\n' +
      'What to do: create it in a text editor, with one setting per line:\n\n' +
      '  QBO_ENVIRONMENT=sandbox\n' +
      '  QBO_CLIENT_ID=...\n' +
      '  QBO_CLIENT_SECRET=...\n' +
      '  QBO_REALM_ID=...\n' +
      '  QBO_REFRESH_TOKEN=...\n\n' +
      'The client id and secret are in the Intuit developer portal, under your app, ' +
      'Keys & credentials, on the Development tab. The realm id and the refresh token ' +
      'come from the OAuth 2.0 Playground on that same portal, after you connect the ' +
      'sandbox company. The .env file is never committed to git.',
  );
}

// The file, not `process.env`: this script rewrites that file, so the file has
// to be what it read. A value exported in a shell would win in `process.env`
// and then the rotation would be saved somewhere nothing reads it back.
const envFileValues = parseEnvFile(readFileSync(envPath, 'utf8'));

let settings: SandboxSettings;
try {
  settings = readSandboxSettings(envFileValues);
} catch (error) {
  if (error instanceof SandboxSettingsProblem) stop(error.message);
  throw error;
}

say(`Settings read from ${envPath}. Environment: sandbox.`);

/**
 * Everything that must never appear in this script's output, including inside
 * an error message the adapter built — `QboAuthError` names the realm id.
 *
 * It grows: the tokens Intuit rotates to are secrets too, and they are not
 * known until the refresh has happened.
 */
const secrets: string[] = [
  settings.realmId,
  settings.clientId,
  settings.clientSecret,
  settings.refreshToken,
  ...(settings.accessToken === undefined ? [] : [settings.accessToken]),
];
const safe = (text: string): string => redactText(text, secrets);

// ---------------------------------------------------------- the connection

const store = new InMemoryQboTokenStore({ [settings.realmId]: seedTokens(settings) });

/**
 * What `QboTokenStore.load` has to hand the adapter: both tokens and both
 * expiry times, as ISO strings.
 */
function seedTokens(from: SandboxSettings): QboTokens {
  const now = Date.now();
  return {
    accessToken: from.accessToken ?? NO_ACCESS_TOKEN,
    refreshToken: from.refreshToken,
    // An access token we were not given is stated as already expired, so the
    // adapter refreshes before its first read instead of spending a round trip
    // to be told the same thing by a 401.
    accessExpiresAt: new Date(
      from.accessToken === undefined ? now - 60_000 : now + 55 * 60_000,
    ).toISOString(),
    // We do not know when this refresh token was issued, and the adapter
    // refuses to use one it believes has expired. Stating the documented
    // lifetime is what lets it try; if the token is in fact dead, Intuit says so
    // and that arrives as an auth failure with a next step, rather than as an
    // assumption baked in here.
    refreshExpiresAt: new Date(now + REFRESH_TOKEN_DAYS * 24 * 3_600_000).toISOString(),
  };
}

/** One recorded HTTP response: which call it answered, and its body verbatim. */
interface Recorded {
  readonly label: string;
  readonly body: string;
}
const recorded: Recorded[] = [];

/**
 * The adapter's `fetchImpl`, wrapped so `--record` can keep what came back.
 *
 * Wrapping the injected fetch is the whole recording mechanism: nothing under
 * `packages/qbo/src` changes, and without `--record` this is a pass-through.
 */
const fetchImpl: FetchLike = async (input, init) => {
  const response = await fetch(input, init);
  if (!recording) return response;
  // A body can only be read once, so the copy is what we read.
  recorded.push({ label: labelFor(input), body: await response.clone().text() });
  return response;
};

/** The fixture name a URL earns: the entity it queried, or the token exchange. */
function labelFor(url: string): string {
  const query = new URL(url).searchParams.get('query');
  if (query === null) return 'token-refresh';
  const entity = /\bfrom\s+(\w+)\b/i.exec(query)?.[1];
  return entity === undefined ? 'query' : `${entity.toLowerCase()}-query`;
}

const source = new QboAccountingSource({
  realmId: settings.realmId,
  baseUrl: QBO_SANDBOX_BASE_URL,
  clientId: settings.clientId,
  clientSecret: settings.clientSecret,
  tokenStore: store,
  fetchImpl,
});

// ------------------------------------------------------------------- reading

const isoDay = (at: Date): string => at.toISOString().slice(0, 10);
const today = new Date();
const ledgerWindow: LedgerWindow = {
  // Inclusive at both ends, so one day fewer than the count of days.
  from: isoDay(new Date(today.getTime() - (WINDOW_DAYS - 1) * 86_400_000)),
  to: isoDay(today),
};

say(`Reading the sandbox ledger from ${ledgerWindow.from} to ${ledgerWindow.to}, ${WINDOW_DAYS} days.`);
say();

/** Counts and a two-row sample. Every ledger row has an id and a total. */
function report(
  what: string,
  rows: readonly { readonly externalId: string; readonly totalCents: Cents }[],
): void {
  say(`${what}: ${rows.length} ${rows.length === 1 ? 'row' : 'rows'}.`);
  if (rows.length === 0) {
    say('  Nothing in this window. An empty sandbox company reads as zero rows, which is');
    say('  a real answer and not a failure.');
    return;
  }
  for (const row of rows.slice(0, 2)) say(`  ${row.externalId}   ${formatCents(row.totalCents)}`);
  if (rows.length > 2) say(`  ... and ${rows.length - 2} more.`);
}

let failure: unknown;
try {
  report('Invoices', await source.listInvoices(ledgerWindow));
  report('Payments', await source.listPayments(ledgerWindow));
  report('Credit memos', await source.listCredits(ledgerWindow));
} catch (error) {
  failure = error;
}

// ------------------------------------------------ the rotation, saved first

/**
 * Whatever the token store now holds, written back into `.env`.
 *
 * This runs whether the reads succeeded or not, and before the failure is
 * reported, because a refresh that happened before the failure has already
 * killed the refresh token that is in the file.
 */
async function saveRotation(): Promise<void> {
  const current = await store.load(settings.realmId);
  if (current === undefined) return; // Unreachable: the store was seeded above.
  secrets.push(current.refreshToken, current.accessToken);

  if (current.refreshToken === settings.refreshToken) {
    say();
    say('The refresh token did not change on this run, so .env was left alone.');
    return;
  }

  const updates = new Map([['QBO_REFRESH_TOKEN', current.refreshToken]]);
  // Only if the person keeps one there. This script does not add a line.
  if (envFileValues['QBO_ACCESS_TOKEN'] !== undefined) {
    updates.set('QBO_ACCESS_TOKEN', current.accessToken);
  }

  // Re-read: the file may have been edited while the ledger was being read, and
  // the rest of it has to survive byte for byte.
  const rewrite = rewriteEnvLines(readFileSync(envPath, 'utf8'), updates);

  if (rewrite.absent.length > 0) {
    say();
    say(
      `${rewrite.absent.join(' and ')} ${rewrite.absent.length === 1 ? 'is' : 'are'} not a line ` +
        'in .env, so the new value was not saved there.',
    );
    if (rewrite.absent.includes('QBO_REFRESH_TOKEN')) {
      say('That is the one that matters. QuickBooks has already replaced the old refresh');
      say('token, so add a QBO_REFRESH_TOKEN= line to .env and repeat the OAuth 2.0');
      say('Playground steps to fill it in.');
    }
  }
  if (rewrite.changed.length === 0) return;

  try {
    saveEnvFileAtomically(envPath, rewrite.text);
  } catch (error) {
    if (!(error instanceof EnvSaveFailed)) throw error;
    say();
    say('The new refresh token could not be saved into .env, and QuickBooks has already');
    say('replaced the one .env holds, so this connection will not work until that is fixed.');
    if (error.completeFileAt === undefined) {
      say('What to do: check that you can write to .env, then repeat the OAuth 2.0');
      say('Playground steps to get a fresh refresh token and paste it into .env.');
    } else {
      say(`What to do: the complete new file is at ${error.completeFileAt}.`);
      say('Rename it over .env yourself.');
    }
    stop(safe(error.message));
  }

  say();
  say('Refresh token rotated and saved.');
}

await saveRotation();

// ------------------------------------------------------------- the fixtures

if (recording) saveFixtures();

/**
 * The recorded responses, redacted, beside the hand-written fixtures rather
 * than over them (ADR 0026): a hand-written fixture asserts what we think the
 * contract is and a recorded one asserts what Intuit actually sent, and it is
 * worth being able to see the two disagree.
 */
function saveFixtures(): void {
  say();
  if (recorded.length === 0) {
    say('Nothing was recorded: no response got far enough to have a body.');
    return;
  }

  const written: string[] = [];
  const seenPerLabel = new Map<string, string[]>();

  for (const { label, body } of recorded) {
    const already = seenPerLabel.get(label) ?? [];
    // The Payment query runs twice — once for the payments, once to resolve what
    // each credit memo was applied to — so the same body arrives twice. One
    // file per distinct body keeps that from being two files saying the same
    // thing, and keeps a genuine second page from being lost.
    if (already.includes(body)) continue;
    already.push(body);
    seenPerLabel.set(label, already);

    const suffix = already.length === 1 ? '' : `-${already.length}`;
    const file = path.join(fixtureDir, `recorded-${label}${suffix}.json`);

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      say(`The ${label} response was not JSON, so it was not saved as a fixture.`);
      continue;
    }
    writeFileSync(file, `${JSON.stringify(redactJson(parsed, secrets), null, 2)}\n`, 'utf8');
    written.push(path.basename(file));
  }

  if (written.length === 0) return;
  say(`Saved ${written.length === 1 ? 'one recorded response' : `${written.length} recorded responses`} under`);
  say(`${fixtureDir}:`);
  for (const name of written) say(`  ${name}`);
  say('The realm id, the client id and every token in them are replaced with __REDACTED__.');
  say('These files are named recorded-*.json and sit beside the hand-written fixtures; none');
  say('of those were changed.');
}

// --------------------------------------------------------------- the verdict

if (failure === undefined) {
  say();
  say('The QuickBooks sandbox connection works: the adapter authenticated, read all three');
  say('kinds of ledger row, and every amount converted to whole cents.');
  process.exit(0);
}

stop(explain(failure));

/** A typed adapter failure, as a sentence and a next step. */
function explain(error: unknown): string {
  if (error instanceof QboAuthError) {
    return (
      `QuickBooks would not accept this connection.\n\n${safe(error.message)}\n\n` +
      'What to do: repeat the OAuth 2.0 Playground steps in the Intuit developer portal ' +
      '(your app, the Playground link, connect the sandbox company) and paste the new ' +
      'refresh token into .env as QBO_REFRESH_TOKEN. A refresh token is single use and ' +
      'lasts about 100 days, so an old one in .env reads exactly like this. If .env also ' +
      'has a QBO_ACCESS_TOKEN line, delete that line: the script will fetch a fresh access ' +
      'token from the refresh token by itself.'
    );
  }
  if (error instanceof QboRateLimited) {
    const wait =
      error.retryAfterMs === undefined
        ? 'a few minutes'
        : `${Math.ceil(error.retryAfterMs / 1000)} seconds`;
    return (
      `QuickBooks asked us to slow down.\n\n${safe(error.message)}\n\n` +
      `What to do: wait ${wait} and run the command again. Nothing is wrong with the ` +
      'connection, and no settings need changing.'
    );
  }
  if (error instanceof QboMalformedResponse) {
    return (
      'QuickBooks sent something this adapter will not turn into money, so it stopped ' +
      `rather than guess.\n\n${safe(error.message)}\n\n` +
      `What to do: send the field it names — ${error.fieldPath} — to whoever maintains ` +
      'this repository. Running `pnpm qbo:verify --record` first saves the response as a ' +
      'fixture they can read, with the realm id and the tokens taken out.'
    );
  }
  if (error instanceof QboInvalidWindow) {
    return (
      `The script asked QuickBooks for a date range it will not use.\n\n${safe(error.message)}\n\n` +
      'What to do: this is a fault in the script rather than in your settings. Report it ' +
      'to whoever maintains this repository.'
    );
  }
  if (error instanceof QboRequestFailed) {
    const cause =
      error.status === 0
        ? 'The request never reached Intuit at all.\n\nWhat to do: check that this machine ' +
          'is online and can reach sandbox-quickbooks.api.intuit.com, then run the command ' +
          'again.'
        : error.status >= 500
          ? `Intuit answered ${error.status}, which is a fault on their side.\n\nWhat to do: ` +
            'wait a few minutes and run the command again. If it keeps happening, check ' +
            'Intuit\'s status page.'
          : `Intuit answered ${error.status} and refused the request.\n\nWhat to do: check ` +
            'that QBO_REALM_ID in .env is the realm id of the sandbox company shown in the ' +
            'OAuth 2.0 Playground, and that QBO_CLIENT_ID and QBO_CLIENT_SECRET are the ones ' +
            'from the Development tab rather than the Production tab.';
    return `The request to QuickBooks failed.\n\n${safe(error.message)}\n\n${cause}`;
  }
  if (error instanceof QboError) {
    return (
      `The QuickBooks adapter failed.\n\n${safe(error.message)}\n\n` +
      'What to do: report this to whoever maintains this repository.'
    );
  }
  return (
    'Something failed that this script does not recognise.\n\n' +
    `${safe(error instanceof Error ? (error.stack ?? error.message) : String(error))}\n\n` +
    'What to do: report this to whoever maintains this repository.'
  );
}

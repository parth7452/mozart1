import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { KmsTokenCipher, type TokenCipher } from '@recouple/crypto';
import {
  PORTAL_ENV,
  PORTAL_KEY_PATTERN,
  PORTAL_LIMITS,
  PORTAL_PARAM_KEY_PATTERN,
  PORTAL_READ_TOKEN_MIN_LENGTH,
  type PortalFailedReason,
  type PortalNeedsAttentionReason,
  type PortalRunEndRecord,
  type PortalRunParams,
  type PortalRunRecord,
} from '@recouple/portal';
import {
  PORTAL_READ_ERROR_CLASSES,
  PORTAL_READ_POLL,
  portalReadPollLimit,
} from '@recouple/pipeline';
import {
  PortalRunRecordRefusedError,
  PortalWriteRefusedError,
  PostgresPortalStore,
} from '@recouple/store-postgres';
import { env } from './env';
import { inngestClient, inngestKeysFromEnv } from './inngest';
import type { PortalReadRequest } from './inngest-portal';
import { QBO_TOKEN_KMS_KEY_ID } from './ledger-sync';
import type { Notice } from './notices';

/**
 * Settings → Portals (ADR 0057 §6, §7, §13; ADR 0062): what its routes and its
 * page share.
 *
 * Every write is a POST in Settings → Email's shape — `isCrossSite`,
 * `requireSession`, the owner check, `memberMayWrite` asked of the database,
 * then `PostgresPortalStore` as the signed-in member — and answers with a
 * redirect carrying a notice key, never a sentence. The database is the
 * referee: connections, credentials and reviews are an owner's, as the caller
 * (migration 0038), whatever this app shows or checks first.
 *
 * **The app seals and never opens** (ADR 0057 §7). The one cipher built here
 * is the portal KMS key's `seal_only` cipher: it holds no way to call
 * `kms:Decrypt`, and the key's policy gives the app's identity nothing else.
 * No `PORTAL_KMS_KEY_ID`, and a credential is not sealed at all: the form says
 * so and the route stores nothing.
 *
 * **A credential goes one place.** The username, the password and the setup
 * key exist in the credential route's request while they are sealed, and
 * nowhere else here: never in a log line, a redirect, an event, an audit
 * payload or an error this app shows. Logs carry ids, codes and class names.
 */

export const PORTAL_SETTINGS_PATH = '/settings/portals';

/** The query parameter a notice key travels in (`?portal=`). */
export const PORTAL_NOTICE_PARAM = 'portal';

/** Where one recipe version is reviewed. */
export function portalVersionPath(recipeVersionId: string): string {
  return `${PORTAL_SETTINGS_PATH}/versions/${recipeVersionId}`;
}

/**
 * What a review form says it was compared with when no version was promoted:
 * the review page's preview and the review route's check agree on it.
 */
export const COMPARED_WITH_NONE = 'none';

/**
 * Connecting a portal, changing its recipe or credential, and starting a run
 * are an owner's acts (ADR 0057 §7, §15). The database says so too.
 */
export function mayManagePortals(role: string): boolean {
  return role === 'owner';
}

export type EnvVars = Readonly<Record<string, string | undefined>>;

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

// ---------------------------------------------------------------------------
// Sealing (ADR 0057 §7)
// ---------------------------------------------------------------------------

/**
 * Whether this deployment can seal a portal credential, and with what.
 *
 * `scannerFromEnv`'s shape (ADR 0018): one answer, typed, and a deployment
 * that cannot say why in names — never values. One variable: the portal key,
 * `PORTAL_KMS_KEY_ID`, Production only. AWS credentials are the SDK's provider
 * chain's business, as for QuickBooks (`qboTokenCipherFromEnv`); a missing one
 * fails at the seal, before anything is written.
 *
 * The QuickBooks key is refused by name. The app's identity may decrypt under
 * that key — the ledger sync rotates tokens with it — so a portal credential
 * sealed there is one this app could open, which is exactly what the split
 * keys exist to prevent (ADR 0057 §7). An alias and an ARN for one key are
 * not caught here; the key policy and the worker's own key check are.
 */
export type PortalSealing =
  | { readonly kind: 'ready'; readonly cipher: TokenCipher }
  | { readonly kind: 'not_configured'; readonly reason: string };

export function portalSealingFromEnv(environment: EnvVars = process.env): PortalSealing {
  const keyId = nonEmpty(environment[PORTAL_ENV.kmsKeyId]);
  if (keyId === undefined) {
    return { kind: 'not_configured', reason: `${PORTAL_ENV.kmsKeyId} is not set` };
  }
  if (keyId === nonEmpty(environment[QBO_TOKEN_KMS_KEY_ID])) {
    return {
      kind: 'not_configured',
      reason:
        `${PORTAL_ENV.kmsKeyId} names the same key as ${QBO_TOKEN_KMS_KEY_ID}; ` +
        'a portal credential needs a key of its own',
    };
  }
  const region = nonEmpty(environment.AWS_REGION) ?? nonEmpty(environment.AWS_DEFAULT_REGION);
  return {
    kind: 'ready',
    cipher: KmsTokenCipher.forKey(keyId, {
      mode: 'seal_only',
      ...(region === undefined ? {} : { region }),
    }),
  };
}

/** The seal-only cipher, or nothing: `portalSealingFromEnv`'s answer, narrowed. */
export function portalCipherFromEnv(environment: EnvVars = process.env): TokenCipher | undefined {
  const sealing = portalSealingFromEnv(environment);
  return sealing.kind === 'ready' ? sealing.cipher : undefined;
}

/**
 * The store as one member of one tenant, as `app_rw` with their claims. Given
 * a cipher only where a credential is sealed; every other route and the page
 * build it with none, so they cannot seal anything.
 */
export function portalStoreFor(
  identity: { readonly orgId: string; readonly userId: string },
  cipher?: TokenCipher,
): PostgresPortalStore {
  return new PostgresPortalStore(
    { connectionString: env.databaseUrl },
    { orgId: identity.orgId, userId: identity.userId },
    cipher === undefined ? {} : { cipher },
  );
}

/**
 * What this deployment lacks for a run, by name and never by value: the
 * worker's two variables (ADR 0057 §6) and the job queue. For the page to say
 * before an owner presses anything; the job records `not_configured` whatever
 * this says.
 */
export function portalRunsMissingFromEnv(environment: EnvVars = process.env): readonly string[] {
  const missing: string[] = [];
  if (nonEmpty(environment[PORTAL_ENV.readUrl]) === undefined) missing.push(PORTAL_ENV.readUrl);
  const token = nonEmpty(environment[PORTAL_ENV.readToken]);
  if (token === undefined) {
    missing.push(PORTAL_ENV.readToken);
  } else if (token.length < PORTAL_READ_TOKEN_MIN_LENGTH) {
    missing.push(`${PORTAL_ENV.readToken} (at least ${PORTAL_READ_TOKEN_MIN_LENGTH} characters)`);
  }
  try {
    if (inngestKeysFromEnv(environment as NodeJS.ProcessEnv) === undefined) {
      missing.push('INNGEST_EVENT_KEY and INNGEST_SIGNING_KEY');
    }
  } catch {
    // One of the two without the other: `inngestKeysFromEnv` says so loudly
    // wherever a job is queued. Here it is only named.
    missing.push('INNGEST_EVENT_KEY and INNGEST_SIGNING_KEY (only one is set)');
  }
  return missing;
}

// ---------------------------------------------------------------------------
// What a person typed
// ---------------------------------------------------------------------------

/** A form field's text, or nothing: a file where text belongs is nothing. */
export function formText(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === 'string' ? value : undefined;
}

/**
 * A setup key as an authenticator app shows it, folded into the canonical
 * base32 it is sealed as (contracts.ts's `totpSecret` rule): spaces, hyphens
 * and trailing `=` padding go, and lower case is raised. Nothing else is
 * guessed at — a `0`, `1`, `8` or `9` is refused, not read as the letter it
 * might have been. `undefined` when it is not a key at all; the store's
 * schema then decides the rest (a whole encoding, 16 to 128 characters).
 *
 * The same rule as `canonicalTotpSecret` in `@recouple/portal`'s `totp.ts`,
 * which the package's index does not export.
 */
export function foldSetupKey(typed: string): string | undefined {
  const trimmed = typed.trim();
  if (!/^[A-Za-z2-7\s-]*=*$/.test(trimmed)) return undefined;
  const folded = trimmed.replace(/=+$/, '').replace(/[\s-]+/g, '').toUpperCase();
  return folded === '' ? undefined : folded;
}

/**
 * Whether a credential's label holds any part of the credential. The label is
 * stored and shown in the clear (ADR 0057 §7), so it may not contain the
 * username (the store refuses that too, without regard to case), the password
 * or the setup key, however the key's groups are spaced.
 */
export function labelHoldsSecret(
  label: string,
  secret: { readonly username: string; readonly password: string; readonly totpSecret?: string | undefined },
): boolean {
  if (secret.username !== '' && label.toLowerCase().includes(secret.username.toLowerCase())) {
    return true;
  }
  if (secret.password !== '' && label.includes(secret.password)) return true;
  if (secret.totpSecret !== undefined && secret.totpSecret !== '') {
    const folded = label.replace(/[\s-]+/g, '').toUpperCase();
    if (folded.includes(secret.totpSecret)) return true;
  }
  return false;
}

/**
 * A connection's run parameters (ADR 0057 §3), one `name=value` per line:
 * the name before the first `=`, trimmed, and the value after it, trimmed.
 * Blank lines are skipped. A line with no `=`, an empty or malformed name, an
 * empty value, a name given twice or more than the contract allows is
 * refused whole — a parameter is typed into the portal's forms, and one the
 * app guessed at is one it typed wrongly. The store's schema checks the rest.
 */
export function parseRunParams(text: string | undefined): PortalRunParams | undefined {
  if (text === undefined) return {};
  const entries: [string, string][] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const at = line.indexOf('=');
    if (at < 0) return undefined;
    const name = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (!PORTAL_PARAM_KEY_PATTERN.test(name) || seen.has(name)) return undefined;
    if (value === '' || value.length > PORTAL_LIMITS.paramValueMax) return undefined;
    seen.add(name);
    entries.push([name, value]);
  }
  if (entries.length > PORTAL_LIMITS.paramsMaxEntries) return undefined;
  // `fromEntries` defines own properties, so no name can reach a prototype.
  return Object.fromEntries(entries);
}

/** A recipe upload's ceiling: far past any real recipe, and well inside a run request (`PORTAL_RUN_REQUEST_MAX_BYTES`). */
export const RECIPE_MAX_BYTES = 128 * 1024;

// ---------------------------------------------------------------------------
// Notices: keys in the URL, words here
// ---------------------------------------------------------------------------

/**
 * Every sentence Settings → Portals will say back, and nothing else
 * (`lib/notices.ts`'s rule, in a table of its own so no other page can be
 * made to say these, nor this page theirs). An unknown key renders nothing,
 * and a fragment that is not its declared shape renders nothing.
 */
export const PORTAL_NOTICES = {
  // --- who may, and faults ---------------------------------------------------
  portal_role: {
    tone: 'bad',
    text: 'only an owner can add a portal connection, change its recipe or credential, or start a run',
  },
  portal_failed: {
    tone: 'bad',
    text: 'that did not go through, and nothing was changed. The reason is in this deployment’s logs.',
  },
  portal_unknown_connection: {
    tone: 'bad',
    text: 'that is not a portal connection of this workspace; nothing changed',
  },
  portal_unknown_version: {
    tone: 'bad',
    text: 'that is not a recipe version of this connection’s portal; nothing changed',
  },

  // --- connections -------------------------------------------------------------
  portal_connection_added: {
    tone: 'good',
    text:
      'the connection is added. Next: upload its recipe, review and promote it, then enter its ' +
      'credential. Nothing signs in to the portal until an owner starts a run.',
  },
  portal_connection_key_invalid: {
    tone: 'bad',
    text:
      'a portal key is lower-case letters, digits and underscores, starting with a letter; ' +
      'nothing was added',
  },
  portal_connection_label_invalid: {
    tone: 'bad',
    text: `a label is 1 to ${PORTAL_LIMITS.labelMax} characters, with no spaces at either end; nothing was added`,
  },
  portal_connection_account_invalid: {
    tone: 'bad',
    text:
      `an account id is 1 to ${PORTAL_LIMITS.accountIdMax} characters with at least one letter ` +
      'or digit, and no spaces at either end; nothing was added',
  },
  portal_connection_params_invalid: {
    tone: 'bad',
    text:
      `run parameters are one name=value per line, at most ${PORTAL_LIMITS.paramsMaxEntries}: a ` +
      'name starts with a letter and holds only letters, digits, dots, dashes and underscores, ' +
      `and a value is 1 to ${PORTAL_LIMITS.paramValueMax} characters; nothing was added`,
  },
  portal_account_here: {
    tone: 'bad',
    text: 'that portal account is already connected in this workspace; nothing was added',
  },
  portal_account_elsewhere: {
    tone: 'bad',
    text:
      'that portal account is connected in another workspace. It has to be turned off there ' +
      'first; nothing was added here.',
  },
  portal_turned_off: {
    tone: 'good',
    text: 'the connection is off. Nothing signs in to the portal until an owner turns it on.',
  },
  portal_already_off: { tone: 'good', text: 'that connection was already off; nothing changed' },
  portal_turned_on: {
    tone: 'good',
    text: 'the connection is on. Nothing signs in to the portal until a run is started.',
  },
  portal_already_on: { tone: 'good', text: 'that connection was already on; nothing changed' },
  portal_needs_credential_rejected: {
    tone: 'bad',
    text:
      'the portal refused this connection’s credential, so it stays off until the credential is ' +
      'entered again; nothing changed',
  },
  portal_needs_credential_removed: {
    tone: 'bad',
    text:
      'this connection’s credential was removed, so it stays off until one is entered again; ' +
      'nothing changed',
  },

  // --- recipe versions (ADR 0057 §3) -------------------------------------------
  portal_recipe_added: {
    tone: 'good',
    text:
      'version {1} of the {0} recipe is stored. Review it below: only a dry run runs a version ' +
      'nobody has promoted.',
  },
  portal_recipe_missing: {
    tone: 'bad',
    text: 'choose a recipe file, as JSON, to upload; nothing was stored',
  },
  portal_recipe_too_large: {
    tone: 'bad',
    text: `that recipe file is over ${RECIPE_MAX_BYTES / 1024} KB; nothing was stored`,
  },
  portal_recipe_not_json: {
    tone: 'bad',
    text: 'that file is not JSON text; nothing was stored',
  },
  portal_recipe_refused_at: {
    tone: 'bad',
    text: 'that recipe was refused at {0}, so nothing was stored',
  },
  portal_recipe_refused: {
    tone: 'bad',
    text: 'that recipe is not one this app can run, so nothing was stored',
  },
  portal_recipe_unbindable: {
    tone: 'bad',
    text:
      'that recipe’s sign-in origin or paths cannot be bound, so no credential could ever be ' +
      'sealed to it; nothing was stored',
  },
  portal_recipe_by_agent: {
    tone: 'bad',
    text:
      'that recipe says an agent session drafted it, and only a person’s recipe is uploaded ' +
      'here; nothing was stored',
  },
  portal_recipe_exists: {
    tone: 'bad',
    text:
      'version {1} of the {0} recipe already exists here. A changed portal is a new version ' +
      'number; nothing was stored.',
  },
  portal_recipe_other_portal: {
    tone: 'bad',
    text: 'that recipe is for another portal than this one; nothing was stored',
  },
  portal_version_promoted: {
    tone: 'good',
    text: 'version {1} of the {0} recipe is promoted, effective from {2}',
  },
  portal_version_rejected: {
    tone: 'good',
    text: 'version {1} of the {0} recipe is rejected, and is never promoted',
  },
  portal_version_reviewed_already: {
    tone: 'bad',
    text: 'that version already has its review, and a review is final; nothing changed',
  },
  portal_version_agent_additions: {
    tone: 'bad',
    text:
      'an agent session drafted that version and it adds a host, a POST-as-read entry or a ' +
      'floor-listed dismiss, so it can be rejected but never promoted; nothing changed',
  },
  portal_version_review_stale: {
    tone: 'bad',
    text:
      'the promoted version changed after this review was opened, so what this one adds may ' +
      'have changed too. Nothing was recorded; read it again.',
  },
  portal_verdict_invalid: {
    tone: 'bad',
    text: 'choose to promote or to reject the version; nothing was recorded',
  },

  // --- credentials (ADR 0057 §7, §8) -------------------------------------------
  portal_not_configured: {
    tone: 'bad',
    text: 'credentials cannot be sealed on this deployment, so nothing was stored',
  },
  portal_credential_stored: {
    tone: 'good',
    text:
      'the credential is sealed and stored. This app cannot open it: only the portal worker ' +
      'can, when a run starts.',
  },
  portal_credential_stored_off: {
    tone: 'good',
    text:
      'the credential is sealed and stored. The connection is off: turn it on before a run.',
  },
  portal_credential_username_invalid: {
    tone: 'bad',
    text:
      `a username is ${PORTAL_LIMITS.usernameMin} to ${PORTAL_LIMITS.usernameMax} characters, ` +
      'with no spaces at either end; nothing was stored',
  },
  portal_credential_password_invalid: {
    tone: 'bad',
    text: `enter the password, up to ${PORTAL_LIMITS.passwordMax.toLocaleString('en-US')} characters; nothing was stored`,
  },
  portal_credential_key_invalid: {
    tone: 'bad',
    text:
      `that setup key is not a whole base32 key of ${PORTAL_LIMITS.totpSecretMin} to ` +
      `${PORTAL_LIMITS.totpSecretMax} of the letters A–Z and digits 2–7 (spaces and hyphens ` +
      'between groups are fine); nothing was stored',
  },
  portal_credential_label_invalid: {
    tone: 'bad',
    text:
      `a credential’s label is 1 to ${PORTAL_LIMITS.labelMax} characters, with no spaces at ` +
      'either end; nothing was stored',
  },
  portal_credential_label_secret: {
    tone: 'bad',
    text:
      'a credential’s label is shown on this page, so it may not contain the username, the ' +
      'password or the setup key; nothing was stored',
  },
  portal_credential_no_version: {
    tone: 'bad',
    text:
      'choose a recipe version of this connection’s portal: a credential is sealed to where a ' +
      'version signs in. Nothing was stored.',
  },
  portal_credential_unbindable: {
    tone: 'bad',
    text: 'that version’s sign-in cannot be bound, so nothing was sealed or stored',
  },
  portal_credential_seal_failed: {
    tone: 'bad',
    text:
      'the credential could not be sealed, so nothing was stored. The reason is in this ' +
      'deployment’s logs.',
  },

  // --- runs (ADR 0057 §3, §13) ---------------------------------------------------
  portal_dry_run_queued: {
    tone: 'good',
    text:
      'the dry run is queued. It signs in for real; its outcome appears under the connection ' +
      'within a few minutes.',
  },
  portal_dry_run_no_queue: {
    tone: 'bad',
    text: 'this deployment has no job queue, so nothing was started',
  },
  portal_dry_run_not_queued: {
    tone: 'bad',
    text: 'the dry run could not be queued, so nothing was started. Try again shortly.',
  },
  portal_dry_run_off: {
    tone: 'bad',
    text: 'the connection is off: turn it on before a dry run. Nothing was started.',
  },
  portal_dry_run_no_credential: {
    tone: 'bad',
    text: 'enter a credential before a dry run. Nothing was started.',
  },
  portal_dry_run_rejected: {
    tone: 'bad',
    text: 'that version was rejected, so nothing runs it. Nothing was started.',
  },
  portal_dry_run_binding: {
    tone: 'bad',
    text:
      'the credential was sealed for another sign-in than that version’s, so it would not open. ' +
      'Enter the credential again for that version; nothing was started.',
  },
  portal_dry_run_in_flight: {
    tone: 'bad',
    text:
      'a run of this connection started at {0} UTC and has not finished, so nothing was ' +
      'started. Each run is a real sign-in.',
  },
  // `satisfies`, so a route naming a notice this table lacks fails to compile.
} as const satisfies Readonly<Record<string, Notice>>;

export type PortalNoticeKey = keyof typeof PORTAL_NOTICES;

const PORTAL_KEY_FRAGMENT = PORTAL_KEY_PATTERN;
const VERSION_NUMBER = /^[1-9][0-9]{0,9}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UTC_MINUTE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
/**
 * Where a recipe was refused, as a schema path: names and indices joined by
 * dots and nothing else, so a key the recipe's author made up that is not a
 * plain name never reaches the page — the wordless twin is said instead.
 */
const ISSUE_PATH = /^[A-Za-z][A-Za-z0-9_]{0,40}(\.[A-Za-z0-9_]{1,40}){0,7}$/;

const PORTAL_NOTICE_ABOUT: Readonly<Partial<Record<PortalNoticeKey, readonly RegExp[]>>> = {
  portal_recipe_added: [PORTAL_KEY_FRAGMENT, VERSION_NUMBER],
  portal_recipe_refused_at: [ISSUE_PATH],
  portal_recipe_exists: [PORTAL_KEY_FRAGMENT, VERSION_NUMBER],
  portal_version_promoted: [PORTAL_KEY_FRAGMENT, VERSION_NUMBER, ISO_DATE],
  portal_version_rejected: [PORTAL_KEY_FRAGMENT, VERSION_NUMBER],
  portal_dry_run_in_flight: [UTC_MINUTE],
};

/**
 * The notice a key and its fragments mean, or nothing at all: for an unknown
 * key, the wrong number of fragments, or a fragment that is not its shape.
 */
export function resolvePortalNotice(
  key: unknown,
  about: readonly string[] = [],
): Notice | undefined {
  if (typeof key !== 'string') return undefined;
  // `Object.hasOwn`, not `in`: `constructor` and `toString` are not notices.
  if (!Object.hasOwn(PORTAL_NOTICES, key)) return undefined;
  const copy: Notice = PORTAL_NOTICES[key as PortalNoticeKey];
  const patterns = PORTAL_NOTICE_ABOUT[key as PortalNoticeKey] ?? [];
  if (about.length !== patterns.length) return undefined;
  for (const [index, pattern] of patterns.entries()) {
    if (!pattern.test(about[index] as string)) return undefined;
  }
  // One pass, after every fragment was checked, so no fragment can introduce
  // a later placeholder.
  const text = copy.text.replace(/\{(\d)\}/g, (_, index: string) => about[Number(index)] as string);
  return { text, tone: copy.tone };
}

/** The notice's fragments as a route may send them: the key's own shape, or none. */
export function portalNoticeFits(key: PortalNoticeKey, about: readonly string[]): boolean {
  return resolvePortalNotice(key, about) !== undefined;
}

/** Back to a Settings → Portals page with a notice key and its fragments: a 303, so a refresh repeats nothing. */
export function portalRedirect(
  request: Request,
  path: string,
  notice: PortalNoticeKey,
  about: readonly string[] = [],
): NextResponse {
  const url = new URL(path, request.url);
  url.searchParams.set(PORTAL_NOTICE_PARAM, notice);
  for (const fragment of about) url.searchParams.append('about', fragment);
  return NextResponse.redirect(url, { status: 303 });
}

/** An error's class name, which is all a log line here repeats of it. */
export const className = (error: unknown): string =>
  error instanceof Error ? error.name || error.constructor.name : typeof error;

/**
 * An error for a log line: its class name, and for a refusal the database
 * named, its SQLSTATE and constraint — both names, never a value. Never the
 * message: a driver's can quote a row, and a vendor's can name a key.
 */
export function errorForLog(error: unknown): string {
  const name = className(error);
  if (error instanceof PortalWriteRefusedError || error instanceof PortalRunRecordRefusedError) {
    return `${name} ${error.sqlState}${error.constraint === undefined ? '' : ` ${error.constraint}`}`;
  }
  return name;
}

/** Whether `error` is an `Error` whose literal name is `name`: for a package's refusal the web app does not construct. */
export function isNamed(error: unknown, name: string): boolean {
  return error instanceof Error && error.name === name;
}

/**
 * The request's form, or nothing when its body is not one: logged by class
 * name, and the route answers with a notice rather than a 500.
 */
export async function portalForm(
  request: Request,
  what: string,
  orgId: string,
): Promise<FormData | undefined> {
  try {
    return await request.formData();
  } catch (error) {
    console.error(
      `[recouple] portal ${what}: the form could not be read for org ${orgId} (${className(error)})`,
    );
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Starting a dry run (ADR 0057 §3, §13)
// ---------------------------------------------------------------------------

/**
 * One run of a connection's recipe wants starting: the portal job's event,
 * named once, here, and read by `parsePortalReadRequested` in
 * `./inngest-portal`.
 */
export const PORTAL_READ_REQUESTED = 'portal/read.requested';

/**
 * What a dry run's event carries: the job's own `PortalReadRequest`, narrowed
 * to what Settings sends — ids, one key, a dry run, and the version the owner
 * named. Never a credential, a recipe or a page: the queue is a third party and
 * its payload is durable there (ADR 0021). `userId` is the connection's
 * `created_by`, the member every run acts as, never whoever pressed; `runKey`
 * is fresh per press, so a redelivery is one run and a second press a second.
 *
 * A type-only import: `./inngest-portal` imports this module when it loads, so
 * a value imported back would be read before it was set.
 */
export interface PortalReadRequestedData extends PortalReadRequest {
  readonly dryRun: true;
  readonly recipeVersionId: string;
}

export function portalReadRequestedEvent(data: PortalReadRequestedData): {
  name: string;
  data: PortalReadRequest;
} {
  return { name: PORTAL_READ_REQUESTED, data };
}

/**
 * Queues a dry run, and says what happened as a notice key. With no Inngest
 * keys there is no queue at all, which is said rather than a run promised;
 * half the keys, or a queue that refused the event, is logged by class name
 * and said as not started. Never throws: a press that did not queue must say
 * so, and nothing was changed that would need undoing.
 */
export async function queuePortalDryRun(input: {
  readonly connectionId: string;
  readonly orgId: string;
  readonly actingAs: string;
  readonly recipeVersionId: string;
  /** The owner who pressed, for the log line; the run acts as `actingAs`. */
  readonly pressedBy: string;
}): Promise<Extract<PortalNoticeKey, 'portal_dry_run_queued' | 'portal_dry_run_no_queue' | 'portal_dry_run_not_queued'>> {
  const where =
    `connection ${input.connectionId} version ${input.recipeVersionId} org ${input.orgId}`;
  let keys: ReturnType<typeof inngestKeysFromEnv>;
  try {
    keys = inngestKeysFromEnv();
  } catch (error) {
    console.error(`[recouple] portal dry run not queued: ${where} (${className(error)})`);
    return 'portal_dry_run_not_queued';
  }
  if (keys === undefined) {
    console.error(`[recouple] portal dry run not queued: ${where} (no queue on this deployment)`);
    return 'portal_dry_run_no_queue';
  }
  const runKey = randomUUID();
  try {
    await inngestClient(keys).send(
      portalReadRequestedEvent({
        connectionId: input.connectionId,
        orgId: input.orgId,
        userId: input.actingAs,
        dryRun: true,
        recipeVersionId: input.recipeVersionId,
        runKey,
      }),
    );
  } catch (error) {
    console.error(`[recouple] portal dry run not queued: ${where} (${className(error)})`);
    return 'portal_dry_run_not_queued';
  }
  console.info(
    `[recouple] portal dry run queued: ${where} run key ${runKey} by ${input.pressedBy} ` +
      `acting as ${input.actingAs}`,
  );
  return 'portal_dry_run_queued';
}

// ---------------------------------------------------------------------------
// Runs, in words (ADR 0057 §13, ADR 0062 §5)
// ---------------------------------------------------------------------------

/** Past the job's own wait: a busy worker's retries, a minute and a half apart, and the queue. */
const RUN_QUEUE_MARGIN_MS = 10 * 60_000;

/**
 * How long a run may go without an outcome and still be said to be running,
 * and hold back a new dry run of its connection: as long as the portal job
 * waits for it — `portalReadPollLimit` polls for its recipe's own `maxRunMs`,
 * the job's own arithmetic — and ten minutes more. Past that the run is said
 * never to have finished. A run whose recipe cap is not known is given the
 * worker's ceiling, the longest any run can take.
 *
 * Never shorter than the job's wait, because the cost of saying too early
 * that a run is over is a second real sign-in on the portal account.
 */
export function runInFlightForMs(maxRunMs: number | undefined): number {
  const polls = portalReadPollLimit(maxRunMs ?? PORTAL_READ_POLL.workerCeilingMs);
  return PORTAL_READ_POLL.firstWaitMs + polls * PORTAL_READ_POLL.waitMs + RUN_QUEUE_MARGIN_MS;
}

/** `YYYY-MM-DD HH:MM`, UTC: when a run started or ended, to the minute. */
export function utcMinute(at: Date): string {
  return at.toISOString().slice(0, 16).replace('T', ' ');
}

/** A run with no outcome yet that started within `runInFlightForMs` of its recipe's cap. */
export function runInFlight(run: PortalRunRecord, now: Date, maxRunMs: number | undefined): boolean {
  return run.end === null && now.getTime() - run.startedAt.getTime() < runInFlightForMs(maxRunMs);
}

const NEEDS_ATTENTION_WORDS = {
  mfa_unanswerable:
    'The portal asked for a second factor the run cannot answer, no setup key is sealed with ' +
    'the credential, or the code page was not where the recipe says. The connection stays on. ' +
    'Sign in by hand once before the next run.',
  challenge:
    'The portal showed a challenge, such as a CAPTCHA, which a run never solves. Sign in by ' +
    'hand and look.',
  page_changed:
    'A page did not have what the recipe expects, so the run stopped. The portal may have ' +
    'changed; at sign-in it may be a password or code the portal refused without showing an ' +
    'error. The connection stays on. Sign in by hand before the next run: each wrong sign-in ' +
    'counts toward a lockout.',
  terms_prompt:
    'A notice or dialog asked the run to accept something. Accepting terms is a person’s to ' +
    'do: sign in by hand and look.',
  credential_rejected:
    'The portal refused the credential, so the connection is turned off until the credential is ' +
    'entered again, and the sign-in is never retried: the account cannot be locked out. Check ' +
    'the password by signing in by hand, enter the credential again, then turn the connection on.',
  session_expired:
    'After signing in, the portal sent the run back to its sign-in page. A run never signs in ' +
    'twice, so it stopped. The connection stays on.',
  account_mismatch:
    'The portal did not show this connection’s account id after sign-in, so nothing was ' +
    'captured. A wrong account id needs a new connection.',
  binding_mismatch:
    'The recipe version signs in somewhere the credential was not sealed for, so nothing was ' +
    'opened or typed. Enter the credential again for this version.',
  capture_refused:
    'A captured file was refused at the door and not stored. Fetch it from the portal by hand.',
} as const satisfies Record<PortalNeedsAttentionReason, string>;

/** The code refused rather than the password: the one reason whose words depend on where it stopped. */
const CODE_REJECTED_WORDS =
  'The portal refused the authenticator code; usually the setup key was saved or entered ' +
  'wrong. The connection is turned off until the credential is entered again, and the sign-in ' +
  'is never retried: check the setup key, enter the whole credential again, then turn the ' +
  'connection on.';

const FAILED_WORDS = {
  guard_refused: 'The browser was sent to a host or path the recipe does not list, and the run ended.',
  never_click:
    'The recipe tried to press a control on the never-click list, and the run ended.',
  file_input:
    'The recipe reached a form with a file input, which a run never fills, and the run ended.',
  cap_exceeded: 'The run reached its cap on pages, downloads or time.',
  sign_in_form_refused:
    'The sign-in page did not have exactly one bound form with one username box and one ' +
    'password box, so nothing was typed.',
  error: 'The run failed with an error.',
} as const satisfies Record<PortalFailedReason, string>;

type PortalReadErrorClass = (typeof PORTAL_READ_ERROR_CLASSES)[keyof typeof PORTAL_READ_ERROR_CLASSES];

/**
 * What each class name the portal job records means, keyed by the job's own
 * constants (`PORTAL_READ_ERROR_CLASSES`) so a renamed class is a compile
 * error here rather than a run said in the wrong words.
 */
const ERROR_CLASS_WORDS = {
  [PORTAL_READ_ERROR_CLASSES.connectionDisabled]:
    'The connection was off when the run started, so nothing was signed in to.',
  [PORTAL_READ_ERROR_CLASSES.memberMayNotWrite]:
    'The member it runs as may no longer add documents in this workspace, so nothing was ' +
    'signed in to. Add the connection again as a current owner.',
  [PORTAL_READ_ERROR_CLASSES.memberNotOwner]:
    'The member it runs as is no longer an owner here, so a refused sign-in could not turn the ' +
    'connection off, and nothing was signed in to. Add the connection again as a current owner.',
  [PORTAL_READ_ERROR_CLASSES.termsNotAllowing]:
    'The portal’s terms are not recorded as allowing a run, so nothing was signed in to.',
  [PORTAL_READ_ERROR_CLASSES.recipeRejected]: 'That version was rejected, so it was not run.',
  [PORTAL_READ_ERROR_CLASSES.workerNotConfigured]:
    'This deployment has no portal worker set up, so nothing was run.',
  [PORTAL_READ_ERROR_CLASSES.recipeNotConfigured]:
    'The portal has no promoted recipe version in effect, so nothing was run.',
  [PORTAL_READ_ERROR_CLASSES.credentialNotConfigured]:
    'No credential is stored for the connection, so nothing was run.',
  [PORTAL_READ_ERROR_CLASSES.runLost]:
    'The portal worker no longer held the run — it restarted, or forgot it — so how it ended ' +
    'is not known.',
  [PORTAL_READ_ERROR_CLASSES.runTimedOut]: 'The run did not finish within its time.',
  [PORTAL_READ_ERROR_CLASSES.workerBusy]:
    'The portal worker was busy with another run, so this one was not started.',
  [PORTAL_READ_ERROR_CLASSES.workerRefused]: 'The portal worker refused the request.',
  [PORTAL_READ_ERROR_CLASSES.workerUnavailable]: 'The portal worker could not be reached.',
  [PORTAL_READ_ERROR_CLASSES.workerContract]:
    'The portal worker answered in a way the job does not accept, so the run was stopped.',
  [PORTAL_READ_ERROR_CLASSES.captureIntegrity]:
    'A captured file was not the bytes the worker listed, so it was not stored.',
  [PORTAL_READ_ERROR_CLASSES.captureUnscanned]:
    'A captured file could not be scanned, so it was not stored.',
} as const satisfies Record<PortalReadErrorClass, string>;

/** A recorded class name's words, or the fallback: never the class name alone. */
function classWords(errorClass: string, fallback: string): string {
  const known = Object.hasOwn(ERROR_CLASS_WORDS, errorClass)
    ? ERROR_CLASS_WORDS[errorClass as PortalReadErrorClass]
    : fallback;
  return `${known} (${errorClass})`;
}

/** How a run is said: a short headline, a sentence, and a tone. Built only from codes, counts and class names. */
export interface RunWords {
  readonly headline: string;
  readonly sentence: string;
  readonly tone: 'good' | 'bad' | 'neutral';
}

/** A finished run in words, from its outcome row: the outcome, the reason and the class name, never anything a page said. */
export function runEndWords(end: PortalRunEndRecord, dryRun: boolean): RunWords {
  switch (end.outcome) {
    case 'completed': {
      const captured = dryRun
        ? 'As a dry run, it captured and stored nothing.'
        : `${end.counts.captures} captured: ${end.counts.newDocuments} new ` +
          `document${end.counts.newDocuments === 1 ? '' : 's'}, ${end.counts.deduplicated} ` +
          'already held.';
      return { headline: 'Completed', sentence: `Every step passed. ${captured}`, tone: 'good' };
    }
    case 'not_configured':
      return {
        headline: 'Not run',
        sentence: classWords(
          end.errorClass,
          'Something it needs is missing: the portal worker, a promoted recipe version or a ' +
            'credential.',
        ),
        tone: 'bad',
      };
    case 'refused':
      return {
        headline: 'Refused',
        sentence: classWords(
          end.errorClass,
          'Nothing was signed in to: the connection was off, the member it runs as may no ' +
            'longer add documents here, or the portal’s terms are not recorded as allowing a run.',
        ),
        tone: 'bad',
      };
    case 'needs_attention':
      return {
        headline: 'Needs a person',
        sentence:
          end.reason === 'credential_rejected' && end.atStep === 'answer_mfa'
            ? CODE_REJECTED_WORDS
            : NEEDS_ATTENTION_WORDS[end.reason],
        tone: 'bad',
      };
    case 'failed':
      return {
        headline: 'Failed',
        sentence:
          end.reason === 'error'
            ? classWords(end.errorClass, FAILED_WORDS.error)
            : FAILED_WORDS[end.reason],
        tone: 'bad',
      };
  }
}

/** Any run in words: its outcome, or that it is running or never finished. */
export function runWords(run: PortalRunRecord, now: Date, maxRunMs: number | undefined): RunWords {
  if (run.end !== null) return runEndWords(run.end, run.dryRun);
  if (runInFlight(run, now, maxRunMs)) {
    return {
      headline: 'Running',
      sentence: 'It has not recorded an outcome yet. Refresh in a minute.',
      tone: 'neutral',
    };
  }
  return {
    headline: 'Did not finish',
    sentence:
      'It started and never recorded an outcome, so the job running it was stopped. Tell ' +
      'whoever runs this deployment; nothing on any case changed.',
    tone: 'bad',
  };
}

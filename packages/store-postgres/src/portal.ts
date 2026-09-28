/**
 * `PostgresPortalStore`: the `PortalStore` port (`@recouple/portal`'s
 * `contracts.ts`) on Postgres, over migration 0038 (ADR 0057 §6, §7, §13, §15;
 * ADR 0062).
 *
 * Everything runs as `app_rw` with one member's claims set transaction-locally
 * (`withTenant`, the shape every store here repeats rather than reaches into),
 * and the database is the referee of who may do what: an owner writes
 * connections, credentials and reviews; a writer adds a person's recipe
 * version; every author column is the caller; the two run tables are written
 * only through their definer functions; and every append-only table refuses an
 * UPDATE whoever asks. What this file adds is what only code can do before the
 * database is asked: refusing by name rather than by SQLSTATE, sealing a
 * credential before anything is written, counting what a recipe version adds,
 * and keeping every value that could be a credential out of every error, audit
 * payload and log line. The service role appears nowhere.
 *
 * **The app seals and never opens** (ADR 0057 §7). `sealAndStoreCredential`
 * reads the named recipe version as the database holds it, takes its binding
 * from `bindingOf` (the one computation of a binding) and seals the payload
 * under `portalCredentialContext` before anything is written, so a KMS failure
 * writes nothing. Nothing here calls `decrypt`: the app's cipher is seal-only,
 * and only the worker holds `kms:Decrypt`.
 *
 * **A refused sign-in turns the connection off, and a re-entry since is never
 * undone** (ADR 0057 §8, ADR 0046's rule). The disable locks the connection
 * row `FOR UPDATE`, which conflicts with the `FOR KEY SHARE` a credential
 * insert's foreign key takes, so a disable and a credential stored at the same
 * moment are serialised, and the disable compares the credential the portal
 * refused with the latest only once it holds the row. A refused or removed
 * credential is a hold on the connection, recorded in the disable's audit row
 * even when the connection was already off (an owner turned it off while a
 * run was in flight), and the connection is turned on again only while no
 * hold names its current credential. Every disable row is asked, not only the
 * latest, so a row can add a hold and never lift one; only a newer credential
 * does ("disabled until an owner replaces the credential"). So an enable
 * cannot send a known-bad password back to the portal and lock the dedicated
 * user out. The rule is this store's, not 0038's: the database lets an owner
 * flip `enabled` by any path, so every path that turns a connection on is
 * `enableConnection`.
 *
 * Refusals are named (`PortalStoreError` and its subclasses) and carry ids,
 * codes (a portal key, a version number), field names, rules and SQLSTATEs:
 * never a credential, a label, an account id, a parameter or page text, and
 * never a driver error's message or `detail` about a row, which can quote it.
 */

import type { Pool, PoolClient } from 'pg';
import type { TokenCipher } from '@recouple/crypto';
import type { RejectionCode } from '@recouple/ingest';
import {
  NEVER_CLICK_FLOOR,
  NewPortalConnectionSchema,
  PORTAL_AUDIT_ACTIONS,
  PORTAL_CAPTURE_KINDS,
  PORTAL_CONSTRAINTS,
  PORTAL_DISABLE_REASONS,
  PORTAL_FAILED_REASONS,
  PORTAL_KEY_PATTERN,
  PORTAL_LIMITS,
  PORTAL_NEEDS_ATTENTION_REASONS,
  PORTAL_REVIEW_VERDICTS,
  PORTAL_RUN_OUTCOMES,
  PortalBindingSchema,
  PortalCredentialPayloadSchema,
  PortalRunParamsSchema,
  SealedPortalCredentialSchema,
  bindingOf,
  matchesNeverClick,
  parseRecipe,
  portalCredentialContext,
  type CaptureKind,
  type DisablePortalConnectionInput,
  type NewPortalConnection,
  type NewPortalCredential,
  type NewPortalRecipeVersion,
  type PortalBinding,
  type PortalCaptureInput,
  type PortalConnectionRecord,
  type PortalConnectionToRead,
  type PortalCredentialPayload,
  type PortalCredentialRecord,
  type PortalDisableOutcome,
  type PortalDisableReason,
  type PortalEnableOutcome,
  type PortalFailedReason,
  type PortalNeedsAttentionReason,
  type PortalRecipeAddition,
  type PortalRecipeReviewInput,
  type PortalRecipeReviewRecord,
  type PortalRecipeVersionRecord,
  type PortalRunEndInput,
  type PortalRunEndRecord,
  type PortalRunOutcome,
  type PortalRunRecord,
  type PortalRunStartInput,
  type PortalStore,
  type RecipeStep,
  type RecipeVersion,
  type RunStepLogEntry,
  type SealedPortalCredential,
} from '@recouple/portal';
import { sessionPool, type PostgresStoreConfig, type TenantContext } from './store';

/** How many runs `listRuns` returns when asked for no number, and the most it returns. */
export const PORTAL_RUNS_DEFAULT = 20;
export const PORTAL_RUNS_MAX = 100;

// ---------------------------------------------------------------------------
// Refusals, by name
// ---------------------------------------------------------------------------

/** Base class, so a route or a job can catch every refusal of this store in one place. */
export class PortalStoreError extends Error {
  constructor(message: string) {
    super(message);
    // Each subclass also names itself with a literal: a bundler that minifies
    // class names would otherwise turn a refusal a page acts on into noise.
    this.name = new.target.name;
  }
}

/** One field a caller gave and the rule it broke. Never the value. */
export interface PortalInputIssue {
  readonly field: string;
  readonly rule: string;
}

/**
 * An input this store will not send to the database. It names the field and
 * the rule, never the value, as the contract's schemas do. A credential
 * payload's refusal names the rule by its code only, so not even a schema's
 * own wording about the value leaves this file.
 */
export class PortalInputError extends PortalStoreError {
  override readonly name = 'PortalInputError';
  constructor(readonly issues: readonly PortalInputIssue[]) {
    super(`portal store input refused: ${issues.map((i) => `${i.field}: ${i.rule}`).join('; ')}`);
  }
}

/**
 * The store was asked to act for a member or an org other than the one whose
 * claims it holds. A programming error, said so rather than answered: the
 * database reads the claims, so an answer about anybody else would be an
 * answer to a different question.
 */
export class PortalActorMismatchError extends PortalStoreError {
  override readonly name = 'PortalActorMismatchError';
  constructor(
    readonly field: string,
    readonly storeOrgId: string,
    readonly storeUserId: string,
  ) {
    super(
      `${field} is not this store's: it acts as user ${storeUserId} of org ${storeOrgId}, ` +
        'and a portal store answers and writes for that member only',
    );
  }
}

/**
 * Connecting a portal, storing its credential, reviewing a recipe version and
 * turning a connection on or off are an owner's acts (ADR 0057 §7, §15).
 */
export class PortalOwnerRequiredError extends PortalStoreError {
  override readonly name = 'PortalOwnerRequiredError';
  constructor(
    readonly orgId: string,
    readonly userId: string,
  ) {
    super(
      `user ${userId} is not an owner of org ${orgId}; only an owner connects a portal, ` +
        'stores its credential, reviews a recipe version or turns a connection on or off ' +
        '(ADR 0057 §15)',
    );
  }
}

/** A person's recipe version is added by a writer; a `read_only` member adds none. */
export class PortalWriterRequiredError extends PortalStoreError {
  override readonly name = 'PortalWriterRequiredError';
  constructor(
    readonly orgId: string,
    readonly userId: string,
  ) {
    super(`user ${userId} may not write in org ${orgId}, so adds no portal recipe version`);
  }
}

/** A connection this tenant cannot see, where the port has no `undefined` to answer with. */
export class PortalConnectionNotFoundError extends PortalStoreError {
  override readonly name = 'PortalConnectionNotFoundError';
  constructor(readonly connectionId: string) {
    super(`portal connection ${connectionId} is not this tenant's`);
  }
}

/** A recipe version this tenant cannot see, where the port has no `undefined` to answer with. */
export class PortalRecipeVersionNotFoundError extends PortalStoreError {
  override readonly name = 'PortalRecipeVersionNotFoundError';
  constructor(readonly recipeVersionId: string) {
    super(`portal recipe version ${recipeVersionId} is not this tenant's`);
  }
}

/** A credential is sealed only to a version of its connection's own portal. */
export class PortalRecipeVersionPortalMismatchError extends PortalStoreError {
  override readonly name = 'PortalRecipeVersionPortalMismatchError';
  constructor(
    readonly recipeVersionId: string,
    readonly connectionId: string,
  ) {
    super(
      `portal recipe version ${recipeVersionId} is for another portal than connection ` +
        `${connectionId}; a credential is sealed only to its own portal's binding`,
    );
  }
}

/** This workspace already holds this portal account enabled, as the connection named. */
export class PortalAccountAlreadyConnectedError extends PortalStoreError {
  override readonly name = 'PortalAccountAlreadyConnectedError';
  constructor(
    readonly portalKey: string,
    readonly connectionId: string,
  ) {
    super(`this ${portalKey} account is already connected here, as connection ${connectionId}`);
  }
}

/**
 * Another workspace holds this portal account enabled (ADR 0057 §13, one per
 * account across the deployment). Says that much and nothing about which.
 */
export class PortalAccountConnectedElsewhereError extends PortalStoreError {
  override readonly name = 'PortalAccountConnectedElsewhereError';
  constructor(readonly portalKey: string) {
    super(
      `this ${portalKey} account is already connected in another workspace; ` +
        'that workspace has to turn its connection off first',
    );
  }
}

/**
 * A portal's version numbers are unique per tenant: a changed portal is a new
 * version, never an edit (ADR 0057 §3).
 */
export class PortalRecipeVersionExistsError extends PortalStoreError {
  override readonly name = 'PortalRecipeVersionExistsError';
  constructor(
    readonly portalKey: string,
    readonly version: number,
  ) {
    super(
      `version ${version} of the ${portalKey} recipe already exists here; ` +
        'a changed portal is a new version',
    );
  }
}

/**
 * Who drafted a version is on its row and in its recipe, and the two must agree
 * (ADR 0057 §3, §5).
 */
export class PortalRecipeProvenanceError extends PortalStoreError {
  override readonly name = 'PortalRecipeProvenanceError';
  constructor(readonly rule: string) {
    super(`portal recipe version refused: ${rule}`);
  }
}

/** One verdict per version, and it is final. */
export class PortalRecipeAlreadyReviewedError extends PortalStoreError {
  override readonly name = 'PortalRecipeAlreadyReviewedError';
  constructor(readonly recipeVersionId: string) {
    super(`portal recipe version ${recipeVersionId} already has its one review`);
  }
}

/**
 * An agent session's draft that adds a host, a POST-as-read entry or a
 * floor-listed `dismiss` beyond the promoted version is never promoted: only a
 * person's version may add one (ADR 0057 §3). It may still be rejected.
 */
export class PortalAgentDraftAdditionsError extends PortalStoreError {
  override readonly name = 'PortalAgentDraftAdditionsError';
  constructor(
    readonly recipeVersionId: string,
    readonly additionCount: number,
  ) {
    super(
      `portal recipe version ${recipeVersionId} was drafted by an agent session and adds ` +
        `${additionCount} ${additionCount === 1 ? 'entry' : 'entries'} beyond the promoted ` +
        'version; only a person-authored version may add a host, a POST-as-read entry or a ' +
        'floor-listed dismiss',
    );
  }
}

/** A credential's label names it for a person and never contains its username (ADR 0057 §7). */
export class PortalCredentialLabelError extends PortalStoreError {
  override readonly name = 'PortalCredentialLabelError';
  constructor() {
    super(
      'a portal credential label may not contain its username; it is stored and shown in the clear',
    );
  }
}

/**
 * The store was built with no cipher, so it seals nothing. The portal job
 * never seals, and is built this way on purpose; Settings → Portals is given
 * the portal KMS key's seal-only cipher.
 */
export class PortalSealingNotConfiguredError extends PortalStoreError {
  override readonly name = 'PortalSealingNotConfiguredError';
  constructor() {
    super('this portal store has no cipher, so it cannot seal a credential');
  }
}

/** A `credential_rejected` disable named a credential that is not one of this connection's. */
export class PortalCredentialNotFoundError extends PortalStoreError {
  override readonly name = 'PortalCredentialNotFoundError';
  constructor(
    readonly connectionId: string,
    readonly credentialId: string,
  ) {
    super(`portal credential ${credentialId} is not one of connection ${connectionId}'s`);
  }
}

/**
 * The connection is off because the portal refused its credential, or an owner
 * removed it, and no newer credential has been stored since: turning it on
 * would type the refused password again (ADR 0057 §8).
 */
export class PortalCredentialReplacementRequiredError extends PortalStoreError {
  override readonly name = 'PortalCredentialReplacementRequiredError';
  constructor(
    readonly connectionId: string,
    readonly disabledFor: 'credential_rejected' | 'credential_removed',
  ) {
    super(
      `portal connection ${connectionId} was turned off for ${disabledFor}; an owner enters the ` +
        'credential again before it is turned back on',
    );
  }
}

/**
 * The database refused a run's start, outcome or capture row. It names the
 * run, the SQLSTATE, the constraint when there is one, and the refusal's own
 * words when they are migration 0038's (which carry ids only); never a
 * driver error's `detail`, which quotes the row.
 */
export class PortalRunRecordRefusedError extends PortalStoreError {
  override readonly name = 'PortalRunRecordRefusedError';
  constructor(
    readonly record: 'start' | 'outcome' | 'capture',
    readonly runId: string,
    readonly sqlState: string,
    readonly constraint: string | undefined,
    readonly refusal: string | undefined,
  ) {
    super(
      `the database refused run ${runId}'s ${record} row (SQLSTATE ${sqlState}` +
        `${constraint !== undefined ? `, ${constraint}` : ''})` +
        `${refusal !== undefined ? `: ${refusal}` : ''}`,
    );
  }
}

/**
 * The database refused any other write here: the table, the SQLSTATE, the
 * constraint when there is one, and the refusal's own words when they are
 * migration 0038's. Never the driver error itself, whose `detail` quotes the
 * row — for a credential, its sealed fields.
 */
export class PortalWriteRefusedError extends PortalStoreError {
  override readonly name = 'PortalWriteRefusedError';
  constructor(
    readonly table: string,
    readonly sqlState: string,
    readonly constraint: string | undefined,
    readonly refusal: string | undefined,
  ) {
    super(
      `the database refused a write to ${table} (SQLSTATE ${sqlState}` +
        `${constraint !== undefined ? `, ${constraint}` : ''})` +
        `${refusal !== undefined ? `: ${refusal}` : ''}`,
    );
  }
}

/**
 * A row the database holds that this build cannot read. Named by table, id and
 * field, never by value.
 */
export class PortalStoredDataError extends PortalStoreError {
  override readonly name = 'PortalStoredDataError';
  constructor(
    readonly table: string,
    readonly id: string,
    readonly field: string,
  ) {
    super(`${table} row ${id} holds a ${field} this build cannot read`);
  }
}

// ---------------------------------------------------------------------------
// What a recipe version adds (ADR 0057 §3)
// ---------------------------------------------------------------------------

/**
 * What `version` adds beyond `comparedWith`, the promoted version in effect it
 * is reviewed against (none for a portal's first, when everything counts):
 *
 *  - each host on its allowlist that is not on the other's, compared lower-case
 *    and reported lower-case, once;
 *  - each POST-as-read entry the other does not have, step, path and body
 *    discriminator alike;
 *  - each `dismiss` step whose control is on the never-click floor
 *    (`NEVER_CLICK_FLOOR`) and that the other does not carry exactly — the same
 *    name, selector, label and container text, since a changed container is a
 *    new thing for a reviewer to read.
 *
 * Pure, so the review screen can show exactly what a review row will name, and
 * in the version's own order, so the same two versions always give the same
 * list. The database repeats the one rule that matters most — an agent
 * session's draft with any of these is never promoted — as the floor under it.
 */
export function recipeAdditions(
  version: RecipeVersion,
  comparedWith: RecipeVersion | undefined,
): PortalRecipeAddition[] {
  const additions: PortalRecipeAddition[] = [];

  const knownHosts = new Set((comparedWith?.hostAllowlist ?? []).map((host) => host.toLowerCase()));
  for (const listed of version.hostAllowlist) {
    const host = listed.toLowerCase();
    if (knownHosts.has(host)) continue;
    knownHosts.add(host);
    additions.push({ kind: 'host', host });
  }

  const postKey = (entry: RecipeVersion['postAsRead'][number]): string =>
    JSON.stringify([
      entry.step,
      entry.path,
      entry.bodyDiscriminator?.field ?? null,
      entry.bodyDiscriminator?.equals ?? null,
    ]);
  const knownPosts = new Set((comparedWith?.postAsRead ?? []).map(postKey));
  for (const entry of version.postAsRead) {
    const key = postKey(entry);
    if (knownPosts.has(key)) continue;
    knownPosts.add(key);
    additions.push({
      kind: 'post_as_read',
      step: entry.step,
      path: entry.path,
      bodyDiscriminator:
        entry.bodyDiscriminator === undefined
          ? null
          : { field: entry.bodyDiscriminator.field, equals: entry.bodyDiscriminator.equals },
    });
  }

  const floorDismisses = (steps: readonly RecipeStep[]) =>
    everyStep(steps).filter(
      (step): step is Extract<RecipeStep, { kind: 'dismiss' }> =>
        step.kind === 'dismiss' && matchesNeverClick(step.label, NEVER_CLICK_FLOOR),
    );
  const dismissKey = (step: Extract<RecipeStep, { kind: 'dismiss' }>): string =>
    JSON.stringify([step.name, step.selector, step.label, step.containerText]);
  const knownDismisses = new Set(floorDismisses(comparedWith?.steps ?? []).map(dismissKey));
  for (const step of floorDismisses(version.steps)) {
    const key = dismissKey(step);
    if (knownDismisses.has(key)) continue;
    knownDismisses.add(key);
    additions.push({ kind: 'dismiss', step: step.name, label: step.label });
  }

  return additions;
}

/** A recipe's steps, those inside `for_each` included, in the order they are written. */
function everyStep(steps: readonly RecipeStep[]): RecipeStep[] {
  return steps.flatMap((step) =>
    step.kind === 'for_each' ? [step, ...everyStep(step.steps)] : [step],
  );
}

// ---------------------------------------------------------------------------
// The fan-out, which has no tenant
// ---------------------------------------------------------------------------

/**
 * Every enabled portal connection across every org, as ids and a portal key,
 * through `app.portal_connections_to_read()` (ADR 0057 §13).
 *
 * No `TenantContext`, because there is no tenant yet: this is the query that
 * decides which tenants the fan-out adopts. It runs as `app_rw` like
 * everything else, with the claims cleared rather than assumed, because the
 * function refuses any caller carrying an org or a subject (migration 0033's
 * rule). Never the service role.
 */
export async function listPortalConnectionsToRead(
  config: PostgresStoreConfig,
): Promise<readonly PortalConnectionToRead[]> {
  const client = await sessionPool(config).connect();
  try {
    await client.query('begin');
    await client.query(`set local role ${config.role ?? 'app_rw'}`);
    await client.query(`select set_config('request.jwt.claims', '', true)`);
    const { rows } = await client.query<{
      connection_id: string;
      org_id: string;
      portal_key: string;
      created_by: string;
    }>(
      'select connection_id, org_id, portal_key, created_by from app.portal_connections_to_read()',
    );
    await client.query('commit');
    return rows.map((row) => {
      if (!PORTAL_KEY_PATTERN.test(row.portal_key)) {
        throw new PortalStoredDataError('portal_connections', row.connection_id, 'portal_key');
      }
      return {
        connectionId: row.connection_id,
        orgId: row.org_id,
        portalKey: row.portal_key,
        createdBy: row.created_by,
      };
    });
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export interface PortalStoreOptions {
  /**
   * What seals a credential: in the app, the portal KMS key's `seal_only`
   * cipher (ADR 0057 §7), never the QuickBooks one. Absent — the portal job,
   * which never seals — and `sealAndStoreCredential` is refused by name before
   * anything is read. This store only ever calls `encrypt`.
   */
  readonly cipher?: TokenCipher;
}

/**
 * A recipe version as the store reads it: the version's own columns, and its one
 * review's when it has one.
 */
interface VersionRow {
  id: string;
  org_id: string;
  portal_key: string;
  version: number;
  effective_from: string;
  recipe: unknown;
  created_by: string;
  agent_session_id: string | null;
  created_at: Date;
  review_id: string | null;
  verdict: string | null;
  reviewer: string | null;
  compared_with_version_id: string | null;
  additions: unknown;
  reviewed_at: Date | null;
}

const VERSION_COLUMNS = `
  v.id, v.org_id, v.portal_key, v.version,
  to_char(v.effective_from, 'YYYY-MM-DD') as effective_from,
  v.recipe, v.created_by, v.agent_session_id, v.created_at,
  r.id as review_id, r.verdict, r.reviewer, r.compared_with_version_id, r.additions,
  r.created_at as reviewed_at`;

interface ConnectionRow {
  id: string;
  org_id: string;
  portal_key: string;
  label: string;
  account_id: string;
  params: unknown;
  enabled: boolean;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

const CONNECTION_COLUMNS = `
  c.id, c.org_id, c.portal_key, c.label, c.account_id, c.params, c.enabled, c.created_by,
  c.created_at, c.updated_at`;

interface CredentialRow {
  id: string;
  connection_id: string;
  label: string | null;
  cipher: string;
  key_id: string;
  wrapped_key: string;
  ciphertext: string;
  sign_in_origin: string;
  sign_in_paths: string[];
  hosts_hash: string;
  created_by: string;
  created_at: Date;
}

interface RunRow {
  run_id: string;
  connection_id: string;
  recipe_version_id: string | null;
  dry_run: boolean;
  requested_by: string;
  started_at: Date;
  outcome: string | null;
  reason: string | null;
  error_class: string | null;
  at_step: string | null;
  page_count: number | null;
  capture_count: number | null;
  new_document_count: number | null;
  deduplicated_count: number | null;
  refusal_count: number | null;
  step_log: unknown;
  finished_at: Date | null;
}

/**
 * The two reasons a connection stays off until a newer credential is stored
 * (ADR 0057 §7, §8): a hold, as `credentialHold` reads one back.
 */
const CREDENTIAL_DISABLES = [
  'credential_rejected',
  'credential_removed',
] as const satisfies readonly PortalDisableReason[];
type CredentialDisableReason = (typeof CREDENTIAL_DISABLES)[number];

export class PostgresPortalStore implements PortalStore {
  private readonly pool: Pool;
  private readonly role: string;
  private readonly cipher: TokenCipher | undefined;

  constructor(
    private readonly config: PostgresStoreConfig,
    private readonly tenant: TenantContext,
    options: PortalStoreOptions = {},
  ) {
    this.pool = sessionPool(config);
    this.role = config.role ?? 'app_rw';
    this.cipher = options.cipher;
  }

  /**
   * As `PostgresStore.withTenant`: the role and the claims are
   * transaction-local, so a pooled connection cannot carry one tenant's claims
   * into another's query. Repeated here rather than reached into, as every
   * store in this package repeats it.
   */
  private async withTenant<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`set local role ${this.role}`);
      await client.query('select set_config($1, $2, true)', [
        'request.jwt.claims',
        JSON.stringify({ org_id: this.tenant.orgId, sub: this.tenant.userId }),
      ]);
      const result = await work(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  // -------------------------------------------------------------------------
  // Who may
  // -------------------------------------------------------------------------

  /**
   * Whether this member may write in this org: `app.member_may_write()`, the
   * predicate every `tenant_insert` policy is gated on. Asked only about the
   * member this store acts as.
   */
  async memberMayWrite(actor: {
    readonly orgId: string;
    readonly userId: string;
  }): Promise<boolean> {
    if (actor.orgId !== this.tenant.orgId || actor.userId !== this.tenant.userId) {
      throw new PortalActorMismatchError('actor', this.tenant.orgId, this.tenant.userId);
    }
    return this.withTenant(async (client) => {
      const { rows } = await client.query<{ may: boolean | null }>(
        'select app.member_may_write() as may',
      );
      return rows[0]?.may === true;
    });
  }

  /**
   * Whether this member is an owner here: `app.member_is_owner()`, asked only
   * about the member this store acts as. Not in the port, and meant for the
   * job to ask beside `memberMayWrite` before a run: turning a connection off
   * when the portal refuses its credential is an owner's write (0038's UPDATE
   * policy), so a run acting as a member who is now only a writer could be
   * refused and then be unable to stop the next run from typing the same
   * password (ADR 0057 §8).
   */
  async memberIsOwner(actor: {
    readonly orgId: string;
    readonly userId: string;
  }): Promise<boolean> {
    if (actor.orgId !== this.tenant.orgId || actor.userId !== this.tenant.userId) {
      throw new PortalActorMismatchError('actor', this.tenant.orgId, this.tenant.userId);
    }
    return this.withTenant(async (client) => {
      const { rows } = await client.query<{ owner: boolean | null }>(
        'select app.member_is_owner() as owner',
      );
      return rows[0]?.owner === true;
    });
  }

  /**
   * Refuses a caller who is not an owner, by name, before the first write (the
   * policies would refuse too, as a bare 42501).
   */
  private async assertOwner(client: PoolClient): Promise<void> {
    const { rows } = await client.query<{ owner: boolean | null }>(
      'select app.member_is_owner() as owner',
    );
    if (rows[0]?.owner !== true) {
      throw new PortalOwnerRequiredError(this.tenant.orgId, this.tenant.userId);
    }
  }

  private async assertWriter(client: PoolClient): Promise<void> {
    const { rows } = await client.query<{ may: boolean | null }>(
      'select app.member_may_write() as may',
    );
    if (rows[0]?.may !== true) {
      throw new PortalWriterRequiredError(this.tenant.orgId, this.tenant.userId);
    }
  }

  // -------------------------------------------------------------------------
  // Connections (ADR 0057 §13)
  // -------------------------------------------------------------------------

  /**
   * Adds an enabled connection, as this member, an owner, with one audit row.
   *
   * One enabled connection per portal account across the deployment: the
   * database's partial unique index compares account ids folded to their
   * letters and digits, and its refusal is named here as held in this
   * workspace (with the connection that holds it) or elsewhere (with nothing
   * about where).
   */
  async createConnection(input: NewPortalConnection): Promise<string> {
    const parsed = NewPortalConnectionSchema.safeParse(input);
    if (!parsed.success) throw new PortalInputError(issuesOf(parsed.error.issues, 'message'));
    const connection = parsed.data;
    // Migration 0038 goes one step past the contract here: one-per-account
    // compares ids by their ASCII letters and digits, so an id with none would
    // equal every other id with none.
    if (!/[A-Za-z0-9]/.test(connection.accountId)) {
      refuse('accountId', 'at least one ASCII letter or digit');
    }

    return this.withTenant(async (client) => {
      await this.assertOwner(client);

      await client.query('savepoint portal_connection_insert');
      let connectionId: string;
      try {
        const { rows } = await client.query<{ id: string }>(
          `insert into portal_connections
             (org_id, portal_key, label, account_id, params, created_by)
           values ($1, $2, $3, $4, $5::jsonb, $6)
           returning id`,
          [
            this.tenant.orgId,
            connection.portalKey,
            connection.label,
            connection.accountId,
            JSON.stringify(connection.params),
            this.tenant.userId,
          ],
        );
        const id = rows[0]?.id;
        if (id === undefined) throw new Error('insert into portal_connections returned no row');
        connectionId = id;
        await client.query('release savepoint portal_connection_insert');
      } catch (error) {
        await client.query('rollback to savepoint portal_connection_insert');
        throw await this.connectionRefusal(
          client,
          error,
          connection.portalKey,
          connection.accountId,
        );
      }

      await this.audit(
        client,
        PORTAL_AUDIT_ACTIONS.connectionCreated,
        'portal_connections',
        connectionId,
        {
          portal_key: connection.portalKey,
        },
      );
      return connectionId;
    });
  }

  /** The tenant's connections, enabled or not, newest first. */
  async listConnections(): Promise<readonly PortalConnectionRecord[]> {
    return this.withTenant(async (client) => {
      const { rows } = await client.query<ConnectionRow>(
        `select ${CONNECTION_COLUMNS}
           from portal_connections c
          order by c.created_at desc, c.id desc`,
      );
      return rows.map(toConnection);
    });
  }

  /** One connection, or `undefined` when this tenant cannot see it: RLS, not a filter. */
  async connection(connectionId: string): Promise<PortalConnectionRecord | undefined> {
    const id = uuidOf(connectionId, 'connectionId');
    return this.withTenant(async (client) => {
      const { rows } = await client.query<ConnectionRow>(
        `select ${CONNECTION_COLUMNS} from portal_connections c where c.id = $1`,
        [id],
      );
      return rows[0] === undefined ? undefined : toConnection(rows[0]);
    });
  }

  /**
   * Turns a connection off, with one audit row naming why.
   *
   * `credential_rejected` is the job's, on the portal refusing the sign-in
   * (ADR 0057 §8). Under the connection's row lock it acts only while the
   * refused credential is still the latest: `newer_credential` means an owner
   * entered one since, and nothing is written, so that entry is never undone.
   * The other two reasons are an owner's; `credential_removed` names the
   * credential it removes, or none when none was ever stored.
   *
   * A refusal or a removal is a hold: it keeps the connection off until a
   * newer credential is stored (`enableConnection`). So it is recorded even on
   * a connection that is off already — an owner turned it off while a run was
   * in flight, and the run then met a refused sign-in — with `already_off:
   * true` in its audit row, because `enabled` did not flip, and the answer is
   * still `already_off`. Nothing is written when that very hold is recorded
   * already (the job's finish step replayed, a removal pressed twice), and a
   * `turned_off`, which holds nothing, writes nothing on a connection already
   * off. `undefined` when this tenant cannot see the connection.
   */
  async disableConnection(
    input: DisablePortalConnectionInput,
  ): Promise<PortalDisableOutcome | undefined> {
    const connectionId = uuidOf(input.connectionId, 'connectionId');
    const reason: unknown = input.reason;
    if (!isOneOf(PORTAL_DISABLE_REASONS, reason)) {
      refuse('reason', `one of ${PORTAL_DISABLE_REASONS.join(', ')}`);
    }
    const namedCredential: unknown = (input as { readonly credentialId?: unknown }).credentialId;
    let refusedCredentialId: string | undefined;
    if (reason === 'credential_rejected') {
      refusedCredentialId = uuidOf(namedCredential, 'credentialId');
    } else if (namedCredential !== undefined) {
      refuse(
        'credentialId',
        'only a credential_rejected disable names the credential the portal refused',
      );
    }

    return this.withTenant(async (client) => {
      const locked = await this.lockConnection(client, connectionId);
      if (locked === undefined) return undefined;

      const latest = await latestCredentialId(client, connectionId);
      if (refusedCredentialId !== undefined) {
        const { rows } = await client.query<{ id: string }>(
          `select id from portal_credentials where id = $1 and connection_id = $2`,
          [refusedCredentialId, connectionId],
        );
        if (rows[0] === undefined) {
          throw new PortalCredentialNotFoundError(connectionId, refusedCredentialId);
        }
        if (latest !== refusedCredentialId) return 'newer_credential';
      }
      // The credential this disable holds the connection off for: the one the
      // portal refused, or the one an owner removes (none, if none was ever
      // stored). A turn-off holds nothing.
      const credentialId =
        reason === 'credential_rejected'
          ? refusedCredentialId
          : reason === 'credential_removed'
            ? latest
            : undefined;
      const payload = {
        reason,
        ...(credentialId !== undefined ? { credential_id: credentialId } : {}),
      };

      if (!locked.enabled) {
        if (
          reason === 'turned_off' ||
          (await this.credentialHold(client, connectionId, credentialId, [reason])) !== undefined
        ) {
          return 'already_off';
        }
        await this.audit(
          client,
          PORTAL_AUDIT_ACTIONS.connectionDisabled,
          'portal_connections',
          connectionId,
          { ...payload, already_off: true },
        );
        return 'already_off';
      }

      let updated: { readonly rowCount: number | null };
      try {
        updated = await client.query(
          `update portal_connections set enabled = false where id = $1`,
          [connectionId],
        );
      } catch (error) {
        throw writeRefusal('portal_connections', error);
      }
      // The row is locked and this member is an owner, so anything but one row
      // is a policy that no longer reads as it did a statement ago.
      if (updated.rowCount !== 1) {
        throw new PortalOwnerRequiredError(this.tenant.orgId, this.tenant.userId);
      }
      await this.audit(
        client,
        PORTAL_AUDIT_ACTIONS.connectionDisabled,
        'portal_connections',
        connectionId,
        payload,
      );
      return 'disabled';
    });
  }

  /**
   * Turns a connection back on, as an owner, with one audit row. Storing a
   * credential does not.
   *
   * Refused (`PortalCredentialReplacementRequiredError`, naming the latest
   * hold's reason) while any `credential_rejected` or `credential_removed`
   * disable names the connection's current credential — or, while none has
   * ever been stored, a removal that named none: the refused password is never
   * typed into the portal again (ADR 0057 §8), and only a newer credential
   * lifts the hold. Every disable is asked, not only the latest, so a
   * `turned_off` recorded after a refusal does not hide it. One enabled
   * connection per account applies as it does to a new one. `undefined` when
   * this tenant cannot see the connection.
   */
  async enableConnection(connectionId: string): Promise<PortalEnableOutcome | undefined> {
    const id = uuidOf(connectionId, 'connectionId');
    return this.withTenant(async (client) => {
      const locked = await this.lockConnection(client, id);
      if (locked === undefined) return undefined;
      if (locked.enabled) return 'already_on';

      const latest = await latestCredentialId(client, id);
      const held = await this.credentialHold(client, id, latest, CREDENTIAL_DISABLES);
      if (held !== undefined) throw new PortalCredentialReplacementRequiredError(id, held);

      await client.query('savepoint portal_connection_enable');
      try {
        const updated = await client.query(
          `update portal_connections set enabled = true where id = $1`,
          [id],
        );
        if (updated.rowCount !== 1) {
          throw new PortalOwnerRequiredError(this.tenant.orgId, this.tenant.userId);
        }
        await client.query('release savepoint portal_connection_enable');
      } catch (error) {
        await client.query('rollback to savepoint portal_connection_enable');
        throw await this.connectionRefusal(client, error, locked.portalKey, locked.accountId);
      }

      await this.audit(client, PORTAL_AUDIT_ACTIONS.connectionEnabled, 'portal_connections', id, {
        ...(latest !== undefined ? { credential_id: latest } : {}),
      });
      return 'enabled';
    });
  }

  /**
   * The connection's row, visible and locked for an owner's change, or
   * `undefined` when this tenant cannot see it.
   *
   * `FOR UPDATE` and not the `FOR NO KEY UPDATE` a plain UPDATE takes: it is
   * the one row lock that conflicts with the `FOR KEY SHARE` a credential
   * insert's foreign key holds until it commits, so a change here and a
   * credential being stored are serialised, and whichever reads second reads
   * the other's row.
   */
  private async lockConnection(
    client: PoolClient,
    connectionId: string,
  ): Promise<
    | { readonly enabled: boolean; readonly portalKey: string; readonly accountId: string }
    | undefined
  > {
    const { rows: visible } = await client.query<{ id: string }>(
      `select id from portal_connections where id = $1`,
      [connectionId],
    );
    if (visible[0] === undefined) return undefined;
    // Before the lock, because a row lock reads through the UPDATE policy,
    // which shows a non-owner nothing: "not an owner" is not "not found".
    await this.assertOwner(client);
    const { rows } = await client.query<{
      enabled: boolean;
      portal_key: string;
      account_id: string;
    }>(`select enabled, portal_key, account_id from portal_connections where id = $1 for update`, [
      connectionId,
    ]);
    const row = rows[0];
    if (row === undefined) {
      throw new PortalOwnerRequiredError(this.tenant.orgId, this.tenant.userId);
    }
    return { enabled: row.enabled, portalKey: row.portal_key, accountId: row.account_id };
  }

  /**
   * The latest hold of `reasons` on the connection that names `credentialId`,
   * from the disables' audit rows: a `credential_rejected` or
   * `credential_removed` disable naming that credential, or, asked about
   * `undefined`, one that named none (a removal while none was stored).
   *
   * Every disable row is asked, not only the connection's latest, so a row
   * can add a hold and never lift one: a `turned_off` recorded after a refusal
   * does not hide it, whoever wrote it. A hold moves out of reach only because
   * it is asked about by the current credential's id, which only a newer
   * credential changes.
   */
  private async credentialHold(
    client: PoolClient,
    connectionId: string,
    credentialId: string | undefined,
    reasons: readonly CredentialDisableReason[],
  ): Promise<CredentialDisableReason | undefined> {
    const { rows } = await client.query<{ reason: string | null }>(
      `select a.payload->>'reason' as reason
         from audit_log a
        where a.org_id = $1
          and a.subject_table = 'portal_connections'
          and a.subject_id = $2
          and a.action = $3
          and a.payload->>'reason' = any($4::text[])
          and a.payload->>'credential_id' is not distinct from $5::text
        order by a.id desc
        limit 1`,
      [
        this.tenant.orgId,
        connectionId,
        PORTAL_AUDIT_ACTIONS.connectionDisabled,
        [...reasons],
        credentialId ?? null,
      ],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    if (!isOneOf(CREDENTIAL_DISABLES, row.reason)) {
      throw new PortalStoredDataError('audit_log', connectionId, 'disable reason');
    }
    return row.reason;
  }

  /**
   * A refused connection insert or enable, by name. The one-per-account index
   * is answered by looking, under a savepoint the caller has rolled back to:
   * held here names this workspace's connection, and anything else is
   * elsewhere. Any other failure is the original error.
   */
  private async connectionRefusal(
    client: PoolClient,
    error: unknown,
    portalKey: string,
    accountId: string,
  ): Promise<unknown> {
    if (isUniqueViolationOn(error, PORTAL_CONSTRAINTS.oneEnabledPerAccount)) {
      const { rows } = await client.query<{ id: string }>(
        `select id from portal_connections
          where enabled and portal_key = $1
            and lower(regexp_replace(account_id, '[^A-Za-z0-9]', '', 'g'))
                = lower(regexp_replace($2, '[^A-Za-z0-9]', '', 'g'))
          order by created_at, id
          limit 1`,
        [portalKey, accountId],
      );
      const here = rows[0]?.id;
      return here !== undefined
        ? new PortalAccountAlreadyConnectedError(portalKey, here)
        : new PortalAccountConnectedElsewhereError(portalKey);
    }
    if (sqlState(error) === '42501') {
      return new PortalOwnerRequiredError(this.tenant.orgId, this.tenant.userId);
    }
    return writeRefusal('portal_connections', error);
  }

  // -------------------------------------------------------------------------
  // Credentials (ADR 0057 §7)
  // -------------------------------------------------------------------------

  /**
   * Seals a credential to the binding of the named recipe version, as the
   * database holds it, and stores it as a new row; returns its id.
   *
   * Read → seal → write, in that order and never interleaved:
   *
   *  1. as an owner (refused by name before anything is read or sealed), the
   *     connection and the version, which must be of the connection's portal;
   *     the binding is `bindingOf` the stored recipe, never a request's fields;
   *  2. the payload sealed under `portalCredentialContext({org, connection},
   *     binding)`, with no transaction open, so a slow KMS holds no connection
   *     and a KMS failure writes nothing;
   *  3. one transaction: the row, whose policy asks again that the caller is an
   *     owner and is its `created_by`, and its audit row, ids only.
   *
   * The plaintext is an argument to `encrypt` and nothing else: a refusal names
   * fields and rules, never a value, and the label may not contain the
   * username. A version is immutable and a connection's portal is frozen, so
   * what step 1 read is what step 3 writes against.
   */
  async sealAndStoreCredential(input: NewPortalCredential): Promise<string> {
    const connectionId = uuidOf(input.connectionId, 'connectionId');
    const recipeVersionId = uuidOf(input.recipeVersionId, 'recipeVersionId');
    const label = credentialLabelOf(input.label);
    const payload = credentialPayloadOf(input.payload);
    if (label !== null && label.toLowerCase().includes(payload.username.toLowerCase())) {
      throw new PortalCredentialLabelError();
    }
    const cipher = this.cipher;
    if (cipher === undefined) throw new PortalSealingNotConfiguredError();

    // 1. What the credential is bound to, as the database holds it.
    const binding = await this.withTenant(async (client): Promise<PortalBinding> => {
      await this.assertOwner(client);
      const { rows: connections } = await client.query<{ portal_key: string }>(
        `select portal_key from portal_connections where id = $1`,
        [connectionId],
      );
      const connection = connections[0];
      if (connection === undefined) throw new PortalConnectionNotFoundError(connectionId);
      const version = await this.versionRow(client, recipeVersionId);
      if (version === undefined) throw new PortalRecipeVersionNotFoundError(recipeVersionId);
      if (version.portal_key !== connection.portal_key) {
        throw new PortalRecipeVersionPortalMismatchError(recipeVersionId, connectionId);
      }
      return bindingOf(restoreRecipe(version));
    });

    // 2. Sealed before anything is written.
    const context = portalCredentialContext({ orgId: this.tenant.orgId, connectionId }, binding);
    const sealed = sealedOf(await cipher.encrypt(JSON.stringify(payload), context));

    // 3. The row and its audit, together.
    return this.withTenant(async (client) => {
      let credentialId: string;
      try {
        const { rows } = await client.query<{ id: string }>(
          `insert into portal_credentials
             (org_id, connection_id, label, cipher, key_id, wrapped_key, ciphertext,
              sign_in_origin, sign_in_paths, hosts_hash, created_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10, $11)
           returning id`,
          [
            this.tenant.orgId,
            connectionId,
            label,
            sealed.cipher,
            sealed.keyId,
            sealed.wrappedKey,
            sealed.ciphertext,
            binding.signInOrigin,
            [...binding.signInPaths],
            binding.hostsHash,
            this.tenant.userId,
          ],
        );
        const id = rows[0]?.id;
        if (id === undefined) throw new Error('insert into portal_credentials returned no row');
        credentialId = id;
      } catch (error) {
        // The owner was demoted between the read and the write.
        if (sqlState(error) === '42501') {
          throw new PortalOwnerRequiredError(this.tenant.orgId, this.tenant.userId);
        }
        // Never the driver's error: its `detail` would carry the sealed row.
        throw writeRefusal('portal_credentials', error);
      }
      await this.audit(
        client,
        PORTAL_AUDIT_ACTIONS.credentialStored,
        'portal_connections',
        connectionId,
        {
          credential_id: credentialId,
          recipe_version_id: recipeVersionId,
        },
      );
      return credentialId;
    });
  }

  /**
   * The connection's current credential, the latest row by `seq`, as ciphertext
   * and binding; `undefined` when none.
   */
  async latestCredential(connectionId: string): Promise<PortalCredentialRecord | undefined> {
    const id = uuidOf(connectionId, 'connectionId');
    return this.withTenant(async (client) => {
      const { rows } = await client.query<CredentialRow>(
        `select id, connection_id, label, cipher, key_id, wrapped_key, ciphertext,
                sign_in_origin, sign_in_paths, hosts_hash, created_by, created_at
           from portal_credentials
          where connection_id = $1
          order by seq desc
          limit 1`,
        [id],
      );
      return rows[0] === undefined ? undefined : toCredential(rows[0]);
    });
  }

  // -------------------------------------------------------------------------
  // Recipe versions and reviews (ADR 0057 §3, §5)
  // -------------------------------------------------------------------------

  /**
   * Stores a recipe version as this member; returns its id.
   *
   * Refused unless `parseRecipe` accepts it (`RecipeRefusedError`) and
   * `bindingOf` can bind it (`PortalBindingError`), since a version no
   * credential can be sealed to can never run. Its portal key, version and
   * effective date are the row's columns. A person's version is any writer's;
   * an agent session's draft only an owner's, and its session id must be the
   * one its recipe names — the database repeats both rules.
   */
  async addRecipeVersion(input: NewPortalRecipeVersion): Promise<string> {
    const recipe = parseRecipe(input.recipe);
    if (!PORTAL_KEY_PATTERN.test(recipe.portalKey)) refuse('recipe.portalKey', 'a portal key');
    if (recipe.version > INT4_MAX) refuse('recipe.version', `at most ${INT4_MAX}`);
    bindingOf(recipe);

    const agentSessionId: unknown = input.agentSessionId;
    const drafted = recipe.provenance.draftedBy;
    if (drafted.kind === 'agent_session') {
      if (agentSessionId === undefined) {
        throw new PortalRecipeProvenanceError(
          'its recipe says an agent session drafted it, and no agent session id was given',
        );
      }
      if (
        typeof agentSessionId !== 'string' ||
        agentSessionId.trim() === '' ||
        CONTROL.test(agentSessionId)
      ) {
        refuse('agentSessionId', 'an agent session id: not blank, no control characters');
      }
      if (agentSessionId !== drafted.id) {
        throw new PortalRecipeProvenanceError(
          'the agent session id is not the one its recipe names',
        );
      }
    } else if (agentSessionId !== undefined) {
      throw new PortalRecipeProvenanceError(
        'its recipe says a person drafted it, so it names no agent session',
      );
    }
    const byAgent = agentSessionId !== undefined;

    return this.withTenant(async (client) => {
      if (byAgent) await this.assertOwner(client);
      else await this.assertWriter(client);

      let recipeVersionId: string;
      try {
        const { rows } = await client.query<{ id: string }>(
          `insert into portal_recipe_versions
             (org_id, portal_key, version, effective_from, recipe, created_by, agent_session_id)
           values ($1, $2, $3, $4::date, $5::jsonb, $6, $7)
           returning id`,
          [
            this.tenant.orgId,
            recipe.portalKey,
            recipe.version,
            recipe.effectiveFrom,
            JSON.stringify(recipe),
            this.tenant.userId,
            byAgent ? agentSessionId : null,
          ],
        );
        const id = rows[0]?.id;
        if (id === undefined) throw new Error('insert into portal_recipe_versions returned no row');
        recipeVersionId = id;
      } catch (error) {
        if (isUniqueViolationOn(error, PORTAL_CONSTRAINTS.oneVersionPerNumber)) {
          throw new PortalRecipeVersionExistsError(recipe.portalKey, recipe.version);
        }
        if (sqlState(error) === '42501') {
          throw byAgent
            ? new PortalOwnerRequiredError(this.tenant.orgId, this.tenant.userId)
            : new PortalWriterRequiredError(this.tenant.orgId, this.tenant.userId);
        }
        throw writeRefusal('portal_recipe_versions', error);
      }

      await this.audit(
        client,
        PORTAL_AUDIT_ACTIONS.recipeVersionAdded,
        'portal_recipe_versions',
        recipeVersionId,
        {
          portal_key: recipe.portalKey,
          version: recipe.version,
          drafted_by: drafted.kind,
          ...(byAgent ? { agent_session_id: agentSessionId } : {}),
        },
      );
      return recipeVersionId;
    });
  }

  /**
   * Records an owner's one verdict on a version; returns the review's id.
   *
   * The review names what the version adds (`recipeAdditions`) beyond the
   * promoted version in effect today (UTC) for its portal — none for a
   * portal's first, when everything counts — and an agent session's draft
   * that adds anything is refused promotion by name, before the database's
   * trigger would refuse it again. Rejecting one is always allowed.
   */
  async reviewRecipeVersion(input: PortalRecipeReviewInput): Promise<string> {
    const recipeVersionId = uuidOf(input.recipeVersionId, 'recipeVersionId');
    const verdict: unknown = input.verdict;
    if (!isOneOf(PORTAL_REVIEW_VERDICTS, verdict)) {
      refuse('verdict', `one of ${PORTAL_REVIEW_VERDICTS.join(', ')}`);
    }

    return this.withTenant(async (client) => {
      await this.assertOwner(client);
      const row = await this.versionRow(client, recipeVersionId);
      if (row === undefined) throw new PortalRecipeVersionNotFoundError(recipeVersionId);
      if (row.review_id !== null) throw new PortalRecipeAlreadyReviewedError(recipeVersionId);

      const { comparedWith, additions } = await this.additionsFor(client, row);
      if (verdict === 'promoted' && row.agent_session_id !== null && additions.length > 0) {
        throw new PortalAgentDraftAdditionsError(recipeVersionId, additions.length);
      }

      let reviewId: string;
      try {
        const { rows } = await client.query<{ id: string }>(
          `insert into portal_recipe_reviews
             (org_id, recipe_version_id, verdict, reviewer, compared_with_version_id, additions)
           values ($1, $2, $3, $4, $5, $6::jsonb)
           returning id`,
          [
            this.tenant.orgId,
            recipeVersionId,
            verdict,
            this.tenant.userId,
            comparedWith?.id ?? null,
            JSON.stringify(additions),
          ],
        );
        const id = rows[0]?.id;
        if (id === undefined) throw new Error('insert into portal_recipe_reviews returned no row');
        reviewId = id;
      } catch (error) {
        if (isUniqueViolationOn(error, PORTAL_CONSTRAINTS.oneReviewPerVersion)) {
          throw new PortalRecipeAlreadyReviewedError(recipeVersionId);
        }
        if (sqlState(error) === '42501') {
          throw new PortalOwnerRequiredError(this.tenant.orgId, this.tenant.userId);
        }
        throw writeRefusal('portal_recipe_reviews', error);
      }

      await this.audit(
        client,
        PORTAL_AUDIT_ACTIONS.recipeVersionReviewed,
        'portal_recipe_versions',
        recipeVersionId,
        {
          review_id: reviewId,
          verdict,
          compared_with_version_id: comparedWith?.id ?? null,
          addition_count: additions.length,
        },
      );
      return reviewId;
    });
  }

  /**
   * What a review of this version would name now: the promoted version in
   * effect it would be compared with, and what it adds beyond it. For the
   * review screen, so what an owner reads before promoting is what the review
   * row will say. `undefined` when this tenant cannot see the version.
   */
  async reviewPreview(recipeVersionId: string): Promise<
    | {
        readonly comparedWithVersionId: string | null;
        readonly additions: readonly PortalRecipeAddition[];
      }
    | undefined
  > {
    const id = uuidOf(recipeVersionId, 'recipeVersionId');
    return this.withTenant(async (client) => {
      const row = await this.versionRow(client, id);
      if (row === undefined) return undefined;
      const { comparedWith, additions } = await this.additionsFor(client, row);
      return { comparedWithVersionId: comparedWith?.id ?? null, additions };
    });
  }

  /** One version by id, reviewed or not; `undefined` when this tenant cannot see it. */
  async recipeVersion(recipeVersionId: string): Promise<PortalRecipeVersionRecord | undefined> {
    const id = uuidOf(recipeVersionId, 'recipeVersionId');
    return this.withTenant(async (client) => {
      const row = await this.versionRow(client, id);
      return row === undefined ? undefined : toVersion(row);
    });
  }

  /** Every version of one portal's recipe here, reviewed or not, the highest version first. */
  async listRecipeVersions(portalKey: string): Promise<readonly PortalRecipeVersionRecord[]> {
    if (typeof portalKey !== 'string' || !PORTAL_KEY_PATTERN.test(portalKey)) {
      refuse('portalKey', 'a portal key');
    }
    return this.withTenant(async (client) => {
      const { rows } = await client.query<VersionRow>(
        `select ${VERSION_COLUMNS}
           from portal_recipe_versions v
           left join portal_recipe_reviews r on r.org_id = v.org_id and r.recipe_version_id = v.id
          where v.portal_key = $1
          order by v.version desc`,
        [portalKey],
      );
      return rows.map(toVersion);
    });
  }

  /**
   * The connection's promoted version in effect today, UTC: the latest
   * `effective_from` not after today, the highest version breaking a tie. The
   * clock is the database's, the one `app.record_portal_read_start()` asks, so
   * the two cannot disagree about what is in effect.
   */
  async promotedRecipe(connectionId: string): Promise<PortalRecipeVersionRecord | undefined> {
    const id = uuidOf(connectionId, 'connectionId');
    return this.withTenant(async (client) => {
      const { rows } = await client.query<VersionRow>(
        `select ${VERSION_COLUMNS}
           from portal_connections c
           join portal_recipe_versions v on v.org_id = c.org_id and v.portal_key = c.portal_key
           join portal_recipe_reviews r
             on r.org_id = v.org_id and r.recipe_version_id = v.id and r.verdict = 'promoted'
          where c.id = $1
            and v.effective_from <= (now() at time zone 'utc')::date
          order by v.effective_from desc, v.version desc
          limit 1`,
        [id],
      );
      return rows[0] === undefined ? undefined : toVersion(rows[0]);
    });
  }

  private async versionRow(
    client: PoolClient,
    recipeVersionId: string,
  ): Promise<VersionRow | undefined> {
    const { rows } = await client.query<VersionRow>(
      `select ${VERSION_COLUMNS}
         from portal_recipe_versions v
         left join portal_recipe_reviews r on r.org_id = v.org_id and r.recipe_version_id = v.id
        where v.id = $1`,
      [recipeVersionId],
    );
    return rows[0];
  }

  /**
   * The promoted version in effect for a version's portal (never the version
   * itself), and what the version adds beyond it.
   */
  private async additionsFor(
    client: PoolClient,
    row: VersionRow,
  ): Promise<{
    readonly comparedWith: VersionRow | undefined;
    readonly additions: PortalRecipeAddition[];
  }> {
    const { rows } = await client.query<VersionRow>(
      `select ${VERSION_COLUMNS}
         from portal_recipe_versions v
         join portal_recipe_reviews r
           on r.org_id = v.org_id and r.recipe_version_id = v.id and r.verdict = 'promoted'
        where v.portal_key = $1
          and v.id <> $2
          and v.effective_from <= (now() at time zone 'utc')::date
        order by v.effective_from desc, v.version desc
        limit 1`,
      [row.portal_key, row.id],
    );
    const comparedWith = rows[0];
    return {
      comparedWith,
      additions: recipeAdditions(
        restoreRecipe(row),
        comparedWith === undefined ? undefined : restoreRecipe(comparedWith),
      ),
    };
  }

  // -------------------------------------------------------------------------
  // Runs (ADR 0057 §13, ADR 0023's shape)
  // -------------------------------------------------------------------------

  /**
   * Writes the run's start row through `app.record_portal_read_start()`, the
   * one door into `portal_read_starts`; returns the run id. The function is
   * the referee: the caller must be the connection's `created_by`, and a read
   * that is not a dry run names a promoted version in effect or none. A replay
   * of the same start writes nothing; any other second start is refused.
   */
  async recordRunStart(input: PortalRunStartInput): Promise<string> {
    const runId = uuidOf(input.runId, 'runId');
    this.assertOwnOrg(input.orgId);
    const connectionId = uuidOf(input.connectionId, 'connectionId');
    const recipeVersionId =
      input.recipeVersionId === null ? null : uuidOf(input.recipeVersionId, 'recipeVersionId');
    const dryRun: unknown = input.dryRun;
    if (typeof dryRun !== 'boolean') refuse('dryRun', 'true or false');
    if (input.requestedBy !== this.tenant.userId) {
      throw new PortalActorMismatchError('requestedBy', this.tenant.orgId, this.tenant.userId);
    }

    return this.withTenant(async (client) => {
      try {
        const { rows } = await client.query<{ id: string | null }>(
          `select app.record_portal_read_start(
                    $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::boolean, $6::uuid) as id`,
          [runId, this.tenant.orgId, connectionId, recipeVersionId, dryRun, this.tenant.userId],
        );
        const id = rows[0]?.id;
        if (id === undefined || id === null) {
          throw new Error('app.record_portal_read_start() returned no run id');
        }
        return id;
      } catch (error) {
        throw runRecordRefusal('start', runId, error);
      }
    });
  }

  /**
   * Writes the run's one outcome row through `app.record_portal_read_run()`;
   * returns its id. Checked here first against `PortalRunEnd`'s shape — which
   * reasons an outcome takes and when a class name is carried — and the step
   * log is rebuilt from each line's name and pass or fail and nothing else, so
   * no third key can reach the row. A replay of the same outcome writes
   * nothing; any other second outcome is refused.
   */
  async recordRunEnd(input: PortalRunEndInput): Promise<string> {
    const runId = uuidOf(input.runId, 'runId');
    this.assertOwnOrg(input.orgId);
    const end = runEndColumns(input);
    const atStep = input.atStep === null ? null : stepNameOf(input.atStep, 'atStep');
    const given: unknown = input.counts;
    if (given === null || typeof given !== 'object') refuse('counts', 'an object of counts');
    const counts = given as Readonly<Record<string, unknown>>;
    const pages = countOf(counts.pages, 'counts.pages');
    const captures = countOf(counts.captures, 'counts.captures');
    const newDocuments = countOf(counts.newDocuments, 'counts.newDocuments');
    const deduplicated = countOf(counts.deduplicated, 'counts.deduplicated');
    const refusals = countOf(counts.refusals, 'counts.refusals');
    const stepLog = stepLogOf(input.stepLog);

    return this.withTenant(async (client) => {
      try {
        const { rows } = await client.query<{ id: string | null }>(
          `select app.record_portal_read_run(
                    $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text,
                    $7::integer, $8::integer, $9::integer, $10::integer, $11::integer,
                    $12::jsonb) as id`,
          [
            runId,
            this.tenant.orgId,
            end.outcome,
            end.reason,
            end.errorClass,
            atStep,
            pages,
            captures,
            newDocuments,
            deduplicated,
            refusals,
            JSON.stringify(stepLog),
          ],
        );
        const id = rows[0]?.id;
        if (id === undefined || id === null) {
          throw new Error('app.record_portal_read_run() returned no id');
        }
        return id;
      } catch (error) {
        throw runRecordRefusal('outcome', runId, error);
      }
    });
  }

  /**
   * Writes one capture's row; returns its id.
   *
   * The database checks what it can see: that the run is not a dry run, that
   * the capture names the run's own recipe version, and that a stored
   * capture's hash is its document's. A replay of exactly the same capture —
   * a job step retried after its row committed — returns the row already
   * written rather than a second one, under a lock per run so two deliveries
   * of one step cannot both write.
   *
   * The contract asks for this row "in the transaction that wrote its
   * `uploads` row"; `ingestDocument` writes that row in its own transaction,
   * and this port is handed only the document id afterwards, so this is its
   * own transaction, written straight after the ingest. What that leaves: the
   * job ingests and calls this in one retried step, and the bytes dedupe to
   * the same document, so a retry replays this row; but a worker that forgets
   * the run between the two writes (a restart, its result's TTL) answers the
   * retry's capture fetch 404, and a `portal_fetch` document keeps no capture
   * row naming its run. Closing that takes a port that ingests and records in
   * one transaction, which is the contract's decision, not this method's.
   */
  async recordCapture(input: PortalCaptureInput): Promise<string> {
    this.assertOwnOrg(input.orgId);
    const capture = captureOf(input);
    return this.withTenant(async (client) => {
      try {
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 5))', [
          `portal_capture:${capture.runId}`,
        ]);
        const { rows: existing } = await client.query<{ id: string }>(
          `select id from portal_captures
            where run_id = $1 and recipe_version_id = $2 and kind = $3 and step_name = $4
              and page_path = $5 and snapshot_rule_version is not distinct from $6::integer
              and sha256 = $7 and captured_at = $8::timestamptz
              and document_id is not distinct from $9::uuid
              and refusal is not distinct from $10::text
            order by created_at, id
            limit 1`,
          captureParams(capture),
        );
        if (existing[0] !== undefined) return existing[0].id;

        const { rows } = await client.query<{ id: string }>(
          `insert into portal_captures
             (run_id, recipe_version_id, kind, step_name, page_path, snapshot_rule_version,
              sha256, captured_at, document_id, refusal, org_id)
           values ($1, $2, $3, $4, $5, $6::integer, $7, $8::timestamptz, $9::uuid, $10::text, $11)
           returning id`,
          [...captureParams(capture), this.tenant.orgId],
        );
        const id = rows[0]?.id;
        if (id === undefined) throw new Error('insert into portal_captures returned no row');
        return id;
      } catch (error) {
        throw runRecordRefusal('capture', capture.runId, error);
      }
    });
  }

  /**
   * The connection's runs, newest first, each start with its outcome or `null`
   * (running, or a run that never finished).
   */
  async listRuns(
    connectionId: string,
    limit: number = PORTAL_RUNS_DEFAULT,
  ): Promise<readonly PortalRunRecord[]> {
    const id = uuidOf(connectionId, 'connectionId');
    if (!Number.isInteger(limit) || limit < 1 || limit > PORTAL_RUNS_MAX) {
      refuse('limit', `a whole number from 1 to ${PORTAL_RUNS_MAX}`);
    }
    return this.withTenant(async (client) => {
      const { rows } = await client.query<RunRow>(
        `select s.id as run_id, s.connection_id, s.recipe_version_id, s.dry_run, s.requested_by,
                s.started_at, r.outcome, r.reason, r.error_class, r.at_step, r.page_count,
                r.capture_count, r.new_document_count, r.deduplicated_count, r.refusal_count,
                r.step_log, r.finished_at
           from portal_read_starts s
           left join portal_read_runs r on r.org_id = s.org_id and r.run_id = s.id
          where s.connection_id = $1
          order by s.started_at desc, s.id desc
          limit $2`,
        [id, limit],
      );
      return rows.map(toRun);
    });
  }

  /**
   * Every enabled connection in the deployment: untenanted, with the claims
   * cleared (`listPortalConnectionsToRead`).
   */
  async connectionsToRead(): Promise<readonly PortalConnectionToRead[]> {
    return listPortalConnectionsToRead(this.config);
  }

  // -------------------------------------------------------------------------
  // Helpers that need the tenant
  // -------------------------------------------------------------------------

  private assertOwnOrg(orgId: unknown): void {
    if (orgId !== this.tenant.orgId) {
      throw new PortalActorMismatchError('orgId', this.tenant.orgId, this.tenant.userId);
    }
  }

  /**
   * One `audit_log` row, as this member (migration 0030's policy refuses any
   * other). Ids and codes only (`PORTAL_AUDIT_ACTIONS`): never a credential, a
   * label, an account id or page text. The chain hash is the trigger's.
   */
  private async audit(
    client: PoolClient,
    action: string,
    subjectTable: 'portal_connections' | 'portal_recipe_versions',
    subjectId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await client.query(
        `insert into audit_log (org_id, actor_id, action, subject_table, subject_id, payload)
         values ($1, $2, $3, $4, $5, $6::jsonb)`,
        [
          this.tenant.orgId,
          this.tenant.userId,
          action,
          subjectTable,
          subjectId,
          JSON.stringify(payload),
        ],
      );
    } catch (error) {
      throw writeRefusal('audit_log', error);
    }
  }
}

// ---------------------------------------------------------------------------
// Reading rows back
// ---------------------------------------------------------------------------

function toConnection(row: ConnectionRow): PortalConnectionRecord {
  const params = PortalRunParamsSchema.safeParse(row.params);
  if (!params.success) throw new PortalStoredDataError('portal_connections', row.id, 'params');
  return {
    connectionId: row.id,
    orgId: row.org_id,
    portalKey: row.portal_key,
    label: row.label,
    accountId: row.account_id,
    params: params.data,
    enabled: row.enabled,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * A credential row as the job hands it to the worker. Its binding and its
 * sealed fields are checked against the contract's schemas on the way out,
 * so a row the worker would refuse is refused here, at its source.
 */
function toCredential(row: CredentialRow): PortalCredentialRecord {
  const binding = PortalBindingSchema.safeParse({
    signInOrigin: row.sign_in_origin,
    signInPaths: row.sign_in_paths,
    hostsHash: row.hosts_hash,
  });
  if (!binding.success) throw new PortalStoredDataError('portal_credentials', row.id, 'binding');
  const sealed = SealedPortalCredentialSchema.safeParse({
    cipher: row.cipher,
    keyId: row.key_id,
    wrappedKey: row.wrapped_key,
    ciphertext: row.ciphertext,
  });
  if (!sealed.success) {
    throw new PortalStoredDataError('portal_credentials', row.id, 'sealed credential');
  }
  return {
    credentialId: row.id,
    connectionId: row.connection_id,
    label: row.label,
    sealed: sealed.data,
    binding: binding.data,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/**
 * The stored recipe, back through `parseRecipe`, and agreeing with its row.
 * A version this build cannot parse is loud: it is what a run would send the
 * worker and what a credential would be sealed to.
 */
function restoreRecipe(
  row: Pick<VersionRow, 'id' | 'recipe' | 'portal_key' | 'version' | 'effective_from'>,
): RecipeVersion {
  let recipe: RecipeVersion;
  try {
    recipe = parseRecipe(row.recipe);
  } catch {
    throw new PortalStoredDataError('portal_recipe_versions', row.id, 'recipe');
  }
  if (
    recipe.portalKey !== row.portal_key ||
    recipe.version !== row.version ||
    recipe.effectiveFrom !== row.effective_from
  ) {
    throw new PortalStoredDataError(
      'portal_recipe_versions',
      row.id,
      'recipe that disagrees with its row',
    );
  }
  return recipe;
}

function toVersion(row: VersionRow): PortalRecipeVersionRecord {
  return {
    recipeVersionId: row.id,
    orgId: row.org_id,
    portalKey: row.portal_key,
    version: row.version,
    effectiveFrom: row.effective_from,
    recipe: restoreRecipe(row),
    createdBy: row.created_by,
    agentSessionId: row.agent_session_id,
    createdAt: row.created_at,
    review: toReview(row),
  };
}

function toReview(row: VersionRow): PortalRecipeReviewRecord | null {
  if (row.review_id === null) return null;
  if (
    !isOneOf(PORTAL_REVIEW_VERDICTS, row.verdict) ||
    row.reviewer === null ||
    row.reviewed_at === null
  ) {
    throw new PortalStoredDataError('portal_recipe_reviews', row.review_id, 'review');
  }
  return {
    reviewId: row.review_id,
    verdict: row.verdict,
    reviewer: row.reviewer,
    comparedWithVersionId: row.compared_with_version_id,
    additions: additionsOf(row.additions, row.review_id),
    createdAt: row.reviewed_at,
  };
}

/** A review's additions as `PortalRecipeAddition[]`, each with exactly its variant's fields. */
function additionsOf(raw: unknown, reviewId: string): PortalRecipeAddition[] {
  const unreadable = (): never => {
    throw new PortalStoredDataError('portal_recipe_reviews', reviewId, 'additions');
  };
  if (!Array.isArray(raw)) return unreadable();
  return raw.map((entry: unknown): PortalRecipeAddition => {
    if (entry === null || typeof entry !== 'object') return unreadable();
    const a = entry as Record<string, unknown>;
    switch (a.kind) {
      case 'host':
        return typeof a.host === 'string' ? { kind: 'host', host: a.host } : unreadable();
      case 'post_as_read': {
        if (typeof a.step !== 'string' || typeof a.path !== 'string') return unreadable();
        const discriminator = a.bodyDiscriminator;
        if (discriminator === null) {
          return { kind: 'post_as_read', step: a.step, path: a.path, bodyDiscriminator: null };
        }
        if (discriminator === undefined || typeof discriminator !== 'object') return unreadable();
        const d = discriminator as Record<string, unknown>;
        return typeof d.field === 'string' && typeof d.equals === 'string'
          ? {
              kind: 'post_as_read',
              step: a.step,
              path: a.path,
              bodyDiscriminator: { field: d.field, equals: d.equals },
            }
          : unreadable();
      }
      case 'dismiss':
        return typeof a.step === 'string' && typeof a.label === 'string'
          ? { kind: 'dismiss', step: a.step, label: a.label }
          : unreadable();
      default:
        return unreadable();
    }
  });
}

function toRun(row: RunRow): PortalRunRecord {
  return {
    runId: row.run_id,
    connectionId: row.connection_id,
    recipeVersionId: row.recipe_version_id,
    dryRun: row.dry_run,
    requestedBy: row.requested_by,
    startedAt: row.started_at,
    end: row.outcome === null ? null : toRunEnd(row),
  };
}

/**
 * An outcome row as `PortalRunEnd` and the rest, refusing any combination the
 * contract has no shape for.
 */
function toRunEnd(row: RunRow): PortalRunEndRecord {
  const unreadable = (field: string): never => {
    throw new PortalStoredDataError('portal_read_runs', row.run_id, field);
  };
  if (row.finished_at === null) return unreadable('finished_at');
  const rest = {
    atStep: row.at_step,
    counts: {
      pages: row.page_count ?? unreadable('page_count'),
      captures: row.capture_count ?? unreadable('capture_count'),
      newDocuments: row.new_document_count ?? unreadable('new_document_count'),
      deduplicated: row.deduplicated_count ?? unreadable('deduplicated_count'),
      refusals: row.refusal_count ?? unreadable('refusal_count'),
    },
    stepLog: storedStepLog(row.step_log) ?? unreadable('step_log'),
    finishedAt: row.finished_at,
  };
  const outcome = row.outcome;
  if (outcome === 'completed' && row.reason === null && row.error_class === null) {
    return { outcome, ...rest };
  }
  if (
    (outcome === 'not_configured' || outcome === 'refused') &&
    row.reason === null &&
    row.error_class !== null
  ) {
    return { outcome, errorClass: row.error_class, ...rest };
  }
  if (
    outcome === 'needs_attention' &&
    isOneOf(PORTAL_NEEDS_ATTENTION_REASONS, row.reason) &&
    row.error_class === null
  ) {
    return { outcome, reason: row.reason, ...rest };
  }
  if (outcome === 'failed' && row.reason === 'error' && row.error_class !== null) {
    return { outcome, reason: 'error', errorClass: row.error_class, ...rest };
  }
  if (
    outcome === 'failed' &&
    isOneOf(PORTAL_FAILED_REASONS, row.reason) &&
    row.reason !== 'error' &&
    row.error_class === null
  ) {
    return { outcome, reason: row.reason, ...rest };
  }
  return unreadable('outcome');
}

function storedStepLog(raw: unknown): RunStepLogEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const log: RunStepLogEntry[] = [];
  for (const entry of raw as unknown[]) {
    if (entry === null || typeof entry !== 'object') return undefined;
    const { step, passed } = entry as { step?: unknown; passed?: unknown };
    if (typeof step !== 'string' || typeof passed !== 'boolean') return undefined;
    log.push({ step, passed });
  }
  return log;
}

// ---------------------------------------------------------------------------
// Checking what a caller hands in
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const CLASS_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/**
 * `\p{Cc}`, as contracts.ts has it: migration 0038's
 * `[\u0001-\u001f\u007f-\u009f]`, and NUL, which text cannot hold.
 */
const CONTROL = /\p{Cc}/u;
/**
 * A capture's page path: contracts.ts's `RunCapture.pagePath` and 0038's
 * `portal_captures_page_path_check`.
 */
const PAGE_PATH = /^\/[^?#;\p{Cc}]*$/u;
const COOKIELESS_SEGMENT = /\([A-Za-z]\(/;
const INT4_MAX = 2_147_483_647;

/**
 * The door's refusal codes (`@recouple/ingest`'s `RejectionCode`), which
 * `portal_captures.refusal` admits. `satisfies` holds this list to the type in
 * both directions, and `rejection-codes.test.ts` holds the type to 0034's
 * check; 0038's check repeats it.
 */
const REJECTION_CODES = {
  empty_file: true,
  body_too_short: true,
  too_large: true,
  type_not_allowed: true,
  content_does_not_match_type: true,
  encrypted_pdf: true,
  active_content_pdf: true,
  decompression_bomb: true,
  malformed_pdf: true,
  macro_enabled_spreadsheet: true,
  active_content_spreadsheet: true,
  legacy_or_encrypted_office: true,
  xml_dtd_refused: true,
  malformed_spreadsheet: true,
  spreadsheet_too_large: true,
} as const satisfies Record<RejectionCode, true>;

function refuse(field: string, rule: string): never {
  throw new PortalInputError([{ field, rule }]);
}

function isOneOf<T extends string>(set: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (set as readonly string[]).includes(value);
}

function uuidOf(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) refuse(field, 'a lower-case uuid');
  return value;
}

/** A schema's issues as fields and rules: its own wording, or for a credential only its code. */
function issuesOf(
  issues: readonly {
    readonly path: readonly PropertyKey[];
    readonly message: string;
    readonly code: string;
  }[],
  rule: 'message' | 'code',
  prefix?: string,
): PortalInputIssue[] {
  return issues.map((issue) => ({
    field:
      [...(prefix !== undefined ? [prefix] : []), ...issue.path.map(String)].join('.') || '(input)',
    rule: rule === 'message' ? issue.message : issue.code,
  }));
}

/**
 * The payload, checked and copied field by field, so nothing a caller added rides
 * along into the ciphertext.
 */
function credentialPayloadOf(raw: unknown): PortalCredentialPayload {
  const parsed = PortalCredentialPayloadSchema.safeParse(raw);
  if (!parsed.success) throw new PortalInputError(issuesOf(parsed.error.issues, 'code', 'payload'));
  const { username, password, totpSecret } = parsed.data;
  return { username, password, ...(totpSecret !== undefined ? { totpSecret } : {}) };
}

/**
 * A credential's label: absent, or 0038's rule for one (1–labelMax characters, no
 * control characters, trimmed).
 */
function credentialLabelOf(label: unknown): string | null {
  if (label === undefined) return null;
  if (
    typeof label !== 'string' ||
    label.length < 1 ||
    label.length > PORTAL_LIMITS.labelMax ||
    CONTROL.test(label) ||
    label.trim() !== label
  ) {
    refuse(
      'label',
      `1–${PORTAL_LIMITS.labelMax} characters, no control characters, ` +
        'no leading or trailing whitespace',
    );
  }
  return label;
}

/** What the cipher returned, held to the contract before it goes near a column. */
function sealedOf(sealed: unknown): SealedPortalCredential {
  const parsed = SealedPortalCredentialSchema.safeParse(sealed);
  if (!parsed.success) throw new PortalInputError(issuesOf(parsed.error.issues, 'code', 'sealed'));
  return parsed.data;
}

function stepNameOf(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > PORTAL_LIMITS.stepNameMax ||
    CONTROL.test(value)
  ) {
    refuse(field, `a step name: 1–${PORTAL_LIMITS.stepNameMax} characters, no control characters`);
  }
  return value;
}

function countOf(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > INT4_MAX) {
    refuse(field, 'a whole number from 0');
  }
  return value;
}

/**
 * A step log as `RunStepLogEntry[]`: each line rebuilt from its name and pass or
 * fail, one line per name.
 */
function stepLogOf(raw: unknown): RunStepLogEntry[] {
  if (!Array.isArray(raw)) refuse('stepLog', 'an array of step lines');
  const seen = new Set<string>();
  return (raw as unknown[]).map((entry, i) => {
    const line = (entry ?? {}) as { readonly step?: unknown; readonly passed?: unknown };
    const step = stepNameOf(line.step, `stepLog.${i}.step`);
    if (typeof line.passed !== 'boolean') refuse(`stepLog.${i}.passed`, 'true or false');
    if (seen.has(step)) refuse(`stepLog.${i}.step`, 'one line per step name');
    seen.add(step);
    return { step, passed: line.passed };
  });
}

/**
 * A run end's outcome, reason and class name, as `PortalRunEnd` allows them:
 * a reason exactly for `needs_attention` and `failed`, from that outcome's
 * list, and a class name exactly for `not_configured`, `refused` and a
 * `failed` run whose reason is `error` — read off the object as it arrived,
 * so a field the type would forbid is refused rather than dropped.
 */
function runEndColumns(input: PortalRunEndInput): {
  readonly outcome: PortalRunOutcome;
  readonly reason: PortalNeedsAttentionReason | PortalFailedReason | null;
  readonly errorClass: string | null;
} {
  const raw = input as {
    readonly outcome?: unknown;
    readonly reason?: unknown;
    readonly errorClass?: unknown;
  };
  const outcome = raw.outcome;
  if (!isOneOf(PORTAL_RUN_OUTCOMES, outcome)) {
    refuse('outcome', `one of ${PORTAL_RUN_OUTCOMES.join(', ')}`);
  }
  const issues: PortalInputIssue[] = [];

  let reason: PortalNeedsAttentionReason | PortalFailedReason | null = null;
  if (outcome === 'needs_attention' || outcome === 'failed') {
    const reasons: readonly (PortalNeedsAttentionReason | PortalFailedReason)[] =
      outcome === 'needs_attention' ? PORTAL_NEEDS_ATTENTION_REASONS : PORTAL_FAILED_REASONS;
    if (isOneOf(reasons, raw.reason)) reason = raw.reason;
    else issues.push({ field: 'reason', rule: `one of ${reasons.join(', ')}` });
  } else if (raw.reason !== undefined) {
    issues.push({ field: 'reason', rule: `a ${outcome} run takes none` });
  }

  const takesClass =
    outcome === 'not_configured' ||
    outcome === 'refused' ||
    (outcome === 'failed' && raw.reason === 'error');
  let errorClass: string | null = null;
  if (takesClass) {
    const value = raw.errorClass;
    if (
      typeof value === 'string' &&
      value.length <= PORTAL_LIMITS.errorClassMax &&
      CLASS_NAME.test(value)
    ) {
      errorClass = value;
    } else {
      issues.push({
        field: 'errorClass',
        rule: `a class name, at most ${PORTAL_LIMITS.errorClassMax} characters`,
      });
    }
  } else if (raw.errorClass !== undefined) {
    issues.push({
      field: 'errorClass',
      rule: 'only a not_configured, refused or failed-with-error run names one',
    });
  }

  if (issues.length > 0) throw new PortalInputError(issues);
  return { outcome, reason, errorClass };
}

interface CaptureColumns {
  readonly runId: string;
  readonly recipeVersionId: string;
  readonly kind: CaptureKind;
  readonly stepName: string;
  readonly pagePath: string;
  readonly snapshotRuleVersion: number | null;
  readonly sha256: string;
  readonly capturedAt: string;
  readonly documentId: string | null;
  readonly refusal: RejectionCode | null;
}

/** A capture checked against contracts.ts's rules and 0038's columns. */
function captureOf(input: PortalCaptureInput): CaptureColumns {
  const runId = uuidOf(input.runId, 'runId');
  const recipeVersionId = uuidOf(input.recipeVersionId, 'recipeVersionId');
  const kind: unknown = input.kind;
  if (!isOneOf(PORTAL_CAPTURE_KINDS, kind)) {
    refuse('kind', `one of ${PORTAL_CAPTURE_KINDS.join(', ')}`);
  }
  const stepName = stepNameOf(input.stepName, 'stepName');

  const pagePath: unknown = input.pagePath;
  if (
    typeof pagePath !== 'string' ||
    pagePath.length > PORTAL_LIMITS.pathMax ||
    !PAGE_PATH.test(pagePath) ||
    COOKIELESS_SEGMENT.test(pagePath)
  ) {
    refuse(
      'pagePath',
      'a path from /, with no query, fragment, ; parameters or cookieless session segment',
    );
  }

  const version: unknown = input.snapshotRuleVersion;
  let snapshotRuleVersion: number | null = null;
  if (kind === 'page_snapshot') {
    if (
      typeof version !== 'number' ||
      !Number.isInteger(version) ||
      version < 1 ||
      version > INT4_MAX
    ) {
      refuse('snapshotRuleVersion', "a page snapshot names its serialiser's rule version");
    }
    snapshotRuleVersion = version;
  } else if (version !== null) {
    refuse('snapshotRuleVersion', 'a download has none');
  }

  const sha256: unknown = input.sha256;
  if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) {
    refuse('sha256', 'a lower-case hex SHA-256');
  }
  const capturedAt: unknown = input.capturedAt;
  if (!(capturedAt instanceof Date) || Number.isNaN(capturedAt.getTime())) {
    refuse('capturedAt', 'a date');
  }

  const documentId: unknown = (input as { readonly documentId?: unknown }).documentId;
  const refusal: unknown = (input as { readonly refusal?: unknown }).refusal;
  if ((documentId === undefined) === (refusal === undefined)) {
    refuse(
      'documentId',
      'a capture is stored as a document or refused at the door, one or the other',
    );
  }
  if (
    refusal !== undefined &&
    !(typeof refusal === 'string' && Object.hasOwn(REJECTION_CODES, refusal))
  ) {
    refuse('refusal', "one of the door's refusal codes");
  }

  return {
    runId,
    recipeVersionId,
    kind,
    stepName,
    pagePath,
    snapshotRuleVersion,
    sha256,
    capturedAt: capturedAt.toISOString(),
    documentId: documentId === undefined ? null : uuidOf(documentId, 'documentId'),
    refusal: refusal === undefined ? null : (refusal as RejectionCode),
  };
}

function captureParams(capture: CaptureColumns): unknown[] {
  return [
    capture.runId,
    capture.recipeVersionId,
    capture.kind,
    capture.stepName,
    capture.pagePath,
    capture.snapshotRuleVersion,
    capture.sha256,
    capture.capturedAt,
    capture.documentId,
    capture.refusal,
  ];
}

// ---------------------------------------------------------------------------
// The database's answers
// ---------------------------------------------------------------------------

async function latestCredentialId(
  client: PoolClient,
  connectionId: string,
): Promise<string | undefined> {
  const { rows } = await client.query<{ id: string }>(
    `select id from portal_credentials where connection_id = $1 order by seq desc limit 1`,
    [connectionId],
  );
  return rows[0]?.id;
}

function sqlState(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function isUniqueViolationOn(error: unknown, constraint: string): boolean {
  return (
    sqlState(error) === '23505' && (error as { constraint?: unknown }).constraint === constraint
  );
}

/** Migration 0038's own refusals, which name ids and rules and never a value. */
const OWN_REFUSAL = /^portal (read start|read run|capture|recipe review) blocked: /;

interface DatabaseRefusal {
  readonly sqlState: string;
  readonly constraint: string | undefined;
  readonly refusal: string | undefined;
}

/**
 * What a refusal about a row may repeat. Class 22 (a value the column will not
 * take), class 23 (a constraint, a trigger's agreement) and 42501 (a policy, an
 * author, a run function's caller) are refusals about a row, and their driver
 * errors quote it: the message can hold a value (`invalid input syntax for
 * type uuid: "…"`) and `detail` holds the whole row. So only the SQLSTATE, the
 * constraint's name and 0038's own words are kept. Anything else — a dropped
 * connection, a timeout — says nothing about a row and is the original error.
 */
function databaseRefusal(error: unknown): DatabaseRefusal | undefined {
  const state = sqlState(error);
  if (
    state === undefined ||
    !(state.startsWith('22') || state.startsWith('23') || state === '42501')
  ) {
    return undefined;
  }
  const constraint = (error as { constraint?: unknown }).constraint;
  const message = error instanceof Error ? error.message : '';
  return {
    sqlState: state,
    constraint: typeof constraint === 'string' ? constraint : undefined,
    refusal: OWN_REFUSAL.test(message) ? message : undefined,
  };
}

/**
 * A run's start, outcome or capture row refused, by name: the caller refused
 * (42501), a row naming what does not exist or may not run (23001), a check or
 * an agreement (23514), a replay that differs (23505), a tenancy tie (23503).
 */
function runRecordRefusal(
  record: 'start' | 'outcome' | 'capture',
  runId: string,
  error: unknown,
): unknown {
  const refused = databaseRefusal(error);
  return refused === undefined
    ? error
    : new PortalRunRecordRefusedError(
        record,
        runId,
        refused.sqlState,
        refused.constraint,
        refused.refusal,
      );
}

/** Any other write refused, by name, for `databaseRefusal`'s reason. */
function writeRefusal(table: string, error: unknown): unknown {
  const refused = databaseRefusal(error);
  return refused === undefined
    ? error
    : new PortalWriteRefusedError(table, refused.sqlState, refused.constraint, refused.refusal);
}

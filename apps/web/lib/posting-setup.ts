import { REASON_FAMILIES, type ReasonFamily } from '@recouple/core-domain';
import {
  QboAccountReadBackError,
  QboAuthError,
  QboChartTooLarge,
  QboMalformedResponse,
  QboRateLimited,
  QboRequestFailed,
  SETUP_ACCOUNTS,
  SETUP_ROWS,
  proposePostingSetup,
  resolveSetupRow,
  type AccountReadBackField,
  type LedgerAccountMap,
  type PostingSetupProposal,
  type QboAccount,
  type RowResolution,
  type SetupAccountSpec,
  type SetupRow,
} from '@recouple/qbo';
import {
  CredentialUnreadableError,
  LedgerAccountBusyError,
  LockPoolTimeoutError,
  MAP_ACCOUNT_TYPES,
  OwnerRequiredError,
  PostingConnectionNotFoundError,
  type PostgresPostingStore,
  type PostingConnectionView,
  type RecordedSetupAccounts,
  type UnansweredAccountCreate,
} from '@recouple/store-postgres';
import type { QboPoster, QboRequestOptions } from './qbo-posting';

/**
 * Setting up posting with one press (ADR 0063, amending ADR 0060 §4).
 *
 * The page proposes from a live read of the company's chart of accounts; the
 * press re-reads it, creates at most the two accounts ADR 0063 admits, saves
 * the map and turns the switch on — in that order, and nothing after a step
 * that refuses. It is not one transaction: QuickBooks and our database are two
 * places. What makes a second press safe is find-first — an account a first
 * press created is found by its name and reused — and a request id for each
 * attempt at a row, so a create sent again after one that had no answer is
 * the same request to Intuit, and a create after an answered one is not. An
 * account setup already recorded for a row, and since renamed or moved away
 * from our name, is never made a second time: the press refuses instead.
 * Nothing is ever deleted to roll back. Two presses at once are one press and
 * a refusal: a press holds its connection's claim from the moment it reads
 * the connection until the switch is on.
 *
 * Every account a press asks QuickBooks for is on the audit log before the
 * request goes out. One QuickBooks answered with — read back as it was sent or
 * not — is logged by its id and then audited as created. One whose answer
 * never came — a timeout, a 5xx, a reply with no id, a read-back that could
 * not be made, a 4xx that does not say which of the two requests it refused —
 * has only its request on the record, because nothing told the press its id:
 * a later press that finds it in the chart, as that request would have made
 * it, records it then as found, before it plans anything. Until one does, the
 * request row is all the audit log has of it.
 *
 * Every request a press makes to QuickBooks waits at most
 * `PRESS_REQUEST_TIMEOUT_MS`, so that the press ends — with its refusal in
 * words — inside the setup route's `maxDuration`, rather than being cut off by
 * the platform with a gateway timeout.
 *
 * Every refusal is a named error carrying ids and words from a closed set. An
 * account's name — ours, or one the customer typed — never reaches a log line,
 * a redirect, an error message or an audit row.
 */

type Identity = { readonly orgId: string; readonly userId: string };

/** The form's word for "the account we create": never an id, which is digits. */
export const CREATE_ACCOUNT = 'create';
/** A split write-off row's default: the one write-off account above it (ADR 0063 §1). */
export const SAME_AS_WRITEOFF = 'same';
/** The setup form's field for one family's write-off, or for `unclassified`. */
export function splitField(family: ReasonFamily | 'unclassified'): string {
  return `split_${family}`;
}

/** A QuickBooks account id as a form sends it: digits, nothing else. */
const ACCOUNT_ID = /^[0-9]{1,20}$/;

/** What a press chose for one account: one the company has, or ours to create. */
export type AccountChoice =
  | { readonly kind: 'existing'; readonly accountId: string }
  | { readonly kind: 'create' };

/**
 * What the form says, and all it is trusted to say: which existing account
 * id, or "create", each row chose. An A/R account is never ours to create.
 */
export interface PostingSetupChoices {
  readonly ar: string;
  readonly deductionsReceivable: AccountChoice;
  readonly writeoffByFamily: Readonly<Record<ReasonFamily, AccountChoice>>;
  readonly unclassifiedWriteoff: AccountChoice;
}

/**
 * The setup form's choices, or nothing when it is not the form the page draws:
 * an A/R that is not an id, a row that is neither an id nor `create`. A split
 * row left at `same`, or not sent, is the one write-off row.
 */
export function setupChoicesFrom(form: FormData): PostingSetupChoices | undefined {
  const read = (name: string): string | undefined => {
    const value = form.get(name);
    return typeof value === 'string' ? value.trim() : undefined;
  };
  const choice = (value: string | undefined): AccountChoice | undefined => {
    if (value === CREATE_ACCOUNT) return { kind: 'create' };
    return value !== undefined && ACCOUNT_ID.test(value) ? { kind: 'existing', accountId: value } : undefined;
  };

  const ar = read('ar');
  const deductionsReceivable = choice(read('deductionsReceivable'));
  const writeoff = choice(read('writeoff'));
  if (ar === undefined || !ACCOUNT_ID.test(ar) || deductionsReceivable === undefined || writeoff === undefined) {
    return undefined;
  }
  const split = (name: string): AccountChoice | undefined => {
    const value = read(name);
    return value === undefined || value === SAME_AS_WRITEOFF ? writeoff : choice(value);
  };
  const writeoffByFamily: Partial<Record<ReasonFamily, AccountChoice>> = {};
  for (const family of REASON_FAMILIES) {
    const slot = split(splitField(family));
    if (slot === undefined) return undefined;
    writeoffByFamily[family] = slot;
  }
  const unclassifiedWriteoff = split(splitField('unclassified'));
  if (unclassifiedWriteoff === undefined) return undefined;
  return {
    ar,
    deductionsReceivable,
    writeoffByFamily: writeoffByFamily as Record<ReasonFamily, AccountChoice>,
    unclassifiedWriteoff,
  };
}

// --- refusals ---------------------------------------------------------------

/** Every way a setup press refuses, by name. Ids and closed-set words only. */
export class PostingSetupError extends Error {}

/**
 * Posting is off: this deployment does not post at all (`QBO_POSTING`), or it
 * cannot build a QuickBooks client for this connection. Nothing was read.
 */
export class PostingSetupOffError extends PostingSetupError {
  override readonly name = 'PostingSetupOffError';
  constructor(
    readonly connectionId: string,
    readonly reason: 'not_posting' | 'no_client',
  ) {
    super(`posting cannot be set up for connection ${connectionId}: ${reason}`);
  }
}

/**
 * Another press of Turn on posting is running: one holds this connection's
 * claim — a double click, or a second owner at the same moment — or presses
 * for other companies hold every connection a claim is held on
 * (`no_connection`). This press read, created and saved nothing; the other
 * one's outcome is on the page once it has ended.
 */
export class PostingSetupBusyError extends PostingSetupError {
  override readonly name = 'PostingSetupBusyError';
  constructor(
    readonly connectionId: string,
    readonly reason: 'held' | 'no_connection',
  ) {
    super(`connection ${connectionId} could not be claimed for setup: ${reason}`);
  }
}

/** The connection already has a map; changing one is the account-map form's. */
export class PostingSetupMappedError extends PostingSetupError {
  override readonly name = 'PostingSetupMappedError';
  constructor(readonly connectionId: string) {
    super(`connection ${connectionId} already has an account map`);
  }
}

/** The company has no active Accounts Receivable account, and we never create one. */
export class PostingSetupNoReceivableError extends PostingSetupError {
  override readonly name = 'PostingSetupNoReceivableError';
  constructor() {
    super('the company has no active Accounts Receivable account');
  }
}

/**
 * An account the form chose is not, on the press's own read, an active
 * account of its row's type. `fields` name the rows, never the accounts.
 */
export class PostingSetupChoiceError extends PostingSetupError {
  override readonly name = 'PostingSetupChoiceError';
  constructor(readonly fields: readonly string[]) {
    super(`not an active account of the right type: ${fields.join(', ')}`);
  }
}

/**
 * One of our two names is taken by an account we may not use: the wrong type,
 * or inactive. We never reactivate, retype or rename it (ADR 0063 §2).
 */
export class PostingSetupNameTakenError extends PostingSetupError {
  override readonly name = 'PostingSetupNameTakenError';
  constructor(
    readonly row: SetupRow,
    readonly reason: 'name_taken_wrong_type' | 'name_taken_inactive',
    readonly accountId: string,
  ) {
    super(`the ${row} name is taken by account ${accountId}: ${reason}`);
  }
}

/**
 * The press would create one of our two accounts, and an account setup made or
 * found for that row before is still in the company's chart — only no longer
 * under our name at the top of it: renamed, or moved under another account,
 * and perhaps made inactive as well (ADR 0063 §2). A second create would put a
 * second account in the customer's books while the first is there, so the
 * press stops before it asks QuickBooks for anything. We never rename it back:
 * the owner chooses it, or another account, under Change accounts, or gives
 * it back its name in QuickBooks. `accountId` is the account already there.
 */
export class PostingSetupRenamedError extends PostingSetupError {
  override readonly name = 'PostingSetupRenamedError';
  constructor(
    readonly row: SetupRow,
    readonly accountId: string,
  ) {
    super(`the ${row} account ${accountId} that setup recorded no longer holds its name at the top of the chart`);
  }
}

/**
 * The company's chart of accounts did not end within the pages a press reads
 * (`CHART_MAX_PAGES`): our two names cannot be looked for in all of it, so
 * nothing was created or saved. Numbers only.
 */
export class PostingSetupChartTooLargeError extends PostingSetupError {
  override readonly name = 'PostingSetupChartTooLargeError';
  constructor(
    readonly pages: number,
    readonly pageSize: number,
  ) {
    super(`the chart of accounts did not end within ${pages} pages of ${pageSize} accounts`);
  }
}

/**
 * QuickBooks created an account, and it did not read back as it was sent. It
 * is in the customer's books all the same, so it was logged and audited by its
 * id before this was thrown. `mismatch` names the fields that differed — `Id`,
 * `Name`, `AccountType`, `Active` — and never what they read.
 */
export class PostingSetupReadBackError extends PostingSetupError {
  override readonly name = 'PostingSetupReadBackError';
  constructor(
    readonly row: SetupRow,
    readonly accountId: string,
    readonly mismatch: readonly AccountReadBackField[],
  ) {
    super(`the ${row} account ${accountId} did not read back as it was created: ${mismatch.join(', ')}`);
  }
}

/**
 * QuickBooks refused a request at a create: a 4xx other than 401 and 429,
 * which are classes of their own. `createAccount` makes two requests — the
 * create, then a read of what it made — and a refusal does not say which one
 * it answered, so whether the account now exists is not known here. Refused
 * outright, it would be refused again on a second press; made and then not
 * read back, a second press finds it, uses it and records it as found. The
 * page the owner lands on reads the chart afresh and shows which. `httpStatus`
 * and `faultCode` are ADR 0060 §6's two; nothing Intuit wrote is kept.
 */
export class PostingSetupCreateRefusedError extends PostingSetupError {
  override readonly name = 'PostingSetupCreateRefusedError';
  constructor(
    readonly row: SetupRow,
    readonly httpStatus: number,
    readonly faultCode: string | undefined,
  ) {
    super(
      `QuickBooks refused to create the ${row} account (HTTP ${httpStatus}` +
        `${faultCode === undefined ? '' : `, fault ${faultCode}`})`,
    );
  }
}

/** Where a press could not ask QuickBooks: ADR 0060 §6's status and fault code, and at a create its row. */
export interface UnreachableAt {
  readonly row?: SetupRow | undefined;
  readonly httpStatus?: number | undefined;
  readonly faultCode?: string | undefined;
}

/**
 * QuickBooks could not be asked, at one step: the chart's read, a create, or
 * the type check before the map is saved. `causeClass` is the error's class
 * name; `httpStatus` and `faultCode` are Intuit's, when it answered at all —
 * never anything it said, which may quote a body. At `create` the answer may
 * have been lost after the account was made: the request is on the audit log,
 * and the next press finds the account and records it as found.
 */
export class PostingSetupUnreachableError extends PostingSetupError {
  override readonly name = 'PostingSetupUnreachableError';
  readonly row: SetupRow | undefined;
  readonly httpStatus: number | undefined;
  readonly faultCode: string | undefined;
  constructor(
    readonly step: 'read_chart' | 'create' | 'save_map',
    readonly causeClass: string,
    at: UnreachableAt = {},
  ) {
    super(`QuickBooks could not be asked at ${step} (${causeClass})`);
    this.row = at.row;
    this.httpStatus = at.httpStatus;
    this.faultCode = at.faultCode;
  }
}

// --- the plan -----------------------------------------------------------------

/** Where one slot of the map comes from: an account the chart has, or one to create. */
export type SetupSlot = { readonly accountId: string } | { readonly create: SetupRow };

export interface PostingSetupPlan {
  readonly arAccountId: string;
  readonly deductionsReceivable: SetupSlot;
  readonly writeoffByFamily: Readonly<Record<ReasonFamily, SetupSlot>>;
  readonly unclassifiedWriteoff: SetupSlot;
  /** What to create, each at most once, in `SETUP_ROWS`' order, so two presses create alike. */
  readonly create: readonly SetupRow[];
}

/**
 * Every row of a press decided against one read of the chart, before anything
 * is created — so a refusal on any row creates nothing on any other. Pure.
 *
 * A chosen account must be active and of its row's type as that read reports
 * it. A `create` is resolved by name, find-first: our account by that name,
 * active and of the right type, is reused; the name taken by anything else
 * refuses; no such name is ours to create — unless an account setup already
 * recorded for that row (`recorded`, created or found) is still in the chart,
 * which then no longer holds our name: renamed, or moved under another
 * account. That refuses too, rather than make a second one.
 */
export function planPostingSetup(
  accounts: readonly QboAccount[],
  choices: PostingSetupChoices,
  recorded: RecordedSetupAccounts,
): PostingSetupPlan {
  const ofType = (account: QboAccount, types: readonly string[]): boolean =>
    account.active && types.includes(account.accountType);
  if (!accounts.some((account) => ofType(account, MAP_ACCOUNT_TYPES.ar))) {
    throw new PostingSetupNoReceivableError();
  }
  const usable = (id: string, types: readonly string[]): boolean =>
    accounts.some((account) => account.id === id && ofType(account, types));

  const wrong: string[] = [];
  const resolved = new Map<SetupRow, RowResolution>();
  const slot = (
    field: string,
    choice: AccountChoice,
    row: SetupRow,
    types: readonly string[],
  ): SetupSlot => {
    if (choice.kind === 'existing') {
      if (!usable(choice.accountId, types)) wrong.push(field);
      return { accountId: choice.accountId };
    }
    const resolution = resolved.get(row) ?? resolveSetupRow(accounts, row);
    resolved.set(row, resolution);
    return resolution.kind === 'existing' ? { accountId: resolution.accountId } : { create: row };
  };

  if (!usable(choices.ar, MAP_ACCOUNT_TYPES.ar)) wrong.push('ar');
  const deductionsReceivable = slot(
    'deductions_receivable',
    choices.deductionsReceivable,
    'deductions_receivable',
    MAP_ACCOUNT_TYPES.deductionsReceivable,
  );
  const writeoffByFamily: Partial<Record<ReasonFamily, SetupSlot>> = {};
  for (const family of REASON_FAMILIES) {
    writeoffByFamily[family] = slot(
      `writeoff.${family}`,
      choices.writeoffByFamily[family],
      'writeoff',
      MAP_ACCOUNT_TYPES.writeoff,
    );
  }
  const unclassifiedWriteoff = slot(
    'writeoff.unclassified',
    choices.unclassifiedWriteoff,
    'writeoff',
    MAP_ACCOUNT_TYPES.writeoff,
  );

  if (wrong.length > 0) throw new PostingSetupChoiceError(wrong);
  for (const row of SETUP_ROWS) {
    const resolution = resolved.get(row);
    if (resolution?.kind === 'blocked') {
      throw new PostingSetupNameTakenError(row, resolution.reason, resolution.accountId);
    }
  }
  const create = SETUP_ROWS.filter((row) => resolved.get(row)?.kind === 'create');
  for (const row of create) {
    // The latest of ours still in the chart, whatever order it was listed in.
    const ours = [...recorded[row]].reverse().find((id) => accounts.some((account) => account.id === id));
    if (ours !== undefined) throw new PostingSetupRenamedError(row, ours);
  }
  return {
    arAccountId: choices.ar,
    deductionsReceivable,
    writeoffByFamily: writeoffByFamily as Record<ReasonFamily, SetupSlot>,
    unclassifiedWriteoff,
    create,
  };
}

// --- the press ------------------------------------------------------------------

/** What a press needs of the posting store, as the member pressing. */
export type PostingSetupStore = Pick<
  PostgresPostingStore,
  | 'memberIsOwner'
  | 'withSetupClaim'
  | 'postingConnections'
  | 'unansweredAccountCreates'
  | 'recordedSetupAccounts'
  | 'recordAccountCreateRequested'
  | 'recordAccountCreated'
  | 'recordAccountFound'
  | 'saveAccountMap'
  | 'setPostingEnabled'
>;

/**
 * How many pages of a thousand accounts a settings request reads of a chart —
 * a press, and the page — before it refuses the chart by name
 * (`QboChartTooLarge`) rather than read on: a chart that ends on its second
 * page, 1,999 accounts at most. It is what lets a press and the page count
 * their requests (ADR 0063 §1, §2).
 */
export const CHART_MAX_PAGES = 2;

/**
 * How long each request a press makes to QuickBooks may wait, where
 * `QboClient` would wait a minute. A press makes at most seven — the chart
 * (`CHART_MAX_PAGES` pages), each of two creates and its read-back, and the
 * type check before the map — after waiting at most
 * `SETUP_CLAIM_CONNECT_TIMEOUT_MS` (10 s) for a connection to hold its claim
 * on, and refreshes the company's token at most once, on bounds of its own: a
 * lock connection (`LOCK_POOL_CONNECT_TIMEOUT_MS`, 30 s), the company's lock
 * (15 s) and Intuit's token call (10 s). So it has asked everything it will ask
 * within 240 s, a minute inside the setup route's `maxDuration`, and a
 * QuickBooks that answers slowly is told to the owner as unreachable rather
 * than cut off by the platform. The account-map route's type check waits the
 * same (ADR 0063 §2).
 */
export const PRESS_REQUEST_TIMEOUT_MS = 25_000;

/** What a press builds each of its QuickBooks clients with, and the account-map route its type check. */
export const PRESS_BOUNDS: QboRequestOptions = Object.freeze({
  timeoutMs: PRESS_REQUEST_TIMEOUT_MS,
  maxPages: CHART_MAX_PAGES,
});

export interface PostingSetupDeps {
  readonly store: PostingSetupStore;
  /** `qboPostingFromEnv()`: nothing means this deployment does not post. */
  readonly poster: QboPoster | undefined;
  /** The member pressing, as the session resolved them. */
  readonly identity: Identity;
}

export interface PostingSetupResult {
  readonly mapId: string;
  /** The accounts this press created, in the order it created them. */
  readonly created: readonly SetupRow[];
}

/**
 * One owner's press (ADR 0063 §2): owner, then the connection's claim, then
 * the chart re-read, then an earlier press's unanswered create settled, then
 * each create find-first and on the record, then the map, then the switch.
 *
 * Throws, by name: `PostingSetupOffError`, `OwnerRequiredError`,
 * `PostingSetupBusyError`, `PostingConnectionNotFoundError`,
 * `PostingSetupMappedError`, `PostingSetupChartTooLargeError`,
 * `PostingSetupNoReceivableError`, `PostingSetupChoiceError`,
 * `PostingSetupNameTakenError`, `PostingSetupRenamedError`,
 * `PostingSetupReadBackError`, `PostingSetupCreateRefusedError`,
 * `PostingSetupUnreachableError`, and whatever the store's own map and switch
 * refuse with (`AccountMapTypeError`, `AccountMapRequiredError`). Anything
 * else is not a refusal and is thrown as it came.
 */
export async function setUpPosting(
  deps: PostingSetupDeps,
  input: { readonly connectionId: string; readonly choices: PostingSetupChoices },
): Promise<PostingSetupResult> {
  const { store, poster, identity } = deps;
  if (poster === undefined) throw new PostingSetupOffError(input.connectionId, 'not_posting');
  // The database's answer, before anything is claimed or QuickBooks asked.
  if (!(await store.memberIsOwner())) throw new OwnerRequiredError(identity.orgId, identity.userId);

  const claim = await store.withSetupClaim(input.connectionId, () =>
    pressHoldingClaim(store, poster, identity, input),
  );
  if (!claim.held) throw new PostingSetupBusyError(input.connectionId, claim.reason);
  return claim.result;
}

/** The press itself, run only while it holds its connection's claim. */
async function pressHoldingClaim(
  store: PostingSetupStore,
  poster: QboPoster,
  identity: Identity,
  input: { readonly connectionId: string; readonly choices: PostingSetupChoices },
): Promise<PostingSetupResult> {
  const connection = (await store.postingConnections()).find(
    (candidate) => candidate.connectionId === input.connectionId,
  );
  if (connection === undefined) throw new PostingConnectionNotFoundError(input.connectionId);
  // Read under the claim, so a press after another one sees the map it saved.
  if (connection.map !== undefined) throw new PostingSetupMappedError(connection.connectionId);

  const listAccounts = poster.accountsFor(identity, connection, PRESS_BOUNDS);
  const createAccount = poster.accountCreatorFor(identity, connection, PRESS_BOUNDS);
  const readAccountTypes = poster.accountTypesFor(identity, connection, PRESS_BOUNDS);
  if (listAccounts === undefined || createAccount === undefined || readAccountTypes === undefined) {
    throw new PostingSetupOffError(connection.connectionId, 'no_client');
  }

  // 1. The chart, re-read. The form said which account or "create" each row
  //    chose; nothing it says about a type or a name is taken from it.
  const accounts = await askQuickBooks('read_chart', listAccounts);
  const context: CreateContext = { store, createAccount, identity, connection };
  //    An earlier press that asked for an account and never heard back is
  //    answered from this read, before anything is planned from it — whatever
  //    this press chose, and whether or not it goes on.
  await settleUnanswered(context, accounts);
  //    Then every row decided, against this read and every account setup has
  //    recorded for this connection, found just now included.
  const plan = planPostingSetup(accounts, input.choices, await store.recordedSetupAccounts(connection.connectionId));

  // 2. Each create, found first by the plan and then made, one at a time.
  const made = new Map<SetupRow, string>();
  for (const row of plan.create) {
    made.set(row, await createOne(context, row));
  }

  // 3. The map, through the one door a map is saved by: it reads every
  //    account's type live again before it writes.
  const idOf = (slot: SetupSlot): string => {
    if ('accountId' in slot) return slot.accountId;
    const id = made.get(slot.create);
    if (id === undefined) throw new Error(`setup planned the ${slot.create} account and did not create it`);
    return id;
  };
  const map: LedgerAccountMap = {
    arAccountId: plan.arAccountId,
    deductionsReceivableAccountId: idOf(plan.deductionsReceivable),
    writeoffByFamily: Object.fromEntries(
      REASON_FAMILIES.map((family) => [family, idOf(plan.writeoffByFamily[family])]),
    ) as Record<ReasonFamily, string>,
    unclassifiedWriteoff: idOf(plan.unclassifiedWriteoff),
  };
  const { mapId } = await askQuickBooks('save_map', () =>
    store.saveAccountMap(connection.connectionId, map, readAccountTypes),
  );

  // 4. The switch, as the switch route turns it: one audit row.
  await store.setPostingEnabled(connection.connectionId, true);
  return { mapId, created: [...made.keys()] };
}

interface CreateContext {
  readonly store: PostingSetupStore;
  readonly createAccount: (spec: SetupAccountSpec, requestId: string) => Promise<QboAccount>;
  readonly identity: Identity;
  readonly connection: PostingConnectionView;
}

/**
 * An earlier press's create that never got an answer, put on the record
 * (ADR 0063 §2). QuickBooks may have made that account and its answer been
 * lost on the way back — a timeout, a 5xx, a reply with no id, a read-back
 * that could not be made, a 4xx that does not say which of the two requests
 * it refused — and then no row names the account's id. So for each row whose
 * latest request has no answer after it (`unansweredAccountCreates`), this
 * press's read is searched for the account that request would have made
 * (`asRequested`). Exactly one is logged, with the request id it answers, and
 * recorded by its id as found (`recordAccountFound`), and never as created:
 * nobody saw it made, and a person could have made it in QuickBooks in
 * between.
 *
 * Anything else leaves the request unanswered: no such account; two, which
 * QuickBooks' unique names rule out and which nothing here could choose
 * between; or one under our name that our request could not have made —
 * inactive, a sub-account, named otherwise than exactly, or of another type.
 * That last is not a refusal: an Other Expense account under the write-off
 * name is one the plan may still use for the map (`resolveSetupRow`), and no
 * `POST /account` of ours made it, because ours sends `Expense`.
 */
async function settleUnanswered(context: CreateContext, accounts: readonly QboAccount[]): Promise<void> {
  const { store, connection } = context;
  const unanswered: readonly UnansweredAccountCreate[] = await store.unansweredAccountCreates(
    connection.connectionId,
  );
  for (const { row, requestId } of unanswered) {
    const [found, another] = accounts.filter((account) => asRequested(account, row));
    if (found === undefined || another !== undefined) continue;
    logAccount(context, { row, accountId: found.id, requestId, how: 'found' });
    await store.recordAccountFound(connection.connectionId, { row, qboAccountId: found.id });
  }
}

/**
 * Whether an account is one our `POST /account` for `row` could have made: a
 * top-level account, active, named and typed exactly as `SETUP_ACCOUNTS`
 * sends them. That is what the create's read-back would have accepted, less
 * the id it never learned.
 */
function asRequested(account: QboAccount, row: SetupRow): boolean {
  const sent = SETUP_ACCOUNTS[row];
  return (
    account.active &&
    account.name === sent.name &&
    account.fullyQualifiedName === sent.name &&
    account.accountType === sent.accountType
  );
}

/**
 * One of our two accounts, made (ADR 0063 §2), and its id.
 *
 * The request goes on the audit log before it is sent — the owner asked again
 * as it is written — so an answer that never arrives still leaves the press
 * that asked, and the request id Intuit holds. Then the create: a fixed name
 * and type, under the request id that row was recorded with — its
 * connection's, its row's and its attempt's — and read back by
 * `createAccount`. An account QuickBooks made is logged by its id before it is
 * audited — one that read back wrong too, which is in the customer's books all
 * the same — so an audit row that cannot be written still leaves the id where
 * a person can find it, and its request unanswered, for the next press that
 * finds the account as it was asked for to record as found
 * (`settleUnanswered`).
 */
async function createOne(context: CreateContext, row: SetupRow): Promise<string> {
  const { store, createAccount, connection } = context;
  const requestId = await store.recordAccountCreateRequested(connection.connectionId, row);

  let account: QboAccount;
  try {
    account = await createAccount(SETUP_ACCOUNTS[row], requestId);
  } catch (error) {
    if (!(error instanceof QboAccountReadBackError)) throw createRefusal(row, error);
    logAccount(context, { row, accountId: error.accountId, requestId, how: 'created', mismatch: error.mismatch });
    await store.recordAccountCreated(connection.connectionId, {
      row,
      qboAccountId: error.accountId,
      readBackMismatch: error.mismatch,
    });
    throw new PostingSetupReadBackError(row, error.accountId, error.mismatch);
  }
  logAccount(context, { row, accountId: account.id, requestId, how: 'created' });
  await store.recordAccountCreated(connection.connectionId, { row, qboAccountId: account.id });
  return account.id;
}

/**
 * The line that says an account is in the customer's books, and how this
 * press knows: it made it (and whether it read back as sent), or it found it
 * as an earlier request that had no answer asked for it. Ids and closed-set
 * words, and the request id the account was asked for under.
 */
function logAccount(
  context: CreateContext,
  at: {
    readonly row: SetupRow;
    readonly accountId: string;
    readonly requestId: string;
    readonly how: 'created' | 'found';
    readonly mismatch?: readonly AccountReadBackField[];
  },
): void {
  const { connection, identity } = context;
  const { row, accountId, requestId, how, mismatch = [] } = at;
  console.info(
    `[recouple] posting setup: ${how} the ${row} account ${accountId} in realm ${connection.realmId} ` +
      (how === 'created'
        ? `under request ${requestId}` +
          (mismatch.length === 0 ? '' : `, and it read back unlike it was sent (${mismatch.join(', ')})`)
        : `as request ${requestId} asked for it, after that request had no answer`) +
      `, connection ${connection.connectionId} org ${identity.orgId}`,
  );
}

/**
 * A create that did not answer with an account, as the refusal it is: a 4xx
 * Intuit gave — to the create, or to the read of what it made, which the
 * refusal does not say — is `PostingSetupCreateRefusedError`; anything else
 * that means QuickBooks could not be asked is `PostingSetupUnreachableError`.
 * After either the account may exist all the same, and the next press finds
 * it by its name and records it. Anything else is returned as it came.
 */
function createRefusal(row: SetupRow, error: unknown): unknown {
  const failure = failureOf(error);
  const status = failure.httpStatus;
  if (error instanceof QboRequestFailed && status !== undefined && status >= 400 && status < 500) {
    return new PostingSetupCreateRefusedError(row, status, failure.faultCode);
  }
  if (!quickBooksUnavailable(error)) return error;
  return new PostingSetupUnreachableError('create', error.name, { row, ...failure });
}

/**
 * Runs one step that reads QuickBooks, turning "it could not be asked" into
 * `PostingSetupUnreachableError`: the class name, status and fault code kept,
 * the words dropped. A chart longer than a press reads is
 * `PostingSetupChartTooLargeError`: QuickBooks answered, and there is more of
 * it than setup looks at.
 */
async function askQuickBooks<T>(
  step: PostingSetupUnreachableError['step'],
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof QboChartTooLarge) throw new PostingSetupChartTooLargeError(error.pages, error.pageSize);
    if (!quickBooksUnavailable(error)) throw error;
    throw new PostingSetupUnreachableError(step, error.name, failureOf(error));
  }
}

/**
 * QuickBooks, or our way to it, could not be used just now: Intuit refused the
 * sign-in, rate-limited us, failed or timed out, or answered with something we
 * cannot read; the company's lock stayed busy, or no connection to take it on
 * was free; the stored sign-in would not open. A class name says which.
 * `QboInvalidAccountSpec`, `QboInvalidId` and their kind are our own mistakes,
 * not QuickBooks being away, and are thrown.
 */
function quickBooksUnavailable(error: unknown): error is Error {
  return (
    error instanceof QboAuthError ||
    error instanceof QboRateLimited ||
    error instanceof QboRequestFailed ||
    error instanceof QboMalformedResponse ||
    error instanceof LedgerAccountBusyError ||
    error instanceof LockPoolTimeoutError ||
    error instanceof CredentialUnreadableError
  );
}

/** An Intuit fault code as ADR 0060 §6 admits one to a log line: a short token, nothing else. */
const FAULT_CODE = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * Intuit's HTTP status and fault code, when a request got that far — the two
 * things ADR 0060 §6 lets a log line carry — and never a body or a message.
 * The posting job reads them the same way (`packages/pipeline`'s `failureOf`).
 */
function failureOf(error: unknown): { readonly httpStatus?: number; readonly faultCode?: string } {
  if (!(error instanceof QboRequestFailed)) return {};
  const fault = error.fault as { Error?: Array<{ code?: unknown }> } | undefined;
  const code = fault?.Error?.[0]?.code;
  return {
    ...(Number.isInteger(error.status) && error.status > 0 ? { httpStatus: error.status } : {}),
    ...(typeof code === 'string' && FAULT_CODE.test(code) ? { faultCode: code } : {}),
  };
}

// --- the page's read ------------------------------------------------------------

/**
 * One connection's chart of accounts as the settings page shows it: the
 * proposal over a live read, or why there is none. `unreadable` has been
 * logged, by class name, where it was found.
 */
export type PostingChart =
  | { readonly kind: 'read'; readonly proposal: PostingSetupProposal }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'not_configured' };

export interface PostingConnectionSetup extends PostingConnectionView {
  readonly chart: PostingChart;
}

/**
 * How long one request of the page's own chart read may wait on QuickBooks,
 * where a press waits `PRESS_REQUEST_TIMEOUT_MS`. The read is optional and
 * the page is not: Connect and Disconnect are on it, and a QuickBooks that
 * stalls rather than fails would otherwise hold them for as long as the read
 * waited. A token refresh the read needs keeps its own bounds — a lock
 * connection at 30 seconds, the company's lock at 15, Intuit's token call at
 * 10 — and is never cut short, since a refresh abandoned half way can cost the
 * customer their connection. With `CHART_MAX_PAGES` pages of a chart, that is
 * 75 s at worst, inside the page's `maxDuration`.
 */
export const CHART_READ_TIMEOUT_MS = 10_000;

/** What the page builds each connection's chart read with. */
export const CHART_READ_BOUNDS: QboRequestOptions = Object.freeze({
  timeoutMs: CHART_READ_TIMEOUT_MS,
  maxPages: CHART_MAX_PAGES,
});

/**
 * Each connection with its chart read live, read-only, for the page to propose
 * from or to change a saved map with (ADR 0063 §1, §4): every enabled
 * connection, on every owner's view, with a map or without. The reads run side
 * by side, so a QuickBooks slow to answer for one company holds the page for
 * that read and not for the sum of them, and each is bounded by
 * `CHART_READ_BOUNDS`.
 */
export async function postingSettingsFor(
  poster: QboPoster,
  identity: Identity,
  connections: readonly PostingConnectionView[],
): Promise<readonly PostingConnectionSetup[]> {
  return Promise.all(
    connections.map(async (connection) => ({
      ...connection,
      chart: await chartFor(poster, identity, connection),
    })),
  );
}

/**
 * One connection's chart, or why there is none.
 *
 * The page's own read, and an optional one. Whatever stops it — QuickBooks
 * failing, or not answering a request within `CHART_READ_TIMEOUT_MS`; a chart
 * longer than `CHART_MAX_PAGES` pages; the company's lock; the stored
 * sign-in; KMS sealing a refreshed token; or a mistake of ours — costs this
 * card and never the page, whose Connect and Disconnect an owner needs most
 * when QuickBooks is failing. So nothing is rethrown: it is logged as an
 * error, by class name and ids only, because what an error says may quote
 * QuickBooks' own answer, and shown as `unreadable`.
 * The press re-reads for itself and throws what it does not recognise.
 */
async function chartFor(
  poster: QboPoster,
  identity: Identity,
  connection: PostingConnectionView,
): Promise<PostingChart> {
  try {
    const listAccounts = poster.accountsFor(identity, connection, CHART_READ_BOUNDS);
    if (listAccounts === undefined) return { kind: 'not_configured' };
    return { kind: 'read', proposal: proposePostingSetup(await listAccounts()) };
  } catch (error) {
    const { httpStatus, faultCode } = failureOf(error);
    console.error(
      `[recouple] posting settings: chart of accounts unreadable (${classOf(error)}` +
        `${httpStatus === undefined ? '' : `, HTTP ${httpStatus}`}` +
        `${faultCode === undefined ? '' : `, fault ${faultCode}`}), ` +
        `connection ${connection.connectionId} org ${identity.orgId}`,
    );
    return { kind: 'unreadable' };
  }
}

/** A class name, as `alerts.ts` admits one: an identifier, nothing longer. */
const CLASS_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;

/** An error's class name when it has one that is an identifier, and nothing it says. */
function classOf(error: unknown): string {
  const name = error instanceof Error ? error.name : undefined;
  return name !== undefined && CLASS_NAME.test(name) ? name : 'unnamed';
}

/**
 * Setting up posting with one press (ADR 0063): a company's chart of accounts
 * as we read it, the two accounts setup may create, and what the settings card
 * proposes to an owner.
 *
 * Nothing here does I/O: every function reads what QuickBooks already
 * answered, or accounts already read — no clock, no network, no model — and
 * no proposal depends on the order QuickBooks listed the chart in. It proposes
 * only accounts it found, active and of the type their row needs, plus the two
 * fixed names in `SETUP_ACCOUNTS` as "we'll create it". It never makes up an
 * id, and it has no way to say "create an A/R account": we never do
 * (ADR 0063 §3).
 */

import { createHash } from 'node:crypto';
import { QboInvalidAccountSpec, QboMalformedResponse, type AccountReadBackField } from './errors';
import { PostingInputError } from './posting';
import { describe, readOptionalString, readString, type JsonObject } from './reader';

/** One account in a company's chart, as `QboClient.listAccounts` reads it. */
export interface QboAccount {
  readonly id: string;
  /** The account's own name: for a sub-account, only its last segment. */
  readonly name: string;
  /** `Parent:Child` for a sub-account; the name itself for a top-level one. */
  readonly fullyQualifiedName: string;
  /** QuickBooks' `AccountType`: the only type anything here checks. */
  readonly accountType: string;
  /** The detail type. Never checked: an accountant may change it (ADR 0063). */
  readonly accountSubType: string | undefined;
  readonly active: boolean;
}

/** The two rows of an account map that setup may create an account for. */
export type SetupRow = 'deductions_receivable' | 'writeoff';

export const SETUP_ROWS: readonly SetupRow[] = Object.freeze(['deductions_receivable', 'writeoff']);

/** What `POST /account` carries for a row. Nothing else is ever sent. */
export interface SetupAccountSpec {
  readonly name: string;
  readonly accountType: string;
  readonly accountSubType: string;
}

/**
 * The only accounts we ever create (ADR 0063 §2–3), fixed here and nowhere
 * else. Nobody types these names, which is why an audit row can name the row
 * and the QuickBooks id and never a name. `QboClient.createAccount` refuses
 * anything that is not one of these exactly.
 */
export const SETUP_ACCOUNTS: Readonly<Record<SetupRow, SetupAccountSpec>> = Object.freeze({
  deductions_receivable: Object.freeze({
    name: 'Deductions Receivable',
    accountType: 'Other Current Asset',
    accountSubType: 'OtherCurrentAssets',
  }),
  writeoff: Object.freeze({
    name: 'Customer Deductions',
    accountType: 'Expense',
    accountSubType: 'OtherMiscellaneousServiceCost',
  }),
});

const ACCOUNTS_RECEIVABLE: readonly string[] = ['Accounts Receivable'];
const OTHER_CURRENT_ASSET: readonly string[] = ['Other Current Asset'];
/** A write-off may land in either, as a map accepts either (ADR 0060 §4). */
const WRITEOFF_TYPES: readonly string[] = ['Expense', 'Other Expense'];

/**
 * The `AccountType`s an existing account may have to be reused for a row. The
 * write-off row reuses an Other Expense account as readily as an Expense one;
 * what we create is always `SETUP_ACCOUNTS`' own type.
 */
const REUSABLE_TYPES: Readonly<Record<SetupRow, readonly string[]>> = {
  deductions_receivable: OTHER_CURRENT_ASSET,
  writeoff: WRITEOFF_TYPES,
};

/**
 * What one row resolves to (ADR 0063 §2): reuse an account found, create the
 * row's account, or stop, because an account we will not touch holds its name.
 * `blocked` names that account so the owner can find it in QuickBooks; it is
 * never an account to post to.
 */
export type RowResolution =
  | { readonly kind: 'existing'; readonly accountId: string }
  | { readonly kind: 'create' }
  | {
      readonly kind: 'blocked';
      readonly reason: 'name_taken_wrong_type' | 'name_taken_inactive';
      readonly accountId: string;
    };

/**
 * The Receivable row. Found or chosen, never created: with no active A/R
 * account the row is `missing` and setup cannot go on (ADR 0063 §1).
 */
export type ArProposal =
  | { readonly kind: 'existing'; readonly accountId: string }
  | { readonly kind: 'choose' }
  | { readonly kind: 'missing' };

/** What the settings card shows an owner arriving with no map (ADR 0063 §1). */
export interface PostingSetupProposal {
  readonly ar: ArProposal;
  readonly deductionsReceivable: RowResolution;
  readonly writeoff: RowResolution;
  /**
   * What each row's dropdown offers: the company's **active** accounts of the
   * types a map accepts there — Accounts Receivable; Other Current Asset; and
   * for a write-off, Expense and Other Expense together — sorted by full name.
   */
  readonly options: {
    readonly ar: QboAccount[];
    readonly otherCurrentAsset: QboAccount[];
    readonly expense: QboAccount[];
  };
}

/**
 * One row of an `Account` query or read, or a loud failure naming the field.
 * Nothing is defaulted: the id must be digits, because it is later spliced into
 * a query and a path, and `Active` must be a JSON boolean, because an account
 * whose state we cannot read is one we could otherwise propose while it is
 * inactive.
 */
export function toQboAccount(row: JsonObject, path: string): QboAccount {
  const id = readAccountId(row, path);
  const active = row['Active'];
  if (typeof active !== 'boolean') {
    throw new QboMalformedResponse(
      `expected true or false at ${path}.Active, got ${describe(active)}`,
      `${path}.Active`,
    );
  }
  return {
    id,
    name: readString(row, 'Name', path),
    fullyQualifiedName: readString(row, 'FullyQualifiedName', path),
    accountType: readString(row, 'AccountType', path),
    accountSubType: readOptionalString(row, 'AccountSubType', path),
    active,
  };
}

/** An account's `Id`, proven to be digits, or `QboMalformedResponse` naming it. */
export function readAccountId(row: JsonObject, path: string): string {
  const id = readString(row, 'Id', path);
  if (!/^\d{1,20}$/.test(id)) {
    throw new QboMalformedResponse(
      `expected an account id of decimal digits at ${path}.Id, got ${describe(id)}`,
      `${path}.Id`,
    );
  }
  return id;
}

/**
 * Which row a spec creates the account for, or `QboInvalidAccountSpec`:
 * `createAccount` sends one of `SETUP_ACCOUNTS`, exactly, or nothing
 * (ADR 0063 §3).
 */
export function setupRowOf(spec: SetupAccountSpec): SetupRow {
  const row = SETUP_ROWS.find((candidate) => {
    const fixed = SETUP_ACCOUNTS[candidate];
    return (
      spec.name === fixed.name &&
      spec.accountType === fixed.accountType &&
      spec.accountSubType === fixed.accountSubType
    );
  });
  if (row === undefined) {
    throw new QboInvalidAccountSpec(
      'only the two accounts in SETUP_ACCOUNTS are ever created (ADR 0063 §3)',
    );
  }
  return row;
}

/**
 * What differs between what `POST /account` sent and the account read back by
 * the id QuickBooks answered with (ADR 0063 §2): the id, the name, the type and
 * `Active`, compared exactly as QuickBooks sent them, so a missing field is a
 * difference rather than a default. The detail type is not compared: an
 * accountant may change it, and our type check reads `AccountType` only.
 */
export function accountReadBackMismatch(
  sent: SetupAccountSpec,
  accountId: string,
  got: JsonObject,
): readonly AccountReadBackField[] {
  const mismatch: AccountReadBackField[] = [];
  if (got['Id'] !== accountId) mismatch.push('Id');
  if (got['Name'] !== sent.name) mismatch.push('Name');
  if (got['AccountType'] !== sent.accountType) mismatch.push('AccountType');
  if (got['Active'] !== true) mismatch.push('Active');
  return mismatch;
}

/**
 * Seeds `postingSetupRequestId`. Changing it changes the request id of every
 * setup create, and a press after the change would no longer be the same
 * request to Intuit as the press before it — so it never changes.
 */
const SETUP_REQUEST_NAMESPACE = 'recouple:qbo:posting-setup:v1';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The `Request-Id` of one attempt at a row's `POST /account` (ADR 0063 §2):
 * derived from the connection, the row and the attempt, and nothing else.
 *
 * `attempt` is how many answers the audit log already holds for that row of
 * that connection — an account a press created, or one it found as a request
 * with no answer had asked for it (`recordAccountCreateRequested` counts
 * them). So a press that sends again a create no answer ever came for — after
 * a timeout, a 5xx — is the same request to Intuit as the one before it (ADR
 * 0060 §3), which Intuit answers rather than making a second account. A
 * create after an answered one is a new request: Intuit cannot answer it with
 * the account the answered one made, which an accountant may have renamed or
 * moved since.
 *
 * A SHA-256 of a fixed namespace, the connection id (lower-cased, so its
 * spelling does not matter), the row and — from the second attempt on — the
 * attempt's number, cut to 128 bits with the version (8) and variant bits set:
 * RFC 9562's shape for a name-based UUID, which is what `assertRequestId`
 * accepts. A first attempt is named by its connection and row alone, as every
 * create was before attempts were counted. Not a secret: it decides nothing.
 */
export function postingSetupRequestId(connectionId: string, row: SetupRow, attempt: number): string {
  if (!UUID.test(connectionId)) {
    throw new PostingInputError('a connection id must be a UUID');
  }
  assertSetupRow(row);
  if (!Number.isSafeInteger(attempt) || attempt < 0) {
    throw new PostingInputError('a setup attempt is a whole number from 0');
  }
  const name = `${SETUP_REQUEST_NAMESPACE}:${connectionId.toLowerCase()}:${row}`;
  const bytes = createHash('sha256')
    .update(attempt === 0 ? name : `${name}:${attempt}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * What one create-able row resolves to against the chart as read, find-first
 * (ADR 0063 §2):
 *
 * - an **active** account holding the row's name, of a type the row accepts,
 *   is reused: `existing`;
 * - otherwise an account holding the name blocks the row — `wrong_type` if one
 *   is active, else `inactive` — because a create would collide with it and we
 *   never reactivate, retype or rename an account: the owner resolves it in
 *   QuickBooks;
 * - no account holding the name means we create it.
 *
 * An account holds a name when it is a **top-level** account named exactly
 * that, in any case. A sub-account's name is only its last segment, and
 * `Assets:Deductions Receivable` is not the account we would create, so it
 * neither blocks the row nor is reused for it. Of several accounts that
 * qualify, the lowest id is named, so the answer does not depend on the order
 * the chart was listed in.
 */
export function resolveSetupRow(accounts: readonly QboAccount[], row: SetupRow): RowResolution {
  assertSetupRow(row);
  assertChart(accounts);
  const name = SETUP_ACCOUNTS[row].name;
  const reusableTypes = REUSABLE_TYPES[row];
  const holders = accounts.filter((account) => holdsName(account, name));

  const reusable = lowestId(
    holders.filter((account) => account.active && reusableTypes.includes(account.accountType)),
  );
  if (reusable !== undefined) return { kind: 'existing', accountId: reusable.id };

  const wrongType = lowestId(holders.filter((account) => account.active));
  if (wrongType !== undefined) {
    return { kind: 'blocked', reason: 'name_taken_wrong_type', accountId: wrongType.id };
  }
  const inactive = lowestId(holders);
  if (inactive !== undefined) {
    return { kind: 'blocked', reason: 'name_taken_inactive', accountId: inactive.id };
  }
  return { kind: 'create' };
}

/**
 * The card an owner sees on arriving with no saved map (ADR 0063 §1), as a
 * pure function of the chart as read:
 *
 * - the Receivable row is the company's one active A/R account, `choose` when
 *   there are several, and `missing` when there is none — never a create;
 * - the Deductions held and Write-offs rows are `resolveSetupRow`'s answers;
 * - each dropdown lists the active accounts of the types its row accepts.
 *
 * Every id it proposes — a row's `existing` and every option — belongs to an
 * active account of the right type. A `blocked` row's id is the account in the
 * way, shown so the owner can find it; it is not offered for posting.
 */
export function proposePostingSetup(accounts: readonly QboAccount[]): PostingSetupProposal {
  assertChart(accounts);
  const ar = activeOf(accounts, ACCOUNTS_RECEIVABLE);
  const [onlyAr] = ar;
  return {
    ar:
      onlyAr === undefined
        ? { kind: 'missing' }
        : ar.length === 1
          ? { kind: 'existing', accountId: onlyAr.id }
          : { kind: 'choose' },
    deductionsReceivable: resolveSetupRow(accounts, 'deductions_receivable'),
    writeoff: resolveSetupRow(accounts, 'writeoff'),
    options: {
      ar,
      otherCurrentAsset: activeOf(accounts, OTHER_CURRENT_ASSET),
      expense: activeOf(accounts, WRITEOFF_TYPES),
    },
  };
}

function assertSetupRow(row: SetupRow): void {
  if (!SETUP_ROWS.includes(row)) {
    throw new PostingInputError('a setup row is deductions_receivable or writeoff');
  }
}

/**
 * Refuses a list that is not a chart: an id that is not digits, or two
 * accounts under one id. Either would let a proposal name an id that also
 * belongs to an account it must not propose.
 */
function assertChart(accounts: readonly QboAccount[]): void {
  const seen = new Set<string>();
  for (const account of accounts) {
    if (!/^\d{1,20}$/.test(account.id)) {
      throw new PostingInputError('an account id must be decimal digits');
    }
    if (seen.has(account.id)) {
      throw new PostingInputError(`two accounts share id ${account.id}`);
    }
    seen.add(account.id);
  }
}

/** A top-level account named exactly `name`, in any case. */
function holdsName(account: QboAccount, name: string): boolean {
  const wanted = name.toLowerCase();
  return (
    account.name.toLowerCase() === wanted && account.fullyQualifiedName.toLowerCase() === wanted
  );
}

function activeOf(accounts: readonly QboAccount[], types: readonly string[]): QboAccount[] {
  return accounts
    .filter((account) => account.active && types.includes(account.accountType))
    .sort(byFullName);
}

/** By full name as a person reads it, case aside; then exactly; then by id. */
function byFullName(a: QboAccount, b: QboAccount): number {
  return (
    compareText(a.fullyQualifiedName.toLowerCase(), b.fullyQualifiedName.toLowerCase()) ||
    compareText(a.fullyQualifiedName, b.fullyQualifiedName) ||
    compareIds(a.id, b.id)
  );
}

function lowestId(accounts: readonly QboAccount[]): QboAccount | undefined {
  return [...accounts].sort((a, b) => compareIds(a.id, b.id))[0];
}

/** Code-unit order: the same answer on every machine, whatever its locale. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Digit strings as numbers, without `Number`: an id may pass 2^53. */
function compareIds(a: string, b: string): number {
  return a.length - b.length || compareText(a, b);
}

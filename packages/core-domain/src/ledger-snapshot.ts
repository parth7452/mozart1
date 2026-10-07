/**
 * A snapshot of the books, as a daily ledger sync keeps it (ADR 0074, ADR 0066
 * §4): the trial balance's rows and the general-ledger postings on the
 * receivable, posting and deductions accounts — and the one definition of the
 * canonical JSON its hash is taken over.
 *
 * **What is kept, and what is not.** A trial-balance row keeps its account's
 * id and name and its two sides in cents. A posting keeps those plus its date,
 * its transaction type, the ledger's id for its transaction and its document
 * number. A memo and the customer or vendor named on a line are **never**
 * kept: they are a third party's words and nothing a tie-out needs. Which
 * postings are kept is `booksAccountRoles`' answer — an account with any role
 * — never the whole ledger (the founder's answer to ADR 0066 §4).
 *
 * **The hash.** `snapshotSha256(content, prevSha256)` is SHA-256 over the
 * canonical JSON of `{ content, prev_sha256 }`: keys sorted by code unit,
 * no whitespace, every amount in cents as a decimal string (so no reader's
 * number type can round one), every absent value as `null`, arrays in the
 * order the ledger printed them. `prev_sha256` is the previous snapshot's hash
 * for the same connection, or `null` for the first, so altering or removing a
 * snapshot breaks every hash after it. A refused snapshot is hashed the same
 * way, over its header and no lines: a gap in the books is a link in the
 * chain, never a hole in it.
 *
 * Pure. The database does not recompute the hash; it checks the chain's head,
 * the counts and the totals, and keeps the rows from which anybody can
 * recompute it (`PostgresLedgerSnapshotStore.snapshotContent`).
 */

import { createHash } from 'node:crypto';
import type { Cents } from './money';
import type { GeneralLedger, TrialBalance } from './books';

/** A snapshot read all three reports, or one of them failed and nothing was kept. */
export type LedgerSnapshotStatus = 'complete' | 'refused';

/** One trial-balance row as kept: cents as decimal strings. */
export interface SnapshotTrialBalanceLine {
  readonly account_external_id: string | null;
  readonly account_name: string;
  readonly debit_cents: string;
  readonly credit_cents: string;
}

/** One general-ledger posting as kept. No memo, no counterparty name. */
export interface SnapshotPostingLine extends SnapshotTrialBalanceLine {
  readonly txn_date: string;
  readonly txn_type: string | null;
  readonly transaction_external_id: string | null;
  readonly doc_number: string | null;
}

/**
 * What a snapshot's hash covers, besides `prev_sha256`: every column the
 * database keeps for it except its own id, sequence, author, timestamp and the
 * two hashes, and every line. snake_case, because these are the column names
 * a person recomputing the hash from the rows will see.
 */
export interface LedgerSnapshotContent {
  readonly format: typeof LEDGER_SNAPSHOT_FORMAT;
  readonly org_id: string;
  readonly connection_id: string;
  readonly run_id: string;
  readonly as_of: string;
  readonly window_from: string;
  readonly window_to: string;
  readonly basis: string | null;
  readonly currency: string | null;
  readonly status: LedgerSnapshotStatus;
  readonly refusal_class: string | null;
  readonly total_debit_cents: string | null;
  readonly total_credit_cents: string | null;
  readonly trial_balance: readonly SnapshotTrialBalanceLine[];
  readonly ledger_postings: readonly SnapshotPostingLine[];
}

/** Names the canonical shape, so a later change to it is a new format, not a silent one. */
export const LEDGER_SNAPSHOT_FORMAT = 'recouple.ledger_snapshot.v1';

/** A class name, as `ledger_snapshots.refusal_class` admits one. */
const CLASS_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** A snapshot that cannot be built as asked. Ids and field names only. */
export class LedgerSnapshotError extends Error {
  override readonly name = 'LedgerSnapshotError';
}

interface SnapshotIds {
  readonly orgId: string;
  readonly connectionId: string;
  readonly runId: string;
  /** The run's window; the trial balance is as of its last day. */
  readonly window: { readonly from: string; readonly to: string };
}

/**
 * The content of a snapshot, from what the sync read.
 *
 * `complete` takes the trial balance as of the window's last day and the
 * general ledger over the window, already narrowed by the caller to the
 * accounts with a role; `refused` takes the class name of the read that
 * failed, and keeps no lines and no totals.
 *
 * Refuses a trial balance whose lines do not add up to its totals — an
 * adapter never returns one, and the database would refuse it too — and an
 * `asOf` or window that is not the run's.
 */
export function buildLedgerSnapshot(
  input: SnapshotIds &
    (
      | {
          readonly status: 'complete';
          readonly trialBalance: TrialBalance;
          readonly generalLedger: GeneralLedger;
        }
      | { readonly status: 'refused'; readonly refusalClass: string }
    ),
): LedgerSnapshotContent {
  const { window } = input;
  if (!ISO_DAY.test(window.from) || !ISO_DAY.test(window.to) || window.from > window.to) {
    throw new LedgerSnapshotError('a snapshot window is two YYYY-MM-DD days, in order');
  }
  const header = {
    format: LEDGER_SNAPSHOT_FORMAT,
    org_id: input.orgId,
    connection_id: input.connectionId,
    run_id: input.runId,
    as_of: window.to,
    window_from: window.from,
    window_to: window.to,
  } as const;

  if (input.status === 'refused') {
    if (!CLASS_NAME.test(input.refusalClass)) {
      throw new LedgerSnapshotError('a refused snapshot carries a class name, never a message');
    }
    return {
      ...header,
      basis: null,
      currency: null,
      status: 'refused',
      refusal_class: input.refusalClass,
      total_debit_cents: null,
      total_credit_cents: null,
      trial_balance: [],
      ledger_postings: [],
    };
  }

  const { trialBalance, generalLedger } = input;
  if (trialBalance.asOf !== window.to) {
    throw new LedgerSnapshotError("a snapshot's trial balance is as of its run's last day");
  }
  if (generalLedger.window.from !== window.from || generalLedger.window.to !== window.to) {
    throw new LedgerSnapshotError("a snapshot's general ledger covers its run's window");
  }
  const trial = trialBalance.lines.map((line) => ({
    account_external_id: line.accountExternalId ?? null,
    account_name: line.accountName,
    debit_cents: centsText(line.debitCents),
    credit_cents: centsText(line.creditCents),
  }));
  const debit = trialBalance.lines.reduce((sum, line) => sum + BigInt(line.debitCents), 0n);
  const credit = trialBalance.lines.reduce((sum, line) => sum + BigInt(line.creditCents), 0n);
  if (
    debit !== BigInt(trialBalance.totalDebitCents) ||
    credit !== BigInt(trialBalance.totalCreditCents)
  ) {
    throw new LedgerSnapshotError("the trial balance's lines do not add up to its totals");
  }
  const postings = generalLedger.accounts.flatMap((account) =>
    account.lines.map((line) => {
      if (!ISO_DAY.test(line.date)) {
        throw new LedgerSnapshotError("a posting's date is YYYY-MM-DD");
      }
      return {
        account_external_id: line.accountExternalId ?? account.accountExternalId ?? null,
        account_name: line.accountName,
        debit_cents: centsText(line.debitCents),
        credit_cents: centsText(line.creditCents),
        txn_date: line.date,
        txn_type: line.transactionType ?? null,
        transaction_external_id: line.transactionExternalId ?? null,
        doc_number: line.documentNumber ?? null,
      };
    }),
  );

  return {
    ...header,
    basis: trialBalance.basis ?? null,
    currency: trialBalance.currency ?? generalLedger.currency ?? null,
    status: 'complete',
    refusal_class: null,
    total_debit_cents: centsText(trialBalance.totalDebitCents),
    total_credit_cents: centsText(trialBalance.totalCreditCents),
    trial_balance: trial,
    ledger_postings: postings,
  };
}

/** SHA-256, hex, over the canonical JSON of `{ content, prev_sha256 }`. */
export function snapshotSha256(content: LedgerSnapshotContent, prevSha256: string | null): string {
  if (prevSha256 !== null && !SHA256_HEX.test(prevSha256)) {
    throw new LedgerSnapshotError('prev_sha256 is 64 lowercase hex, or null for the first');
  }
  return createHash('sha256')
    .update(snapshotCanonicalJson({ content, prev_sha256: prevSha256 }), 'utf8')
    .digest('hex');
}

/**
 * Canonical JSON: keys sorted by code unit at every depth, no whitespace,
 * `JSON.stringify`'s escaping for strings. Admits strings, booleans, `null`,
 * safe integers, arrays and plain objects, and refuses anything else —
 * `undefined` above all, because a key that is sometimes absent and sometimes
 * `null` would hash two ways. A fraction or an unsafe integer is refused too:
 * amounts are passed as strings, and a number that is not an exact integer has
 * no business in a hash.
 */
export function snapshotCanonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(value)) {
        throw new LedgerSnapshotError('canonical JSON admits only safe integers as numbers');
      }
      return String(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(snapshotCanonicalJson).join(',')}]`;
      const proto = Object.getPrototypeOf(value) as unknown;
      if (proto !== Object.prototype && proto !== null) {
        throw new LedgerSnapshotError('canonical JSON admits only plain objects');
      }
      const entries = Object.keys(value as Record<string, unknown>)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        .map((key) => {
          const field = (value as Record<string, unknown>)[key];
          if (field === undefined) {
            throw new LedgerSnapshotError(`canonical JSON has no undefined: ${key}`);
          }
          return `${JSON.stringify(key)}:${snapshotCanonicalJson(field)}`;
        });
      return `{${entries.join(',')}}`;
    }
    default:
      throw new LedgerSnapshotError(`canonical JSON does not admit a ${typeof value}`);
  }
}

function centsText(amount: Cents): string {
  if (!Number.isSafeInteger(amount)) {
    throw new LedgerSnapshotError('an amount in a snapshot is a whole number of cents');
  }
  return String(amount);
}

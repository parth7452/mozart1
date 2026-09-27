/**
 * The QuickBooks bodies a write-back sends, built from `draftEntries` output
 * and the tenant's account map only (ADR 0060 §1). Nothing here reads a
 * document, a clock or the network: the memo is the case id, the canonical
 * reason and our reference; the date is the approval day the caller passes;
 * the reference is stamped from the `writebacks` row id.
 *
 * The draft's `Payer reason as printed:` memo is text off a page (invariant 4)
 * and is never posted: each line's description is the posting memo.
 */

import {
  cents,
  sumCents,
  type AccountRole,
  type Cents,
  type DraftEntry,
  type JournalStage,
  type ReasonFamily,
} from '@recouple/core-domain';
import { QboMalformedResponse } from './errors';
import { assertQboId } from './ids';
import { centsToQboAmount, qboAmountToCents } from './money';
import { readArray, readObject, readString, type JsonObject } from './reader';

/** One `ledger_account_maps` row, as QuickBooks account ids. */
export interface LedgerAccountMap {
  readonly arAccountId: string;
  readonly deductionsReceivableAccountId: string;
  readonly writeoffByFamily: Readonly<Record<ReasonFamily, string>>;
  readonly unclassifiedWriteoff: string;
}

export type PostingSide = 'Debit' | 'Credit';

export interface PostingLine {
  readonly accountId: string;
  readonly side: PostingSide;
  readonly amountCents: Cents;
}

export interface JournalEntryPosting {
  readonly entity: 'JournalEntry';
  readonly customerId: string;
  readonly txnDate: string;
  readonly reference: string;
  readonly memo: string;
  readonly lines: readonly PostingLine[];
  readonly body: JsonObject;
}

export interface ZeroPaymentPosting {
  readonly entity: 'Payment';
  readonly customerId: string;
  readonly txnDate: string;
  readonly reference: string;
  readonly invoiceId: string;
  readonly journalEntryId: string;
  readonly amountCents: Cents;
  readonly body: JsonObject;
}

export type Posting = JournalEntryPosting | ZeroPaymentPosting;

export class PostingInputError extends Error {
  override readonly name = 'PostingInputError';
}

interface Common {
  readonly caseId: string;
  readonly family: ReasonFamily | undefined;
  /** The `writebacks` row id; also the request id. */
  readonly writebackId: string;
  /** The approval day, `YYYY-MM-DD`. Never back-dated, never today's clock. */
  readonly approvedOn: string;
  readonly customerId: string;
}

/**
 * The reference stamped on an entity (`DocNumber`, `PaymentRefNum`): `RC`
 * plus the row id's first 19 hex digits, 21 characters, QuickBooks' limit.
 */
export function postingReference(writebackId: string): string {
  const hex = writebackId.toLowerCase().replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/.test(hex)) {
    throw new PostingInputError('a writeback id must be a UUID');
  }
  return `RC${hex.slice(0, 19)}`;
}

export function postingMemo(caseId: string, family: ReasonFamily | undefined, reference: string): string {
  return `Case ${caseId} | ${family ?? 'unclassified'} | ${reference}`;
}

/** The found posting: the draft's `found` entry, as one JournalEntry. */
export function buildFoundEntry(
  input: Common & { readonly entries: readonly DraftEntry[]; readonly map: LedgerAccountMap },
): JournalEntryPosting {
  return buildEntry(input, ['found']);
}

/**
 * The settlement posting: `recovered` and `written_off` in one entry, and for
 * a declined case never filed, `found` as well (ADR 0060 §1). The draft's
 * `Dr Cash` becomes `Dr AR`: we never debit a cash account.
 */
export function buildSettlementEntry(
  input: Common & {
    readonly entries: readonly DraftEntry[];
    readonly map: LedgerAccountMap;
    readonly includeFound: boolean;
  },
): JournalEntryPosting {
  return buildEntry(input, settlementStages(input.includeFound));
}

/**
 * The zero-total Payment that applies our found entry's credit to the
 * short-paid invoice, so aging does not show both.
 */
export function buildZeroPayment(
  input: Omit<Common, 'family'> & {
    readonly family: ReasonFamily | undefined;
    readonly invoiceId: string;
    readonly journalEntryId: string;
    readonly amountCents: Cents;
  },
): ZeroPaymentPosting {
  const invoiceId = assertQboId(input.invoiceId);
  const journalEntryId = assertQboId(input.journalEntryId);
  const customerId = assertQboId(input.customerId);
  const txnDate = assertDay(input.approvedOn);
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
    throw new PostingInputError('a zero payment applies a positive amount');
  }
  const reference = postingReference(input.writebackId);
  const amount = centsToQboAmount(input.amountCents);
  return {
    entity: 'Payment',
    customerId,
    txnDate,
    reference,
    invoiceId,
    journalEntryId,
    amountCents: input.amountCents,
    body: {
      CustomerRef: { value: customerId },
      TotalAmt: centsToQboAmount(cents(0)),
      TxnDate: txnDate,
      PaymentRefNum: reference,
      PrivateNote: postingMemo(input.caseId, input.family, reference),
      Line: [
        { Amount: amount, LinkedTxn: [{ TxnId: invoiceId, TxnType: 'Invoice' }] },
        { Amount: amount, LinkedTxn: [{ TxnId: journalEntryId, TxnType: 'JournalEntry' }] },
      ],
    },
  };
}

function buildEntry(
  input: Common & { readonly entries: readonly DraftEntry[]; readonly map: LedgerAccountMap },
  stages: readonly JournalStage[],
): JournalEntryPosting {
  const customerId = assertQboId(input.customerId);
  const txnDate = assertDay(input.approvedOn);
  const reference = postingReference(input.writebackId);
  const memo = postingMemo(input.caseId, input.family, reference);

  const lines = entryLines(input.entries, input.map, stages);

  return {
    entity: 'JournalEntry',
    customerId,
    txnDate,
    reference,
    memo,
    lines,
    body: {
      TxnDate: txnDate,
      DocNumber: reference,
      PrivateNote: memo,
      Line: lines.map((line) => ({
        Amount: centsToQboAmount(line.amountCents),
        Description: memo,
        DetailType: 'JournalEntryLineDetail',
        JournalEntryLineDetail: {
          PostingType: line.side,
          AccountRef: { value: line.accountId },
          Entity: { Type: 'Customer', EntityRef: { value: customerId } },
        },
      })),
    },
  };
}

/**
 * The lines an entry posts for these stages, as account ids, sides and cents:
 * what a `writebacks` row stores in `lines` when it is approved, and what the
 * job's rebuilt body must equal before it is sent. Balanced, or refused.
 */
export function entryLines(
  entries: readonly DraftEntry[],
  map: LedgerAccountMap,
  stages: readonly JournalStage[],
): readonly PostingLine[] {
  const lines: PostingLine[] = [];
  for (const entry of entries) {
    if (!stages.includes(entry.stage)) continue;
    for (const line of entry.lines) {
      const accountId = accountFor(line.role, entry.tag, map);
      if (line.debit > 0) lines.push({ accountId, side: 'Debit', amountCents: line.debit });
      if (line.credit > 0) lines.push({ accountId, side: 'Credit', amountCents: line.credit });
    }
  }
  if (lines.length === 0) {
    throw new PostingInputError(`no draft lines for ${stages.join(', ')}`);
  }
  const debits = sumCents(lines.filter((l) => l.side === 'Debit').map((l) => l.amountCents));
  const credits = sumCents(lines.filter((l) => l.side === 'Credit').map((l) => l.amountCents));
  if (debits !== credits) {
    throw new PostingInputError(`the entry does not balance: ${debits} debit, ${credits} credit`);
  }
  return lines;
}

/** The stages a settlement entry carries (ADR 0060 §1). */
export function settlementStages(includeFound: boolean): readonly JournalStage[] {
  return includeFound ? ['found', 'recovered', 'written_off'] : ['recovered', 'written_off'];
}

function accountFor(
  role: AccountRole,
  family: ReasonFamily | undefined,
  map: LedgerAccountMap,
): string {
  switch (role) {
    case 'accounts_receivable':
    case 'cash':
      return assertQboId(map.arAccountId);
    case 'deductions_receivable':
      return assertQboId(map.deductionsReceivableAccountId);
    case 'writeoff_expense':
      return assertQboId(
        family === undefined ? map.unclassifiedWriteoff : map.writeoffByFamily[family],
      );
  }
}

function assertDay(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new PostingInputError('the approval day must be YYYY-MM-DD');
  }
  return value;
}

/**
 * Compares what was sent with what QuickBooks read back: customer, date, each
 * line's account, side and cents in order, and a payment's links. Any
 * difference is named; nothing is reversed.
 */
export function verifyReadBack(
  sent: Posting,
  got: JsonObject,
): 'match' | { readonly mismatch: readonly string[] } {
  const mismatch: string[] = [];
  const check = (what: string, ok: boolean): void => {
    if (!ok) mismatch.push(what);
  };
  try {
    check('TxnDate', got['TxnDate'] === sent.txnDate);
    if (sent.entity === 'JournalEntry') {
      const lines = readArray(got['Line'], 'Line');
      check('Line.length', lines.length === sent.lines.length);
      sent.lines.forEach((want, index) => {
        const raw = lines[index];
        if (raw === undefined) return;
        const path = `Line[${index}]`;
        const line = readObject(raw, path);
        const detail = readObject(line['JournalEntryLineDetail'], `${path}.JournalEntryLineDetail`);
        const account = readObject(detail['AccountRef'], `${path}.AccountRef`);
        const entity = readObject(detail['Entity'], `${path}.Entity`);
        const ref = readObject(entity['EntityRef'], `${path}.Entity.EntityRef`);
        check(`${path}.AccountRef`, readString(account, 'value', path) === want.accountId);
        check(`${path}.PostingType`, detail['PostingType'] === want.side);
        check(`${path}.Amount`, qboAmountToCents(line['Amount'], `${path}.Amount`) === want.amountCents);
        check(`${path}.Entity`, readString(ref, 'value', path) === sent.customerId);
      });
    } else {
      const customer = readObject(got['CustomerRef'], 'CustomerRef');
      check('CustomerRef', readString(customer, 'value', 'CustomerRef') === sent.customerId);
      check('TotalAmt', qboAmountToCents(got['TotalAmt'], 'TotalAmt') === 0);
      const lines = readArray(got['Line'], 'Line').map((raw, index) => readObject(raw, `Line[${index}]`));
      const linked = (type: string, id: string): boolean =>
        lines.some((line, index) => {
          const links = readArray(line['LinkedTxn'], `Line[${index}].LinkedTxn`).map((l) =>
            readObject(l, `Line[${index}].LinkedTxn`),
          );
          return (
            links.length === 1 &&
            links[0]?.['TxnType'] === type &&
            links[0]?.['TxnId'] === id &&
            qboAmountToCents(line['Amount'], `Line[${index}].Amount`) === sent.amountCents
          );
        });
      check('Line.length', lines.length === 2);
      check('Line.Invoice', linked('Invoice', sent.invoiceId));
      check('Line.JournalEntry', linked('JournalEntry', sent.journalEntryId));
    }
  } catch (error) {
    if (error instanceof QboMalformedResponse) {
      mismatch.push(`malformed:${error.fieldPath}`);
    } else {
      throw error;
    }
  }
  return mismatch.length === 0 ? 'match' : { mismatch };
}

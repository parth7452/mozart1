/**
 * `post-writeback`: posts one approved `writebacks` row to QuickBooks and
 * reads it back (ADR 0060 §3). Pure over ports: the store is `app_rw` with
 * the approver's claims, the client is the connection's `QboClient`.
 *
 * It refuses before it builds a request unless the deployment allows posting
 * (`QBO_POSTING`), the member may still write, the connection's switch is on
 * and the row is `pending`. It sends once: a failure after sending is an
 * unknown outcome, recorded `failed`, and only a person retries it. A Payment
 * is sent only after its journal entry verified. Nothing here reads a
 * document; every amount is `draftEntries` output in integer cents.
 */

import { draftEntries, type Cents, type ReasonFamily } from '@recouple/core-domain';
import {
  QboRequestFailed,
  buildFoundEntry,
  buildSettlementEntry,
  buildZeroPayment,
  verifyReadBack,
  type JsonObject,
  type LedgerAccountMap,
  type Posting,
  type PostingLine,
  type QboWriteEntity,
} from '@recouple/qbo';

export interface PostingWriteback {
  readonly writebackId: string;
  readonly deductionId: string;
  readonly decisionId: string;
  readonly schemaId: 'B' | 'S';
  readonly method: 'journal_entry' | 'payment_application';
  readonly status: 'pending' | 'succeeded' | 'failed';
  readonly qboTxnId: string | undefined;
  readonly connectionId: string;
  readonly realmId: string;
  readonly postingEnabled: boolean;
  readonly amountCents: Cents;
  readonly lines: readonly PostingLine[] | undefined;
  readonly caseAmountCents: Cents;
  readonly family: ReasonFamily | undefined;
  readonly outcome: 'won' | 'partial' | 'lost' | 'declined' | undefined;
  readonly recoveredCents: Cents | undefined;
  readonly invoiceId: string | undefined;
  readonly approvedOn: string;
  readonly map: LedgerAccountMap;
  readonly journalEntryId: string | undefined;
}

export interface PostingAttempt {
  readonly writebackId: string;
  readonly status: 'succeeded' | 'failed';
  readonly qboTxnId?: string;
  readonly reason?: string;
  readonly httpStatus?: number;
  readonly faultCode?: string;
  readonly mismatch?: readonly string[];
}

export interface PostingJobStore {
  memberMayWrite(): Promise<boolean>;
  writebackForPosting(writebackId: string): Promise<PostingWriteback | undefined>;
  recordWritebackAttempt(attempt: PostingAttempt): Promise<void>;
}

export interface PostingLedgerClient {
  post(entity: QboWriteEntity, body: JsonObject, requestId: string): Promise<JsonObject>;
  getById(entity: QboWriteEntity, id: string): Promise<JsonObject>;
  /** The invoice's `CustomerRef`, read live: text off a page never picks it. */
  invoiceCustomer(invoiceId: string): Promise<string>;
}

export interface PostingJobDeps {
  /** `qboPostingFromEnv()`'s verdict: false means nothing is built. */
  readonly postingAllowed: boolean;
  readonly store: PostingJobStore;
  clientFor(connection: { readonly connectionId: string; readonly realmId: string }):
    | PostingLedgerClient
    | undefined;
}

export const POSTING_REFUSALS = [
  'not_configured',
  'member_may_not_write',
  'not_found',
  'posting_disabled',
  'not_pending',
  'no_client',
  'no_invoice',
  'entry_not_verified',
  'lines_changed',
] as const;
export type PostingRefusal = (typeof POSTING_REFUSALS)[number];

/** Refused before anything was sent. Settled: repeating it answers the same. */
export class PostingRefusedError extends Error {
  override readonly name = 'PostingRefusedError';
  constructor(
    readonly writebackId: string,
    readonly reason: PostingRefusal,
  ) {
    super(`writeback ${writebackId} was not posted: ${reason}`);
  }
}

/** Sent, and not verified. Recorded `failed`; only a person retries it. */
export class WritebackFailedError extends Error {
  override readonly name = 'WritebackFailedError';
  constructor(
    readonly writebackId: string,
    readonly reason: 'send_failed' | 'unknown_outcome' | 'readback_failed' | 'readback_mismatch',
  ) {
    super(`writeback ${writebackId} failed: ${reason}`);
  }
}

export type PostingJobResult =
  | { readonly status: 'succeeded'; readonly writebackId: string; readonly qboTxnId: string }
  | { readonly status: 'already_succeeded'; readonly writebackId: string; readonly qboTxnId: string | undefined };

export async function postWritebackJob(
  deps: PostingJobDeps,
  input: { readonly writebackId: string },
): Promise<PostingJobResult> {
  const { writebackId } = input;
  const refuse = (reason: PostingRefusal): never => {
    throw new PostingRefusedError(writebackId, reason);
  };
  if (!deps.postingAllowed) refuse('not_configured');
  if (!(await deps.store.memberMayWrite())) refuse('member_may_not_write');
  const row = await deps.store.writebackForPosting(writebackId);
  if (row === undefined) return refuse('not_found');
  if (row.status === 'succeeded') {
    return { status: 'already_succeeded', writebackId, qboTxnId: row.qboTxnId };
  }
  if (!row.postingEnabled) refuse('posting_disabled');
  if (row.status !== 'pending') refuse('not_pending');
  if (row.invoiceId === undefined) return refuse('no_invoice');
  if (row.method === 'payment_application' && row.journalEntryId === undefined) {
    refuse('entry_not_verified');
  }
  const client = deps.clientFor({ connectionId: row.connectionId, realmId: row.realmId });
  if (client === undefined) return refuse('no_client');

  const customerId = await client.invoiceCustomer(row.invoiceId);
  const posting = buildPosting(row, row.invoiceId, customerId);
  if (posting.entity === 'JournalEntry' && !sameLines(posting.lines, row.lines)) {
    refuse('lines_changed');
  }

  let created: JsonObject;
  try {
    created = await client.post(posting.entity, posting.body, writebackId);
  } catch (error) {
    const { httpStatus, faultCode } = failureOf(error);
    // A timeout or a 5xx after sending may have posted: unknown, not retried.
    const reason =
      httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500 ? 'send_failed' : 'unknown_outcome';
    await deps.store.recordWritebackAttempt({
      writebackId,
      status: 'failed',
      reason,
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      ...(faultCode !== undefined ? { faultCode } : {}),
    });
    throw new WritebackFailedError(writebackId, reason);
  }

  const qboTxnId = typeof created['Id'] === 'string' ? created['Id'] : undefined;
  let got: JsonObject;
  try {
    if (qboTxnId === undefined) throw new Error('no Id');
    got = await client.getById(posting.entity, qboTxnId);
  } catch (error) {
    const { httpStatus, faultCode } = failureOf(error);
    await deps.store.recordWritebackAttempt({
      writebackId,
      status: 'failed',
      reason: 'readback_failed',
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      ...(faultCode !== undefined ? { faultCode } : {}),
    });
    throw new WritebackFailedError(writebackId, 'readback_failed');
  }

  const verdict = verifyReadBack(posting, got);
  if (verdict !== 'match') {
    await deps.store.recordWritebackAttempt({
      writebackId,
      status: 'failed',
      reason: 'readback_mismatch',
      mismatch: verdict.mismatch,
    });
    throw new WritebackFailedError(writebackId, 'readback_mismatch');
  }
  await deps.store.recordWritebackAttempt({ writebackId, status: 'succeeded', qboTxnId, reason: 'sent' });
  return { status: 'succeeded', writebackId, qboTxnId };
}

function buildPosting(row: PostingWriteback, invoiceId: string, customerId: string): Posting {
  const common = {
    caseId: row.deductionId,
    family: row.family,
    writebackId: row.writebackId,
    approvedOn: row.approvedOn,
    customerId,
  };
  if (row.method === 'payment_application') {
    return buildZeroPayment({
      ...common,
      invoiceId,
      journalEntryId: row.journalEntryId as string,
      amountCents: row.amountCents,
    });
  }
  const entries = draftEntries({
    amountCents: row.caseAmountCents,
    recoveredCents: row.recoveredCents,
    outcome: row.outcome,
    family: row.family,
  });
  return row.schemaId === 'B'
    ? buildFoundEntry({ ...common, entries, map: row.map })
    : buildSettlementEntry({ ...common, entries, map: row.map, includeFound: row.outcome === 'declined' });
}

function sameLines(built: readonly PostingLine[], stored: readonly PostingLine[] | undefined): boolean {
  if (stored === undefined || stored.length !== built.length) return false;
  return built.every((line, index) => {
    const other = stored[index];
    return (
      other !== undefined &&
      other.accountId === line.accountId &&
      other.side === line.side &&
      other.amountCents === line.amountCents
    );
  });
}

/** The HTTP status and Intuit's fault code, never a body or a message. */
function failureOf(error: unknown): { httpStatus?: number; faultCode?: string } {
  if (!(error instanceof QboRequestFailed)) return {};
  const out: { httpStatus?: number; faultCode?: string } = {};
  if (error.status > 0) out.httpStatus = error.status;
  const fault = error.fault as { Error?: Array<{ code?: unknown }> } | undefined;
  const code = fault?.Error?.[0]?.code;
  if (typeof code === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(code)) out.faultCode = code;
  return out;
}

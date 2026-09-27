import { describe, expect, it } from 'vitest';
import { cents, draftEntries, REASON_FAMILIES } from '@recouple/core-domain';
import { QboRequestFailed, entryLines, type JsonObject, type LedgerAccountMap } from '@recouple/qbo';
import {
  PostingRefusedError,
  WritebackFailedError,
  postWritebackJob,
  type PostingAttempt,
  type PostingLedgerClient,
  type PostingWriteback,
} from '../src/posting-job';

/**
 * The posting job over a fake store and a fake client (ADR 0060 §3). No
 * network: the client is a hand-written object, and nothing is recorded.
 */

const writebackId = '11111111-2222-4333-8444-555555555555';
const map: LedgerAccountMap = {
  arAccountId: '84',
  deductionsReceivableAccountId: '90',
  writeoffByFamily: Object.fromEntries(REASON_FAMILIES.map((f, i) => [f, String(200 + i)])) as never,
  unclassifiedWriteoff: '299',
};
const amount = cents(50_000);

function foundRow(overrides: Partial<PostingWriteback> = {}): PostingWriteback {
  return {
    writebackId,
    deductionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    decisionId: 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    schemaId: 'B',
    method: 'journal_entry',
    status: 'pending',
    qboTxnId: undefined,
    connectionId: 'c0000000-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    realmId: '9130',
    postingEnabled: true,
    amountCents: amount,
    lines: entryLines(draftEntries({ amountCents: amount, family: 'shortage' }), map, ['found']),
    caseAmountCents: amount,
    family: 'shortage',
    outcome: undefined,
    recoveredCents: undefined,
    invoiceId: '71',
    approvedOn: '2026-09-27',
    map,
    journalEntryId: undefined,
    ...overrides,
  };
}

/** What QuickBooks would read back: the body sent, amounts as numbers. */
function echo(id: string, body: JsonObject | undefined): JsonObject {
  return JSON.parse(JSON.stringify({ Id: id, ...body }), (key, value: unknown) =>
    (key === 'Amount' || key === 'TotalAmt') && typeof value === 'string' ? Number(value) : value,
  ) as JsonObject;
}

function harness(row: PostingWriteback | undefined, client: Partial<PostingLedgerClient> = {}) {
  const attempts: PostingAttempt[] = [];
  const posts: Array<{ entity: string; body: JsonObject; requestId: string }> = [];
  let storeTouched = false;
  const fake: PostingLedgerClient = {
    invoiceCustomer: async () => '58',
    post: async (entity, body, requestId) => {
      posts.push({ entity, body, requestId });
      return { Id: '301' };
    },
    getById: async (_entity, id) => echo(id, posts[0]?.body),
    ...client,
  };
  const deps = {
    postingAllowed: true,
    store: {
      memberMayWrite: async () => {
        storeTouched = true;
        return true;
      },
      writebackForPosting: async () => row,
      recordWritebackAttempt: async (attempt: PostingAttempt) => {
        attempts.push(attempt);
      },
    },
    clientFor: () => fake,
  };
  return { deps, attempts, posts, touched: () => storeTouched };
}

describe('post-writeback', () => {
  it('refuses before touching anything when QBO_POSTING is not set', async () => {
    const h = harness(foundRow());
    await expect(
      postWritebackJob({ ...h.deps, postingAllowed: false }, { writebackId }),
    ).rejects.toMatchObject({ reason: 'not_configured' });
    expect(h.touched()).toBe(false);
    expect(h.posts).toHaveLength(0);
  });

  it('refuses a member who may no longer write, and a connection whose switch is off', async () => {
    const h = harness(foundRow());
    await expect(
      postWritebackJob(
        { ...h.deps, store: { ...h.deps.store, memberMayWrite: async () => false } },
        { writebackId },
      ),
    ).rejects.toMatchObject({ reason: 'member_may_not_write' });
    const off = harness(foundRow({ postingEnabled: false }));
    await expect(postWritebackJob(off.deps, { writebackId })).rejects.toBeInstanceOf(PostingRefusedError);
    expect(off.posts).toHaveLength(0);
  });

  it('posts once with the row id as the request id, reads it back and records succeeded', async () => {
    const h = harness(foundRow());
    const result = await postWritebackJob(h.deps, { writebackId });
    expect(result).toEqual({ status: 'succeeded', writebackId, qboTxnId: '301' });
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]?.requestId).toBe(writebackId);
    expect(h.posts[0]?.entity).toBe('JournalEntry');
    expect(JSON.stringify(h.posts[0]?.body)).not.toMatch(/Payer reason as printed/);
    expect(h.attempts).toEqual([
      { writebackId, status: 'succeeded', qboTxnId: '301', reason: 'sent' },
    ]);
  });

  it('records a 5xx as an unknown outcome, never resends, and names the fault code only', async () => {
    let calls = 0;
    const h = harness(foundRow(), {
      post: async () => {
        calls += 1;
        throw new QboRequestFailed('server error with a body', 503, {
          Error: [{ code: '6000', Detail: 'a customer name' }],
        });
      },
    });
    await expect(postWritebackJob(h.deps, { writebackId })).rejects.toBeInstanceOf(WritebackFailedError);
    expect(calls).toBe(1);
    expect(h.attempts).toEqual([
      { writebackId, status: 'failed', reason: 'unknown_outcome', httpStatus: 503, faultCode: '6000' },
    ]);
  });

  it('records a read-back that disagrees as readback_mismatch', async () => {
    const h = harness(foundRow(), {
      getById: async () => ({ Id: '301', TxnDate: '2026-01-01', Line: [] }),
    });
    await expect(postWritebackJob(h.deps, { writebackId })).rejects.toMatchObject({
      reason: 'readback_mismatch',
    });
    expect(h.attempts[0]).toMatchObject({ status: 'failed', reason: 'readback_mismatch' });
  });

  it('refuses stored lines that differ from the rebuilt entry, before sending', async () => {
    const h = harness(foundRow({ lines: [] }));
    await expect(postWritebackJob(h.deps, { writebackId })).rejects.toMatchObject({
      reason: 'lines_changed',
    });
    expect(h.posts).toHaveLength(0);
  });

  it('sends a payment only after its journal entry verified', async () => {
    const pending = harness(foundRow({ method: 'payment_application', lines: undefined }));
    await expect(postWritebackJob(pending.deps, { writebackId })).rejects.toMatchObject({
      reason: 'entry_not_verified',
    });
    expect(pending.posts).toHaveLength(0);

    const ready = harness(
      foundRow({ method: 'payment_application', lines: undefined, journalEntryId: '301' }),
      { post: async (_e, body) => ({ Id: '302', ...body }), getById: async () => ({}) },
    );
    ready.deps.clientFor = () => ({
      invoiceCustomer: async () => '58',
      post: async (entity, body, requestId) => {
        ready.posts.push({ entity, body, requestId });
        return { Id: '302' };
      },
      getById: async () => echo('302', ready.posts[0]?.body),
    });
    await expect(postWritebackJob(ready.deps, { writebackId })).resolves.toMatchObject({
      status: 'succeeded',
      qboTxnId: '302',
    });
    expect(ready.posts[0]?.entity).toBe('Payment');
  });

  it('answers an already-succeeded row without sending', async () => {
    const h = harness(foundRow({ status: 'succeeded', qboTxnId: '301' }));
    await expect(postWritebackJob(h.deps, { writebackId })).resolves.toMatchObject({
      status: 'already_succeeded',
    });
    expect(h.posts).toHaveLength(0);
  });
});

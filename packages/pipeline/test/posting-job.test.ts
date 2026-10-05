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
    findByReference: async () => [],
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
      findByReference: async () => [],
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

  describe('a person\'s retry reads back by reference first', () => {
    async function sentBody(): Promise<JsonObject> {
      const first = harness(foundRow());
      await postWritebackJob(first.deps, { writebackId });
      return first.posts[0]!.body;
    }

    it('finds the entry already posted and sends nothing', async () => {
      const body = await sentBody();
      const references: string[] = [];
      const h = harness(foundRow(), {
        findByReference: async (_entity, reference) => {
          references.push(reference);
          return [echo('301', body)];
        },
      });
      await expect(postWritebackJob(h.deps, { writebackId, retry: true })).resolves.toMatchObject({
        status: 'succeeded',
        qboTxnId: '301',
      });
      expect(references).toEqual([`RC${writebackId.replace(/-/g, '').slice(0, 19)}`]);
      expect(h.posts).toHaveLength(0);
      expect(h.attempts).toEqual([
        { writebackId, status: 'succeeded', qboTxnId: '301', reason: 'found_on_retry' },
      ]);
    });

    it('sends again with the same request id when nothing carries the reference', async () => {
      const h = harness(foundRow());
      await expect(postWritebackJob(h.deps, { writebackId, retry: true })).resolves.toMatchObject({
        status: 'succeeded',
      });
      expect(h.posts.map((p) => p.requestId)).toEqual([writebackId]);
    });

    it('refuses two entities carrying one reference', async () => {
      const body = await sentBody();
      const h = harness(foundRow(), {
        findByReference: async () => [echo('301', body), echo('305', body)],
      });
      await expect(postWritebackJob(h.deps, { writebackId, retry: true })).rejects.toBeInstanceOf(
        WritebackFailedError,
      );
      expect(h.posts).toHaveLength(0);
      expect(h.attempts[0]).toMatchObject({ status: 'failed', reason: 'ambiguous_reference' });
    });

    it('a first send never looks', async () => {
      let looked = false;
      const h = harness(foundRow(), {
        findByReference: async () => {
          looked = true;
          return [];
        },
      });
      await postWritebackJob(h.deps, { writebackId });
      expect(looked).toBe(false);
    });
  });
});

/**
 * ADR 0068 §6: a settlement decision that carries its own lines is posted
 * from them. The computed entry for this case would be Dr 200 (shortage
 * write-off) / Cr 90; the stored lines send the write-off somewhere else.
 */
describe('post-writeback, a settlement with stored lines', () => {
  const stored = [
    { accountId: '300', side: 'Debit' as const, amountCents: cents(30_000), memo: 'Agreed with the buyer' },
    { accountId: '305', side: 'Debit' as const, amountCents: cents(20_000) },
    { accountId: '90', side: 'Credit' as const, amountCents: amount },
  ];
  const rowCopy = stored.map(({ accountId, side, amountCents }) => ({ accountId, side, amountCents }));

  function settlementRow(overrides: Partial<PostingWriteback> = {}): PostingWriteback {
    return foundRow({
      schemaId: 'S',
      outcome: 'lost',
      recoveredCents: cents(0),
      lines: rowCopy,
      settlementLines: stored,
      ...overrides,
    });
  }

  const sentLines = (body: JsonObject | undefined) =>
    ((body?.['Line'] ?? []) as JsonObject[]).map((line) => {
      const detail = line['JournalEntryLineDetail'] as JsonObject;
      return [
        (detail['AccountRef'] as JsonObject)['value'],
        detail['PostingType'],
        line['Amount'],
        line['Description'],
      ];
    });

  it('sends the stored lines in order with their memos, never the computed ones', async () => {
    const h = harness(settlementRow());
    await expect(postWritebackJob(h.deps, { writebackId })).resolves.toMatchObject({ status: 'succeeded' });
    expect(h.posts).toHaveLength(1);
    const ours = h.posts[0]?.body['PrivateNote'];
    expect(sentLines(h.posts[0]?.body)).toEqual([
      ['300', 'Debit', '300.00', 'Agreed with the buyer'],
      ['305', 'Debit', '200.00', ours],
      ['90', 'Credit', '500.00', ours],
    ]);
    // The account `draftEntries` and the map would have used is not in it.
    expect(JSON.stringify(h.posts[0]?.body)).not.toContain('"value":"200"');
    expect(h.attempts).toEqual([{ writebackId, status: 'succeeded', qboTxnId: '301', reason: 'sent' }]);
  });

  it('ignores a map that has changed since: the stored lines are what was approved', async () => {
    const h = harness(settlementRow({ map: { ...map, deductionsReceivableAccountId: '91', unclassifiedWriteoff: '1' } }));
    await postWritebackJob(h.deps, { writebackId });
    expect(sentLines(h.posts[0]?.body).map(([account]) => account)).toEqual(['300', '305', '90']);
  });

  it('refuses before sending when the stored lines differ from the row\'s copy', async () => {
    const h = harness(settlementRow({ lines: [rowCopy[0]!, { ...rowCopy[1]!, accountId: '306' }, rowCopy[2]!] }));
    await expect(postWritebackJob(h.deps, { writebackId })).rejects.toMatchObject({ reason: 'lines_changed' });
    expect(h.posts).toHaveLength(0);
    const computed = harness(
      settlementRow({ lines: entryLines(draftEntries({ amountCents: amount, outcome: 'lost', family: 'shortage' }), map, ['written_off']) }),
    );
    await expect(postWritebackJob(computed.deps, { writebackId })).rejects.toMatchObject({ reason: 'lines_changed' });
    expect(computed.posts).toHaveLength(0);
  });

  it('reads back against the stored lines: QuickBooks holding another account is a mismatch', async () => {
    const h = harness(settlementRow(), {
      getById: async (_entity, id) => {
        const got = echo(id, h.posts[0]?.body) as { Line: Array<{ JournalEntryLineDetail: { AccountRef: { value: string } } }> };
        got.Line[0]!.JournalEntryLineDetail.AccountRef.value = '200';
        return got as unknown as JsonObject;
      },
    });
    await expect(postWritebackJob(h.deps, { writebackId })).rejects.toMatchObject({ reason: 'readback_mismatch' });
    expect(h.attempts).toEqual([
      { writebackId, status: 'failed', reason: 'readback_mismatch', mismatch: ['Line[0].AccountRef'] },
    ]);
  });

  it('never puts a memo in what it records about an attempt', async () => {
    const h = harness(settlementRow(), {
      getById: async () => ({ Id: '301', TxnDate: '2026-01-01', Line: [] }),
    });
    await expect(postWritebackJob(h.deps, { writebackId })).rejects.toBeInstanceOf(WritebackFailedError);
    expect(JSON.stringify(h.attempts)).not.toContain('Agreed');
  });

  it('a settlement with no stored lines is posted from the computed ones, as before', async () => {
    const lines = entryLines(
      draftEntries({ amountCents: amount, outcome: 'lost', recoveredCents: cents(0), family: 'shortage' }),
      map,
      ['recovered', 'written_off'],
    );
    const h = harness(settlementRow({ settlementLines: undefined, lines }));
    await postWritebackJob(h.deps, { writebackId });
    expect(sentLines(h.posts[0]?.body).map(([account, side]) => [account, side])).toEqual([
      ['200', 'Debit'],
      ['90', 'Credit'],
    ]);
  });
});

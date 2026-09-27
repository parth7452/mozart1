import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { cents, draftEntries, type ReasonFamily } from '@recouple/core-domain';
import { QboClient } from '../src/client';
import { toLedgerPayment } from '../src/map';
import { centsToQboAmount, qboAmountToCents } from '../src/money';
import {
  buildFoundEntry,
  buildSettlementEntry,
  buildZeroPayment,
  postingReference,
  verifyReadBack,
  type LedgerAccountMap,
} from '../src/posting';
import type { JsonObject } from '../src/reader';
import { configFor, fixture, jsonResponse, recordingFetch } from './helpers';

// Synthetic fixtures (test/fixtures/posting/README.md): nothing here was recorded.

const FAMILIES: readonly ReasonFamily[] = [
  'promotion', 'freight', 'shortage', 'pricing', 'compliance',
  'returns', 'quality', 'duplicate', 'post_audit', 'other',
];
const MAP: LedgerAccountMap = {
  arAccountId: '1100',
  deductionsReceivableAccountId: '4001',
  writeoffByFamily: Object.fromEntries(FAMILIES.map((f, i) => [f, String(6000 + i)])) as Record<
    ReasonFamily,
    string
  >,
  unclassifiedWriteoff: '6999',
};
const CASE = '7c1e2c1e-0000-4000-8000-000000000001';
const ROW = '11111111-2222-3333-4444-555555555555';
const PAY_ROW = '55555555-6666-7777-8888-999999999999';
const DAY = '2026-09-27';

function found() {
  return buildFoundEntry({
    entries: draftEntries({ amountCents: cents(127000), family: 'shortage' }),
    map: MAP,
    caseId: CASE,
    family: 'shortage',
    writebackId: ROW,
    approvedOn: DAY,
    customerId: '58',
  });
}

function created(name: string, entity: string): JsonObject {
  return (fixture(`posting/${name}`) as Record<string, JsonObject>)[entity] as JsonObject;
}

describe('centsToQboAmount', () => {
  it('formats cents with string digits', () => {
    expect(centsToQboAmount(cents(0))).toBe('0.00');
    expect(centsToQboAmount(cents(5))).toBe('0.05');
    expect(centsToQboAmount(cents(123450))).toBe('1234.50');
    expect(centsToQboAmount(cents(-5))).toBe('-0.05');
    expect(() => centsToQboAmount(0.5 as never)).toThrow();
  });

  it('round-trips with qboAmountToCents', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1e13, max: 1e13 }), (n) => {
        const text = centsToQboAmount(cents(n));
        expect(qboAmountToCents(Number(text), 'x')).toBe(n);
      }),
    );
  });
});

describe('posting bodies', () => {
  it('found: Dr Deductions Receivable / Cr AR, memo holds no page text, reference from the row', () => {
    const entry = buildFoundEntry({
      entries: draftEntries({ amountCents: cents(127000), printedReasonCode: 'IGNORE ME' }),
      map: MAP,
      caseId: CASE,
      family: undefined,
      writebackId: ROW,
      approvedOn: DAY,
      customerId: '58',
    });
    expect(entry.reference).toBe(postingReference(ROW));
    expect(entry.reference).toHaveLength(21);
    expect(entry.body['DocNumber']).toBe(entry.reference);
    expect(entry.lines).toEqual([
      { accountId: '4001', side: 'Debit', amountCents: 127000 },
      { accountId: '1100', side: 'Credit', amountCents: 127000 },
    ]);
    expect(JSON.stringify(entry.body)).not.toContain('IGNORE ME');
    expect(entry.memo).toContain(CASE);
  });

  it('settlement of a partial is one entry of four lines, AR in place of cash', () => {
    const entry = buildSettlementEntry({
      entries: draftEntries({
        amountCents: cents(127000),
        recoveredCents: cents(100000),
        outcome: 'partial',
        family: 'freight',
      }),
      map: MAP,
      includeFound: false,
      caseId: CASE,
      family: 'freight',
      writebackId: ROW,
      approvedOn: DAY,
      customerId: '58',
    });
    expect(entry.lines).toEqual([
      { accountId: '1100', side: 'Debit', amountCents: 100000 },
      { accountId: '4001', side: 'Credit', amountCents: 100000 },
      { accountId: '6001', side: 'Debit', amountCents: 27000 },
      { accountId: '4001', side: 'Credit', amountCents: 27000 },
    ]);
  });

  it('a declined case carries the found lines too', () => {
    const entry = buildSettlementEntry({
      entries: draftEntries({ amountCents: cents(500), outcome: 'declined' }),
      map: MAP,
      includeFound: true,
      caseId: CASE,
      family: undefined,
      writebackId: ROW,
      approvedOn: DAY,
      customerId: '58',
    });
    expect(entry.lines.map((l) => l.accountId)).toEqual(['4001', '1100', '6999', '4001']);
  });
});

describe('verifyReadBack', () => {
  it('matches the entry QuickBooks echoed', () => {
    expect(verifyReadBack(found(), created('journalentry-created.json', 'JournalEntry'))).toBe('match');
  });

  it('names every difference', () => {
    const got = structuredClone(created('journalentry-created.json', 'JournalEntry')) as {
      TxnDate: string;
      Line: { Amount: number }[];
    };
    got.TxnDate = '2026-09-26';
    got.Line[1]!.Amount = 1269.99;
    expect(verifyReadBack(found(), got as unknown as JsonObject)).toEqual({
      mismatch: ['TxnDate', 'Line[1].Amount'],
    });
  });

  it('checks a zero payment links our entry and the invoice', () => {
    const sent = buildZeroPayment({
      caseId: CASE,
      family: 'shortage',
      writebackId: PAY_ROW,
      approvedOn: DAY,
      customerId: '58',
      invoiceId: '145',
      journalEntryId: '901',
      amountCents: cents(127000),
    });
    const got = created('payment-zero.json', 'Payment');
    expect(verifyReadBack(sent, got)).toBe('match');
    expect(verifyReadBack({ ...sent, journalEntryId: '900' }, got)).toEqual({
      mismatch: ['Line.JournalEntry'],
    });
  });
});

describe('zero payment in the sync', () => {
  it('pairs the JournalEntry line as a credit: no cash reaches the invoice', () => {
    const payment = toLedgerPayment(created('payment-zero.json', 'Payment'), 'Payment[0]');
    expect(payment.totalCents).toBe(0);
    expect(payment.appliedTo).toEqual([]);
  });
});

describe('QboClient writes', () => {
  it('sends the caller request id as query param and header, and reuses it on a retry', async () => {
    let attempt = 0;
    const recorder = recordingFetch(() => {
      attempt += 1;
      return attempt === 1
        ? jsonResponse({ Fault: { Error: [{ code: '6000' }] } }, 503)
        : jsonResponse(fixture('posting/journalentry-created.json'));
    });
    const client = new QboClient(configFor(recorder.fetchImpl));
    const entry = found();
    await expect(client.post('JournalEntry', entry.body, ROW)).rejects.toThrow();
    const got = await client.post('JournalEntry', entry.body, ROW);
    expect(got['Id']).toBe('901');
    expect(recorder.calls).toHaveLength(2);
    for (const call of recorder.calls) {
      expect(call.method).toBe('POST');
      expect(new URL(call.url).pathname).toMatch(/\/journalentry$/);
      expect(new URL(call.url).searchParams.get('requestid')).toBe(ROW);
      expect(call.headers.get('Request-Id')).toBe(ROW);
      expect(JSON.parse(call.body ?? '')).toEqual(entry.body);
    }
  });

  it('refuses a request id that is not a UUID', async () => {
    const recorder = recordingFetch(() => jsonResponse({}));
    const client = new QboClient(configFor(recorder.fetchImpl));
    await expect(client.post('Payment', {}, 'nope')).rejects.toThrow(/UUID/);
    expect(recorder.calls).toHaveLength(0);
  });

  it('reads back by id with a fresh request id', async () => {
    const recorder = recordingFetch(() => jsonResponse(fixture('posting/payment-zero.json')));
    const client = new QboClient(configFor(recorder.fetchImpl));
    const got = await client.getById('Payment', '902');
    expect(got['Id']).toBe('902');
    const [call] = recorder.calls;
    expect(new URL(call!.url).pathname).toMatch(/\/payment\/902$/);
    expect(call!.headers.get('Request-Id')).not.toBe(ROW);
  });
});

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  LEDGER_SNAPSHOT_FORMAT,
  LedgerSnapshotError,
  buildLedgerSnapshot,
  cents,
  snapshotCanonicalJson,
  snapshotSha256,
  type GeneralLedger,
  type TrialBalance,
} from '../src/index';

/**
 * A snapshot of the books (ADR 0074): what is kept, and the one definition of
 * the canonical JSON its hash covers. The properties that matter are the two a
 * post-audit leans on — the same snapshot always hashes the same, however its
 * keys happened to be ordered, and any change to any line or to the chain
 * changes the hash.
 */

const IDS = {
  orgId: '11111111-1111-1111-1111-111111111111',
  connectionId: '33333333-3333-3333-3333-333333333333',
  runId: '44444444-4444-4444-4444-444444444444',
  window: { from: '2026-09-03', to: '2026-10-07' },
};

function trialBalance(): TrialBalance {
  return {
    sourceKind: 'qbo',
    asOf: '2026-10-07',
    basis: 'Accrual',
    currency: 'USD',
    lines: [
      { accountExternalId: '84', accountName: 'Accounts Receivable', debitCents: cents(1_250_000), creditCents: cents(0) },
      { accountExternalId: '79', accountName: 'Sales', debitCents: cents(0), creditCents: cents(1_000_000) },
      { accountName: 'Promotional Allowances', debitCents: cents(0), creditCents: cents(250_000) },
    ],
    totalDebitCents: cents(1_250_000),
    totalCreditCents: cents(1_250_000),
  };
}

function generalLedger(): GeneralLedger {
  return {
    sourceKind: 'qbo',
    window: IDS.window,
    currency: 'USD',
    accounts: [
      {
        accountExternalId: '84',
        accountName: 'Accounts Receivable',
        lines: [
          {
            accountName: 'Accounts Receivable',
            date: '2026-09-10',
            transactionType: 'Payment',
            transactionExternalId: '128',
            documentNumber: 'ACH-55512',
            name: 'Sysco Baltimore, LLC',
            memo: 'short paid, see remittance',
            debitCents: cents(0),
            creditCents: cents(920_000),
          },
        ],
      },
    ],
  };
}

function complete() {
  return buildLedgerSnapshot({
    ...IDS,
    status: 'complete',
    trialBalance: trialBalance(),
    generalLedger: generalLedger(),
  });
}

/** The same value with every object's keys in a shuffled order. */
function shuffled(value: unknown, seed: number): unknown {
  if (Array.isArray(value)) return value.map((item, i) => shuffled(item, seed + i));
  if (value === null || typeof value !== 'object') return value;
  const keys = Object.keys(value as Record<string, unknown>);
  const order = keys
    .map((key, i) => ({ key, rank: (Math.imul(seed + 1, i + 7919) >>> 0) % 1009 }))
    .sort((a, b) => a.rank - b.rank)
    .map(({ key }) => key);
  return Object.fromEntries(
    order.map((key) => [key, shuffled((value as Record<string, unknown>)[key], seed + 3)]),
  );
}

describe('buildLedgerSnapshot', () => {
  it('keeps the trial balance and the postings in cents as strings, and no memo or name', () => {
    const content = complete();
    expect(content.format).toBe(LEDGER_SNAPSHOT_FORMAT);
    expect(content.as_of).toBe('2026-10-07');
    expect(content.total_debit_cents).toBe('1250000');
    expect(content.trial_balance[2]).toEqual({
      account_external_id: null,
      account_name: 'Promotional Allowances',
      debit_cents: '0',
      credit_cents: '250000',
    });
    expect(content.ledger_postings).toEqual([
      {
        account_external_id: '84',
        account_name: 'Accounts Receivable',
        debit_cents: '0',
        credit_cents: '920000',
        txn_date: '2026-09-10',
        txn_type: 'Payment',
        transaction_external_id: '128',
        doc_number: 'ACH-55512',
      },
    ]);
    const text = snapshotCanonicalJson(content);
    expect(text).not.toContain('Sysco');
    expect(text).not.toContain('short paid');
  });

  it('keeps a refused read as a class name, no totals and no lines', () => {
    const content = buildLedgerSnapshot({ ...IDS, status: 'refused', refusalClass: 'QboReportTooLarge' });
    expect(content).toMatchObject({
      status: 'refused',
      refusal_class: 'QboReportTooLarge',
      total_debit_cents: null,
      trial_balance: [],
      ledger_postings: [],
    });
    expect(() =>
      buildLedgerSnapshot({ ...IDS, status: 'refused', refusalClass: 'report too large: 20001 lines' }),
    ).toThrow(LedgerSnapshotError);
  });

  it('refuses a trial balance whose lines do not add up, or one not as of the run’s last day', () => {
    expect(() =>
      buildLedgerSnapshot({
        ...IDS,
        status: 'complete',
        trialBalance: { ...trialBalance(), totalCreditCents: cents(1_250_001) },
        generalLedger: generalLedger(),
      }),
    ).toThrow(/do not add up/);
    expect(() =>
      buildLedgerSnapshot({
        ...IDS,
        status: 'complete',
        trialBalance: { ...trialBalance(), asOf: '2026-10-06' },
        generalLedger: generalLedger(),
      }),
    ).toThrow(/last day/);
    expect(() =>
      buildLedgerSnapshot({
        ...IDS,
        status: 'complete',
        trialBalance: trialBalance(),
        generalLedger: { ...generalLedger(), window: { from: '2026-09-04', to: '2026-10-07' } },
      }),
    ).toThrow(/window/);
  });
});

describe('snapshotSha256', () => {
  it('is 64 hex, chains on prev_sha256, and refuses a malformed prev', () => {
    const first = snapshotSha256(complete(), null);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    const second = snapshotSha256(complete(), first);
    expect(second).not.toBe(first);
    expect(() => snapshotSha256(complete(), 'ABC')).toThrow(LedgerSnapshotError);
  });

  it('is stable under the order of every object’s keys', () => {
    const content = complete();
    const prev = snapshotSha256(content, null);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000 }), (seed) => {
        const reordered = shuffled(content, seed) as typeof content;
        expect(snapshotCanonicalJson(reordered)).toBe(snapshotCanonicalJson(content));
        expect(snapshotSha256(reordered, prev)).toBe(snapshotSha256(content, prev));
      }),
    );
  });

  it('changes when any field of any line changes', () => {
    const content = complete();
    const base = snapshotSha256(content, null);
    const lines = [
      ...content.trial_balance.map((_, i) => ['trial_balance', i] as const),
      ...content.ledger_postings.map((_, i) => ['ledger_postings', i] as const),
    ];
    fc.assert(
      fc.property(
        fc.constantFrom(...lines),
        fc.constantFrom('account_name', 'debit_cents', 'credit_cents', 'account_external_id'),
        fc.integer({ min: 1, max: 1_000_000 }),
        ([kind, index], field, bump) => {
          const list = content[kind].map((line, i) =>
            i !== index
              ? line
              : {
                  ...line,
                  [field]:
                    field === 'debit_cents' || field === 'credit_cents'
                      ? String(BigInt(line[field]) + BigInt(bump))
                      : `${line[field] ?? ''}~${bump}`,
                },
          );
          const changed = { ...content, [kind]: list };
          expect(snapshotSha256(changed, null)).not.toBe(base);
        },
      ),
    );
  });

  it('changes when a line is removed, added or reordered', () => {
    const content = complete();
    const base = snapshotSha256(content, null);
    const [a, b, c] = content.trial_balance;
    expect(snapshotSha256({ ...content, trial_balance: [a!, b!] }, null)).not.toBe(base);
    expect(snapshotSha256({ ...content, trial_balance: [a!, b!, c!, c!] }, null)).not.toBe(base);
    expect(snapshotSha256({ ...content, trial_balance: [b!, a!, c!] }, null)).not.toBe(base);
  });
});

describe('snapshotCanonicalJson', () => {
  it('sorts keys, writes no whitespace, and refuses undefined, fractions and class instances', () => {
    expect(snapshotCanonicalJson({ b: 1, a: [true, null, 'x'] })).toBe('{"a":[true,null,"x"],"b":1}');
    expect(() => snapshotCanonicalJson({ a: undefined })).toThrow(LedgerSnapshotError);
    expect(() => snapshotCanonicalJson({ a: 1.5 })).toThrow(LedgerSnapshotError);
    expect(() => snapshotCanonicalJson({ a: new Date(0) })).toThrow(LedgerSnapshotError);
  });
});

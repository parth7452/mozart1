import { describe, expect, it } from 'vitest';
import { cents } from '@recouple/core-domain';
import type {
  AccountingSource,
  LedgerCredit,
  LedgerInvoice,
  LedgerPayment,
} from '../src/index';
import { InMemoryAccountingSource } from '../src/testing/index';

/**
 * Phase 1.5 ships the ERP seam before the ERP. These tests pin the two things
 * a later adapter can break without noticing: that the port is read-only, and
 * that a window means what a window means at both ends.
 */

function invoice(externalId: string, issuedOn: string): LedgerInvoice {
  return {
    sourceKind: 'qbo',
    externalId,
    invoiceNumber: `INV-${externalId}`,
    customerExternalId: 'cus-1',
    customerName: 'Sysco Baltimore, LLC',
    issuedOn,
    totalCents: cents(100_000),
    balanceCents: cents(0),
    currency: 'USD',
  };
}

function payment(externalId: string, receivedOn: string): LedgerPayment {
  return {
    sourceKind: 'qbo',
    externalId,
    customerExternalId: 'cus-1',
    receivedOn,
    totalCents: cents(92_000),
    appliedTo: [],
  };
}

function credit(externalId: string, issuedOn: string): LedgerCredit {
  return {
    sourceKind: 'qbo',
    externalId,
    customerExternalId: 'cus-1',
    issuedOn,
    totalCents: cents(8_000),
    appliedTo: [],
  };
}

describe('AccountingSource', () => {
  it('is read-only by construction: the port has no method that writes', () => {
    // A type-level test. `AccountingSource` is exhausted by `kind` and the three
    // list methods, so this alias is `never` unless something writeable is
    // added — at which point `keyof` grows and the assignment below fails to
    // compile. Write-back is Phase 4 and belongs behind its own port.
    type ReadOnlySurface = 'kind' | 'listInvoices' | 'listPayments' | 'listCredits';
    type Unexpected = Exclude<keyof AccountingSource, ReadOnlySurface>;
    const noWriteMethods: Unexpected[] = [];
    expect(noWriteMethods).toEqual([]);

    // And the other direction, so a method cannot quietly be dropped either.
    type Missing = Exclude<ReadOnlySurface, keyof AccountingSource>;
    const nothingMissing: Missing[] = [];
    expect(nothingMissing).toEqual([]);
  });

  it('lets the in-memory double satisfy the port', () => {
    const source: AccountingSource = new InMemoryAccountingSource();
    expect(source.kind).toBe('qbo');
  });
});

describe('InMemoryAccountingSource', () => {
  const source = new InMemoryAccountingSource({
    invoices: [
      invoice('inv-before', '2026-05-31'),
      invoice('inv-from', '2026-06-01'),
      invoice('inv-middle', '2026-06-15'),
      invoice('inv-to', '2026-06-30'),
      invoice('inv-after', '2026-07-01'),
    ],
    payments: [
      payment('pay-before', '2026-05-31'),
      payment('pay-from', '2026-06-01'),
      payment('pay-to', '2026-06-30'),
      payment('pay-after', '2026-07-01'),
    ],
    credits: [
      credit('cm-before', '2026-05-31'),
      credit('cm-from', '2026-06-01'),
      credit('cm-to', '2026-06-30'),
      credit('cm-after', '2026-07-01'),
    ],
  });

  const june = { from: '2026-06-01', to: '2026-06-30' };

  it('filters invoices on issuedOn, inclusive at both ends', async () => {
    expect((await source.listInvoices(june)).map((i) => i.externalId)).toEqual([
      'inv-from',
      'inv-middle',
      'inv-to',
    ]);
  });

  it('filters payments on receivedOn, inclusive at both ends', async () => {
    expect((await source.listPayments(june)).map((p) => p.externalId)).toEqual([
      'pay-from',
      'pay-to',
    ]);
  });

  it('filters credits on issuedOn, inclusive at both ends', async () => {
    expect((await source.listCredits(june)).map((c) => c.externalId)).toEqual([
      'cm-from',
      'cm-to',
    ]);
  });

  it('returns rows in the order it was given them', async () => {
    const wide = { from: '2000-01-01', to: '2100-01-01' };
    expect((await source.listInvoices(wide)).map((i) => i.externalId)).toEqual([
      'inv-before',
      'inv-from',
      'inv-middle',
      'inv-to',
      'inv-after',
    ]);
  });

  it('returns nothing for a window that contains no rows, rather than everything', async () => {
    const empty = { from: '2026-08-01', to: '2026-08-31' };
    expect(await source.listInvoices(empty)).toEqual([]);
    expect(await source.listPayments(empty)).toEqual([]);
    expect(await source.listCredits(empty)).toEqual([]);

    // A window whose end precedes its start contains nothing. It does not
    // quietly widen to everything.
    const reversed = { from: '2026-06-30', to: '2026-06-01' };
    expect(await source.listInvoices(reversed)).toEqual([]);
  });

  it('starts empty when it is given nothing', async () => {
    const bare = new InMemoryAccountingSource();
    const wide = { from: '2000-01-01', to: '2100-01-01' };
    expect(await bare.listInvoices(wide)).toEqual([]);
    expect(await bare.listPayments(wide)).toEqual([]);
    expect(await bare.listCredits(wide)).toEqual([]);
  });

  it('stands in for the other ledgers behind the same port', () => {
    expect(new InMemoryAccountingSource({ kind: 'netsuite' }).kind).toBe('netsuite');
    expect(new InMemoryAccountingSource({ kind: 'xero' }).kind).toBe('xero');
  });
});

describe('the testing entry point', () => {
  it('is not reachable from the package index', async () => {
    // CLAUDE.md: no mocks or fixtures reachable from production code paths. The
    // double lives behind `@recouple/adapters/testing` and nothing re-exports
    // it, so importing the package cannot hand you one by accident.
    const index: Record<string, unknown> = await import('../src/index');
    expect(Object.keys(index)).not.toContain('InMemoryAccountingSource');
  });
});

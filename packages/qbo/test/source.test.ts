import { describe, expect, it } from 'vitest';
import type { AccountingSource } from '@recouple/adapters';
import { QboAccountingSource } from '../src/source';
import { QboInvalidWindow, QboMalformedResponse } from '../src/errors';
import {
  AUGUST,
  configFor,
  entityOf,
  fixture,
  jsonResponse,
  recordingFetch,
  startPositionOf,
  REALM_ID,
} from './helpers';

/** Serves the fixture corpus: invoices in three pages, payments and credits in one. */
function ledgerFetch() {
  return recordingFetch((request) => {
    const entity = entityOf(request.statement);
    if (entity === 'Invoice') {
      const start = startPositionOf(request.statement);
      if (start === 1) return jsonResponse(fixture('invoice-page-1.json'));
      if (start === 3) return jsonResponse(fixture('invoice-page-2.json'));
      return jsonResponse(fixture('invoice-page-3.json'));
    }
    if (entity === 'Payment') return jsonResponse(fixture('payment-query.json'));
    if (entity === 'CreditMemo') return jsonResponse(fixture('creditmemo-query.json'));
    throw new Error(`the fake was asked for an entity it does not serve: ${String(entity)}`);
  });
}

type Fetch = ReturnType<typeof ledgerFetch>['fetchImpl'];

/** Pages of two, so the three invoice fixtures are walked the way QBO would. */
function pagedSource(fetchImpl: Fetch): QboAccountingSource {
  return new QboAccountingSource(configFor(fetchImpl, undefined, { pageSize: 2 }));
}

/** The default `MAXRESULTS 1000`: the payment and credit fixtures fit in one page. */
function sourceOver(fetchImpl: Fetch): QboAccountingSource {
  return new QboAccountingSource(configFor(fetchImpl));
}

describe('QboAccountingSource', () => {
  it('is an AccountingSource and says which ledger it is', () => {
    const { fetchImpl } = ledgerFetch();
    const source: AccountingSource = sourceOver(fetchImpl);
    expect(source.kind).toBe('qbo');
    // The port has no writer, and neither does this. If a `writeX` ever appears
    // on the adapter it has to appear on the port first, which is an ADR.
    expect(Object.getOwnPropertyNames(QboAccountingSource.prototype).sort()).toEqual([
      'constructor',
      'listCredits',
      'listInvoices',
      'listPayments',
    ]);
  });

  it('maps invoices, paging until a page comes back short', async () => {
    const { fetchImpl, calls } = ledgerFetch();
    const invoices = await pagedSource(fetchImpl).listInvoices(AUGUST);

    expect(calls).toHaveLength(3);
    expect(calls.map((call) => startPositionOf(call.statement))).toEqual([1, 3, 5]);
    expect(calls[0]?.statement).toContain(
      "select * from Invoice where TxnDate >= '2026-08-01' and TxnDate <= '2026-09-30'",
    );
    expect(calls[0]?.url).toContain(`/v3/company/${REALM_ID}/query`);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer access-token-1');

    expect(invoices).toHaveLength(4);
    expect(invoices[0]).toEqual({
      sourceKind: 'qbo',
      externalId: '145',
      invoiceNumber: 'INV-10441',
      customerExternalId: '58',
      customerName: 'Sysco Baltimore, LLC',
      issuedOn: '2026-08-14',
      dueOn: '2026-09-13',
      totalCents: 312_000,
      balanceCents: 0,
      currency: 'USD',
    });
  });

  it('leaves dueOn off an invoice QBO gave no due date, rather than inventing one', async () => {
    const { fetchImpl } = ledgerFetch();
    const invoices = await pagedSource(fetchImpl).listInvoices(AUGUST);
    expect(invoices[1]?.externalId).toBe('146');
    expect(invoices[1]).not.toHaveProperty('dueOn');
  });

  it('reads an amount JSON serialised with one decimal place as exact cents', async () => {
    const { fetchImpl } = ledgerFetch();
    const invoices = await pagedSource(fetchImpl).listInvoices(AUGUST);
    const oneDecimal = invoices.find((invoice) => invoice.externalId === '148');
    expect(oneDecimal?.totalCents).toBe(123_450);
    expect(oneDecimal?.balanceCents).toBe(123_450);
  });

  it('maps payments and what they were applied to', async () => {
    const { fetchImpl } = ledgerFetch();
    const payments = await sourceOver(fetchImpl).listPayments(AUGUST);

    expect(payments).toHaveLength(3);
    expect(payments[0]).toEqual({
      sourceKind: 'qbo',
      externalId: '301',
      customerExternalId: '58',
      receivedOn: '2026-08-31',
      totalCents: 274_025,
      reference: 'ACH-88213',
      memo: 'Remittance 0831 - short pay, MFG chargeback ref 4471',
      appliedTo: [
        { invoiceExternalId: '145', amountCents: 185_000 },
        { invoiceExternalId: '146', amountCents: 89_025 },
      ],
    });
  });

  it('does not count a credit memo as cash a payment applied', async () => {
    const { fetchImpl } = ledgerFetch();
    const payments = await sourceOver(fetchImpl).listPayments(AUGUST);

    // Payment 302 is the zero-dollar payment QBO writes when a credit memo is
    // applied to an invoice. Its line links both — and counting that link here
    // would report $1,270 of cash that never arrived.
    const creditApplication = payments.find((payment) => payment.externalId === '302');
    expect(creditApplication?.totalCents).toBe(0);
    expect(creditApplication?.appliedTo).toEqual([]);
  });

  it('reads an empty PrivateNote as no memo at all', async () => {
    const { fetchImpl } = ledgerFetch();
    const payments = await sourceOver(fetchImpl).listPayments(AUGUST);
    expect(payments.find((payment) => payment.externalId === '302')).not.toHaveProperty('memo');
    expect(payments.find((payment) => payment.externalId === '303')).not.toHaveProperty('memo');
  });

  it('ignores a linked transaction that is neither an invoice nor a credit memo', async () => {
    const { fetchImpl } = ledgerFetch();
    const payments = await sourceOver(fetchImpl).listPayments(AUGUST);
    // Payment 303's line links the invoice and a Deposit.
    expect(payments.find((payment) => payment.externalId === '303')?.appliedTo).toEqual([
      { invoiceExternalId: '147', amountCents: 50_000 },
    ]);
  });

  it('resolves a credit memo to the invoice through the payment that links them', async () => {
    const { fetchImpl, calls } = ledgerFetch();
    const credits = await sourceOver(fetchImpl).listCredits(AUGUST);

    // Credits need the payments too: QBO records the application there, never
    // on the CreditMemo.
    expect(calls.map((call) => entityOf(call.statement))).toEqual(['CreditMemo', 'Payment']);

    expect(credits).toEqual([
      {
        sourceKind: 'qbo',
        externalId: '501',
        customerExternalId: '58',
        issuedOn: '2026-09-01',
        totalCents: 127_000,
        memo: 'Shortage allowance, claim 4471',
        appliedTo: [{ invoiceExternalId: '145', amountCents: 127_000 }],
      },
      {
        sourceKind: 'qbo',
        externalId: '502',
        customerExternalId: '72',
        issuedOn: '2026-09-10',
        totalCents: 6_240,
        appliedTo: [],
      },
    ]);
  });

  it('sends a fresh Request-Id on every request', async () => {
    const { fetchImpl, calls } = ledgerFetch();
    // Three pages, so this also covers the case the header exists for: two
    // pages of one read must not share an idempotency key, or the second can be
    // answered from the first one's cached response.
    await pagedSource(fetchImpl).listInvoices(AUGUST);

    const ids = calls.map((call) => call.headers.get('Request-Id'));
    expect(ids).toHaveLength(3);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('refuses an amount that cannot be two decimal places rather than rounding a ledger figure', async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(fixture('invoice-three-decimals.json')));
    const source = new QboAccountingSource(configFor(fetchImpl));

    await expect(source.listInvoices(AUGUST)).rejects.toThrow(QboMalformedResponse);
    await expect(source.listInvoices(AUGUST)).rejects.toThrow(/Invoice\[0\]\.TotalAmt/);
  });

  it('will not put an unvalidated window into a query', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse({ QueryResponse: {} }));
    const source = new QboAccountingSource(configFor(fetchImpl));

    // `from` and `to` are interpolated between single quotes, so an unchecked
    // string is query injection into a customer's ledger.
    await expect(
      source.listInvoices({ from: "2026-08-01' or '1'='1", to: '2026-09-30' }),
    ).rejects.toThrow(QboInvalidWindow);
    await expect(source.listInvoices({ from: '2026-02-31', to: '2026-09-30' })).rejects.toThrow(
      QboInvalidWindow,
    );
    await expect(source.listInvoices({ from: '2026-09-30', to: '2026-08-01' })).rejects.toThrow(
      QboInvalidWindow,
    );

    expect(calls).toHaveLength(0);
  });
});

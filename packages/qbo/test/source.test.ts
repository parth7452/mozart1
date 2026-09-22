import { describe, expect, it } from 'vitest';
import type { AccountingSource } from '@recouple/adapters';
import { QboAccountingSource } from '../src/source';
import { QboInvalidId, QboInvalidWindow, QboMalformedResponse } from '../src/errors';
import { QBO_IDS_PER_QUERY } from '../src/client';
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
    // `getInvoiceHistories` is a read, and ADR 0035 is its ADR.
    expect(Object.getOwnPropertyNames(QboAccountingSource.prototype).sort()).toEqual([
      'constructor',
      'getInvoiceHistories',
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

/** A QBO invoice row, as the query endpoint returns one. */
function invoiceRow(id: string, total: number, balance: number, paymentIds: readonly string[]) {
  return {
    Id: id,
    DocNumber: `D-${id}`,
    TxnDate: '2026-05-01',
    TotalAmt: total,
    Balance: balance,
    CustomerRef: { value: '58', name: 'Sysco Baltimore, LLC' },
    CurrencyRef: { value: 'USD', name: 'United States Dollar' },
    LinkedTxn: paymentIds.map((txnId) => ({ TxnId: txnId, TxnType: 'Payment' })),
  };
}

function paymentRow(id: string, lines: readonly { amount: number; links: readonly [string, string][] }[]) {
  return {
    Id: id,
    TxnDate: '2026-05-20',
    TotalAmt: lines.reduce((sum, line) => sum + line.amount, 0),
    CustomerRef: { value: '58', name: 'Sysco Baltimore, LLC' },
    Line: lines.map((line) => ({
      Amount: line.amount,
      LinkedTxn: line.links.map(([txnType, txnId]) => ({ TxnType: txnType, TxnId: txnId })),
    })),
  };
}

/** Serves rows by `Id in (…)` and nothing else, and records every statement. */
function byIdFetch(ledger: Record<string, readonly { Id: string }[]>) {
  return recordingFetch(({ statement }) => {
    const entity = entityOf(statement) ?? '';
    const list = /\bId in \(([^)]*)\)/.exec(statement ?? '');
    if (list === null) throw new Error(`not a by-id query: ${String(statement)}`);
    const wanted = new Set((list[1] ?? '').split(',').map((p) => p.trim().replace(/^'|'$/g, '')));
    const found = (ledger[entity] ?? []).filter((row) => wanted.has(row.Id));
    return jsonResponse({ QueryResponse: found.length === 0 ? {} : { [entity]: found } });
  });
}

describe('QboAccountingSource.getInvoiceHistories (ADR 0035)', () => {
  it('returns each invoice with every payment its own LinkedTxn names, whatever their dates', async () => {
    const { fetchImpl, calls } = byIdFetch({
      Invoice: [invoiceRow('145', 3120, 0, ['301', '302'])],
      Payment: [
        paymentRow('301', [{ amount: 1850, links: [['Invoice', '145']] }]),
        // Applies credit memo 77 to invoice 145: a credit, not cash. One line
        // linking both, the shape `resolveCreditApplications` reads (ADR 0026).
        paymentRow('302', [
          {
            amount: 1270,
            links: [
              ['Invoice', '145'],
              ['CreditMemo', '77'],
            ],
          },
        ]),
      ],
      CreditMemo: [
        {
          Id: '77',
          TxnDate: '2026-05-19',
          TotalAmt: 1270,
          CustomerRef: { value: '58', name: 'Sysco Baltimore, LLC' },
          PrivateNote: 'promo allowance',
        },
      ],
    });

    const histories = await sourceOver(fetchImpl).getInvoiceHistories(['145']);

    expect(histories.invoices.map((i) => i.externalId)).toEqual(['145']);
    expect(histories.payments.map((p) => p.externalId).sort()).toEqual(['301', '302']);
    expect(histories.credits).toEqual([
      expect.objectContaining({
        externalId: '77',
        appliedTo: [{ invoiceExternalId: '145', amountCents: 127_000 }],
      }),
    ]);
    // Three reads, each by id, none by date.
    expect(calls.map((c) => entityOf(c.statement))).toEqual(['Invoice', 'Payment', 'CreditMemo']);
    expect(calls.every((c) => !(c.statement ?? '').includes('TxnDate'))).toBe(true);
  });

  it('leaves out an id the ledger does not have, without failing', async () => {
    const { fetchImpl } = byIdFetch({ Invoice: [invoiceRow('145', 100, 100, [])] });
    const histories = await sourceOver(fetchImpl).getInvoiceHistories(['145', '999']);
    expect(histories.invoices.map((i) => i.externalId)).toEqual(['145']);
    expect(histories.payments).toEqual([]);
  });

  it('refuses to return a partial history: a linked payment QuickBooks does not return is loud', async () => {
    const { fetchImpl } = byIdFetch({
      Invoice: [invoiceRow('145', 3120, 1270, ['301', '302'])],
      Payment: [paymentRow('301', [{ amount: 1850, links: [['Invoice', '145']] }])],
    });
    // Tallied without 302, invoice 145 would read as a short-pay.
    await expect(sourceOver(fetchImpl).getInvoiceHistories(['145'])).rejects.toThrow(
      QboMalformedResponse,
    );
    await expect(sourceOver(fetchImpl).getInvoiceHistories(['145'])).rejects.toThrow(
      /links Payment 302, which QuickBooks did not return/,
    );
  });

  it('chunks the id list and asks for each id once', async () => {
    const ids = Array.from({ length: QBO_IDS_PER_QUERY + 5 }, (_, n) => String(n + 1));
    const { fetchImpl, calls } = byIdFetch({ Invoice: [] });
    await sourceOver(fetchImpl).getInvoiceHistories([...ids, '1', '2']);

    expect(calls).toHaveLength(2);
    const asked = calls.flatMap((call) =>
      (/\bId in \(([^)]*)\)/.exec(call.statement ?? '')?.[1] ?? '').split(',').map((p) => p.trim()),
    );
    expect(asked).toHaveLength(ids.length);
    expect(new Set(asked).size).toBe(ids.length);
  });

  it('will not put an id that is not digits into a query', async () => {
    const { fetchImpl, calls } = byIdFetch({ Invoice: [] });
    const source = sourceOver(fetchImpl);
    await expect(source.getInvoiceHistories(["1') or ('1'='1"])).rejects.toThrow(QboInvalidId);
    await expect(source.getInvoiceHistories(['12a'])).rejects.toThrow(QboInvalidId);
    expect(calls).toHaveLength(0);

    // And an id off the ledger's own LinkedTxn is held to the same rule.
    const poisoned = byIdFetch({ Invoice: [invoiceRow('145', 10, 5, ["7' or '1'='1"])] });
    await expect(sourceOver(poisoned.fetchImpl).getInvoiceHistories(['145'])).rejects.toThrow(
      QboInvalidId,
    );
    expect(poisoned.calls).toHaveLength(1);
  });

  it('asks nothing at all for no ids', async () => {
    const { fetchImpl, calls } = byIdFetch({});
    expect(await sourceOver(fetchImpl).getInvoiceHistories([])).toEqual({
      invoices: [],
      payments: [],
      credits: [],
    });
    expect(calls).toHaveLength(0);
  });
});

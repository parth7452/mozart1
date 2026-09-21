import { describe, expect, it } from 'vitest';
import {
  QboAuthError,
  QboError,
  QboMalformedResponse,
  QboRateLimited,
  QboRequestFailed,
} from '../src/errors';
import { QboAccountingSource } from '../src/source';
import { AUGUST, configFor, fixture, jsonResponse, recordingFetch } from './helpers';

function sourceThatGets(response: () => Response): QboAccountingSource {
  const { fetchImpl } = recordingFetch(response);
  return new QboAccountingSource(configFor(fetchImpl));
}

/**
 * The rule under all of these: **an empty ledger and an unreadable ledger are
 * different facts.** Every case here must throw. A customer with no deductions
 * and a customer whose token was revoked both render as "0 invoices" the moment
 * one of them is swallowed, and only one of those is good news.
 */
describe('failures are typed, never an empty list', () => {
  it('throws QboAuthError on a 401', async () => {
    const source = sourceThatGets(() => jsonResponse(fixture('fault-authentication.json'), 401));
    await expect(source.listInvoices(AUGUST)).rejects.toThrow(QboAuthError);
    await expect(source.listInvoices(AUGUST)).rejects.toThrow(/rejected the access token/);
  });

  it('throws QboRateLimited on a 429, carrying the backoff Intuit asked for', async () => {
    const source = sourceThatGets(() =>
      jsonResponse(fixture('fault-throttled.json'), 429, { 'retry-after': '30' }),
    );

    await expect(source.listPayments(AUGUST)).rejects.toThrow(QboRateLimited);
    const error = await source.listPayments(AUGUST).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(QboRateLimited);
    expect((error as QboRateLimited).retryAfterMs).toBe(30_000);
  });

  it('says it does not know the backoff rather than inventing one', async () => {
    const source = sourceThatGets(() => jsonResponse(fixture('fault-throttled.json'), 429));
    const error = await source.listPayments(AUGUST).catch((caught: unknown) => caught);
    expect((error as QboRateLimited).retryAfterMs).toBeUndefined();
  });

  it('throws QboRequestFailed for anything else, carrying the status and the Fault', async () => {
    const source = sourceThatGets(() => jsonResponse(fixture('fault-validation.json'), 400));
    const error = await source.listInvoices(AUGUST).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(QboRequestFailed);
    expect((error as QboRequestFailed).status).toBe(400);
    expect((error as QboRequestFailed).fault).toMatchObject({ type: 'ValidationFault' });
  });

  it('throws QboRequestFailed with status 0 when there was no response at all', async () => {
    const { fetchImpl } = recordingFetch(() => {
      throw new Error('getaddrinfo ENOTFOUND sandbox-quickbooks.api.intuit.com');
    });
    const source = new QboAccountingSource(configFor(fetchImpl));

    const error = await source.listInvoices(AUGUST).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(QboRequestFailed);
    expect((error as QboRequestFailed).status).toBe(0);
    // The query is not in the message: it names the window of a customer's ledger.
    expect((error as QboRequestFailed).message).not.toContain('TxnDate');
  });

  it('throws QboMalformedResponse when a 200 is not JSON', async () => {
    const source = sourceThatGets(
      () => new Response('<html>maintenance</html>', { status: 200 }),
    );
    await expect(source.listInvoices(AUGUST)).rejects.toThrow(QboMalformedResponse);
  });

  it('throws QboMalformedResponse when a required field is missing, naming it', async () => {
    const source = sourceThatGets(() =>
      jsonResponse({
        QueryResponse: {
          Invoice: [
            {
              Id: '145',
              TxnDate: '2026-08-14',
              TotalAmt: 100,
              Balance: 0,
              CurrencyRef: { value: 'USD' },
              CustomerRef: { value: '58', name: 'Sysco Baltimore, LLC' },
            },
          ],
        },
      }),
    );

    const error = await source.listInvoices(AUGUST).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(QboMalformedResponse);
    // No `DocNumber`. An invoice number of '' would reconcile against nothing
    // and nobody would notice for a quarter.
    expect((error as QboMalformedResponse).fieldPath).toBe('Invoice[0].DocNumber');
  });

  it('refuses a payment line that links two invoices to one amount', async () => {
    const source = sourceThatGets(() =>
      jsonResponse({
        QueryResponse: {
          Payment: [
            {
              Id: '301',
              TxnDate: '2026-08-31',
              TotalAmt: 500,
              CustomerRef: { value: '58' },
              Line: [
                {
                  Amount: 500,
                  LinkedTxn: [
                    { TxnId: '145', TxnType: 'Invoice' },
                    { TxnId: '146', TxnType: 'Invoice' },
                  ],
                },
              ],
            },
          ],
        },
      }),
    );

    // Splitting the amount evenly would be a guess on a money field.
    await expect(source.listPayments(AUGUST)).rejects.toThrow(QboMalformedResponse);
    await expect(source.listPayments(AUGUST)).rejects.toThrow(/cannot be attributed/);
  });

  it('throws QboMalformedResponse for a date that is not a calendar day', async () => {
    const source = sourceThatGets(() =>
      jsonResponse({
        QueryResponse: {
          CreditMemo: [
            {
              Id: '501',
              TxnDate: '2026-02-31',
              TotalAmt: 10,
              CustomerRef: { value: '58' },
            },
          ],
        },
      }),
    );
    await expect(source.listCredits(AUGUST)).rejects.toThrow(QboMalformedResponse);
  });

  it('gives every failure one base class to catch', () => {
    for (const error of [
      new QboAuthError('a'),
      new QboRateLimited('b', undefined),
      new QboMalformedResponse('c', 'Invoice[0].TotalAmt'),
      new QboRequestFailed('d', 500, undefined),
    ]) {
      expect(error).toBeInstanceOf(QboError);
      expect(error).toBeInstanceOf(Error);
      // The class name survives onto the instance, so a log line says which.
      expect(error.name).toBe(error.constructor.name);
    }
  });
});

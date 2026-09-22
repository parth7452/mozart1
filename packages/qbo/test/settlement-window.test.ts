/**
 * The production run of 2026-09-22, replayed (ADR 0035).
 *
 * Run `be42505b-cf27-4376-8edc-17d97811bdba` synced the Intuit sandbox company
 * over 2026-08-19..2026-09-22 and recorded 12 invoices examined, nothing opened
 * and 8 anomalies. Every one of the eight was a payment inside the window applied
 * to an invoice dated before it — so the three short-pays in that ledger, all
 * paid inside the window, were invisible.
 *
 * This replays the recorded Intuit responses (`fixtures/recorded-*.json`, from a
 * real sandbox, redacted) through the real adapter. The fake serves them the way
 * QuickBooks filters them — by `TxnDate` for a window query, by `Id` for an
 * `Id in (…)` query — so both the old and the new semantics are exercised
 * through `QboAccountingSource` and `QboClient`, not beside them.
 *
 * The detector is not touched and neither is any threshold: the difference
 * between the two halves of this file is only which rows reach it.
 */

import { describe, expect, it } from 'vitest';
import {
  detectShortPays,
  invoicesNamedBy,
  settlementLedger,
  type LedgerWindow,
  type ShortPayReport,
} from '@recouple/core-domain';
import { QboAccountingSource } from '../src/source';
import type { JsonObject } from '../src/reader';
import { configFor, entityOf, fixture, jsonResponse, recordingFetch, type Recorder } from './helpers';

/** The production run's window, exactly as `ledgerSyncWindow` built it. */
const PRODUCTION_WINDOW: LedgerWindow = { from: '2026-08-19', to: '2026-09-22' };
/** What `pnpm qbo:verify --record` walked: ninety days back from 2026-09-21. */
const RECORDED_WINDOW: LedgerWindow = { from: '2026-06-24', to: '2026-09-21' };

const RECORDED: Record<string, readonly JsonObject[]> = {
  Invoice: rows('recorded-invoice-query.json', 'Invoice'),
  Payment: rows('recorded-payment-query.json', 'Payment'),
  CreditMemo: rows('recorded-creditmemo-query.json', 'CreditMemo'),
};

function rows(file: string, entity: string): readonly JsonObject[] {
  const body = fixture(file) as { QueryResponse: Record<string, JsonObject[] | undefined> };
  return body.QueryResponse[entity] ?? [];
}

/**
 * QuickBooks, as far as these two query shapes go: a `TxnDate` range, or an
 * `Id in (…)` list. Anything else is refused, so a query the adapter starts
 * sending that this fake does not understand fails here rather than returning
 * the whole ledger.
 */
function recordedQbo(): Recorder {
  return recordingFetch(({ statement }) => {
    const entity = entityOf(statement);
    const all = entity === undefined ? undefined : RECORDED[entity];
    if (entity === undefined || all === undefined) {
      throw new Error(`the recorded ledger holds no ${String(entity)}: ${String(statement)}`);
    }

    const range = /TxnDate >= '(\d{4}-\d{2}-\d{2})' and TxnDate <= '(\d{4}-\d{2}-\d{2})'/.exec(
      statement ?? '',
    );
    const ids = /\bId in \(([^)]*)\)/.exec(statement ?? '');

    let found: readonly JsonObject[];
    if (range !== null) {
      const [, from, to] = range as unknown as [string, string, string];
      found = all.filter((row) => {
        const date = row['TxnDate'] as string;
        return date >= from && date <= to;
      });
    } else if (ids !== null) {
      const wanted = new Set(
        (ids[1] ?? '').split(',').map((part) => part.trim().replace(/^'|'$/g, '')),
      );
      found = all.filter((row) => wanted.has(row['Id'] as string));
    } else {
      throw new Error(`a query shape this fake does not serve: ${String(statement)}`);
    }

    return jsonResponse({
      QueryResponse: found.length === 0 ? {} : { [entity]: found },
      time: '2026-09-22T07:00:00.000-07:00',
    });
  });
}

/** ADR 0031's semantics: every entity filtered by its own transaction date. */
async function byInvoiceDate(window: LedgerWindow): Promise<ShortPayReport> {
  const source = new QboAccountingSource(configFor(recordedQbo().fetchImpl));
  const [invoices, payments, credits] = await Promise.all([
    source.listInvoices(window),
    source.listPayments(window),
    source.listCredits(window),
  ]);
  return detectShortPays(invoices, payments, credits);
}

/**
 * ADR 0035's: the payments and credits in the window, then the invoices they
 * name by id with their whole histories — the composition `syncLedger` runs.
 */
async function byPaymentDate(
  window: LedgerWindow,
): Promise<{ report: ShortPayReport; recorder: Recorder }> {
  const recorder = recordedQbo();
  const source = new QboAccountingSource(configFor(recorder.fetchImpl));
  const [payments, credits] = await Promise.all([
    source.listPayments(window),
    source.listCredits(window),
  ]);
  const activity = { payments, credits };
  const histories = await source.getInvoiceHistories(invoicesNamedBy(activity));
  const ledger = settlementLedger(activity, histories);
  return {
    report: detectShortPays(ledger.invoices, ledger.payments, ledger.credits),
    recorder,
  };
}

describe('the production ledger sync of 2026-09-22, replayed from the recorded sandbox', () => {
  it('under invoice-date windows: 12 examined, nothing found, 8 anomalies — what production recorded', async () => {
    const report = await byInvoiceDate(PRODUCTION_WINDOW);

    expect(report.invoicesExamined).toBe(12);
    expect(report.candidates).toEqual([]);
    expect(report.anomalies).toHaveLength(8);
    // Every one of them is a payment in the window applied to an invoice dated
    // before it. That is the defect, not eight problems with the ledger.
    expect(new Set(report.anomalies.map((a) => a.kind))).toEqual(
      new Set(['application_to_unknown_invoice']),
    );
    expect(
      report.anomalies.map((a) => `${a.transactionExternalId}->${a.invoiceExternalId}`).sort(),
    ).toEqual(
      ['101->67', '116->63', '120->12', '128->96', '32->16', '33->13', '61->12', '98->42'].sort(),
    );
  });

  it('under invoice-date windows the full recording does find them: the defect is the axis', async () => {
    const report = await byInvoiceDate(RECORDED_WINDOW);
    expect(report.candidates.map((c) => c.invoiceExternalId).sort()).toEqual(['13', '16', '67']);
    expect(report.anomalies.map((a) => a.invoiceExternalId)).toEqual(['96']);
  });

  it('under payment-date windows: the three short-pays, and only the one real anomaly', async () => {
    const { report } = await byPaymentDate(PRODUCTION_WINDOW);

    expect(report.candidates.map((c) => c.invoiceExternalId).sort()).toEqual(['13', '16', '67']);
    // The amounts are the ledger's own, in integer cents, and each gap is
    // total − payments exactly as before: nothing about the arithmetic moved.
    const byId = new Map(report.candidates.map((c) => [c.invoiceExternalId, c]));
    expect(byId.get('67')).toMatchObject({
      invoiceTotalCents: 45_900,
      appliedPaymentsCents: 22_000,
      gapCents: 23_900,
      gapStatus: 'open',
    });
    expect(byId.get('16')).toMatchObject({
      invoiceTotalCents: 75_000,
      appliedPaymentsCents: 30_000,
      gapCents: 45_000,
      gapStatus: 'open',
    });
    expect(byId.get('13')).toMatchObject({
      invoiceTotalCents: 5_400,
      appliedPaymentsCents: 5_000,
      gapCents: 400,
      gapStatus: 'open',
    });

    // At most one anomaly, and it is the true one: payment 128 applies to
    // invoice 96, which the recorded ledger does not hold.
    expect(report.anomalies.length).toBeLessThanOrEqual(1);
    expect(report.anomalies).toEqual([
      expect.objectContaining({
        kind: 'application_to_unknown_invoice',
        invoiceExternalId: '96',
        transactionExternalId: '128',
      }),
    ]);

    // Invoice 12 was paid in two instalments, both counted: paid in full, so
    // not a candidate. A tally over one of them would have said short by $694.
    expect(byId.has('12')).toBe(false);
  });

  it('asks QuickBooks for the named invoices by id, whatever their dates', async () => {
    const { report, recorder } = await byPaymentDate(PRODUCTION_WINDOW);
    const invoiceQueries = recorder.calls
      .map((call) => call.statement ?? '')
      .filter((statement) => entityOf(statement) === 'Invoice');

    // No invoice is ever asked for by date again.
    expect(invoiceQueries.some((statement) => statement.includes('TxnDate'))).toBe(false);
    expect(invoiceQueries).toHaveLength(1);
    expect(invoiceQueries[0]).toContain(`Id in ('12', '13', '16', '27', '42', '63', '67', '9', '96')`);
    // Eight of the nine came back; 96 is not in the recorded ledger.
    expect(report.invoicesExamined).toBe(8);
  });

  it('tallies an invoice against an application dated before the window', async () => {
    // Invoice 12 is paid by payment 61 (2026-08-20) and payment 120
    // (2026-08-27). A window starting the day after 61 sees only 120 — the
    // history still brings 61 in, so 12 is paid in full rather than short $694.
    const { report } = await byPaymentDate({ from: '2026-08-21', to: '2026-09-22' });
    expect(report.candidates.map((c) => c.invoiceExternalId)).not.toContain('12');
    expect(report.anomalies.map((a) => a.invoiceExternalId)).toEqual(['96']);
  });
});

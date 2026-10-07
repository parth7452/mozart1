import { describe, expect, it } from 'vitest';
import { SIZING_WINDOW_DAYS, windowDays } from '@recouple/core-domain';
import { QboInvalidWindow, QboMalformedResponse, QboReportTooLarge } from '../src/errors';
import { REPORT_CUT_SHORT_TEXT, parseProfitAndLossReport } from '../src/reports';
import { QboAccountingSource } from '../src/source';
import { configFor, fixture, jsonResponse, recordingFetch, REALM_ID } from './helpers';

/**
 * QuickBooks' `ProfitAndLoss` report (ADR 0073), parsed from a hand-written
 * fixture in Intuit's documented shape: five data sections, a parent account
 * whose sub-account is nested under it, and the four computed rows. Nothing
 * here was recorded and nothing here opens a socket.
 *
 * What these hold: a `Summary` and a computed row are never lines; every
 * total printed must equal the lines read, to the cent; empty only on
 * `NoReportData`; a cut-short or multicurrency report is refused; and a
 * refusal names a path, never a figure or a name out of the books.
 */

const YEAR = { from: '2025-10-01', to: '2026-09-30' } as const;

type Json = Record<string, unknown>;

function copy(): Json {
  return structuredClone(fixture('report-profit-and-loss.json')) as Json;
}

function rowsOf(holder: Json): Json[] {
  return (holder['Rows'] as { Row: Json[] }).Row;
}

function amountCell(row: Json, key: 'ColData' | 'Summary' = 'ColData'): { value: string } {
  const holder = key === 'ColData' ? row : (row['Summary'] as Json);
  return (holder['ColData'] as Array<{ value: string }>)[1] as { value: string };
}

function refusal(run: () => unknown): QboMalformedResponse {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(QboMalformedResponse);
    return error as QboMalformedResponse;
  }
  throw new Error('expected QboMalformedResponse');
}

/** Names and figures in the fixture; none may appear in a refusal. */
const FROM_THE_BOOKS = [/\d{3,}/, /Sales of Product/, /Chargebacks/, /Trade Deductions/, /Interest/];

function quotesNothing(error: Error): void {
  for (const pattern of FROM_THE_BOOKS) expect(error.message).not.toMatch(pattern);
}

describe('parseProfitAndLossReport', () => {
  it('reads every account row in its section, nested ones included, and no total as a line', () => {
    const pnl = parseProfitAndLossReport(fixture('report-profit-and-loss.json'), { window: YEAR });
    expect(pnl).toMatchObject({ sourceKind: 'qbo', window: YEAR, basis: 'Accrual', currency: 'USD' });
    expect(windowDays(YEAR)).toBe(SIZING_WINDOW_DAYS);
    expect(pnl.lines.map((line) => [line.accountExternalId, line.section, line.amountCents])).toEqual([
      ['79', 'Income', 12_500_000],
      ['95', 'Income', -120_000],
      ['96', 'Income', -683_000],
      ['80', 'COGS', 6_140_000],
      ['97', 'Expenses', 320_000],
      ['60', 'Expenses', 481_550],
      ['81', 'OtherIncome', 11_235],
      ['82', 'OtherExpenses', 4_500],
    ]);
    expect(pnl.lines.map((line) => line.accountName)).not.toContain('Total Income');
    expect(pnl.lines.map((line) => line.accountName)).not.toContain('Net Income');
  });

  it('refuses a section whose lines do not add up to its total, and quotes nothing', () => {
    const report = copy();
    amountCell(rowsOf(report)[0] as Json, 'Summary').value = '116970.01';
    const error = refusal(() => parseProfitAndLossReport(report, { window: YEAR }));
    expect(error.fieldPath).toBe('ProfitAndLoss.Rows.Row[0].Summary');
    quotesNothing(error);
  });

  it('refuses a nested parent account whose lines do not add up to its own total', () => {
    const report = copy();
    const nested = rowsOf(rowsOf(report)[0] as Json)[1] as Json;
    amountCell(rowsOf(nested)[1] as Json).value = '-6830.10';
    // The section total would now disagree too; the nested one is found first.
    expect(refusal(() => parseProfitAndLossReport(report, { window: YEAR })).fieldPath).toBe(
      'ProfitAndLoss.Rows.Row[0].Rows.Row[1].Summary',
    );
  });

  it('checks each computed row against the arithmetic of the sections', () => {
    for (const [index, wrong] of [
      [2, '55570.10'],
      [4, '47554.49'],
      [7, '67.36'],
      [8, '47621.86'],
    ] as const) {
      const report = copy();
      amountCell(rowsOf(report)[index] as Json, 'Summary').value = wrong;
      const error = refusal(() => parseProfitAndLossReport(report, { window: YEAR }));
      expect(error.fieldPath).toBe(`ProfitAndLoss.Rows.Row[${index}].Summary`);
      quotesNothing(error);
    }
  });

  it('refuses a dropped row: the section total is what catches it', () => {
    const report = copy();
    rowsOf(rowsOf(report)[3] as Json).splice(0, 1);
    expect(refusal(() => parseProfitAndLossReport(report, { window: YEAR })).fieldPath).toBe(
      'ProfitAndLoss.Rows.Row[3].Summary',
    );
  });

  it('refuses a report QuickBooks cut short at its own limit', () => {
    const report = copy();
    rowsOf(rowsOf(report)[3] as Json).push({
      ColData: [{ value: REPORT_CUT_SHORT_TEXT }, { value: '' }],
      type: 'Data',
    });
    expect(() => parseProfitAndLossReport(report, { window: YEAR })).toThrow(QboReportTooLarge);
  });

  it('returns an empty profit and loss only when QuickBooks says there is no data', () => {
    const report = copy();
    (report['Rows'] as Json)['Row'] = [];
    expect(refusal(() => parseProfitAndLossReport(report, { window: YEAR })).fieldPath).toBe(
      'ProfitAndLoss.Rows',
    );
    ((report['Header'] as Json)['Option'] as Array<{ Name: string; Value: string }>)[1]!.Value = 'true';
    expect(parseProfitAndLossReport(report, { window: YEAR }).lines).toEqual([]);
  });

  it('refuses a multicurrency or month-by-month report by the column it expected', () => {
    const report = copy();
    const columns = (report['Columns'] as Json)['Column'] as Array<{ MetaData: Array<{ Value: string }> }>;
    columns[1]!.MetaData[0]!.Value = 'home_amount';
    expect(refusal(() => parseProfitAndLossReport(report, { window: YEAR })).fieldPath).toBe(
      'ProfitAndLoss.Columns.Column.total',
    );

    const months = copy();
    const monthColumns = (months['Columns'] as Json)['Column'] as unknown[];
    monthColumns.push(structuredClone(monthColumns[1]));
    expect(refusal(() => parseProfitAndLossReport(months, { window: YEAR })).fieldPath).toBe(
      'ProfitAndLoss.Columns.Column.total',
    );
  });

  it('refuses a period other than the one asked for, a section it does not know and a stray account', () => {
    expect(
      refusal(() =>
        parseProfitAndLossReport(fixture('report-profit-and-loss.json'), {
          window: { from: '2025-10-02', to: '2026-09-30' },
        }),
      ).fieldPath,
    ).toBe('ProfitAndLoss.Header.StartPeriod');

    const unknown = copy();
    (rowsOf(unknown)[5] as Json)['group'] = 'SomethingNew';
    const error = refusal(() => parseProfitAndLossReport(unknown, { window: YEAR }));
    expect(error.fieldPath).toBe('ProfitAndLoss.Rows.Row[5].group');
    expect(error.message).not.toContain('SomethingNew');

    const stray = copy();
    rowsOf(stray).unshift({ ColData: [{ value: 'Loose', id: '1' }, { value: '1.00' }] });
    expect(refusal(() => parseProfitAndLossReport(stray, { window: YEAR })).fieldPath).toBe(
      'ProfitAndLoss.Rows.Row[0]',
    );

    const twice = copy();
    rowsOf(twice).push(structuredClone(rowsOf(twice)[0] as Json));
    expect(refusal(() => parseProfitAndLossReport(twice, { window: YEAR })).fieldPath).toBe(
      'ProfitAndLoss.Rows.Row[9].group',
    );
  });

  it('refuses an amount that is not exact cents, naming the cell and not the amount', () => {
    const report = copy();
    amountCell(rowsOf(rowsOf(report)[0] as Json)[0] as Json).value = '125000.005';
    const error = refusal(() => parseProfitAndLossReport(report, { window: YEAR }));
    expect(error.fieldPath).toBe('ProfitAndLoss.Rows.Row[0].Rows.Row[0].ColData[1]');
  });
});

describe('QboAccountingSource.profitAndLoss', () => {
  function pnlFetch() {
    return recordingFetch((request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith('/reports/ProfitAndLoss')) {
        return jsonResponse(fixture('report-profit-and-loss.json'));
      }
      throw new Error(`the fake was asked for something it does not serve: ${url.pathname}`);
    });
  }

  it('asks for one total column over the window, in the company’s own basis', async () => {
    const { fetchImpl, calls } = pnlFetch();
    const pnl = await new QboAccountingSource(configFor(fetchImpl)).profitAndLoss(YEAR);
    const url = new URL(calls[0]!.url);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('GET');
    expect(url.pathname).toBe(`/v3/company/${REALM_ID}/reports/ProfitAndLoss`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      start_date: '2025-10-01',
      end_date: '2026-09-30',
      summarize_column_by: 'Total',
    });
    expect(pnl.lines).toHaveLength(8);
  });

  it('refuses a window longer than a year, or one it will not send, before any request', async () => {
    const { fetchImpl, calls } = pnlFetch();
    const source = new QboAccountingSource(configFor(fetchImpl));
    await expect(source.profitAndLoss({ from: '2025-09-30', to: '2026-09-30' })).rejects.toBeInstanceOf(
      QboInvalidWindow,
    );
    await expect(source.profitAndLoss({ from: '2026-09-30', to: '2026-09-01' })).rejects.toBeInstanceOf(
      QboInvalidWindow,
    );
    await expect(source.profitAndLoss({ from: "2025-10-01'", to: '2026-09-30' })).rejects.toBeInstanceOf(
      QboInvalidWindow,
    );
    expect(calls).toHaveLength(0);
  });
});

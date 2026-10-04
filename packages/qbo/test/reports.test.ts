import { describe, expect, it } from 'vitest';
import {
  GENERAL_LEDGER_MAX_LINES,
  GENERAL_LEDGER_MAX_WINDOW_DAYS,
  trialBalanceDifferenceCents,
} from '@recouple/core-domain';
import {
  QboChartTooLarge,
  QboInvalidId,
  QboInvalidWindow,
  QboMalformedResponse,
  QboReportTooLarge,
  QboRequestFailed,
} from '../src/errors';
import {
  GENERAL_LEDGER_COLUMNS,
  parseGeneralLedgerReport,
  parseTrialBalanceReport,
  reportAmountToCents,
  toLedgerAccount,
} from '../src/reports';
import { QboAccountingSource, trialBalancePeriodStart } from '../src/source';
import { configFor, fixture, jsonResponse, recordingFetch, REALM_ID } from './helpers';

/**
 * The books read (ADR 0066 §1): QuickBooks' `TrialBalance` and `GeneralLedger`
 * reports and its chart of accounts, parsed from hand-written fixtures in
 * Intuit's documented shape. Nothing here was recorded and nothing here opens
 * a socket.
 *
 * What these hold: a total is never read as a line; the lines read must add
 * up to the totals printed; a shape we did not expect is `QboMalformedResponse`
 * and never an empty report; an amount that is not exact cents fails the read.
 */

const SEPTEMBER = { from: '2026-09-01', to: '2026-09-30' } as const;
const AS_OF = '2026-09-30';

type Json = Record<string, unknown>;

/** A deep copy of a fixture, for a test that breaks one thing in it. */
function copyOf(name: string): Json {
  return structuredClone(fixture(name)) as Json;
}

function rowsOf(report: Json): Json[] {
  return (report['Rows'] as { Row: Json[] }).Row;
}

function cells(row: Json, key: 'ColData' | 'Header' | 'Summary' = 'ColData'): Array<{ value: string; id?: string }> {
  const holder = key === 'ColData' ? row : (row[key] as Json);
  return holder['ColData'] as Array<{ value: string; id?: string }>;
}

function malformedAt(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(QboMalformedResponse);
    return (error as QboMalformedResponse).fieldPath;
  }
  throw new Error('expected QboMalformedResponse');
}

describe('reportAmountToCents', () => {
  it('reads decimal text exactly, and a blank cell as nothing', () => {
    expect(reportAmountToCents('4151.74', 'x')).toBe(415_174);
    expect(reportAmountToCents('-100.00', 'x')).toBe(-10_000);
    expect(reportAmountToCents('18250', 'x')).toBe(1_825_000);
    expect(reportAmountToCents('225.0', 'x')).toBe(22_500);
    expect(reportAmountToCents('0.00', 'x')).toBe(0);
    expect(reportAmountToCents('', 'x')).toBeUndefined();
    expect(reportAmountToCents('  ', 'x')).toBeUndefined();
  });

  it('refuses anything that is not exact cents, naming the cell', () => {
    for (const value of ['12.345', '1,200.00', '$12.00', '1.0E7', '12.', '.50', 'TOTAL', '12.001']) {
      expect(malformedAt(() => reportAmountToCents(value, 'Row[3].ColData[1]'))).toBe(
        'Row[3].ColData[1]',
      );
    }
  });
});

describe('parseTrialBalanceReport', () => {
  it('reads every account row, and the GrandTotal as the totals — not as a line', () => {
    const tb = parseTrialBalanceReport(fixture('report-trial-balance.json'), { asOf: AS_OF });

    expect(tb.sourceKind).toBe('qbo');
    expect(tb.asOf).toBe(AS_OF);
    expect(tb.periodStart).toBe('2026-01-01');
    expect(tb.basis).toBe('Accrual');
    expect(tb.currency).toBe('USD');
    expect(tb.lines).toHaveLength(9);
    expect(tb.lines.map((line) => line.accountName)).not.toContain('TOTAL');
    expect(tb.lines[0]).toEqual({
      accountExternalId: '35',
      accountName: 'Checking',
      debitCents: 1_825_040,
      creditCents: 0,
    });
    expect(tb.lines[3]).toEqual({
      accountExternalId: '92',
      accountName: 'Allowance for Doubtful Accounts',
      debitCents: 0,
      creditCents: 25_000,
    });
    expect(tb.totalDebitCents).toBe(2_718_575);
    expect(tb.totalCreditCents).toBe(2_718_575);
    expect(trialBalanceDifferenceCents(tb)).toBe(0);
  });

  it('reads accounts inside nested sections and never a section total', () => {
    const tb = parseTrialBalanceReport(fixture('report-trial-balance-nested.json'), { asOf: AS_OF });

    expect(tb.lines.map((line) => line.accountName)).toEqual([
      'Checking',
      'Accounts Receivable (A/R)',
      'Deductions Receivable',
      'Allowance for Doubtful Accounts',
      'Sales of Product Income',
      'Distributor Chargebacks',
      'Opening Balance Equity',
      'Customer Deductions',
      'Freight Out',
    ]);
    // Nine accounts, and none of the four section totals or their headers.
    for (const name of ['Assets', 'Total Assets', 'Total Other Current Assets', 'Total Income', 'TOTAL']) {
      expect(tb.lines.map((line) => line.accountName)).not.toContain(name);
    }
    expect(tb.totalDebitCents).toBe(2_718_575);
    expect(tb.totalCreditCents).toBe(2_718_575);
  });

  it('gives the flat and the nested report the same lines', () => {
    const flat = parseTrialBalanceReport(fixture('report-trial-balance.json'), { asOf: AS_OF });
    const nested = parseTrialBalanceReport(fixture('report-trial-balance-nested.json'), { asOf: AS_OF });
    const byId = (lines: typeof flat.lines) =>
      [...lines]
        .map((line) => [line.accountExternalId, line.debitCents, line.creditCents])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    expect(byId(nested.lines)).toEqual(byId(flat.lines));
  });

  it('returns a ledger that does not balance rather than refusing it', () => {
    const report = copyOf('report-trial-balance.json');
    const rows = rowsOf(report);
    // Checking is $100.00 heavier, and QuickBooks' own total says so too.
    cells(rows[0] as Json)[1]!.value = '18350.40';
    cells(rows[rows.length - 1] as Json, 'Summary')[1]!.value = '27285.75';

    const tb = parseTrialBalanceReport(report, { asOf: AS_OF });
    expect(tb.totalDebitCents).toBe(2_728_575);
    expect(tb.totalCreditCents).toBe(2_718_575);
    expect(trialBalanceDifferenceCents(tb)).toBe(10_000);
  });

  it('refuses a report whose lines do not add up to its totals', () => {
    const report = copyOf('report-trial-balance.json');
    rowsOf(report).splice(2, 1); // a row dropped: the total no longer ties out
    expect(malformedAt(() => parseTrialBalanceReport(report, { asOf: AS_OF }))).toBe(
      'TrialBalance.GrandTotal',
    );
  });

  it('refuses a nested section whose lines do not add up to its own total', () => {
    const report = copyOf('report-trial-balance-nested.json');
    const assets = rowsOf(report)[0] as Json;
    cells(assets, 'Summary')[1]!.value = '23650.66';
    expect(malformedAt(() => parseTrialBalanceReport(report, { asOf: AS_OF }))).toBe(
      'TrialBalance.Rows.Row[0].Summary',
    );
  });

  it('refuses an amount that is not exact cents, naming the cell', () => {
    const report = copyOf('report-trial-balance.json');
    cells(rowsOf(report)[1] as Json)[1]!.value = '4130.255';
    expect(malformedAt(() => parseTrialBalanceReport(report, { asOf: AS_OF }))).toBe(
      'TrialBalance.Rows.Row[1].ColData[1]',
    );
  });

  it('refuses a report with no totals row unless it says it has no data', () => {
    const report = copyOf('report-trial-balance.json');
    rowsOf(report).pop();
    expect(malformedAt(() => parseTrialBalanceReport(report, { asOf: AS_OF }))).toBe(
      'TrialBalance.Rows',
    );

    const empty = copyOf('report-trial-balance.json');
    empty['Rows'] = {};
    expect(malformedAt(() => parseTrialBalanceReport(empty, { asOf: AS_OF }))).toBe('TrialBalance.Rows');

    (empty['Header'] as Json)['Option'] = [{ Name: 'NoReportData', Value: 'true' }];
    const tb = parseTrialBalanceReport(empty, { asOf: AS_OF });
    expect(tb.lines).toEqual([]);
    expect(tb.totalDebitCents).toBe(0);
  });

  it('refuses shapes it was not written for, loudly', () => {
    // Another report entirely.
    expect(
      malformedAt(() => parseTrialBalanceReport(fixture('report-general-ledger.json'), { asOf: AS_OF })),
    ).toBe('TrialBalance.Header.ReportName');
    // A query response, not a report.
    expect(
      malformedAt(() => parseTrialBalanceReport(fixture('account-query-books.json'), { asOf: AS_OF })),
    ).toBe('TrialBalance.Header');
    // Another day than the one asked for.
    expect(
      malformedAt(() => parseTrialBalanceReport(fixture('report-trial-balance.json'), { asOf: '2026-09-29' })),
    ).toBe('TrialBalance.Header.EndPeriod');

    // A column layout we do not read: two Debit columns (summarised by month).
    const twoDebits = copyOf('report-trial-balance.json');
    ((twoDebits['Columns'] as Json)['Column'] as Json[]).push({ ColTitle: 'Debit', ColType: 'Money' });
    expect(malformedAt(() => parseTrialBalanceReport(twoDebits, { asOf: AS_OF }))).toBe(
      'TrialBalance.Columns.Column',
    );

    // A row with a cell missing.
    const short = copyOf('report-trial-balance.json');
    cells(rowsOf(short)[4] as Json).pop();
    expect(malformedAt(() => parseTrialBalanceReport(short, { asOf: AS_OF }))).toBe(
      'TrialBalance.Rows.Row[4].ColData',
    );

    // A cell whose value is a number, not text.
    const numeric = copyOf('report-trial-balance.json');
    (cells(rowsOf(numeric)[0] as Json)[1] as unknown as Json)['value'] = 18250.4;
    expect(malformedAt(() => parseTrialBalanceReport(numeric, { asOf: AS_OF }))).toBe(
      'TrialBalance.Rows.Row.0.ColData.1.value',
    );

    // A row that is neither data nor a section, and one that is both.
    const neither = copyOf('report-trial-balance.json');
    rowsOf(neither).splice(1, 0, { type: 'Data' });
    expect(malformedAt(() => parseTrialBalanceReport(neither, { asOf: AS_OF }))).toBe(
      'TrialBalance.Rows.Row[1]',
    );

    // A second GrandTotal.
    const twice = copyOf('report-trial-balance.json');
    rowsOf(twice).push(structuredClone(rowsOf(twice)[rowsOf(twice).length - 1] as Json));
    expect(malformedAt(() => parseTrialBalanceReport(twice, { asOf: AS_OF }))).toBe(
      'TrialBalance.Rows.Row[10]',
    );
  });

  it('never quotes a figure from the books in a tie-out refusal', () => {
    const report = copyOf('report-trial-balance.json');
    rowsOf(report).splice(2, 1);
    try {
      parseTrialBalanceReport(report, { asOf: AS_OF });
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as Error).message).not.toMatch(/\d{3,}/);
    }
  });
});

describe('parseGeneralLedgerReport', () => {
  it('reads a section per account: postings as lines, the opening balance and the total as neither', () => {
    const ledger = parseGeneralLedgerReport(fixture('report-general-ledger.json'), { window: SEPTEMBER });

    expect(ledger.sourceKind).toBe('qbo');
    expect(ledger.window).toEqual(SEPTEMBER);
    expect(ledger.basis).toBe('Accrual');
    expect(ledger.accounts.map((account) => [account.accountExternalId, account.accountName, account.lines.length])).toEqual([
      ['84', 'Accounts Receivable (A/R)', 5],
      ['91', 'Deductions Receivable', 1],
      ['95', 'Trade Deductions', 0],
      ['96', 'Distributor Chargebacks', 2],
      ['97', 'Customer Deductions', 1],
    ]);

    const receivable = ledger.accounts[0]!;
    expect(receivable.beginningBalanceCents).toBe(490_025);
    expect(receivable.lines[0]).toEqual({
      accountExternalId: '84',
      accountName: 'Accounts Receivable (A/R)',
      date: '2026-09-02',
      transactionType: 'Payment',
      transactionExternalId: '302',
      name: 'Sysco Baltimore, LLC',
      debitCents: 0,
      creditCents: 127_000,
      balanceCents: 363_025,
    });
    expect(receivable.lines[3]).toEqual({
      accountExternalId: '84',
      accountName: 'Accounts Receivable (A/R)',
      date: '2026-09-18',
      transactionType: 'Journal Entry',
      transactionExternalId: '610',
      documentNumber: 'RC-JE-1',
      name: 'US Foods, Inc.',
      memo: 'Deduction held, claim CB-203',
      debitCents: 0,
      creditCents: 50_000,
      balanceCents: 503_025,
    });

    // No line anywhere is a total or an opening balance.
    const everything = ledger.accounts.flatMap((account) => account.lines);
    expect(everything).toHaveLength(9);
    for (const line of everything) {
      expect(line.date).toMatch(/^2026-09-\d\d$/);
      expect(line.debitCents + line.creditCents).toBeGreaterThan(0);
    }
    // An income account carries no balance forward, and says so by absence.
    expect(ledger.accounts[3]!.beginningBalanceCents).toBeUndefined();
  });

  it('lists a sub-account as its own account, after its parent', () => {
    const ledger = parseGeneralLedgerReport(fixture('report-general-ledger.json'), { window: SEPTEMBER });
    const chargebacks = ledger.accounts.find((account) => account.accountExternalId === '96')!;
    expect(chargebacks.lines.map((line) => [line.date, line.documentNumber, line.debitCents])).toEqual([
      ['2026-09-01', 'CM-2210', 127_000],
      ['2026-09-10', 'CM-2211', 50_000],
    ]);
    expect(chargebacks.lines.every((line) => line.accountExternalId === '96')).toBe(true);
  });

  it('refuses a section whose postings do not add up to its total', () => {
    const dropped = copyOf('report-general-ledger.json');
    const receivable = rowsOf(dropped)[0] as Json;
    (receivable['Rows'] as { Row: Json[] }).Row.splice(2, 1);
    expect(malformedAt(() => parseGeneralLedgerReport(dropped, { window: SEPTEMBER }))).toBe(
      'GeneralLedger.Rows.Row[0].Summary',
    );

    // A parent's total covers its sub-accounts' postings.
    const parent = copyOf('report-general-ledger.json');
    cells(rowsOf(parent)[2] as Json, 'Summary')[6]!.value = '1770.01';
    expect(malformedAt(() => parseGeneralLedgerReport(parent, { window: SEPTEMBER }))).toBe(
      'GeneralLedger.Rows.Row[2].Summary',
    );
  });

  it('would count a total read as a line: the tie-out is what catches it', () => {
    // Move a section's Summary into its rows as if it were a posting. Its first
    // cell is not a date, so the row is refused where it stands.
    const report = copyOf('report-general-ledger.json');
    const section = rowsOf(report)[1] as Json;
    (section['Rows'] as { Row: Json[] }).Row.push({ ColData: cells(section, 'Summary'), type: 'Data' });
    expect(malformedAt(() => parseGeneralLedgerReport(report, { window: SEPTEMBER }))).toBe(
      'GeneralLedger.Rows.Row[1].Rows.Row[2].ColData[0]',
    );
  });

  it('returns an empty ledger only when QuickBooks says there is no data', () => {
    const ledger = parseGeneralLedgerReport(fixture('report-general-ledger-no-data.json'), {
      window: SEPTEMBER,
    });
    expect(ledger.accounts).toEqual([]);

    const silent = copyOf('report-general-ledger-no-data.json');
    (silent['Header'] as Json)['Option'] = [{ Name: 'NoReportData', Value: 'false' }];
    expect(malformedAt(() => parseGeneralLedgerReport(silent, { window: SEPTEMBER }))).toBe(
      'GeneralLedger.Rows',
    );
    delete (silent['Header'] as Json)['Option'];
    expect(malformedAt(() => parseGeneralLedgerReport(silent, { window: SEPTEMBER }))).toBe(
      'GeneralLedger.Rows',
    );
    delete silent['Rows'];
    expect(malformedAt(() => parseGeneralLedgerReport(silent, { window: SEPTEMBER }))).toBe(
      'GeneralLedger.Rows',
    );
  });

  it('refuses a column it asked for and did not get — a multicurrency company', () => {
    const report = copyOf('report-general-ledger.json');
    const columns = (report['Columns'] as Json)['Column'] as Array<{ MetaData: Array<{ Value: string }> }>;
    columns[6]!.MetaData[0]!.Value = 'debt_home_amt';
    expect(malformedAt(() => parseGeneralLedgerReport(report, { window: SEPTEMBER }))).toBe(
      'GeneralLedger.Columns.Column',
    );
  });

  it('refuses a posting outside the window, an unreadable date and an amount past the cent', () => {
    expect(
      malformedAt(() =>
        parseGeneralLedgerReport(fixture('report-general-ledger.json'), {
          window: { from: '2026-09-03', to: '2026-09-30' },
        }),
      ),
    ).toBe('GeneralLedger.Rows.Row[0].Rows.Row[1].ColData[0]');

    const badDate = copyOf('report-general-ledger.json');
    const rows = ((rowsOf(badDate)[0] as Json)['Rows'] as { Row: Json[] }).Row;
    cells(rows[1] as Json)[0]!.value = '09/02/2026';
    expect(malformedAt(() => parseGeneralLedgerReport(badDate, { window: SEPTEMBER }))).toBe(
      'GeneralLedger.Rows.Row[0].Rows.Row[1].ColData[0]',
    );

    const badAmount = copyOf('report-general-ledger.json');
    const amountRows = ((rowsOf(badAmount)[0] as Json)['Rows'] as { Row: Json[] }).Row;
    cells(amountRows[1] as Json)[7]!.value = '1270.005';
    expect(malformedAt(() => parseGeneralLedgerReport(badAmount, { window: SEPTEMBER }))).toBe(
      'GeneralLedger.Rows.Row[0].Rows.Row[1].ColData[7]',
    );
  });

  it('refuses a posting outside any account, and a second opening balance', () => {
    const loose = copyOf('report-general-ledger.json');
    const posting = ((rowsOf(loose)[0] as Json)['Rows'] as { Row: Json[] }).Row[1] as Json;
    rowsOf(loose).push(structuredClone(posting));
    expect(malformedAt(() => parseGeneralLedgerReport(loose, { window: SEPTEMBER }))).toBe(
      'GeneralLedger.Rows.Row[4]',
    );

    const twice = copyOf('report-general-ledger.json');
    const rows = ((rowsOf(twice)[0] as Json)['Rows'] as { Row: Json[] }).Row;
    rows.splice(2, 0, structuredClone(rows[0] as Json));
    expect(malformedAt(() => parseGeneralLedgerReport(twice, { window: SEPTEMBER }))).toBe(
      'GeneralLedger.Rows.Row[0].Rows.Row[2]',
    );
  });

  it('refuses a report QuickBooks cut short at its own limit', () => {
    const report = copyOf('report-general-ledger.json');
    const rows = ((rowsOf(report)[3] as Json)['Rows'] as { Row: Json[] }).Row;
    rows.push({
      ColData: [
        { value: 'Unable to display more data. Please reduce the date range.' },
        ...Array.from({ length: 8 }, () => ({ value: '' })),
      ],
      type: 'Data',
    });
    expect(() => parseGeneralLedgerReport(report, { window: SEPTEMBER })).toThrow(QboReportTooLarge);
  });

  it('refuses more postings than one read returns, whole', () => {
    const report = copyOf('report-general-ledger.json');
    const section = rowsOf(report)[3] as Json;
    const rows = (section['Rows'] as { Row: Json[] }).Row;
    const posting = rows[0] as Json;
    for (let count = 0; count < GENERAL_LEDGER_MAX_LINES; count += 1) rows.push(posting);
    try {
      parseGeneralLedgerReport(report, { window: SEPTEMBER });
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(QboReportTooLarge);
      expect((error as QboReportTooLarge).reason).toBe('too_many_lines');
    }
  });
});

describe('toLedgerAccount', () => {
  const rows = (fixture('account-query-books.json') as { QueryResponse: { Account: Json[] } })
    .QueryResponse.Account;

  it('reads the code, the names, the types, whether it is active and the balance', () => {
    expect(toLedgerAccount(rows[1] as Json, 'Account[1]')).toEqual({
      sourceKind: 'qbo',
      externalId: '84',
      code: '1200',
      name: 'Accounts Receivable (A/R)',
      fullyQualifiedName: 'Accounts Receivable (A/R)',
      accountType: 'Accounts Receivable',
      accountSubType: 'AccountsReceivable',
      classification: 'Asset',
      active: true,
      currentBalanceCents: 413_025,
    });
    // A sub-account's full name; a negative balance; a chart row with no code.
    expect(toLedgerAccount(rows[7] as Json, 'Account[7]').fullyQualifiedName).toBe(
      'Trade Deductions:Distributor Chargebacks',
    );
    expect(toLedgerAccount(rows[3] as Json, 'Account[3]').currentBalanceCents).toBe(-25_000);
    const noCode = toLedgerAccount(rows[9] as Json, 'Account[9]');
    expect(noCode.code).toBeUndefined();
    expect('code' in noCode).toBe(false);
    expect(toLedgerAccount(rows[10] as Json, 'Account[10]').active).toBe(false);
  });

  it('refuses a balance that is not exact cents and an Active that is not a boolean', () => {
    expect(
      malformedAt(() => toLedgerAccount({ ...(rows[0] as Json), CurrentBalance: 10.005 }, 'Account[0]')),
    ).toBe('Account[0].CurrentBalance');
    expect(
      malformedAt(() => toLedgerAccount({ ...(rows[0] as Json), CurrentBalance: '18250.40' }, 'Account[0]')),
    ).toBe('Account[0].CurrentBalance');
    expect(malformedAt(() => toLedgerAccount({ ...(rows[0] as Json), Active: 'true' }, 'Account[0]'))).toBe(
      'Account[0].Active',
    );
    expect(malformedAt(() => toLedgerAccount({ ...(rows[0] as Json), AcctNum: 1000 }, 'Account[0]'))).toBe(
      'Account[0].AcctNum',
    );
  });
});

describe('QboAccountingSource, the books', () => {
  /** A QuickBooks that serves the three books reads from the fixtures. */
  function booksFetch() {
    return recordingFetch((request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith('/reports/TrialBalance')) {
        return jsonResponse(fixture('report-trial-balance.json'));
      }
      if (url.pathname.endsWith('/reports/GeneralLedger')) {
        return jsonResponse(fixture('report-general-ledger.json'));
      }
      if (url.pathname.endsWith('/query')) return jsonResponse(fixture('account-query-books.json'));
      throw new Error(`the fake was asked for something it does not serve: ${url.pathname}`);
    });
  }

  it('reads the chart of accounts whole, inactive accounts included', async () => {
    const { fetchImpl, calls } = booksFetch();
    const chart = await new QboAccountingSource(configFor(fetchImpl)).chartOfAccounts();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.statement).toContain('select * from Account where Active in (true, false)');
    expect(chart).toHaveLength(11);
    expect(chart.map((account) => account.code)).toEqual([
      '1000', '1200', '1250', '1290', '3000', '4000', '4900', '4910', '6400', undefined, undefined,
    ]);
    expect(chart.filter((account) => !account.active).map((account) => account.name)).toEqual([
      'Old Clearing',
    ]);
  });

  it('refuses a chart longer than its pages rather than returning part of it', async () => {
    const { fetchImpl } = booksFetch();
    const source = new QboAccountingSource(configFor(fetchImpl, undefined, { pageSize: 11, maxPages: 1 }));
    await expect(source.chartOfAccounts()).rejects.toBeInstanceOf(QboChartTooLarge);
  });

  it('asks for the trial balance as a GET, for the year to date, under a fresh request id', async () => {
    const { fetchImpl, calls } = booksFetch();
    const source = new QboAccountingSource(configFor(fetchImpl));
    const tb = await source.trialBalance(AS_OF);
    await source.trialBalance(AS_OF);

    const url = new URL(calls[0]!.url);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.body).toBeUndefined();
    expect(url.pathname).toBe(`/v3/company/${REALM_ID}/reports/TrialBalance`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      start_date: '2026-01-01',
      end_date: '2026-09-30',
    });
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer access-token-1');
    expect(calls[0]?.headers.get('Request-Id')).not.toBe(calls[1]?.headers.get('Request-Id'));
    expect(tb.lines).toHaveLength(9);
    expect(trialBalancePeriodStart('2027-03-09')).toBe('2027-01-01');
  });

  it('asks for the general ledger with its columns and no account filter', async () => {
    const { fetchImpl, calls } = booksFetch();
    const ledger = await new QboAccountingSource(configFor(fetchImpl)).generalLedger(SEPTEMBER);

    const url = new URL(calls[0]!.url);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('GET');
    expect(url.pathname).toBe(`/v3/company/${REALM_ID}/reports/GeneralLedger`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      start_date: '2026-09-01',
      end_date: '2026-09-30',
      columns: GENERAL_LEDGER_COLUMNS.join(','),
    });
    expect(ledger.accounts).toHaveLength(5);
  });

  it('filters by account, and returns only the accounts asked for', async () => {
    const { fetchImpl, calls } = booksFetch();
    const ledger = await new QboAccountingSource(configFor(fetchImpl)).generalLedger(SEPTEMBER, {
      accountIds: ['96', '91', '96'],
    });

    expect(new URL(calls[0]!.url).searchParams.get('account')).toBe('96,91');
    // The fake answers with every account; the parent of 96 was not asked for.
    expect(ledger.accounts.map((account) => account.accountExternalId)).toEqual(['91', '96']);
  });

  it('asks QuickBooks nothing for an empty list of accounts', async () => {
    const { fetchImpl, calls } = booksFetch();
    const ledger = await new QboAccountingSource(configFor(fetchImpl)).generalLedger(SEPTEMBER, {
      accountIds: [],
    });
    expect(calls).toHaveLength(0);
    expect(ledger).toEqual({ sourceKind: 'qbo', window: SEPTEMBER, accounts: [] });
  });

  it('refuses a window, a day or an account id it will not send — before any request', async () => {
    const { fetchImpl, calls } = booksFetch();
    const source = new QboAccountingSource(configFor(fetchImpl));

    await expect(source.generalLedger({ from: '2026-09-30', to: '2026-09-01' })).rejects.toBeInstanceOf(
      QboInvalidWindow,
    );
    await expect(source.generalLedger({ from: "2026-09-01'", to: '2026-09-30' })).rejects.toBeInstanceOf(
      QboInvalidWindow,
    );
    // 187 days: one more than a read covers.
    expect(GENERAL_LEDGER_MAX_WINDOW_DAYS).toBe(186);
    await expect(source.generalLedger({ from: '2026-03-28', to: '2026-09-30' })).rejects.toBeInstanceOf(
      QboInvalidWindow,
    );
    await expect(source.generalLedger({ from: '2026-03-29', to: '2026-09-30' })).resolves.toBeDefined();
    await expect(source.generalLedger(SEPTEMBER, { accountIds: ['84', '91 or 1=1'] })).rejects.toBeInstanceOf(
      QboInvalidId,
    );
    await expect(source.trialBalance('30/09/2026')).rejects.toBeInstanceOf(QboInvalidWindow);
    await expect(source.trialBalance('2026-02-31')).rejects.toBeInstanceOf(QboInvalidWindow);

    // Only the one window that was allowed reached QuickBooks.
    expect(calls).toHaveLength(1);
  });

  it('turns an Intuit failure into a typed error, never an empty report', async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(fixture('fault-validation.json'), 400));
    const source = new QboAccountingSource(configFor(fetchImpl));
    await expect(source.trialBalance(AS_OF)).rejects.toBeInstanceOf(QboRequestFailed);
    await expect(source.generalLedger(SEPTEMBER)).rejects.toBeInstanceOf(QboRequestFailed);

    const empty = recordingFetch(() => jsonResponse({}));
    const silent = new QboAccountingSource(configFor(empty.fetchImpl));
    await expect(silent.trialBalance(AS_OF)).rejects.toBeInstanceOf(QboMalformedResponse);
    await expect(silent.generalLedger(SEPTEMBER)).rejects.toBeInstanceOf(QboMalformedResponse);
  });
});

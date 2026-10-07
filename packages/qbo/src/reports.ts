/**
 * Reading QuickBooks' Reports API and its chart of accounts into the port's
 * books rows (ADR 0066 §1): `TrialBalance`, `GeneralLedger`, and an `Account`
 * row with its code — and `ProfitAndLoss`, read to size the deductions beside
 * sales (ADR 0073).
 *
 * Nothing here does I/O. Each function takes what QuickBooks already answered
 * and returns typed, cents-based rows or throws `QboMalformedResponse` naming
 * the path it gave up on. **A report we cannot read whole is refused, never
 * returned in part and never returned empty**: an empty trial balance and an
 * unreadable one are different facts, and only the report's own
 * `NoReportData` option says the first.
 *
 * A report is a tree: `Rows.Row[]`, where a row is either data (`ColData`) or
 * a section (`Header`, nested `Rows`, `Summary`). Three things in that tree
 * look like lines and are not, and each is handled by name rather than by
 * luck:
 *
 * - a section's `Summary` ("Total for Accounts Receivable") is a total. It is
 *   never a line; it is what the lines read are **checked against**, so a row
 *   this parser dropped or read twice fails the read instead of shrinking it;
 * - a general ledger's "Beginning Balance" row is a balance brought forward;
 * - the trial balance's `GrandTotal` section is the report's totals.
 *
 * Money arrives as decimal text (`"4151.74"`, `""` for a blank cell) and goes
 * through `parseMoneyToCents`, the one money parser in this system. A value
 * that is not exact cents fails the read.
 */

import { z } from 'zod';
import type {
  GeneralLedger,
  GeneralLedgerAccount,
  GeneralLedgerLine,
  LedgerAccount,
  LedgerWindow,
  ProfitAndLoss,
  ProfitAndLossLine,
  TrialBalance,
  TrialBalanceLine,
} from '@recouple/adapters';
import {
  DateParseError,
  GENERAL_LEDGER_MAX_LINES,
  MoneyError,
  addCents,
  cents,
  parseMoneyToCents,
  parsePrintedDate,
  type Cents,
} from '@recouple/core-domain';
import { QboMalformedResponse, QboReportTooLarge } from './errors';
import { qboAmountToCents } from './money';
import { describe, readOptionalString, type JsonObject } from './reader';
import { toQboAccount } from './setup';

/** The reports this adapter reads. There is deliberately nothing else here. */
export type QboReportName = 'TrialBalance' | 'GeneralLedger' | 'ProfitAndLoss';

/**
 * The general ledger's columns, by Intuit's own keys, in the order asked for:
 * date, transaction type, document number, name, memo, account, debit, credit
 * and running balance. `debt_amt` is Intuit's spelling. These are the keys of
 * a company with one currency; a multicurrency company answers with
 * `debt_home_amt` and its kin, which this reader refuses by name rather than
 * reading a foreign amount as a home one.
 */
export const GENERAL_LEDGER_COLUMNS = Object.freeze([
  'tx_date',
  'txn_type',
  'doc_num',
  'name',
  'memo',
  'account_name',
  'debt_amt',
  'credit_amt',
  'rbal_nat_amount',
] as const);

type GeneralLedgerColumn = (typeof GENERAL_LEDGER_COLUMNS)[number];

/**
 * What QuickBooks prints inside a report it cut short at its cell limit
 * (400,000 cells). The Reports API does not paginate: past the limit the rest
 * is simply not there, so a report carrying this text is refused whole.
 */
export const REPORT_CUT_SHORT_TEXT = 'Unable to display more data';

/** How deep a report's sections may nest before we stop reading it. */
export const REPORT_MAX_DEPTH = 8;

/** The label of the row that carries a general-ledger account's opening balance. */
const BEGINNING_BALANCE = 'Beginning Balance';

// --- the wire shape ------------------------------------------------------------

const CellSchema = z.looseObject({
  value: z.string(),
  id: z.string().optional(),
});
type Cell = z.infer<typeof CellSchema>;

const CellsSchema = z.looseObject({ ColData: z.array(CellSchema) });

interface ReportRow {
  readonly [key: string]: unknown;
  readonly type?: string | undefined;
  readonly group?: string | undefined;
  readonly ColData?: Cell[] | undefined;
  readonly Header?: { ColData: Cell[] } | undefined;
  readonly Rows?: { Row?: ReportRow[] | undefined } | undefined;
  readonly Summary?: { ColData: Cell[] } | undefined;
}

const RowSchema: z.ZodType<ReportRow> = z.lazy(() =>
  z.looseObject({
    type: z.string().optional(),
    group: z.string().optional(),
    ColData: z.array(CellSchema).optional(),
    Header: CellsSchema.optional(),
    Rows: z.looseObject({ Row: z.array(RowSchema).optional() }).optional(),
    Summary: CellsSchema.optional(),
  }),
);

const NameValueSchema = z.looseObject({ Name: z.string(), Value: z.string() });

const ReportSchema = z.looseObject({
  Header: z.looseObject({
    ReportName: z.string(),
    ReportBasis: z.string().optional(),
    StartPeriod: z.string().optional(),
    EndPeriod: z.string().optional(),
    Currency: z.string().optional(),
    Option: z.array(NameValueSchema).optional(),
  }),
  Columns: z.looseObject({
    Column: z.array(
      z.looseObject({
        ColTitle: z.string(),
        ColType: z.string(),
        MetaData: z.array(NameValueSchema).optional(),
      }),
    ),
  }),
  Rows: z.looseObject({ Row: z.array(RowSchema).optional() }),
});
type Report = z.infer<typeof ReportSchema>;

/**
 * The report's envelope, validated, or `QboMalformedResponse` naming the first
 * path that was not what Intuit documents. The message carries the path and
 * what was expected there, never a value out of the customer's books.
 */
function readReport(body: unknown, name: QboReportName): Report {
  const parsed = ReportSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = [name, ...(issue?.path ?? []).map(String)].join('.');
    throw new QboMalformedResponse(
      `the ${name} report is not the shape QuickBooks documents at ${path}: ` +
        `${issue?.code ?? 'invalid'}`,
      path,
    );
  }
  const report = parsed.data;
  if (report.Header.ReportName !== name) {
    throw new QboMalformedResponse(
      `asked for the ${name} report and got ${describe(report.Header.ReportName)}`,
      `${name}.Header.ReportName`,
    );
  }
  assertNotCutShort(report.Rows.Row ?? [], `${name}.Rows`, 0);
  return report;
}

/** Whether the report itself says it has no data: the only honest "empty". */
function saysNoData(report: Report): boolean {
  return (report.Header.Option ?? []).some(
    (option) => option.Name === 'NoReportData' && option.Value === 'true',
  );
}

function assertNotCutShort(rows: readonly ReportRow[], path: string, depth: number): void {
  if (depth > REPORT_MAX_DEPTH) {
    throw new QboMalformedResponse(
      `the report nests more than ${REPORT_MAX_DEPTH} sections deep at ${path}`,
      path,
    );
  }
  rows.forEach((row, index) => {
    const at = `${path}.Row[${index}]`;
    const cells = [
      ...(row.ColData ?? []),
      ...(row.Header?.ColData ?? []),
      ...(row.Summary?.ColData ?? []),
    ];
    if (cells.some((cell) => cell.value.includes(REPORT_CUT_SHORT_TEXT))) {
      throw new QboReportTooLarge('cut_short');
    }
    assertNotCutShort(row.Rows?.Row ?? [], `${at}.Rows`, depth + 1);
  });
}

/** A row is data or a section, never both and never neither. */
function kindOf(row: ReportRow, path: string): 'data' | 'section' {
  const section = row.Header !== undefined || row.Rows !== undefined || row.Summary !== undefined;
  if (row.ColData !== undefined && !section) return 'data';
  if (row.ColData === undefined && section) return 'section';
  throw new QboMalformedResponse(
    `expected a data row or a section at ${path}, got a row that is ${
      section ? 'both' : 'neither'
    }`,
    path,
  );
}

function cellsOf(cells: readonly Cell[], width: number, path: string): readonly Cell[] {
  if (cells.length !== width) {
    throw new QboMalformedResponse(
      `expected ${width} cells at ${path}, one per column, got ${cells.length}`,
      path,
    );
  }
  return cells;
}

function idOf(cell: Cell | undefined): string | undefined {
  return cell?.id === undefined || cell.id === '' ? undefined : cell.id;
}

function textOf(cell: Cell | undefined): string | undefined {
  return cell === undefined || cell.value.trim() === '' ? undefined : cell.value;
}

/**
 * One money cell into cents, or nothing for a blank one.
 *
 * A report prints plain decimal text: digits, an optional leading minus, an
 * optional fraction. Anything else — a comma, a currency sign, an exponent —
 * is not something this API documents and is refused. One decimal place
 * (`"225.0"`) is read as exactly that many dimes, as `qboAmountToCents` reads
 * a JSON `1234.5`: the cell is a whole JSON string, so it cannot be an amount
 * cut short, which is the case `parseMoneyToCents` refuses one place for. A
 * fraction of a cent is still refused there, never rounded.
 */
export function reportAmountToCents(value: string, path: string): Cents | undefined {
  if (value.trim() === '') return undefined;
  if (!/^-?\d+(\.\d+)?$/.test(value)) {
    throw new QboMalformedResponse(
      `expected a decimal amount at ${path}, got ${describe(value)}`,
      path,
    );
  }
  const text = /\.\d$/.test(value) ? `${value}0` : value;
  try {
    return parseMoneyToCents(text);
  } catch (error) {
    if (error instanceof MoneyError) {
      throw new QboMalformedResponse(
        `amount at ${path} is not exact cents: ${error.message}`,
        path,
      );
    }
    throw error;
  }
}

function isoDateOf(value: string, path: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new QboMalformedResponse(`expected YYYY-MM-DD at ${path}, got ${describe(value)}`, path);
  }
  try {
    return parsePrintedDate(value);
  } catch (error) {
    if (error instanceof DateParseError) {
      throw new QboMalformedResponse(`date at ${path} is not a calendar day`, path);
    }
    throw error;
  }
}

const ZERO = cents(0);

// --- the trial balance ---------------------------------------------------------

interface TrialBalanceColumns {
  readonly width: number;
  readonly account: number;
  readonly debit: number;
  readonly credit: number;
}

function trialBalanceColumns(report: Report): TrialBalanceColumns {
  const columns = report.Columns.Column;
  const only = (what: string, test: (index: number) => boolean): number => {
    const found = columns.map((_, index) => index).filter(test);
    const [first] = found;
    if (found.length !== 1 || first === undefined) {
      throw new QboMalformedResponse(
        `expected exactly one ${what} column in the trial balance, got ${found.length}`,
        // `what` is one of our own three constants, never text from the report.
        `TrialBalance.Columns.Column.${what}`,
      );
    }
    return first;
  };
  return {
    width: columns.length,
    account: only('Account', (index) => columns[index]?.ColType === 'Account'),
    debit: only(
      'Debit',
      (index) => columns[index]?.ColType === 'Money' && columns[index]?.ColTitle === 'Debit',
    ),
    credit: only(
      'Credit',
      (index) => columns[index]?.ColType === 'Money' && columns[index]?.ColTitle === 'Credit',
    ),
  };
}

interface Sides {
  debit: Cents;
  credit: Cents;
}

/**
 * QuickBooks' `TrialBalance` report as the port's `TrialBalance`.
 *
 * Every account row at any depth is a line; a nested section's `Summary` is
 * checked against the lines under it and never read as one; and the
 * `GrandTotal` section is the report's totals, which the lines must add up to
 * — to the cent, both sides — or the read is refused. Debits not equalling
 * credits is **not** refused: that is the ledger's fact, and the page's to
 * show.
 */
export function parseTrialBalanceReport(body: unknown, asked: { readonly asOf: string }): TrialBalance {
  const report = readReport(body, 'TrialBalance');
  const columns = trialBalanceColumns(report);

  const endPeriod = report.Header.EndPeriod;
  if (endPeriod !== undefined && endPeriod !== asked.asOf) {
    throw new QboMalformedResponse(
      `asked for a trial balance as of ${asked.asOf} and QuickBooks answered for ` +
        `${describe(endPeriod)}`,
      'TrialBalance.Header.EndPeriod',
    );
  }

  const lines: TrialBalanceLine[] = [];
  let grandTotal: Sides | undefined;

  const sidesOf = (cells: readonly Cell[], path: string): Partial<Sides> => {
    const debit = reportAmountToCents(cells[columns.debit]?.value ?? '', `${path}[${columns.debit}]`);
    const credit = reportAmountToCents(
      cells[columns.credit]?.value ?? '',
      `${path}[${columns.credit}]`,
    );
    return {
      ...(debit === undefined ? {} : { debit }),
      ...(credit === undefined ? {} : { credit }),
    };
  };

  const walk = (rows: readonly ReportRow[], path: string, depth: number): Sides => {
    const total: Sides = { debit: ZERO, credit: ZERO };
    rows.forEach((row, index) => {
      const at = `${path}.Row[${index}]`;
      if (kindOf(row, at) === 'data') {
        const cells = cellsOf(row.ColData ?? [], columns.width, `${at}.ColData`);
        const accountCell = cells[columns.account];
        const accountName = textOf(accountCell);
        if (accountName === undefined) {
          throw new QboMalformedResponse(
            `expected an account name at ${at}.ColData[${columns.account}]`,
            `${at}.ColData[${columns.account}]`,
          );
        }
        const sides = sidesOf(cells, `${at}.ColData`);
        const accountExternalId = idOf(accountCell);
        const line: TrialBalanceLine = {
          ...(accountExternalId === undefined ? {} : { accountExternalId }),
          accountName,
          debitCents: sides.debit ?? ZERO,
          creditCents: sides.credit ?? ZERO,
        };
        lines.push(line);
        total.debit = addCents(total.debit, line.debitCents);
        total.credit = addCents(total.credit, line.creditCents);
        return;
      }

      const summary =
        row.Summary === undefined
          ? undefined
          : sidesOf(
              cellsOf(row.Summary.ColData, columns.width, `${at}.Summary.ColData`),
              `${at}.Summary.ColData`,
            );

      if (row.group === 'GrandTotal') {
        if (grandTotal !== undefined || depth !== 0 || row.Rows !== undefined || summary === undefined) {
          throw new QboMalformedResponse(
            `expected one GrandTotal section, at the top, holding only a Summary, at ${at}`,
            at,
          );
        }
        grandTotal = { debit: summary.debit ?? ZERO, credit: summary.credit ?? ZERO };
        return;
      }

      const under = walk(row.Rows?.Row ?? [], `${at}.Rows`, depth + 1);
      assertTiesOut(under, summary, `${at}.Summary`);
      total.debit = addCents(total.debit, under.debit);
      total.credit = addCents(total.credit, under.credit);
    });
    return total;
  };

  const sum = walk(report.Rows.Row ?? [], 'TrialBalance.Rows', 0);
  // `grandTotal` is assigned inside `walk`, which the compiler cannot see.
  const reported = grandTotal as Sides | undefined;

  if (reported === undefined) {
    if (!(saysNoData(report) && lines.length === 0)) {
      throw new QboMalformedResponse(
        'the trial balance has no GrandTotal row and does not say it has no data',
        'TrialBalance.Rows',
      );
    }
  } else {
    assertTiesOut(sum, reported, 'TrialBalance.GrandTotal');
  }

  const periodStart =
    report.Header.StartPeriod === undefined
      ? undefined
      : isoDateOf(report.Header.StartPeriod, 'TrialBalance.Header.StartPeriod');

  return {
    sourceKind: 'qbo',
    asOf: asked.asOf,
    ...(periodStart === undefined ? {} : { periodStart }),
    ...(report.Header.ReportBasis === undefined ? {} : { basis: report.Header.ReportBasis }),
    ...(report.Header.Currency === undefined ? {} : { currency: report.Header.Currency }),
    lines,
    totalDebitCents: reported?.debit ?? ZERO,
    totalCreditCents: reported?.credit ?? ZERO,
  };
}

/**
 * The lines read under a total must add up to it, on each side the total
 * prints. A blank side of a total checks nothing; a printed one that
 * disagrees means a row was dropped, read twice or misread, and the read is
 * refused. Numbers are not quoted: they are the customer's.
 */
function assertTiesOut(read: Sides, printed: Partial<Sides> | undefined, path: string): void {
  if (printed === undefined) return;
  for (const side of ['debit', 'credit'] as const) {
    const total = printed[side];
    if (total !== undefined && total !== read[side]) {
      throw new QboMalformedResponse(
        `the ${side}s read do not add up to the total printed at ${path}`,
        path,
      );
    }
  }
}

// --- the general ledger --------------------------------------------------------

type GeneralLedgerColumns = Readonly<Record<GeneralLedgerColumn, number>> & {
  readonly width: number;
};

function generalLedgerColumns(report: Report): GeneralLedgerColumns {
  const keys = report.Columns.Column.map(
    // A column is named by its ColKey MetaData where Intuit sends one, else by
    // its ColType: real GeneralLedger reports often carry only the latter.
    (column) =>
      (column.MetaData ?? []).find((entry) => entry.Name === 'ColKey')?.Value ?? column.ColType,
  );
  const at = {} as Record<GeneralLedgerColumn, number>;
  for (const column of GENERAL_LEDGER_COLUMNS) {
    const found = keys.flatMap((key, index) => (key === column ? [index] : []));
    const [first] = found;
    if (found.length !== 1 || first === undefined) {
      throw new QboMalformedResponse(
        `expected exactly one ${column} column in the general ledger, got ${found.length}`,
        // `column` is one of GENERAL_LEDGER_COLUMNS, never a key read from the report.
        `GeneralLedger.Columns.Column.${column}`,
      );
    }
    at[column] = first;
  }
  return { ...at, width: keys.length };
}

/**
 * QuickBooks' `GeneralLedger` report as the port's `GeneralLedger`.
 *
 * One section per account. Inside it, the "Beginning Balance" row is the
 * balance brought forward, every other data row is a posting, and the
 * `Summary` is the section's total: the debits and credits read under a
 * section — its own and its sub-accounts' — must add up to whatever that
 * total prints, or the read is refused. A sub-account's section is its own
 * account, listed after its parent.
 *
 * Every posting must be dated inside the window asked for. More postings than
 * `GENERAL_LEDGER_MAX_LINES` is `QboReportTooLarge`, as is a report QuickBooks
 * itself cut short.
 */
export function parseGeneralLedgerReport(
  body: unknown,
  asked: { readonly window: LedgerWindow },
): GeneralLedger {
  const report = readReport(body, 'GeneralLedger');
  const header = {
    sourceKind: 'qbo' as const,
    window: asked.window,
    ...(report.Header.ReportBasis === undefined ? {} : { basis: report.Header.ReportBasis }),
    ...(report.Header.Currency === undefined ? {} : { currency: report.Header.Currency }),
  };

  const top = report.Rows.Row ?? [];
  if (top.length === 0) {
    if (!saysNoData(report)) {
      throw new QboMalformedResponse(
        'the general ledger has no rows and does not say it has no data',
        'GeneralLedger.Rows',
      );
    }
    return { ...header, accounts: [] };
  }

  const columns = generalLedgerColumns(report);
  const accounts: GeneralLedgerAccount[] = [];
  let lineCount = 0;

  const amountAt = (cells: readonly Cell[], column: GeneralLedgerColumn, path: string) =>
    reportAmountToCents(cells[columns[column]]?.value ?? '', `${path}[${columns[column]}]`);

  const section = (row: ReportRow, at: string, depth: number): Sides => {
    if (row.Header === undefined) {
      // A total with no account of its own — a report-wide total, if QuickBooks
      // ever prints one. It holds no postings; one that does is unreadable.
      if (row.Rows !== undefined) {
        throw new QboMalformedResponse(`expected a section with rows to name its account at ${at}`, at);
      }
      return { debit: ZERO, credit: ZERO };
    }

    const named = row.Header.ColData.find((cell) => cell.value.trim() !== '');
    if (named === undefined) {
      throw new QboMalformedResponse(`expected an account name at ${at}.Header`, `${at}.Header`);
    }
    const sectionId = idOf(named);
    const lines: GeneralLedgerLine[] = [];
    let beginningBalanceCents: Cents | undefined;
    let sawBeginning = false;
    const account: {
      -readonly [K in keyof GeneralLedgerAccount]: GeneralLedgerAccount[K];
    } = {
      ...(sectionId === undefined ? {} : { accountExternalId: sectionId }),
      accountName: named.value,
      lines,
    };
    // Listed before its sub-accounts, in the order QuickBooks printed them.
    accounts.push(account);

    const total: Sides = { debit: ZERO, credit: ZERO };
    (row.Rows?.Row ?? []).forEach((child, index) => {
      const childAt = `${at}.Rows.Row[${index}]`;
      if (kindOf(child, childAt) === 'section') {
        if (depth + 1 > REPORT_MAX_DEPTH) {
          throw new QboMalformedResponse(
            `the report nests more than ${REPORT_MAX_DEPTH} sections deep at ${childAt}`,
            childAt,
          );
        }
        const under = section(child, childAt, depth + 1);
        total.debit = addCents(total.debit, under.debit);
        total.credit = addCents(total.credit, under.credit);
        return;
      }

      const cells = cellsOf(child.ColData ?? [], columns.width, `${childAt}.ColData`);
      const dateCell = cells[columns.tx_date]?.value ?? '';
      if (dateCell === BEGINNING_BALANCE) {
        if (sawBeginning || lines.length > 0) {
          throw new QboMalformedResponse(
            `expected one Beginning Balance row, first in its section, at ${childAt}`,
            childAt,
          );
        }
        sawBeginning = true;
        beginningBalanceCents = amountAt(cells, 'rbal_nat_amount', `${childAt}.ColData`);
        return;
      }

      const date = isoDateOf(dateCell, `${childAt}.ColData[${columns.tx_date}]`);
      if (date < asked.window.from || date > asked.window.to) {
        throw new QboMalformedResponse(
          `a posting at ${childAt} is dated outside the window asked for`,
          `${childAt}.ColData[${columns.tx_date}]`,
        );
      }
      lineCount += 1;
      if (lineCount > GENERAL_LEDGER_MAX_LINES) throw new QboReportTooLarge('too_many_lines');

      const typeCell = cells[columns.txn_type];
      const accountExternalId = sectionId ?? idOf(cells[columns.account_name]);
      const transactionType = textOf(typeCell);
      const transactionExternalId = idOf(typeCell);
      const documentNumber = textOf(cells[columns.doc_num]);
      const name = textOf(cells[columns.name]);
      const memo = textOf(cells[columns.memo]);
      const balanceCents = amountAt(cells, 'rbal_nat_amount', `${childAt}.ColData`);
      const line: GeneralLedgerLine = {
        ...(accountExternalId === undefined ? {} : { accountExternalId }),
        accountName: named.value,
        date,
        ...(transactionType === undefined ? {} : { transactionType }),
        ...(transactionExternalId === undefined ? {} : { transactionExternalId }),
        ...(documentNumber === undefined ? {} : { documentNumber }),
        ...(name === undefined ? {} : { name }),
        ...(memo === undefined ? {} : { memo }),
        debitCents: amountAt(cells, 'debt_amt', `${childAt}.ColData`) ?? ZERO,
        creditCents: amountAt(cells, 'credit_amt', `${childAt}.ColData`) ?? ZERO,
        ...(balanceCents === undefined ? {} : { balanceCents }),
      };
      lines.push(line);
      total.debit = addCents(total.debit, line.debitCents);
      total.credit = addCents(total.credit, line.creditCents);
    });

    if (beginningBalanceCents !== undefined) account.beginningBalanceCents = beginningBalanceCents;

    if (row.Summary !== undefined) {
      const cells = cellsOf(row.Summary.ColData, columns.width, `${at}.Summary.ColData`);
      const debit = amountAt(cells, 'debt_amt', `${at}.Summary.ColData`);
      const credit = amountAt(cells, 'credit_amt', `${at}.Summary.ColData`);
      assertTiesOut(
        total,
        {
          ...(debit === undefined ? {} : { debit }),
          ...(credit === undefined ? {} : { credit }),
        },
        `${at}.Summary`,
      );
    }
    return total;
  };

  top.forEach((row, index) => {
    const at = `GeneralLedger.Rows.Row[${index}]`;
    if (kindOf(row, at) !== 'section') {
      throw new QboMalformedResponse(
        `expected a section per account at ${at}, got a posting outside any account`,
        at,
      );
    }
    section(row, at, 0);
  });

  return { ...header, accounts };
}

// --- the profit and loss ------------------------------------------------------

/**
 * The profit and loss's data sections, by Intuit's `group`, and what each
 * adds to net income: income adds, cost of goods sold and expenses subtract.
 */
const PROFIT_AND_LOSS_SECTIONS: Readonly<Record<string, 1n | -1n>> = Object.freeze({
  Income: 1n,
  COGS: -1n,
  Expenses: -1n,
  OtherIncome: 1n,
  OtherExpenses: -1n,
});

/**
 * The profit and loss's computed rows: a `Summary` and nothing else, each the
 * arithmetic QuickBooks documents over the data sections. Each one printed is
 * checked against that arithmetic over the lines read; none is ever a line.
 */
const PROFIT_AND_LOSS_COMPUTED: Readonly<Record<string, readonly string[]>> = Object.freeze({
  GrossProfit: ['Income', 'COGS'],
  NetOperatingIncome: ['Income', 'COGS', 'Expenses'],
  NetOtherIncome: ['OtherIncome', 'OtherExpenses'],
  NetIncome: ['Income', 'COGS', 'Expenses', 'OtherIncome', 'OtherExpenses'],
});

/** The one money column a `summarize_column_by=Total` report carries, by Intuit's key. */
const PROFIT_AND_LOSS_TOTAL_KEY = 'total';

interface ProfitAndLossColumns {
  readonly width: number;
  readonly account: number;
  readonly amount: number;
}

/**
 * Exactly an account column and one money column. A money column keyed
 * anything but `total` — a multicurrency company's home-currency column, or a
 * report split by month — is refused by the key we expected, never read as
 * the year's total in the home currency.
 */
function profitAndLossColumns(report: Report): ProfitAndLossColumns {
  const columns = report.Columns.Column;
  const account = columns.flatMap((column, index) => (column.ColType === 'Account' ? [index] : []));
  const money = columns.flatMap((column, index) => (column.ColType === 'Money' ? [index] : []));
  const [accountAt] = account;
  if (account.length !== 1 || accountAt === undefined) {
    throw new QboMalformedResponse(
      `expected exactly one Account column in the profit and loss, got ${account.length}`,
      'ProfitAndLoss.Columns.Column.account',
    );
  }
  const [amountAt] = money;
  const key = (index: number): string | undefined =>
    (columns[index]?.MetaData ?? []).find((entry) => entry.Name === 'ColKey')?.Value;
  if (
    money.length !== 1 ||
    amountAt === undefined ||
    columns.length !== 2 ||
    (key(amountAt) !== undefined && key(amountAt) !== PROFIT_AND_LOSS_TOTAL_KEY)
  ) {
    throw new QboMalformedResponse(
      'expected one money column keyed total in the profit and loss, and nothing else',
      `ProfitAndLoss.Columns.Column.${PROFIT_AND_LOSS_TOTAL_KEY}`,
    );
  }
  return { width: columns.length, account: accountAt, amount: amountAt };
}

/**
 * QuickBooks' `ProfitAndLoss` report, one total column, as the port's
 * `ProfitAndLoss`.
 *
 * The top of the report is a list of sections, each named by its `group`.
 * The five data sections (`PROFIT_AND_LOSS_SECTIONS`) hold accounts: every
 * data row at any depth beneath one is a line, filed under that section; a
 * nested section is a parent account and its sub-accounts, and its `Summary`
 * is checked against the lines beneath it and never read as one. The four
 * computed sections (`PROFIT_AND_LOSS_COMPUTED` — Gross Profit, Net
 * Operating Income, Net Other Income, Net Income) hold only a `Summary`, and
 * each is checked against its arithmetic over the lines read. **Every total
 * the report prints must equal the lines read, to the cent, or the read is
 * refused**: a row dropped or read twice is a loud failure, never a smaller
 * company. A section of a group not named here is refused rather than
 * skipped, because a skipped section is a silently missing number.
 *
 * Empty only when the report says `NoReportData`; cut short is
 * `QboReportTooLarge`; the period QuickBooks reports must be the window asked
 * for. Amounts are in each section's natural sign — income positive, a
 * contra-income account such as sales discounts negative.
 */
export function parseProfitAndLossReport(
  body: unknown,
  asked: { readonly window: LedgerWindow },
): ProfitAndLoss {
  const report = readReport(body, 'ProfitAndLoss');
  const header = {
    sourceKind: 'qbo' as const,
    window: asked.window,
    ...(report.Header.ReportBasis === undefined ? {} : { basis: report.Header.ReportBasis }),
    ...(report.Header.Currency === undefined ? {} : { currency: report.Header.Currency }),
  };
  for (const [field, expected] of [
    ['StartPeriod', asked.window.from],
    ['EndPeriod', asked.window.to],
  ] as const) {
    const printed = report.Header[field];
    if (printed !== undefined && printed !== expected) {
      throw new QboMalformedResponse(
        `asked for a profit and loss over ${asked.window.from} to ${asked.window.to} and ` +
          `QuickBooks answered with a different ${field}`,
        `ProfitAndLoss.Header.${field}`,
      );
    }
  }

  const top = report.Rows.Row ?? [];
  if (top.length === 0) {
    if (!saysNoData(report)) {
      throw new QboMalformedResponse(
        'the profit and loss has no rows and does not say it has no data',
        'ProfitAndLoss.Rows',
      );
    }
    return { ...header, lines: [] };
  }

  const columns = profitAndLossColumns(report);
  const lines: ProfitAndLossLine[] = [];
  const sectionTotals = new Map<string, Cents>();

  const summaryOf = (row: ReportRow, at: string): Cents | undefined =>
    row.Summary === undefined
      ? undefined
      : reportAmountToCents(
          cellsOf(row.Summary.ColData, columns.width, `${at}.Summary.ColData`)[columns.amount]
            ?.value ?? '',
          `${at}.Summary.ColData[${columns.amount}]`,
        );

  const walk = (rows: readonly ReportRow[], path: string, group: string, depth: number): Cents => {
    let total = ZERO;
    rows.forEach((row, index) => {
      const at = `${path}.Row[${index}]`;
      if (kindOf(row, at) === 'section') {
        if (depth + 1 > REPORT_MAX_DEPTH) {
          throw new QboMalformedResponse(
            `the report nests more than ${REPORT_MAX_DEPTH} sections deep at ${at}`,
            at,
          );
        }
        const under = walk(row.Rows?.Row ?? [], `${at}.Rows`, group, depth + 1);
        assertTotal(under, summaryOf(row, at), `${at}.Summary`);
        total = addCents(total, under);
        return;
      }
      const cells = cellsOf(row.ColData ?? [], columns.width, `${at}.ColData`);
      const accountCell = cells[columns.account];
      const accountName = textOf(accountCell);
      if (accountName === undefined) {
        throw new QboMalformedResponse(
          `expected an account name at ${at}.ColData[${columns.account}]`,
          `${at}.ColData[${columns.account}]`,
        );
      }
      const accountExternalId = idOf(accountCell);
      const amountCents =
        reportAmountToCents(
          cells[columns.amount]?.value ?? '',
          `${at}.ColData[${columns.amount}]`,
        ) ?? ZERO;
      lines.push({
        ...(accountExternalId === undefined ? {} : { accountExternalId }),
        accountName,
        section: group,
        amountCents,
      });
      total = addCents(total, amountCents);
    });
    return total;
  };

  const computed: Array<{ group: string; printed: Cents | undefined; at: string }> = [];
  top.forEach((row, index) => {
    const at = `ProfitAndLoss.Rows.Row[${index}]`;
    if (kindOf(row, at) !== 'section') {
      throw new QboMalformedResponse(
        `expected a section at ${at}, got an account outside any section`,
        at,
      );
    }
    const group = row.group ?? '';
    if (Object.hasOwn(PROFIT_AND_LOSS_SECTIONS, group)) {
      if (sectionTotals.has(group)) {
        throw new QboMalformedResponse(`expected one section per group at ${at}`, `${at}.group`);
      }
      const under = walk(row.Rows?.Row ?? [], `${at}.Rows`, group, 1);
      assertTotal(under, summaryOf(row, at), `${at}.Summary`);
      sectionTotals.set(group, under);
      return;
    }
    if (Object.hasOwn(PROFIT_AND_LOSS_COMPUTED, group)) {
      if (row.Rows !== undefined || row.Summary === undefined) {
        throw new QboMalformedResponse(
          `expected a computed row holding only a Summary at ${at}`,
          at,
        );
      }
      computed.push({ group, printed: summaryOf(row, at), at: `${at}.Summary` });
      return;
    }
    // The group is QuickBooks' text; the path names the position, not the group.
    throw new QboMalformedResponse(`expected a profit and loss section this reader knows at ${at}`, `${at}.group`);
  });

  for (const { group, printed, at } of computed) {
    const parts = PROFIT_AND_LOSS_COMPUTED[group] ?? [];
    let net = 0n;
    for (const part of parts) {
      net += (PROFIT_AND_LOSS_SECTIONS[part] ?? 0n) * BigInt(sectionTotals.get(part) ?? ZERO);
    }
    assertTotal(cents(Number(net)), printed, at);
  }

  return { ...header, lines };
}

/**
 * The lines read under a total must add up to it. A blank total checks
 * nothing; a printed one that disagrees is a refused read. Numbers are not
 * quoted: they are the customer's.
 */
function assertTotal(read: Cents, printed: Cents | undefined, path: string): void {
  if (printed !== undefined && printed !== read) {
    throw new QboMalformedResponse(`the amounts read do not add up to the total printed at ${path}`, path);
  }
}

// --- the chart of accounts -----------------------------------------------------

/**
 * One row of an `Account` query as the port's `LedgerAccount`.
 *
 * `toQboAccount` reads what posting setup already reads — the id proven to be
 * digits, the names, the type, `Active` as a JSON boolean — and this adds the
 * account code (`AcctNum`), the classification and the running balance. The
 * code and the classification are optional because many charts have neither;
 * a `CurrentBalance` that is present must be exact cents.
 */
export function toLedgerAccount(row: JsonObject, path: string): LedgerAccount {
  const account = toQboAccount(row, path);
  const code = readOptionalString(row, 'AcctNum', path);
  const classification = readOptionalString(row, 'Classification', path);
  const balance = row['CurrentBalance'];
  return {
    sourceKind: 'qbo',
    externalId: account.id,
    ...(code === undefined ? {} : { code }),
    name: account.name,
    fullyQualifiedName: account.fullyQualifiedName,
    accountType: account.accountType,
    ...(account.accountSubType === undefined ? {} : { accountSubType: account.accountSubType }),
    ...(classification === undefined ? {} : { classification }),
    active: account.active,
    ...(balance === undefined || balance === null
      ? {}
      : { currentBalanceCents: qboAmountToCents(balance, `${path}.CurrentBalance`) }),
  };
}

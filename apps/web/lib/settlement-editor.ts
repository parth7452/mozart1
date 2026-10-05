import {
  STATED_INVOICE,
  JournalInputError,
  MoneyError,
  REASON_FAMILIES,
  SETTLEMENT_LINE_PROBLEMS,
  SETTLEMENT_MAX_LINES,
  cents,
  draftEntries,
  parseMoneyToCents,
  settlementLinesFrom,
  settlementTotals,
  type Cents,
  type LedgerAccount,
  type ReasonFamily,
  type SettlementChartAccount,
  type SettlementLine,
  type SettlementLineInput,
  type SettlementLineProblem,
  type SettlementLineProblemCode,
} from '@recouple/core-domain';
import {
  SETTLEMENT_OUTCOMES,
  settlementAccountPolicy,
  type PostingConnectionView,
  type SettlementChartReader,
  type SettlementOutcome,
} from '@recouple/store-postgres';
import { booksSourcesFromEnv, type BooksSources } from './books';
import { qboPostingFromEnv, type QboPoster } from './qbo-posting';
import type { InvoiceLookup } from '@recouple/store-postgres';
import { SETTLE_PARAMS, centsAsText, lineField } from './settlement-fields';

export { SETTLE_PARAMS, centsAsText, lineField } from './settlement-fields';

/**
 * The prepare form for a settlement's journal lines (ADR 0068 §7): what the
 * address asked for, the chart of accounts the form's `<select>`s are drawn
 * from, and the rows the form shows.
 *
 * Nothing here writes, with the one exception every live chart read has: a
 * read whose access token has run out refreshes it (ADR 0033, ADR 0066). So
 * the chart is read only when a member asked to edit the entry, and through
 * the Books read, which refuses to refresh for a member whose refresh the
 * database would not store.
 *
 * A memo never travels in an address. The form is a POST; when a refused form
 * is sent back to be corrected, the accounts and amounts are echoed in the
 * redirect and the memos are not (ADR 0068 §5).
 */

type Param = string | readonly string[] | undefined;
type Identity = { readonly orgId: string; readonly userId: string };

/** How a case settled, as the prepare form states it. */
export interface SettlementChoice {
  readonly outcome: SettlementOutcome;
  readonly recoveredCents: Cents;
  readonly family: ReasonFamily | undefined;
  /**
   * The short-paid invoice as a person stated it: the ledger's id or the
   * number printed on it. Resolved against the ledger when the settlement is
   * prepared (ADR 0069 §1); never used as an id before that.
   */
  readonly invoiceId: string;
}

/** What the page offers before anything was chosen. */
export interface SettlementDefaults {
  readonly outcome: SettlementOutcome | undefined;
  readonly recoveredCents: Cents | undefined;
  readonly family: ReasonFamily | undefined;
  readonly invoiceId: string | undefined;
}

const ACCOUNT_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const CENTS = /^[0-9]{1,15}$/;

const single = (value: Param): string | undefined => (typeof value === 'string' ? value : undefined);

function isOutcome(value: unknown): value is SettlementOutcome {
  return typeof value === 'string' && (SETTLEMENT_OUTCOMES as readonly string[]).includes(value);
}

function isFamily(value: unknown): value is ReasonFamily {
  return typeof value === 'string' && (REASON_FAMILIES as readonly string[]).includes(value);
}

/**
 * How the case settled, from what a form or an address stated. `undefined`
 * when nothing was stated; `'invalid'` when something was and it cannot be
 * read — an outcome that is not one, an invoice that is not an id or a printed number, a
 * figure the money parser will not read, a family that does not exist.
 */
export function settlementChoiceFrom(fields: {
  readonly outcome: unknown;
  readonly recovered: unknown;
  readonly family: unknown;
  readonly invoiceId: unknown;
}): SettlementChoice | 'invalid' | undefined {
  const { outcome, recovered, family, invoiceId } = fields;
  const stated = [outcome, recovered, family, invoiceId].some(
    (value) => value !== undefined && value !== null,
  );
  if (!stated) return undefined;
  if (!isOutcome(outcome)) return 'invalid';
  if (typeof invoiceId !== 'string' || !STATED_INVOICE.test(invoiceId.trim())) return 'invalid';
  if (family !== undefined && family !== null && family !== '' && !isFamily(family)) return 'invalid';
  let recoveredCents: Cents = cents(0);
  if (typeof recovered === 'string' && recovered.trim() !== '') {
    try {
      recoveredCents = parseMoneyToCents(recovered.trim());
    } catch (error) {
      if (error instanceof MoneyError) return 'invalid';
      throw error;
    }
  } else if (recovered !== undefined && recovered !== null && typeof recovered !== 'string') {
    return 'invalid';
  }
  if (recoveredCents < 0) return 'invalid';
  return {
    outcome,
    recoveredCents,
    family: isFamily(family) ? family : undefined,
    invoiceId: invoiceId.trim(),
  };
}

/** One echoed line: an account id and cents, validated; never a memo. */
export interface EchoedLine {
  readonly accountExternalId: string;
  readonly debitCents: Cents;
  readonly creditCents: Cents;
}

/** The lines an address echoes, in order; anything that is not ids and digits is dropped. */
export function echoedLinesFrom(value: Param): readonly EchoedLine[] | undefined {
  const raw = value === undefined ? [] : typeof value === 'string' ? [value] : value;
  if (raw.length === 0) return undefined;
  const lines: EchoedLine[] = [];
  for (const item of raw.slice(0, SETTLEMENT_MAX_LINES)) {
    const [account = '', debit = '', credit = '', ...rest] = item.split('~');
    if (rest.length > 0 || !CENTS.test(debit) || !CENTS.test(credit)) continue;
    if (account !== '' && !ACCOUNT_ID.test(account)) continue;
    lines.push({
      accountExternalId: account,
      debitCents: cents(Number(debit)),
      creditCents: cents(Number(credit)),
    });
  }
  return lines.length === 0 ? undefined : lines;
}

/** The refusals an address names, each from the closed set or dropped. */
export function echoedProblemsFrom(value: Param): readonly SettlementLineProblem[] {
  const raw = single(value);
  if (raw === undefined || raw.length > 600) return [];
  const out: SettlementLineProblem[] = [];
  for (const item of raw.split(',')) {
    const [code = '', line, ...rest] = item.split('.');
    if (rest.length > 0) continue;
    if (!(SETTLEMENT_LINE_PROBLEMS as readonly string[]).includes(code)) continue;
    if (line === undefined) {
      out.push({ code: code as SettlementLineProblemCode });
    } else if (/^[0-9]{1,2}$/.test(line) && Number(line) >= 1 && Number(line) <= SETTLEMENT_MAX_LINES) {
      out.push({ code: code as SettlementLineProblemCode, lineNo: Number(line) });
    }
  }
  return out;
}

/** The address of the editor for a choice, with lines and refusals echoed when given. */
export function settlementEditorPath(
  deductionId: string,
  choice: SettlementChoice,
  echo?: {
    readonly lines?: readonly EchoedLine[];
    readonly problems?: readonly SettlementLineProblem[];
    readonly notice?: string;
  },
): string {
  const params = new URLSearchParams();
  if (echo?.notice !== undefined) params.set('action', echo.notice);
  params.set(SETTLE_PARAMS.outcome, choice.outcome);
  params.set(SETTLE_PARAMS.recovered, centsAsText(choice.recoveredCents));
  if (choice.family !== undefined) params.set(SETTLE_PARAMS.family, choice.family);
  params.set(SETTLE_PARAMS.invoice, choice.invoiceId);
  for (const line of echo?.lines ?? []) {
    params.append(SETTLE_PARAMS.line, `${line.accountExternalId}~${line.debitCents}~${line.creditCents}`);
  }
  if (echo?.problems !== undefined && echo.problems.length > 0) {
    params.set(
      SETTLE_PARAMS.problems,
      echo.problems.map((p) => (p.lineNo === undefined ? p.code : `${p.code}.${p.lineNo}`)).join(','),
    );
  }
  return `/cases/${deductionId}?${params.toString()}#settlement`;
}

// --- the chart -------------------------------------------------------------------

/** The chart could not be read, and why, as a fixed word — never what a vendor said. */
export class SettlementChartUnreadableError extends Error {
  override readonly name = 'SettlementChartUnreadableError';
  constructor(readonly reason: 'not_configured' | 'unreadable') {
    super(`the chart of accounts could not be read: ${reason}`);
  }
}

/** A ledger's chart as the settlement rule reads it: the full name, the type, whether active. */
export function toChartAccounts(accounts: readonly LedgerAccount[]): readonly SettlementChartAccount[] {
  return accounts.map((account) => ({
    externalId: account.externalId,
    name: account.fullyQualifiedName,
    accountType: account.accountType,
    active: account.active,
  }));
}

/**
 * The connection's chart, read live as this member through the Books read
 * (ADR 0066): bounded like the Books page's, and `withoutRefresh` for a
 * member the database would not store a rotated token for. A failure is
 * logged by class name and ids and thrown as `SettlementChartUnreadableError`.
 */
export function settlementChartReader(
  identity: Identity,
  connection: { readonly connectionId: string; readonly realmId: string },
  options: { readonly mayRefresh: boolean; readonly sources?: BooksSources },
): SettlementChartReader {
  return async () => {
    const source = (options.sources ?? booksSourcesFromEnv()).sourceFor(identity, connection, {
      mayRefresh: options.mayRefresh,
    });
    if (source === undefined) throw new SettlementChartUnreadableError('not_configured');
    try {
      return toChartAccounts(await source.chartOfAccounts());
    } catch (error) {
      const name = error instanceof Error ? error.name : typeof error;
      console.error(
        `[recouple] settlement: chart not read (${name}), connection ${connection.connectionId} org ${identity.orgId}`,
      );
      throw new SettlementChartUnreadableError('unreadable');
    }
  };
}

export class SettlementInvoiceUnreadableError extends Error {
  override readonly name = 'SettlementInvoiceUnreadableError';
  constructor(readonly reason: 'not_configured' | 'unreadable' | 'may_not_write') {
    super(`the ledger's invoices could not be read: ${reason}`);
  }
}

/**
 * Reads what the connected company holds for the invoice a person named, for
 * `prepareSettlementDecision` (ADR 0069 §1). A failure is logged by class
 * name and ids — never the text stated, which may be off a document — and
 * thrown as `SettlementInvoiceUnreadableError`.
 */
export function settlementInvoiceLookup(
  identity: Identity,
  connection: { readonly connectionId: string; readonly realmId: string },
  poster: Pick<QboPoster, 'invoiceLookupFor'> | undefined = qboPostingFromEnv(),
): InvoiceLookup {
  return async (stated) => {
    const lookup = poster?.invoiceLookupFor(identity, connection, {
      timeoutMs: 10_000,
      maxPages: 2,
    });
    if (lookup === undefined) throw new SettlementInvoiceUnreadableError('not_configured');
    try {
      return await lookup(stated);
    } catch (error) {
      const name = error instanceof Error ? error.name : typeof error;
      console.error(
        `[recouple] settlement: invoice not read (${name}), connection ${connection.connectionId} org ${identity.orgId}`,
      );
      throw new SettlementInvoiceUnreadableError('unreadable');
    }
  };
}

// --- what the form shows ---------------------------------------------------------

export interface EditorRow {
  readonly lineNo: number;
  readonly accountExternalId: string;
  /** The account's name and type as the chart reports them now, when it has it. */
  readonly accountName: string | undefined;
  readonly accountType: string | undefined;
  /** Text for the money fields: empty for a side with nothing on it. */
  readonly debit: string;
  readonly credit: string;
  /** A receivable line is the case's: shown, sent, and not editable (ADR 0068 §4). */
  readonly locked: boolean;
}

export interface EditorAccountOption {
  readonly externalId: string;
  readonly name: string;
  readonly accountType: string;
}

export type SettlementEditor =
  /** Nothing chosen yet, or what was chosen cannot be read: the first step only. */
  | {
      readonly kind: 'choose';
      readonly defaults: SettlementDefaults;
      readonly invalid: boolean;
      /** Set when the case's settlement is prepared and this would supersede it. */
      readonly supersedes: boolean;
    }
  /** The books cannot hold what was chosen (more recovered than deducted, say). */
  | { readonly kind: 'refused_choice'; readonly defaults: SettlementDefaults; readonly supersedes: boolean }
  | {
      readonly kind: 'chart_unreadable';
      readonly choice: SettlementChoice;
      readonly reason: 'not_configured' | 'unreadable';
      readonly supersedes: boolean;
    }
  | {
      readonly kind: 'ready';
      readonly choice: SettlementChoice;
      readonly supersedes: boolean;
      /** The accounts a line may be put on, as the chart reports them now. */
      readonly accounts: readonly EditorAccountOption[];
      readonly rows: readonly EditorRow[];
      /** How many empty rows follow, for a line a person adds. */
      readonly blankRows: number;
      readonly totals: { readonly debitCents: Cents; readonly creditCents: Cents; readonly balanced: boolean };
      /** Whether the rows are the computed lines, or ones a refused form sent back. */
      readonly echoed: boolean;
      readonly problems: readonly SettlementLineProblem[];
      /** The same form with the computed lines again. */
      readonly resetPath: string;
    };

/** How many empty rows the form offers past the lines it shows. */
export const EDITOR_BLANK_ROWS = 3;

/**
 * The editor for one case, or nothing when it is not offered: posting must be
 * live for the workspace's one connection, the viewer must be able to write,
 * and the case's settlement must not already be approved.
 *
 * `params` are the page's own search parameters. Without a stated outcome the
 * answer is the first step and **no chart is read**; with one, the computed
 * lines are drawn over a chart read live through `readChartFor`.
 */
export async function settlementEditorFor(input: {
  readonly deductionId: string;
  readonly amountCents: number;
  readonly params: Readonly<Record<string, Param>>;
  readonly defaults: SettlementDefaults;
  /** The latest settlement decision, when there is one. */
  readonly settlement: { readonly approved: boolean } | undefined;
  /** The workspace's one posting connection, with its map, or nothing. */
  readonly connection: PostingConnectionView | undefined;
  readonly mayAct: boolean;
  readonly readChartFor: (connection: PostingConnectionView) => SettlementChartReader;
}): Promise<SettlementEditor | undefined> {
  const { connection, params, defaults } = input;
  if (!input.mayAct || connection === undefined || connection.map === undefined) return undefined;
  if (!connection.postingEnabled) return undefined;
  if (input.settlement?.approved === true) return undefined;
  const supersedes = input.settlement !== undefined;
  // A prepared settlement is replaced only when somebody asks to.
  const asked = params[SETTLE_PARAMS.outcome] !== undefined || params[SETTLE_PARAMS.again] !== undefined;
  if (supersedes && !asked) return undefined;

  const choice = settlementChoiceFrom({
    outcome: single(params[SETTLE_PARAMS.outcome]),
    recovered: single(params[SETTLE_PARAMS.recovered]),
    family: single(params[SETTLE_PARAMS.family]),
    invoiceId: single(params[SETTLE_PARAMS.invoice]),
  });
  if (choice === undefined || choice === 'invalid') {
    return { kind: 'choose', defaults, invalid: choice === 'invalid', supersedes };
  }

  let computed: readonly SettlementLine[];
  try {
    computed = settlementLinesFrom(
      draftEntries({
        amountCents: cents(input.amountCents),
        recoveredCents: choice.recoveredCents,
        outcome: choice.outcome,
        family: choice.family,
      }),
      connection.map,
      { includeFound: choice.outcome === 'declined' },
    );
  } catch (error) {
    if (error instanceof JournalInputError || error instanceof MoneyError) {
      return { kind: 'refused_choice', defaults: { ...defaults, ...choice }, supersedes };
    }
    throw error;
  }

  let chart: readonly SettlementChartAccount[];
  try {
    chart = await input.readChartFor(connection)();
  } catch (error) {
    if (error instanceof SettlementChartUnreadableError) {
      return { kind: 'chart_unreadable', choice, reason: error.reason, supersedes };
    }
    throw error;
  }

  const policy = settlementAccountPolicy(connection.map);
  const byId = new Map(chart.map((account) => [account.externalId, account]));
  const accounts = chart
    .filter(
      (account) =>
        account.active &&
        !policy.refusedAccountTypes.includes(account.accountType) &&
        !policy.receivableAccountTypes.includes(account.accountType),
    )
    .map((account) => ({ externalId: account.externalId, name: account.name, accountType: account.accountType }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));

  const echoed = echoedLinesFrom(params[SETTLE_PARAMS.line]);
  const shown: readonly EchoedLine[] = echoed ?? computed;
  const rows = shown.map((line, index): EditorRow => {
    const account = byId.get(line.accountExternalId);
    return {
      lineNo: index + 1,
      accountExternalId: line.accountExternalId,
      accountName: account?.name,
      accountType: account?.accountType,
      debit: line.debitCents > 0 ? centsAsText(line.debitCents) : '',
      credit: line.creditCents > 0 ? centsAsText(line.creditCents) : '',
      locked: line.accountExternalId === policy.receivableAccountId,
    };
  });

  return {
    kind: 'ready',
    choice,
    supersedes,
    accounts,
    rows,
    blankRows: Math.max(0, Math.min(EDITOR_BLANK_ROWS, SETTLEMENT_MAX_LINES - rows.length)),
    totals: settlementTotals(shown),
    echoed: echoed !== undefined,
    problems: echoed === undefined ? [] : echoedProblemsFrom(params[SETTLE_PARAMS.problems]),
    resetPath: settlementEditorPath(input.deductionId, choice),
  };
}

// --- what the form sent ----------------------------------------------------------

export interface PostedLines {
  /** The lines as the store takes them, memos included. */
  readonly lines: readonly SettlementLineInput[];
  /** The same lines without memos: what a redirect may carry. */
  readonly echo: readonly EchoedLine[];
  /** Line numbers (as posted) whose debit or credit the money parser would not read. */
  readonly unreadable: readonly number[];
}

/**
 * The lines of a posted prepare form. A row with no account, no amount and no
 * memo is an empty row and is skipped. An amount is read by
 * `parseMoneyToCents` and by nothing else; one it will not read, or a negative
 * one, is reported by line and treated as empty.
 */
export function postedLinesFrom(form: FormData): PostedLines {
  const lines: SettlementLineInput[] = [];
  const echo: EchoedLine[] = [];
  const unreadable: number[] = [];
  const text = (name: string): string => {
    const value = form.get(name);
    return typeof value === 'string' ? value.trim() : '';
  };
  for (let n = 1; n <= SETTLEMENT_MAX_LINES; n += 1) {
    const account = text(lineField(n, 'account'));
    const debitText = text(lineField(n, 'debit'));
    const creditText = text(lineField(n, 'credit'));
    const memoValue = form.get(lineField(n, 'memo'));
    const memo = typeof memoValue === 'string' ? memoValue : '';
    if (account === '' && debitText === '' && creditText === '' && memo.trim() === '') continue;

    const lineNo = lines.length + 1;
    const amount = (value: string): Cents => {
      if (value === '') return cents(0);
      try {
        const parsed = parseMoneyToCents(value);
        if (parsed < 0) throw new MoneyError('a journal line is not negative');
        return parsed;
      } catch (error) {
        if (!(error instanceof MoneyError)) throw error;
        if (!unreadable.includes(lineNo)) unreadable.push(lineNo);
        return cents(0);
      }
    };
    const debitCents = amount(debitText);
    const creditCents = amount(creditText);
    lines.push({ accountExternalId: account, debitCents, creditCents, ...(memo.trim() === '' ? {} : { memo }) });
    echo.push({
      accountExternalId: ACCOUNT_ID.test(account) ? account : '',
      debitCents,
      creditCents,
    });
  }
  return { lines, echo, unreadable };
}

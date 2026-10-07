import {
  GENERAL_LEDGER_MAX_WINDOW_DAYS,
  booksAccountRoles,
  cents,
  deductionsSizing,
  parsePrintedDate,
  reconcileDeductions,
  sizingWindow,
  windowDays,
  type BooksAccountRole,
  type BooksCase,
  type DeductionsSizing,
  type GeneralLedger,
  type GeneralLedgerLine,
  type GeneralLedgerOptions,
  type LedgerAccount,
  type LedgerWindow,
  type ProfitAndLoss,
  type ReconciliationRow,
  type TrialBalance,
} from '@recouple/core-domain';
import { LEDGER_SYNC_WINDOW_DAYS, ledgerSyncWindow } from '@recouple/pipeline';
import type { LedgerConnectionRecord } from '@recouple/pipeline';
import {
  QboAccountingSource,
  QboAuthError,
  QboChartTooLarge,
  QboInvalidWindow,
  QboMalformedResponse,
  QboRateLimited,
  QboReportTooLarge,
  QboRequestFailed,
  type QboTokenStore,
} from '@recouple/qbo';
import {
  CredentialUnreadableError,
  LedgerAccountBusyError,
  LockPoolTimeoutError,
  type BooksCasesRead,
  type PostingConnectionView,
} from '@recouple/store-postgres';
import { qboAppConfigFromEnv, qboTokenStoreFromEnv, type EnvVars } from './ledger-sync';
import { postingAccountIds } from './posting-accounts';

/**
 * The Books page's read (ADR 0066 §1–§3): each enabled connection's chart of
 * accounts, trial balance and general ledger, read live from the accounting
 * system inside the request, and the deductions reconciliation computed over
 * them. **Nothing here is stored and nothing here writes** — with one
 * exception that is not ours to avoid: a read whose access token has run out
 * refreshes it, and the rotated token is stored as a new sealed row (ADR 0033),
 * exactly as Settings → QuickBooks' chart read does (ADR 0063 §1).
 *
 * That exception is why a member who may not write reads differently. The
 * database stores a rotated token only for a member it lets write, and Intuit
 * kills the old refresh token the moment it issues the new one — so a refresh
 * made for a `read_only` member would be exchanged and then refused at the
 * save, costing the customer their connection. Such a member's reads go
 * through `withoutRefresh`: a fresh token is used, a stale one is
 * `BooksRefreshRefusedError` **before** anything is exchanged, and the page
 * tells them a member who can write has to open it first.
 *
 * It is not gated on `QBO_POSTING`: reading the books is not posting to them.
 * It is gated, like the ledger sync, on the Intuit app's credentials and the
 * KMS key the tokens are sealed with — a deployment without them builds no
 * source, and every connection reads `not_configured`.
 */

type Identity = { readonly orgId: string; readonly userId: string };

/**
 * The four reads the page makes: `AccountingSource`'s books, and the profit
 * and loss the sizing card is computed from (ADR 0073) — nothing else of it.
 */
export interface BooksSource {
  chartOfAccounts(): Promise<readonly LedgerAccount[]>;
  trialBalance(asOf: string): Promise<TrialBalance>;
  generalLedger(window: LedgerWindow, options?: GeneralLedgerOptions): Promise<GeneralLedger>;
  profitAndLoss(window: LedgerWindow): Promise<ProfitAndLoss>;
}

export interface BooksSources {
  /**
   * The connection's source as this member, or nothing when this deployment
   * cannot build one. `mayRefresh` is whether a token refresh this read
   * causes could be stored: the database's `member_may_write()` for the
   * viewer.
   */
  sourceFor(
    identity: Identity,
    connection: { readonly connectionId: string; readonly realmId: string },
    options: { readonly mayRefresh: boolean },
  ): BooksSource | undefined;
}

/**
 * How long one request of a books read may wait on QuickBooks — the settings
 * page's own bound for its chart read (`CHART_READ_TIMEOUT_MS`), for its
 * reason: the read is optional and the page is not.
 */
export const BOOKS_READ_TIMEOUT_MS = 10_000;

/** A chart is read in two pages at most, as on Settings → QuickBooks (ADR 0063 §2). */
export const BOOKS_CHART_MAX_PAGES = 2;

/**
 * A stale access token met by a member whose refresh could not be stored.
 * Thrown before any exchange with Intuit: nothing was refreshed, nothing was
 * changed. Ids only.
 */
export class BooksRefreshRefusedError extends Error {
  override readonly name = 'BooksRefreshRefusedError';
  constructor(readonly realmId: string) {
    super(
      `the QuickBooks sign-in for company ${realmId} is due a refresh, and this member's ` +
        'refresh could not be stored; nothing was exchanged',
    );
  }
}

/**
 * `store`, for a member the database will not store a rotation for: it loads,
 * and it refuses to refresh. `QboClient` asks for the refresh lock only when
 * the token needs refreshing, and exchanges nothing until it holds it — so
 * refusing the lock refuses the refresh, before Intuit hears of it. `save` is
 * refused too, should anything ever reach it.
 */
export function withoutRefresh(store: QboTokenStore): QboTokenStore {
  return {
    load: (realmId) => store.load(realmId),
    async save(realmId) {
      throw new BooksRefreshRefusedError(realmId);
    },
    async withRefreshLock(realmId) {
      throw new BooksRefreshRefusedError(realmId);
    },
  };
}

/**
 * The sources this deployment can build, in `scannerFromEnv`'s shape: one
 * answer, in one place. No Intuit app credentials, or no KMS key, is no source
 * — never one that throws on use, and never one that reads without a token
 * store.
 */
export function booksSourcesFromEnv(environment: EnvVars = process.env): BooksSources {
  return {
    sourceFor(identity, connection, options) {
      const app = qboAppConfigFromEnv(environment);
      if ('missing' in app) return undefined;
      const record: LedgerConnectionRecord = {
        connectionId: connection.connectionId,
        orgId: identity.orgId,
        provider: 'qbo',
        providerAccountId: connection.realmId,
        enabled: true,
        createdBy: identity.userId,
      };
      const tokenStore = qboTokenStoreFromEnv(identity, record, environment);
      if (tokenStore === undefined) return undefined;
      return new QboAccountingSource({
        realmId: connection.realmId,
        baseUrl: app.baseUrl,
        clientId: app.clientId,
        clientSecret: app.clientSecret,
        tokenStore: options.mayRefresh ? tokenStore : withoutRefresh(tokenStore),
        timeoutMs: BOOKS_READ_TIMEOUT_MS,
        maxPages: BOOKS_CHART_MAX_PAGES,
      });
    },
  };
}

// --- what the request asked for --------------------------------------------------

/** Which accounts' ledger the page shows. */
export type BooksScope = 'deductions' | 'all';

export interface BooksRequest {
  readonly window: LedgerWindow;
  readonly scope: BooksScope;
  /** Set when the address named a window we would not read, and why. */
  readonly windowRefused?: 'not_dates' | 'backwards' | 'too_long';
}

type Param = string | readonly string[] | undefined;

/**
 * The window and the scope a request asked for, validated; anything else is
 * the default, said out loud rather than passed on.
 *
 * The default window is the ledger sync's own trailing 35 days
 * (`LEDGER_SYNC_WINDOW_DAYS`), in UTC, so the page shows the ledger the sync
 * walked. `from` and `to` must each be one real `YYYY-MM-DD` day, in order,
 * and no further apart than a general ledger is read over.
 */
export function booksRequestFrom(
  params: { readonly from?: Param; readonly to?: Param; readonly accounts?: Param },
  now: Date,
): BooksRequest {
  const scope: BooksScope = params.accounts === 'all' ? 'all' : 'deductions';
  const fallback = ledgerSyncWindow(now, LEDGER_SYNC_WINDOW_DAYS);
  if (params.from === undefined && params.to === undefined) return { window: fallback, scope };

  const from = dayOf(params.from);
  const to = dayOf(params.to);
  if (from === undefined || to === undefined) {
    return { window: fallback, scope, windowRefused: 'not_dates' };
  }
  if (from > to) return { window: fallback, scope, windowRefused: 'backwards' };
  const window = { from, to };
  if (windowDays(window) > GENERAL_LEDGER_MAX_WINDOW_DAYS) {
    return { window: fallback, scope, windowRefused: 'too_long' };
  }
  return { window, scope };
}

function dayOf(value: Param): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  try {
    return parsePrintedDate(value);
  } catch {
    return undefined;
  }
}

/** Today, as a UTC day: the trial balance's as-of. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

// --- what the page shows -----------------------------------------------------------

/**
 * Why a read is not shown, as a fixed code — never anything the accounting
 * system said. `sign_in_refused` and `sign_in_expired` are the two OAuth
 * outcomes that mean reconnect (ADR 0046); every other code names our own
 * error class's meaning.
 */
export type BooksFailure =
  | 'sign_in_refused'
  | 'sign_in_expired'
  | 'not_authorised'
  | 'refresh_needs_writer'
  | 'rate_limited'
  | 'busy'
  | 'chart_too_large'
  | 'report_too_large'
  | 'unexpected_shape'
  | 'window_refused'
  | 'credential_unreadable'
  | 'unreachable'
  | 'failed';

export type BooksSection<T> =
  | { readonly kind: 'read'; readonly value: T }
  | { readonly kind: 'unreadable'; readonly failure: BooksFailure }
  /** Not asked for, because a read it depends on was not readable. */
  | { readonly kind: 'skipped' };

export interface BooksChart {
  readonly accounts: readonly LedgerAccount[];
  /** Each account's roles, by id; an account with none is absent. */
  readonly roles: Readonly<Record<string, readonly BooksAccountRole[]>>;
}

export interface BooksLedger {
  readonly ledger: GeneralLedger;
  readonly scope: BooksScope;
}

export interface BooksReconciliation {
  readonly rows: readonly ReconciliationRow[];
  /** How many of our cases the window holds, and how many were compared. */
  readonly casesTotal: number;
  readonly casesCompared: number;
  /** How many ledger lines on the deductions accounts were compared. */
  readonly linesCompared: number;
}

export type ConnectionBooks =
  | {
      readonly kind: 'not_configured';
      readonly connectionId: string;
      readonly realmId: string;
    }
  | {
      readonly kind: 'read';
      readonly connectionId: string;
      readonly realmId: string;
      /** Whether the workspace has saved an account map for this connection. */
      readonly mapped: boolean;
      /** The trailing year's deductions beside its sales, and today's balances (ADR 0073). */
      readonly sizing: BooksSection<DeductionsSizing>;
      readonly chart: BooksSection<BooksChart>;
      readonly trialBalance: BooksSection<TrialBalance>;
      readonly ledger: BooksSection<BooksLedger>;
      readonly reconciliation: BooksSection<BooksReconciliation>;
    };

export { postingAccountIds } from './posting-accounts';

/**
 * Every enabled connection's books, read side by side.
 *
 * Per connection the chart is read first — it is the read that refreshes a
 * stale token, once, under the company's lock — and then the trial balance,
 * the general ledger and the trailing year's profit and loss together. The
 * profit and loss is joined to the chart for the sizing card (ADR 0073,
 * `deductionsSizing`), so it is asked only when the chart was read. A failure costs its own section and
 * nothing else: it is logged by class name and ids, since what an error says
 * may quote the accounting system's own answer, and shown as a fixed code. A
 * failure of the sign-in itself is not asked for three times: the other two
 * reads are `skipped`.
 *
 * The general ledger is asked for the accounts the page is about — the
 * receivable, the map's posting accounts and the ones that look like
 * deductions accounts — unless `scope` is `all`. The reconciliation is over
 * the lines on the posting and deductions accounts only, beside `cases`.
 */
export async function booksFor(
  sources: BooksSources,
  identity: Identity,
  connections: readonly PostingConnectionView[],
  input: {
    readonly request: BooksRequest;
    readonly asOf: string;
    readonly mayRefresh: boolean;
    readonly cases: BooksCasesRead;
  },
): Promise<readonly ConnectionBooks[]> {
  return Promise.all(
    connections.map((connection) => connectionBooks(sources, identity, connection, input)),
  );
}

async function connectionBooks(
  sources: BooksSources,
  identity: Identity,
  connection: PostingConnectionView,
  input: {
    readonly request: BooksRequest;
    readonly asOf: string;
    readonly mayRefresh: boolean;
    readonly cases: BooksCasesRead;
  },
): Promise<ConnectionBooks> {
  const ids = { connectionId: connection.connectionId, realmId: connection.realmId };
  const where = `connection ${connection.connectionId} org ${identity.orgId}`;

  let source: BooksSource | undefined;
  try {
    source = sources.sourceFor(identity, connection, { mayRefresh: input.mayRefresh });
  } catch (error) {
    const failure = logged('source', error, where);
    const unreadable = { kind: 'unreadable', failure } as const;
    return {
      kind: 'read',
      ...ids,
      mapped: connection.map !== undefined,
      sizing: { kind: 'skipped' },
      chart: unreadable,
      trialBalance: { kind: 'skipped' },
      ledger: { kind: 'skipped' },
      reconciliation: { kind: 'skipped' },
    };
  }
  if (source === undefined) return { kind: 'not_configured', ...ids };
  const reader = source;

  const chart = await attempt('chart of accounts', where, async (): Promise<BooksChart> => {
    const accounts = await reader.chartOfAccounts();
    return {
      accounts,
      roles: Object.fromEntries(booksAccountRoles(accounts, postingAccountIds(connection))),
    };
  });

  // A sign-in that cannot be used fails every read the same way; ask once.
  if (chart.kind === 'unreadable' && SIGN_IN_FAILURES.has(chart.failure)) {
    return {
      kind: 'read',
      ...ids,
      mapped: connection.map !== undefined,
      sizing: { kind: 'skipped' },
      chart,
      trialBalance: { kind: 'skipped' },
      ledger: { kind: 'skipped' },
      reconciliation: { kind: 'skipped' },
    };
  }

  const { request } = input;
  const [trialBalance, ledger, profitAndLoss] = await Promise.all([
    attempt('trial balance', where, () => reader.trialBalance(input.asOf)),
    request.scope === 'all'
      ? attempt('general ledger', where, async (): Promise<BooksLedger> => ({
          ledger: await reader.generalLedger(request.window),
          scope: 'all',
        }))
      : chart.kind !== 'read'
        ? Promise.resolve<BooksSection<BooksLedger>>({ kind: 'skipped' })
        : attempt('general ledger', where, async (): Promise<BooksLedger> => ({
            ledger: await reader.generalLedger(request.window, {
              accountIds: Object.keys(chart.value.roles),
            }),
            scope: 'deductions',
          })),
    // Sizing joins the profit and loss to the chart; with no chart it is not asked.
    chart.kind !== 'read'
      ? Promise.resolve<BooksSection<ProfitAndLoss>>({ kind: 'skipped' })
      : attempt('profit and loss', where, () => reader.profitAndLoss(sizingWindow(input.asOf))),
  ]);

  const sizing: BooksSection<DeductionsSizing> =
    chart.kind !== 'read' || profitAndLoss.kind === 'skipped'
      ? { kind: 'skipped' }
      : profitAndLoss.kind === 'unreadable'
        ? profitAndLoss
        : {
            kind: 'read',
            value: deductionsSizing(
              chart.value.accounts,
              profitAndLoss.value,
              postingAccountIds(connection),
            ),
          };

  const reconciliation: BooksSection<BooksReconciliation> =
    chart.kind !== 'read' || ledger.kind !== 'read'
      ? { kind: 'skipped' }
      : { kind: 'read', value: reconcile(chart.value, ledger.value.ledger, input.cases) };

  return {
    kind: 'read',
    ...ids,
    mapped: connection.map !== undefined,
    sizing,
    chart,
    trialBalance,
    ledger,
    reconciliation,
  };
}

const SIGN_IN_FAILURES: ReadonlySet<BooksFailure> = new Set([
  'sign_in_refused',
  'sign_in_expired',
  'not_authorised',
  'refresh_needs_writer',
  'credential_unreadable',
  'busy',
]);

/** The ledger's lines on the posting and deductions accounts, beside our cases. */
function reconcile(
  chart: BooksChart,
  ledger: GeneralLedger,
  cases: BooksCasesRead,
): BooksReconciliation {
  const lines: GeneralLedgerLine[] = ledger.accounts.flatMap((account) => {
    const roles =
      account.accountExternalId === undefined ? undefined : chart.roles[account.accountExternalId];
    return roles !== undefined && (roles.includes('posting') || roles.includes('deductions'))
      ? account.lines
      : [];
  });
  const ours: BooksCase[] = cases.rows.map((row) => ({
    caseId: row.deductionId,
    ...(row.claimId === undefined ? {} : { claimId: row.claimId }),
    amountCents: cents(row.amountCents),
    ...(row.payerName === undefined ? {} : { payerName: row.payerName }),
    ...(row.deductionDate === undefined ? {} : { date: row.deductionDate }),
  }));
  return {
    rows: reconcileDeductions(lines, ours),
    casesTotal: cases.total,
    casesCompared: ours.length,
    linesCompared: lines.length,
  };
}

async function attempt<T>(
  what: string,
  where: string,
  read: () => Promise<T>,
): Promise<BooksSection<T>> {
  try {
    return { kind: 'read', value: await read() };
  } catch (error) {
    return { kind: 'unreadable', failure: logged(what, error, where) };
  }
}

/** A class name, as `alerts.ts` admits one: an identifier, nothing longer. */
const CLASS_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;

/**
 * A malformed response's structural path, as `reports.ts` names it: object
 * keys and array indexes only (`GeneralLedger.Rows.Row[3].ColData[0]`,
 * `GeneralLedger.Columns.Column.debt_amt`). Anything else is not logged.
 */
const STRUCTURAL_PATH = /^[A-Za-z_]+(\.[A-Za-z_]+|\[\d{1,6}\])*$/;

/**
 * Logs a failed read — its class name, Intuit's HTTP status when a request
 * got that far, a malformed response's structural path, and ids; never a
 * message, which may quote the accounting system's answer — and answers the
 * code the page shows. The path is logged only when it is letters,
 * underscores, dots and bracketed indexes, at most 200 characters: our own
 * key names and positions, so it says which check refused the report and
 * can carry no value, name or amount from it.
 */
export function logged(what: string, error: unknown, where: string): BooksFailure {
  const name = error instanceof Error ? error.name : undefined;
  const className = name !== undefined && CLASS_NAME.test(name) ? name : 'unnamed';
  const status =
    error instanceof QboRequestFailed && Number.isInteger(error.status) && error.status > 0
      ? `, HTTP ${error.status}`
      : '';
  const path =
    error instanceof QboMalformedResponse &&
    typeof error.fieldPath === 'string' &&
    error.fieldPath.length <= 200 &&
    STRUCTURAL_PATH.test(error.fieldPath)
      ? `, at ${error.fieldPath}`
      : '';
  console.error(`[recouple] books: ${what} unreadable (${className}${status})${path}, ${where}`);
  return failureOf(error);
}

/** Which code an error is shown as. Reads classes and one enum; never a message. */
export function failureOf(error: unknown): BooksFailure {
  if (error instanceof BooksRefreshRefusedError) return 'refresh_needs_writer';
  if (error instanceof QboAuthError) {
    if (error.refusal === 'grant_refused') return 'sign_in_refused';
    if (error.refusal === 'refresh_expired') return 'sign_in_expired';
    return 'not_authorised';
  }
  if (error instanceof QboRateLimited) return 'rate_limited';
  if (error instanceof QboChartTooLarge) return 'chart_too_large';
  if (error instanceof QboReportTooLarge) return 'report_too_large';
  if (error instanceof QboMalformedResponse) return 'unexpected_shape';
  if (error instanceof QboInvalidWindow) return 'window_refused';
  if (error instanceof QboRequestFailed) return 'unreachable';
  if (error instanceof LedgerAccountBusyError || error instanceof LockPoolTimeoutError) return 'busy';
  if (error instanceof CredentialUnreadableError) return 'credential_unreadable';
  return 'failed';
}

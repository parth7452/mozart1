import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  LEDGER_SYNC_ANOMALY_KINDS,
  LEDGER_SYNC_OUTCOMES,
  type CoverageReport,
  type LedgerRunRow,
  type LedgerSyncHealth,
} from '@recouple/store-postgres';
import { LedgerConnectionDisabledError, LedgerSyncRefusedError } from '@recouple/pipeline';
import { CoveragePage } from '../components/coverage-report';
import {
  ANOMALY_GUIDE,
  countedBeforePaymentWindow,
  errorClassGuide,
  OUTCOME_LABELS,
  sourceLabel,
  SYNC_OVERDUE_AFTER_HOURS,
  syncOverdue,
} from '../lib/coverage-presentation';
import { monthLabel, percent } from '../lib/format';
import { qboEnvironmentFromEnv } from '../lib/qbo-connect';
import { LEDGER_SYNC_SCHEDULE } from '../lib/inngest-ledger';
import type { Viewer } from '../components/case-list';

const viewer: Viewer = { email: 'ap@harborline.test', orgName: 'Harborline Foods', role: 'read_only' };
const now = new Date('2026-09-23T12:00:00Z');

const EMPTY_COVERAGE: CoverageReport = {
  months: 12,
  fromMonth: '2025-10-01',
  currentMonth: '2026-09-01',
  bySource: [],
  trailing: [],
  totals: [],
  countedTwice: { cases: 0, cents: 0, byChannel: [], listed: [] },
};
const EMPTY_LEDGER: LedgerSyncHealth = { runs: [], findings: [] };

/** Production's shape on 2026-09-23: three channels, one of them unknown. */
const COVERAGE: CoverageReport = {
  ...EMPTY_COVERAGE,
  bySource: [
    {
      period: '2026-09-01',
      discoveredFrom: 'erp_sync',
      openedCount: 2,
      openedCents: 68_900,
      filedCount: 0,
      filedCents: 0,
      declinedCount: 1,
      declinedCents: 400,
      discoveredCents: 69_300,
      coverageOfDiscovered: 0,
    },
    {
      period: '2026-09-01',
      discoveredFrom: 'unknown',
      openedCount: 2,
      openedCents: 357_000,
      filedCount: 1,
      filedCents: 45_000,
      declinedCount: 0,
      declinedCents: 0,
      discoveredCents: 357_000,
      coverageOfDiscovered: 0.1261,
    },
    {
      period: '2026-09-01',
      discoveredFrom: 'web_upload',
      openedCount: 1,
      openedCents: 80_000,
      filedCount: 0,
      filedCents: 0,
      declinedCount: 0,
      declinedCents: 0,
      discoveredCents: 80_000,
      coverageOfDiscovered: 0,
    },
    {
      period: '2026-08-01',
      discoveredFrom: 'web_upload',
      openedCount: 1,
      openedCents: 100_000,
      filedCount: 2,
      filedCents: 125_000,
      declinedCount: 0,
      declinedCents: 0,
      discoveredCents: 100_000,
      coverageOfDiscovered: 1.25,
    },
  ],
  trailing: [
    { discoveredFrom: 'erp_sync', openedCount: 2, filedCount: 0, filedCents: 0, discoveredCents: 69_300, coverageOfDiscovered: 0 },
    { discoveredFrom: 'unknown', openedCount: 2, filedCount: 1, filedCents: 45_000, discoveredCents: 357_000, coverageOfDiscovered: 0.1261 },
    { discoveredFrom: 'web_upload', openedCount: 2, filedCount: 2, filedCents: 125_000, discoveredCents: 180_000, coverageOfDiscovered: 0.6944 },
  ],
  totals: [
    { period: '2026-09-01', openedCents: 505_900, filedCents: 45_000, declinedCents: 400, discoveredCents: 506_300 },
    { period: '2026-08-01', openedCents: 100_000, filedCents: 125_000, declinedCents: 0, discoveredCents: 100_000 },
  ],
};

function run(overrides: Partial<LedgerRunRow> = {}): LedgerRunRow {
  return {
    runId: 'run-1',
    connectionId: 'conn-1',
    providerAccountId: '9341457960434078',
    windowFrom: '2026-08-20',
    windowTo: '2026-09-23',
    startedAt: '2026-09-23T07:00:00.000Z',
    finishedAt: '2026-09-23T07:00:09.000Z',
    outcome: 'completed',
    invoicesExamined: 9,
    openedCount: 0,
    skippedCount: 2,
    declinedCount: 1,
    anomalyCount: 0,
    itemised: true,
    ...overrides,
  };
}

function page(props: Partial<Parameters<typeof CoveragePage>[0]> = {}): string {
  return renderToStaticMarkup(
    <CoveragePage viewer={viewer} coverage={COVERAGE} ledger={EMPTY_LEDGER} now={now} {...props} />,
  );
}

describe('the coverage page', () => {
  it('says there is nothing yet, and where coverage comes from, for a new workspace', () => {
    const html = page({ coverage: EMPTY_COVERAGE });
    expect(html).toContain('Nothing found yet.');
    expect(html).toContain('No ledger sync has run.');
    expect(html).toContain('href="/settings/quickbooks"');
  });

  it('has one rate card per channel, none for the unrecorded dollars, and no combined rate', () => {
    const html = page();
    const cards = html.match(/class="metric"/g) ?? [];
    expect(cards).toHaveLength(2);
    expect(html).toContain('FOUND IN YOUR LEDGER');
    expect(html).toContain('UPLOADED IN THE APP');
    expect(html).not.toContain('ARRIVAL NOT RECORDED');
    // 0.6944 from the database, formatted and nothing more.
    expect(html).toContain('69.4%');
    expect(html).toContain('$1,250.00 filed of $1,800.00 found, last 12 months');
    expect(html).not.toMatch(/all channels[^<]*%/i);
    expect(html).toContain('a combined rate would move whenever the mix of channels does');
  });

  it('explains the dollars no channel can claim, and gives them no rate in the table', () => {
    const html = page();
    expect(html).toContain('$3,570.00 found in these months arrived without a record of how');
    const unknownRow = html.slice(html.indexOf('Arrival not recorded'));
    expect(unknownRow.slice(0, unknownRow.indexOf('</tr>'))).not.toContain('12.6%');
  });

  it('shows a month over 100% unclamped, with the likely reason', () => {
    const html = page();
    expect(html).toContain('125.0%');
    expect(html).toContain('More filed than found this month');
  });

  it('tags the current month and totals each month in dollars only', () => {
    const html = page();
    expect(html).toContain('Sep 2026');
    expect(html).toContain('month to date');
    expect(html).toContain('All channels — dollars only');
    expect(html).toContain('$5,063.00');
  });

  it('marks ledger dollars from a sandbox company as test data', () => {
    expect(page({ environment: 'sandbox' })).toContain('from a QuickBooks sandbox company, so test data');
    expect(page({ environment: 'production' })).not.toContain('sandbox');
    expect(page()).not.toContain('sandbox');
  });

  it('says which confirmed duplicates still count twice, in which channel, with links', () => {
    const html = page({
      coverage: {
        ...COVERAGE,
        countedTwice: {
          cases: 2,
          cents: 84_300,
          byChannel: [{ discoveredFrom: 'web_upload', cases: 2, cents: 84_300 }],
          listed: [{ deductionId: 'd-1', claimId: 'APDP-1', amountCents: 42_150 }],
        },
      },
    });
    expect(html).toContain('2 cases you confirmed as duplicates still count twice');
    expect(html).toContain('$843.00 of found dollars appear twice');
    expect(html).toContain('Uploaded in the app ($843.00)');
    expect(html).toContain('href="/cases/d-1"');
    expect(html).toContain('and 1 more');
    expect(page()).not.toContain('still count');
  });

  it('lists what the latest completed run found, by kind, with what to do, escaped', () => {
    const html = page({
      ledger: {
        runs: [run({ anomalyCount: 2 })],
        findings: [
          {
            connectionId: 'conn-1',
            providerAccountId: '9341457960434078',
            run: run({ anomalyCount: 2 }),
            anomalies: [
              { kind: 'application_to_unknown_invoice', invoiceExternalId: '96', transactionExternalId: '128' },
              { kind: 'negative_amount', invoiceExternalId: '<img src=x onerror=alert(1)>' },
            ],
          },
        ],
      },
    });
    expect(html).toContain('Applied to an invoice QuickBooks did not return');
    expect(html).toContain('Invoice ID 96 · payment or credit ID 128');
    expect(html).toContain('which read payments and credits from 2026-08-20 to 2026-09-23');
    expect(html).toContain('may only have left the 35 days each run reads');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('says a run counted before anomalies were kept will list them next time', () => {
    const legacy = run({ anomalyCount: 8, itemised: false, startedAt: '2026-09-22T16:40:00.000Z' });
    const html = page({
      ledger: {
        runs: [legacy],
        findings: [{ connectionId: 'conn-1', providerAccountId: '9341457960434078', run: legacy, anomalies: [] }],
      },
    });
    expect(html).toContain('8 anomalies were counted before the app kept their IDs');
    expect(html).toContain('do not compare with later runs');
  });

  it('says what a failed or refused run means, and that a stale sync is stale', () => {
    const html = page({
      ledger: {
        runs: [
          run({ runId: 'r2', outcome: 'failed', errorClass: 'QboAuthError', startedAt: '2026-09-21T07:00:00.000Z' }),
          run({ runId: 'r1', outcome: 'refused', errorClass: 'LedgerSyncRefusedError', startedAt: '2026-09-20T07:00:00.000Z' }),
        ],
        findings: [],
      },
    });
    expect(html).toContain('QuickBooks refused the connection. Reconnect it');
    expect(html).toContain('(QboAuthError)');
    expect(html).toContain('Reconnect as a current owner');
    expect(html).toContain('No sync has run since 2026-09-21 07:00 UTC');
  });

  it('says a run refused because the connection was disconnected was a disconnect, not the member', () => {
    const html = page({
      ledger: {
        runs: [
          run({
            runId: 'r1',
            outcome: 'refused',
            errorClass: 'LedgerConnectionDisabledError',
            startedAt: '2026-09-22T07:00:00.000Z',
          }),
        ],
        findings: [],
      },
    });
    expect(html).toContain('This connection was disconnected before the run began');
    expect(html).toContain('(LedgerConnectionDisabledError)');
    expect(html).not.toContain('Reconnect as a current owner');
    expect(html).not.toContain('can no longer write');
  });
});

describe('the words the page uses', () => {
  it('has a title and what-to-do for every anomaly kind the database allows', () => {
    for (const kind of LEDGER_SYNC_ANOMALY_KINDS) {
      expect(ANOMALY_GUIDE[kind].title, kind).not.toBe('');
      expect(ANOMALY_GUIDE[kind].whatToDo, kind).not.toBe('');
    }
    expect(Object.keys(ANOMALY_GUIDE).sort()).toEqual([...LEDGER_SYNC_ANOMALY_KINDS].sort());
  });

  it('has a label and tone for every run outcome', () => {
    for (const outcome of LEDGER_SYNC_OUTCOMES) {
      expect(OUTCOME_LABELS[outcome].label, outcome).not.toBe('');
    }
    expect(errorClassGuide(undefined, 'completed')).toBe('');
    expect(errorClassGuide('SomethingNew', 'failed')).toMatch(/engineer should look/);
    expect(errorClassGuide('QboRequestFailed', 'failed')).toMatch(/next daily run tries again/);
  });

  it('tells the two refusals apart, and blames nobody for one it does not know', () => {
    const disconnected = errorClassGuide('LedgerConnectionDisabledError', 'refused');
    expect(disconnected).toMatch(/disconnected/);
    expect(disconnected).not.toMatch(/member|current owner/);
    expect(errorClassGuide('LedgerSyncRefusedError', 'refused')).toMatch(/Reconnect as a current owner/);
    for (const unknown of [undefined, 'SomethingNew']) {
      const guide = errorClassGuide(unknown, 'refused');
      expect(guide, String(unknown)).not.toMatch(/member|current owner/);
      expect(guide, String(unknown)).toMatch(/engineer should look/);
    }
  });

  it('reads the refusal classes by the names the job writes, so a rename cannot slip past', () => {
    const disabled = new LedgerConnectionDisabledError('conn-1').name;
    const refused = new LedgerSyncRefusedError('org-1', 'user-1').name;
    const fallback = errorClassGuide('SomethingNew', 'refused');
    expect(errorClassGuide(disabled, 'refused')).toMatch(/disconnected/);
    expect(errorClassGuide(refused, 'refused')).toMatch(/current owner/);
    expect(errorClassGuide(disabled, 'refused')).not.toBe(errorClassGuide(refused, 'refused'));
    expect(errorClassGuide(disabled, 'refused')).not.toBe(fallback);
    expect(errorClassGuide(refused, 'refused')).not.toBe(fallback);
  });

  it('names channels, and shows one it does not know verbatim', () => {
    expect(sourceLabel('erp_sync')).toBe('Found in your ledger');
    expect(sourceLabel('unknown')).toBe('Arrival not recorded');
    expect(sourceLabel('carrier_pigeon')).toBe('carrier_pigeon');
  });

  it('formats the database’s ratios and months without doing sums', () => {
    expect(percent(0.4521)).toBe('45.2%');
    expect(percent(1.25)).toBe('125.0%');
    expect(percent(0)).toBe('0.0%');
    expect(monthLabel('2026-09-01')).toBe('Sep 2026');
    expect(monthLabel('2026-01-01')).toBe('Jan 2026');
    expect(monthLabel('not a date')).toBe('not a date');
  });

  it('calls a sync stale after 26 hours, tied to the 07:00 UTC schedule', () => {
    expect(LEDGER_SYNC_SCHEDULE).toBe('0 7 * * *');
    expect(SYNC_OVERDUE_AFTER_HOURS).toBe(26);
    expect(syncOverdue('2026-09-22T09:00:00.000Z', now)).toBe(true);
    expect(syncOverdue('2026-09-22T11:00:00.000Z', now)).toBe(false);
    expect(syncOverdue(undefined, now)).toBe(false);
  });

  it('marks runs from before the payment-anchored window', () => {
    expect(countedBeforePaymentWindow('2026-09-22T16:40:00.000Z')).toBe(true);
    expect(countedBeforePaymentWindow('2026-09-23T07:00:00.000Z')).toBe(false);
  });

  it('reads the deployment’s QuickBooks environment and nothing else', () => {
    expect(qboEnvironmentFromEnv({ QBO_ENVIRONMENT: 'sandbox' })).toBe('sandbox');
    expect(qboEnvironmentFromEnv({ QBO_ENVIRONMENT: ' production ' })).toBe('production');
    expect(qboEnvironmentFromEnv({ QBO_ENVIRONMENT: 'prod' })).toBeUndefined();
    expect(qboEnvironmentFromEnv({})).toBeUndefined();
  });
});

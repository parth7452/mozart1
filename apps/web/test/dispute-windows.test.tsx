import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DisputeWindowRow } from '@recouple/core-domain';
import {
  DisputeWindowRefusedError,
  type DisputeWindowListed,
  type DisputeWindowRefusal,
  type MappableDebtor,
  type PayerWithoutWindow,
} from '@recouple/store-postgres';
import { DisputeWindowsPage } from '../components/dispute-windows';
import { DisputeDeadline } from '../components/dispute-deadline';
import type { Viewer } from '../components/case-list';
import {
  addWindowHref,
  DISPUTE_WINDOW_NOTICES,
  mayRecordWindows,
  resolveDisputeWindowNotice,
  windowPrefillFrom,
} from '../lib/dispute-window-words';

/**
 * Settings → Dispute windows (ADR 0071): the views, the page, its one write,
 * and the case page's offer of the date a window gives.
 */

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';
const SYSCO = '33333333-3333-3333-3333-333333333333';
const PFG = '44444444-4444-4444-4444-444444444444';
const CASE_ID = '99999999-9999-9999-9999-999999999999';

const viewer: Viewer = { email: 'owner@acme.test', orgName: 'Acme Foods', role: 'owner' };
const debtors: MappableDebtor[] = [
  { debtorId: PFG, displayName: 'PFG', retailerKey: 'pfg' },
  { debtorId: SYSCO, displayName: 'Sysco', retailerKey: 'sysco' },
];

function windowRow(over: Partial<DisputeWindowRow> = {}): DisputeWindowRow {
  return {
    id: '55555555-5555-5555-5555-555555555555',
    debtorId: SYSCO,
    windowDays: 30,
    measuredFrom: 'deduction_date',
    effectiveFrom: '2026-01-01',
    source: 'payer_guide_url',
    confidence: 'high',
    recordedBy: USER_ID,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

const listed: DisputeWindowListed[] = [{ ...windowRow({ sourceNote: 'vendor guide §4' }), debtorName: 'Sysco' }];
const without: PayerWithoutWindow[] = [
  { debtorId: PFG, displayName: 'PFG', openCases: 3, openCasesWithoutDeadline: 2 },
];

function page(over: Partial<Parameters<typeof DisputeWindowsPage>[0]> = {}): string {
  return renderToStaticMarkup(
    <DisputeWindowsPage
      viewer={viewer}
      current={listed}
      debtors={debtors}
      without={without}
      mayRecord
      today="2026-10-07"
      {...over}
    />,
  );
}

describe('Settings → Dispute windows, as a view', () => {
  it('lists the windows in force and the payers with none', () => {
    const html = page();
    expect(html).toContain('<h1>Dispute windows</h1>');
    expect(html).toContain('How long each payer gives you to dispute a deduction.');
    expect(html).toContain('<td>Sysco</td><td>30</td>');
    expect(html).toContain('The payer&#x27;s own guide: vendor guide §4');
    expect(html).toContain('2026-01-01 onwards');
    expect(html).toContain('<td>PFG</td><td>3</td><td>2</td>');
    expect(html).toContain(`href="${addWindowHref(PFG)}"`);
  });

  it('offers the form to an owner or approver, prefilled, with no author field', () => {
    const html = page({ prefill: { debtorId: PFG } });
    expect(html).toContain('action="/settings/dispute-windows/add"');
    expect(html).toContain(`<option value="${PFG}" selected="">PFG</option>`);
    expect(html).toContain('name="windowDays"');
    expect(html).toContain('max="730"');
    expect(html).toContain('value="2026-10-07"');
    expect(html).not.toContain('recordedBy');
  });

  it('shows no form and no add link to a member who may not add one', () => {
    const html = page({ mayRecord: false });
    expect(html).not.toContain('action="/settings/dispute-windows/add"');
    expect(html).not.toContain('Add a window</a>');
    expect(html).toContain('Only an owner or approver can add a window.');
  });

  it('says a notice by key, and nothing for a key it does not know', () => {
    expect(page({ notice: 'windows_recorded' })).toContain(DISPUTE_WINDOW_NOTICES.windows_recorded.text);
    expect(resolveDisputeWindowNotice('codes_mapped')).toBeUndefined();
    expect(resolveDisputeWindowNotice('toString')).toBeUndefined();
  });

  it('lets an owner or approver record, and takes a prefill only as a UUID', () => {
    expect(['owner', 'approver'].map(mayRecordWindows)).toEqual([true, true]);
    expect(['analyst', 'read_only'].map(mayRecordWindows)).toEqual([false, false]);
    expect(windowPrefillFrom({ debtor: PFG })).toEqual({ debtorId: PFG });
    expect(windowPrefillFrom({ debtor: 'pfg' })).toEqual({});
    expect(windowPrefillFrom({ debtor: [PFG] })).toEqual({});
  });
});

describe('the deadline form and a payer window', () => {
  const base = {
    deductionId: CASE_ID,
    state: 'classified' as const,
    disputeDeadline: undefined,
    deadlineSet: undefined,
    mayAct: true,
    today: new Date('2026-10-07T12:00:00Z'),
  };

  it('says the window and prefills the date and the basis', () => {
    const html = renderToStaticMarkup(
      <DisputeDeadline
        {...base}
        disputeWindow={{ kind: 'window', window: windowRow(), deadline: '2026-10-15' }}
      />,
    );
    expect(html).toContain('Payer window: 30 days from the deduction date → 2026-10-15');
    expect(html).toContain('the payer&#x27;s own guide, high');
    expect(html).toContain('value="2026-10-15"');
    expect(html).toContain(
      'value="Payer dispute window: 30 days from the deduction date (the payer&#x27;s own guide)"',
    );
  });

  it('is the form it always was with no window', () => {
    const plain = renderToStaticMarkup(<DisputeDeadline {...base} />);
    expect(renderToStaticMarkup(<DisputeDeadline {...base} disputeWindow={{ kind: 'none' }} />)).toBe(plain);
    expect(plain).not.toContain('Payer window');
  });

  it('says nothing about a window on a case that has a deadline', () => {
    const html = renderToStaticMarkup(
      <DisputeDeadline
        {...base}
        disputeDeadline="2026-11-01"
        disputeWindow={{ kind: 'window', window: windowRow(), deadline: '2026-10-15' }}
      />,
    );
    expect(html).toBe('');
  });
});

const harness = vi.hoisted(() => ({
  role: 'owner' as string,
  mayWrite: true,
  sessions: 0,
  recorded: [] as unknown[],
  identities: [] as unknown[],
  fail: undefined as Error | undefined,
}));

vi.mock('../lib/session', () => ({
  requireSession: async () => {
    harness.sessions += 1;
    return {
      userId: USER_ID,
      email: 'owner@acme.test',
      org: { orgId: ORG_ID, slug: 'acme', name: 'Acme Foods', role: harness.role },
      orgs: [{ orgId: ORG_ID, slug: 'acme', name: 'Acme Foods', role: harness.role }],
    };
  },
  storeFor: () => ({ memberMayWrite: async () => harness.mayWrite, close: async () => undefined }),
}));

vi.mock('../lib/dispute-windows', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/dispute-windows')>()),
  disputeWindowStoreFor: (identity: unknown) => {
    harness.identities.push(identity);
    return {
      recordDisputeWindow: async (input: unknown) => {
        if (harness.fail !== undefined) throw harness.fail;
        harness.recorded.push(input);
        return { ...windowRow(), id: '88888888-8888-8888-8888-888888888888' };
      },
      currentDisputeWindows: async () => listed,
      payersWithoutWindow: async () => without,
    };
  },
}));

vi.mock('../lib/reason-code-maps', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/reason-code-maps')>()),
  payerCodeMapStoreFor: () => ({ mappableDebtors: async () => debtors }),
}));

const add = (await import('../app/settings/dispute-windows/add/route')).POST;
const SettingsPage = (await import('../app/settings/dispute-windows/page')).default;

const valid = {
  debtorId: SYSCO,
  windowDays: '30',
  effectiveFrom: '2026-01-01',
  effectiveTo: '',
  source: 'payer_guide_url',
  sourceNote: 'vendor guide §4',
  confidence: 'high',
};

function request(form: Record<string, string>, site?: string): NextRequest {
  const headers = new Headers();
  if (site !== undefined) headers.set('sec-fetch-site', site);
  const body = new FormData();
  for (const [name, value] of Object.entries(form)) body.set(name, value);
  return new NextRequest('https://app.example.test/settings/dispute-windows/add', { method: 'POST', headers, body });
}

function landed(response: Response) {
  const at = new URL(response.headers.get('location') as string);
  return { status: response.status, path: at.pathname, key: at.searchParams.get('windows') };
}

describe('POST /settings/dispute-windows/add', () => {
  beforeEach(() => {
    harness.role = 'owner';
    harness.mayWrite = true;
    harness.sessions = 0;
    harness.recorded.length = 0;
    harness.identities.length = 0;
    harness.fail = undefined;
    vi.restoreAllMocks();
  });

  it('refuses a cross-site request before the session is resolved', async () => {
    const response = await add(request(valid, 'cross-site'));
    expect(response.status).toBe(403);
    expect(harness.sessions).toBe(0);
    expect(harness.recorded).toEqual([]);
  });

  it('refuses an analyst before the store is asked', async () => {
    harness.role = 'analyst';
    expect(landed(await add(request(valid)))).toEqual({
      status: 303,
      path: '/settings/dispute-windows',
      key: 'windows_role',
    });
    expect(harness.identities).toEqual([]);
  });

  it('refuses a member the database says may not write', async () => {
    harness.mayWrite = false;
    expect(landed(await add(request(valid))).key).toBe('windows_role');
    expect(harness.recorded).toEqual([]);
  });

  it('records the window as the session\'s member, whatever the form says about an author', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const response = await add(request({ ...valid, recordedBy: PFG, effectiveTo: '2026-12-31' }, 'same-origin'));
    expect(landed(response).key).toBe('windows_recorded');
    expect(harness.identities).toEqual([{ orgId: ORG_ID, userId: USER_ID }]);
    expect(harness.recorded).toEqual([
      {
        debtorId: SYSCO,
        windowDays: 30,
        effectiveFrom: '2026-01-01',
        effectiveTo: '2026-12-31',
        source: 'payer_guide_url',
        sourceNote: 'vendor guide §4',
        confidence: 'high',
      },
    ]);
  });

  it.each([
    ['a debtor that is not a UUID', { debtorId: 'sysco' }],
    ['no days', { windowDays: '' }],
    ['zero days', { windowDays: '0' }],
    ['731 days', { windowDays: '731' }],
    ['a fraction of a day', { windowDays: '30.5' }],
    ['a start that is not a date', { effectiveFrom: '01/01/2026' }],
    ['an end that is not a date', { effectiveTo: 'never' }],
    ['a source nobody listed', { source: 'a_model' }],
    ['a confidence nobody listed', { confidence: 'certain' }],
    ['a note past its limit', { sourceNote: 'n'.repeat(501) }],
  ])('refuses %s without asking the store', async (_label, over) => {
    expect(landed(await add(request({ ...valid, ...over }))).key).toBe('windows_invalid');
    expect(harness.identities).toEqual([]);
  });

  it('refuses an end before the start, in its own words', async () => {
    expect(
      landed(await add(request({ ...valid, effectiveFrom: '2026-02-01', effectiveTo: '2026-01-01' }))).key,
    ).toBe('windows_dates');
  });

  it.each<[DisputeWindowRefusal, string | undefined, string]>([
    ['not_permitted', undefined, 'windows_role'],
    ['unknown_debtor', 'debtorId', 'windows_debtor'],
    ['already_recorded', undefined, 'windows_already'],
    ['invalid', 'windowDays', 'windows_invalid'],
    ['invalid', 'effectiveTo', 'windows_dates'],
  ])('answers the store\'s %s (%s) as %s', async (refusal, field, key) => {
    harness.fail = new DisputeWindowRefusedError(ORG_ID, refusal, field);
    expect(landed(await add(request(valid))).key).toBe(key);
  });

  it('answers a fault as a notice, logging a class name', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    harness.fail = new Error('connection terminated');
    expect(landed(await add(request(valid))).key).toBe('windows_failed');
    expect(error.mock.calls.map((call) => call.join(' ')).join('\n')).toContain('(Error)');
  });
});

describe('the Dispute windows page', () => {
  it('reads as the member signed in and renders, with the form only for an owner or approver', async () => {
    harness.role = 'owner';
    harness.identities.length = 0;
    const html = renderToStaticMarkup(
      await SettingsPage({ searchParams: Promise.resolve({ debtor: PFG, windows: 'windows_recorded' }) }),
    );
    expect(harness.identities).toEqual([{ orgId: ORG_ID, userId: USER_ID }]);
    expect(html).toContain(`<option value="${PFG}" selected="">PFG</option>`);
    expect(html).toContain(DISPUTE_WINDOW_NOTICES.windows_recorded.text);

    harness.role = 'analyst';
    const analystHtml = renderToStaticMarkup(await SettingsPage({ searchParams: Promise.resolve({}) }));
    expect(analystHtml).not.toContain('action="/settings/dispute-windows/add"');
    expect(analystHtml).toContain('<td>Sysco</td>');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { renderToStaticMarkup } from 'react-dom/server';
import { CANONICAL_REASON_CODE_LIST, type PayerCodeMapRow } from '@recouple/core-domain';
import {
  PayerCodeMapRefusedError,
  type MappableDebtor,
  type PayerCodeMapListed,
  type PayerCodeMapRefusal,
  type UnmappedPayerCodes,
} from '@recouple/store-postgres';
import { CaseActions } from '../components/case-actions';
import { PayerCodeMappingLine, ReasonCodesPage } from '../components/reason-code-maps';
import type { Viewer } from '../components/case-list';
import {
  mapItHref,
  mayMapPayerCodes,
  prefillFrom,
  REASON_CODE_NOTICES,
  resolveReasonCodeNotice,
} from '../lib/reason-code-words';

/**
 * Settings → Reason codes (ADR 0066): the views, the page and its one write.
 *
 * The views are pure functions of what the store returned. The write is a POST
 * in Settings → Team's shape: a cross-site request is refused before the
 * session is resolved, a role that may not map before the store is asked, and
 * every refusal the store names is its own notice, never a 500. The author is
 * the session's member and never a form field. A payer's code is text off a
 * document: it is shown escaped and never logged.
 */

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';
const UNFI = '33333333-3333-3333-3333-333333333333';
const KEHE = '44444444-4444-4444-4444-444444444444';

const viewer: Viewer = { email: 'owner@acme.test', orgName: 'Acme Foods', role: 'owner' };
const debtors: MappableDebtor[] = [
  { debtorId: KEHE, displayName: 'KeHE', retailerKey: 'kehe' },
  { debtorId: UNFI, displayName: 'UNFI', retailerKey: 'unfi' },
];

function map(over: Partial<PayerCodeMapListed> = {}): PayerCodeMapListed {
  return {
    id: '55555555-5555-5555-5555-555555555555',
    orgId: ORG_ID,
    debtorId: UNFI,
    debtorName: 'UNFI',
    payerCode: 'CB-203',
    canonicalCode: 'price_discrepancy',
    effectiveFrom: '2026-01-01',
    source: 'customer_confirmed',
    confidence: 'high',
    recordedBy: USER_ID,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

const unmapped: UnmappedPayerCodes = {
  rows: [
    { payerCode: 'PREMIUM-NOAUTH', debtorId: UNFI, debtorName: 'UNFI', caseCount: 3, totalCents: 412_550, mappable: true },
    { payerCode: 'SPOILS', printedName: 'Kehe West', caseCount: 1, totalCents: 9_900, mappable: false },
    { payerCode: '<B>X</B>', debtorId: KEHE, debtorName: 'KeHE', caseCount: 1, totalCents: 100, mappable: true },
  ],
  casesExamined: 12,
  casesWithCode: 9,
  casesMapped: 4,
  truncated: false,
};

function page(over: Partial<Parameters<typeof ReasonCodesPage>[0]> = {}): string {
  return renderToStaticMarkup(
    <ReasonCodesPage
      viewer={viewer}
      current={[
        map({ sourceNote: 'AP lead, by phone' }),
        map({
          id: '66666666-6666-6666-6666-666666666666',
          payerCode: 'MCB',
          canonicalCode: 'promo_allowance_claimed',
          source: 'glimpse_guide',
          confidence: 'low',
          effectiveTo: '2026-12-31',
        }),
      ]}
      debtors={debtors}
      unmapped={unmapped}
      mayMap
      today="2026-10-04"
      {...over}
    />,
  );
}

describe('Settings → Reason codes, as a view', () => {
  it('lists each unmapped payer code with its cases and dollars, and a link that prefills the form', () => {
    const html = page();
    expect(html).toContain('PREMIUM-NOAUTH');
    expect(html).toContain('$4,125.50');
    expect(html).toContain(`href="${mapItHref(UNFI, 'PREMIUM-NOAUTH').replace(/&/g, '&amp;')}"`);
    // A code on a case matched to no payer cannot be mapped yet, and says so.
    expect(html).toContain('Kehe West (not matched)');
    expect(html).toContain('Match the payer first');
    expect(html).toContain('4 of 9 cases with a payer code have a mapping');
    expect(html).not.toContain('Only the newest');
  });

  it('shows a payer code as text, never as markup', () => {
    const html = page();
    expect(html).toContain('&lt;B&gt;X&lt;/B&gt;');
    expect(html).not.toContain('<B>X</B>');
  });

  it('lists the mappings in force per payer with what each means, its dates, source and confidence', () => {
    const html = page();
    expect(html).toContain('<h3>UNFI</h3>');
    expect(html).toContain('Paid at a price other than the agreed price');
    expect(html).toContain('Confirmed by the customer: AP lead, by phone');
    expect(html).toContain('2026-01-01 to 2026-12-31');
    expect(html).toContain('Glimpse&#x27;s published guide');
    expect(html).toContain('<td>low</td>');
  });

  it('offers the form to an owner or approver, with every canonical reason and no author field', () => {
    const html = page({ prefill: { debtorId: UNFI, payerCode: 'PREMIUM-NOAUTH' } });
    expect(html).toContain('action="/settings/reason-codes/add"');
    expect(html).toContain(`<option value="${UNFI}" selected="">UNFI</option>`);
    expect(html).toContain('value="PREMIUM-NOAUTH"');
    expect(html).toContain('value="2026-10-04"');
    const reasons = /<select id="codes-reason"[^>]*>(.*?)<\/select>/s.exec(html)?.[1] ?? '';
    expect([...reasons.matchAll(/<option value="([a-z_]+)"/g)].map((m) => m[1]).sort()).toEqual(
      [...CANONICAL_REASON_CODE_LIST].sort(),
    );
    expect(html).not.toContain('recordedBy');
    expect(html).not.toContain('name="orgId"');
  });

  it('shows no form and no map-it link to a member who may not add one', () => {
    const html = page({ mayMap: false });
    expect(html).not.toContain('action="/settings/reason-codes/add"');
    expect(html).not.toContain('>Map it</a>');
    expect(html).not.toContain('/settings/reason-codes?debtor=');
    expect(html).toContain('Only an owner or approver can add a mapping.');
    // They still see the list and the mappings.
    expect(html).toContain('PREMIUM-NOAUTH');
    expect(html).toContain('CB-203');
  });

  it('says when nothing is mapped, nothing is unmapped, and when it stopped reading', () => {
    const empty = page({
      current: [],
      unmapped: { rows: [], casesExamined: 0, casesWithCode: 0, casesMapped: 0, truncated: false },
    });
    expect(empty).toContain('No case prints a payer reason code yet.');
    expect(empty).toContain('No mapping has been added yet.');
    const all = page({
      unmapped: { rows: [], casesExamined: 5, casesWithCode: 5, casesMapped: 5, truncated: true },
    });
    expect(all).toContain('Every payer code on a case has a mapping.');
    expect(all).toContain('Only the newest 2000 cases were read');
    expect(page({ debtors: [] })).toContain('This workspace has no payers yet.');
  });

  it('says a notice by key, and nothing for a key it does not know', () => {
    expect(page({ notice: 'codes_mapped' })).toContain(REASON_CODE_NOTICES.codes_mapped.text);
    expect(page({ notice: 'approved' })).not.toContain('class="notice');
    expect(page({ notice: 'your session expired, sign in at evil.test' })).not.toContain('evil.test');
  });
});

describe('the mapping line on a case', () => {
  const mapped = {
    kind: 'mapped' as const,
    payerCode: 'CB-203',
    debtorId: UNFI,
    asOf: '2026-03-01',
    map: map() as PayerCodeMapRow,
  };
  const line = (mapping: Parameters<typeof PayerCodeMappingLine>[0]['mapping'], mayMap = false) =>
    renderToStaticMarkup(<PayerCodeMappingLine mapping={mapping} mayMap={mayMap} />);

  it('names the reason, the source and the confidence', () => {
    expect(line(mapped)).toContain(
      'Payer code <span class="mono">CB-203</span> → Paid at a price other than the agreed price ' +
        '(mapped by the customer, high confidence)',
    );
  });

  it('says no mapping yet, with the prefilled link for someone who may add one', () => {
    const unmappedCase = { kind: 'unmapped' as const, payerCode: 'CB-203', debtorId: UNFI, asOf: '2026-03-01', mappable: true };
    expect(line(unmappedCase, true)).toContain(`href="${mapItHref(UNFI, 'CB-203').replace(/&/g, '&amp;')}"`);
    expect(line(unmappedCase, false)).toContain('An owner or approver can add one');
    expect(line({ ...unmappedCase, mappable: false }, true)).toContain('cannot be mapped');
    expect(line({ kind: 'no_debtor', payerCode: 'CB-203' }, true)).toContain('not matched to a payer');
  });

  it('renders nothing where the case has no single payer code', () => {
    expect(line({ kind: 'no_code' })).toBe('');
    expect(line(undefined)).toBe('');
  });
});

describe('the decide form and a mapped reason', () => {
  const form = (code: PayerCodeMapRow['canonicalCode'] | undefined) =>
    renderToStaticMarkup(
      <CaseActions
        deductionId="77777777-7777-7777-7777-777777777777"
        state="classified"
        workflow={undefined}
        mayAct
        mayApprove={false}
        viewerUserId={USER_ID}
        filenames={new Map()}
        unservable={new Map()}
        suggestedReason={
          code === undefined ? undefined : { code, payerCode: 'CB-203', provenance: 'mapped by the customer, high confidence' }
        }
      />,
    );

  it('starts on the mapped reason and says where it came from', () => {
    const html = form('price_discrepancy');
    expect(html).toContain('<option value="price_discrepancy" selected="">');
    expect(html).toContain('Pre-selected from the payer code');
    expect(html).toContain('mapped by the customer, high confidence');
    expect(html).toContain('change it if it is wrong');
  });

  it('pre-selects nothing for a mapped reason the form does not offer, and says which it was', () => {
    const html = form('promo_allowance_claimed');
    expect(html).not.toMatch(/<option value="[a-z_]+" selected="">/);
    expect(html).toContain('is not a reason this form offers');
    expect(html).toContain('Promotional allowance deducted beyond what was agreed');
  });

  it('is the form it always was with no mapping', () => {
    const html = form(undefined);
    expect(html).toContain('<option value="" disabled="" selected="">Choose a reason…</option>');
    expect(html).not.toContain('payer code');
  });
});

describe('the words and the prefill', () => {
  it('lets an owner or approver map, and nobody else', () => {
    expect(['owner', 'approver', 'analyst', 'read_only', 'accountant_guest', ''].filter(mayMapPayerCodes)).toEqual([
      'owner',
      'approver',
    ]);
  });

  it('takes a prefill only in the shapes it claims', () => {
    expect(prefillFrom({ debtor: UNFI, code: ' cb-203 ' })).toEqual({ debtorId: UNFI, payerCode: 'CB-203' });
    expect(prefillFrom({ debtor: 'not-a-uuid', code: 'x'.repeat(65) })).toEqual({});
    expect(prefillFrom({ debtor: [UNFI, KEHE], code: ['A', 'B'] })).toEqual({});
    expect(prefillFrom({ code: 'A\u0000B' })).toEqual({});
    expect(prefillFrom({})).toEqual({});
  });

  it('resolves only its own notice keys', () => {
    expect(resolveReasonCodeNotice('codes_role')?.tone).toBe('bad');
    expect(resolveReasonCodeNotice('toString')).toBeUndefined();
    expect(resolveReasonCodeNotice(undefined)).toBeUndefined();
  });
});

const harness = vi.hoisted(() => ({
  role: 'owner' as string,
  mayWrite: true,
  sessions: 0,
  recorded: [] as unknown[],
  identities: [] as unknown[],
  fail: undefined as Error | undefined,
  unmappedAskedWith: [] as unknown[],
  asOf: [] as string[],
}));

const caseStore = { memberMayWrite: async () => harness.mayWrite, close: async () => undefined };

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
  storeFor: () => caseStore,
}));

vi.mock('../lib/reason-code-maps', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/reason-code-maps')>()),
  payerCodeMapStoreFor: (identity: unknown) => {
    harness.identities.push(identity);
    return {
      recordPayerCodeMap: async (input: unknown) => {
        if (harness.fail !== undefined) throw harness.fail;
        harness.recorded.push(input);
        return { ...map(), id: '88888888-8888-8888-8888-888888888888' };
      },
      allCurrentPayerCodeMaps: async (asOf: string) => {
        harness.asOf.push(asOf);
        return [map()];
      },
      mappableDebtors: async () => debtors,
      unmappedPayerCodes: async (terms: unknown) => {
        harness.unmappedAskedWith.push(terms);
        return unmapped;
      },
    };
  },
}));

const add = (await import('../app/settings/reason-codes/add/route')).POST;
const ReasonCodesSettingsPage = (await import('../app/settings/reason-codes/page')).default;

const valid = {
  debtorId: UNFI,
  payerCode: ' cb-203 ',
  canonicalCode: 'price_discrepancy',
  effectiveFrom: '2026-01-01',
  effectiveTo: '',
  source: 'customer_confirmed',
  sourceNote: 'AP lead, by phone',
  confidence: 'high',
};

function request(form: Record<string, string>, site?: string): NextRequest {
  const headers = new Headers();
  if (site !== undefined) headers.set('sec-fetch-site', site);
  const body = new FormData();
  for (const [name, value] of Object.entries(form)) body.set(name, value);
  return new NextRequest('https://app.example.test/settings/reason-codes/add', { method: 'POST', headers, body });
}

function landed(response: Response) {
  const at = new URL(response.headers.get('location') as string);
  return { status: response.status, path: at.pathname, key: at.searchParams.get('codes') };
}

describe('POST /settings/reason-codes/add', () => {
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
    expect(landed(await add(request(valid)))).toEqual({ status: 303, path: '/settings/reason-codes', key: 'codes_role' });
    expect(harness.identities).toEqual([]);
  });

  it('refuses a member the database says may not write', async () => {
    harness.mayWrite = false;
    expect(landed(await add(request(valid))).key).toBe('codes_role');
    expect(harness.recorded).toEqual([]);
  });

  it('records the mapping as the session\'s member, whatever the form says about an author', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const response = await add(request({ ...valid, recordedBy: UNFI, orgId: KEHE, effectiveTo: '2026-12-31' }, 'same-origin'));
    expect(landed(response).key).toBe('codes_mapped');
    expect(harness.identities).toEqual([{ orgId: ORG_ID, userId: USER_ID }]);
    expect(harness.recorded).toEqual([
      {
        debtorId: UNFI,
        payerCode: ' cb-203 ',
        canonicalCode: 'price_discrepancy',
        effectiveFrom: '2026-01-01',
        effectiveTo: '2026-12-31',
        source: 'customer_confirmed',
        sourceNote: 'AP lead, by phone',
        confidence: 'high',
      },
    ]);
    // Ids, the source and the confidence; never the code or the note.
    const line = info.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(line).toContain('88888888-8888-8888-8888-888888888888');
    expect(line).not.toMatch(/cb-203/i);
    expect(line).not.toContain('AP lead');
  });

  it.each([
    ['a debtor that is not a UUID', { debtorId: 'unfi' }],
    ['an empty code', { payerCode: '   ' }],
    ['a code past any the table takes', { payerCode: 'X'.repeat(201) }],
    ['a reason outside the taxonomy', { canonicalCode: 'premium_noauth' }],
    ['a start that is not a date', { effectiveFrom: '01/01/2026' }],
    ['an end that is not a date', { effectiveTo: 'never' }],
    ['a source nobody listed', { source: 'a_model' }],
    ['a confidence nobody listed', { confidence: 'certain' }],
    ['a note past its limit', { sourceNote: 'n'.repeat(501) }],
  ])('refuses %s without asking the store', async (_label, over) => {
    expect(landed(await add(request({ ...valid, ...over }))).key).toBe('codes_invalid');
    expect(harness.recorded).toEqual([]);
    expect(harness.identities).toEqual([]);
  });

  it('refuses an end before the start, in its own words', async () => {
    expect(landed(await add(request({ ...valid, effectiveFrom: '2026-02-01', effectiveTo: '2026-01-01' }))).key).toBe(
      'codes_dates',
    );
  });

  it.each<[PayerCodeMapRefusal, string | undefined, string]>([
    ['not_permitted', undefined, 'codes_role'],
    ['unknown_debtor', 'debtorId', 'codes_debtor'],
    ['already_recorded', undefined, 'codes_already'],
    ['invalid', 'payerCode', 'codes_invalid'],
    ['invalid', 'effectiveTo', 'codes_dates'],
  ])('answers the store\'s %s (%s) as %s', async (refusal, field, key) => {
    harness.fail = new PayerCodeMapRefusedError(ORG_ID, refusal, field);
    expect(landed(await add(request(valid))).key).toBe(key);
  });

  it('answers a fault as a notice, logging a class name and never the code', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    harness.fail = new Error('connection terminated while writing CB-203');
    expect(landed(await add(request(valid))).key).toBe('codes_failed');
    const line = error.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(line).toContain('(Error)');
    expect(line).not.toContain('CB-203');
  });
});

describe('the Reason codes page', () => {
  beforeEach(() => {
    harness.role = 'owner';
    harness.identities.length = 0;
    harness.unmappedAskedWith.length = 0;
    harness.asOf.length = 0;
  });

  it('reads as the member signed in and renders the list, the mappings and the prefilled form', async () => {
    const html = renderToStaticMarkup(
      await ReasonCodesSettingsPage({
        searchParams: Promise.resolve({ debtor: UNFI, code: 'premium-noauth', codes: 'codes_mapped' }),
      }),
    );
    expect(harness.identities).toEqual([{ orgId: ORG_ID, userId: USER_ID }]);
    // The derived half of a case's code is asked of the member's own case store.
    expect(harness.unmappedAskedWith).toEqual([caseStore]);
    expect(harness.asOf).toEqual([new Date().toISOString().slice(0, 10)]);
    expect(html).toContain('Payer codes with no mapping');
    expect(html).toContain('value="PREMIUM-NOAUTH"');
    expect(html).toContain(REASON_CODE_NOTICES.codes_mapped.text);
    expect(html).toContain('aria-current="page"');
  });

  it('shows an analyst the lists and no form', async () => {
    harness.role = 'analyst';
    const html = renderToStaticMarkup(await ReasonCodesSettingsPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('CB-203');
    expect(html).not.toContain('action="/settings/reason-codes/add"');
  });
});

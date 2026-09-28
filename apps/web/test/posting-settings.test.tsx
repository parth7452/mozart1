import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { REASON_FAMILIES } from '@recouple/core-domain';
import { SETUP_ACCOUNTS, proposePostingSetup, type LedgerAccountMap, type QboAccount } from '@recouple/qbo';
import { PostingSettings } from '../components/posting-settings';
import { LedgerConnectionPage } from '../components/ledger-connection';
import type { PostingConnectionSetup } from '../lib/posting-setup';
import type { Viewer } from '../components/case-list';

/**
 * Settings → QuickBooks → Posting, card by card (ADR 0063 §1, §4): what an
 * owner is proposed with no map, when the button is off and why, and a saved
 * map as dropdowns. Every proposal is `proposePostingSetup`'s own answer over a
 * chart written here; the view is a pure function of it.
 */

const CONNECTION_ID = '44444444-4444-4444-8444-444444444444';
const REALM = '4620816365';

function account(id: string, name: string, accountType: string, active = true): QboAccount {
  return { id, name, fullyQualifiedName: name, accountType, accountSubType: undefined, active };
}
const AR = account('7001', 'Trade Receivables', 'Accounts Receivable');
const AR_TWO = account('7006', 'Broadline Receivables', 'Accounts Receivable');
const PREPAID = account('7003', 'Prepaid Freight', 'Other Current Asset');
const PROMO = account('7004', 'Promotional Allowances', 'Expense');
const MISC = account('7005', 'Miscellaneous Losses', 'Other Expense');
const OURS_DR = account('7010', SETUP_ACCOUNTS.deductions_receivable.name, 'Other Current Asset');
const OURS_WO = account('7011', SETUP_ACCOUNTS.writeoff.name, 'Expense');
const IDS = [AR, AR_TWO, PREPAID, PROMO, MISC, OURS_DR, OURS_WO].map((a) => a.id);

function setup(
  chart: readonly QboAccount[] | 'unreadable' | 'not_configured',
  overrides: Partial<PostingConnectionSetup> = {},
): PostingConnectionSetup {
  return {
    connectionId: CONNECTION_ID,
    realmId: REALM,
    postingEnabled: false,
    map: undefined,
    chart: typeof chart === 'string' ? { kind: chart } : { kind: 'read', proposal: proposePostingSetup(chart) },
    ...overrides,
  };
}

function saved(overrides: Partial<LedgerAccountMap> = {}): LedgerAccountMap & { mapId: string } {
  return {
    mapId: 'map-1',
    arAccountId: AR.id,
    deductionsReceivableAccountId: OURS_DR.id,
    writeoffByFamily: Object.fromEntries(REASON_FAMILIES.map((f) => [f, OURS_WO.id])) as LedgerAccountMap['writeoffByFamily'],
    unclassifiedWriteoff: OURS_WO.id,
    ...overrides,
  };
}

const render = (...connections: PostingConnectionSetup[]): string =>
  renderToStaticMarkup(<PostingSettings connections={connections} />);

/** What a person reads: tags gone — so an id in a `value` is not text — and entities read. */
function text(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

/** One dropdown's markup, by its field name. */
function select(html: string, name: string): string {
  const found = new RegExp(`<select[^>]*name="${name}"[^>]*>(.*?)</select>`).exec(html);
  expect(found, name).not.toBeNull();
  return found?.[1] ?? '';
}

/** The values a dropdown offers, and which one it starts on. */
function offers(html: string, name: string): { values: string[]; selected: string | undefined } {
  const options = [...select(html, name).matchAll(/<option([^>]*)>/g)].map((m) => m[1] ?? '');
  return {
    values: options.map((attrs) => /value="([^"]*)"/.exec(attrs)?.[1] ?? ''),
    selected: options.map((attrs) => (/ selected=""/.test(attrs) ? /value="([^"]*)"/.exec(attrs)?.[1] : undefined)).find(
      (value) => value !== undefined,
    ),
  };
}

const button = (html: string): string => /<button[^>]*>Turn on posting<\/button>/.exec(html)?.[0] ?? '';

describe('with no map saved: the proposal and its one button', () => {
  it('proposes every row from what the company already has', () => {
    const html = render(setup([AR, PREPAID, PROMO, OURS_DR, OURS_WO]));
    expect(html).toMatch(/<form[^>]* action="\/settings\/quickbooks\/setup" method="post"/);
    expect(html).toContain(`name="connectionId" value="${CONNECTION_ID}"`);
    const said = text(html);
    expect(said).toContain('Receivable Trade Receivables');
    expect(said).toContain('Deductions held Deductions Receivable');
    expect(said).toContain('Write-offs Customer Deductions , for every reason');
    expect(said).not.toContain("we'll create it");
    expect(button(html)).not.toContain('disabled');
    expect(offers(html, 'deductionsReceivable').selected).toBe(OURS_DR.id);
    expect(offers(html, 'writeoff').selected).toBe(OURS_WO.id);
  });

  it("says we'll create the two accounts that are missing, by their fixed names", () => {
    const html = render(setup([AR, PREPAID, PROMO]));
    const said = text(html);
    expect(said).toContain("Deductions Receivable — we'll create it (Other Current Asset)");
    expect(said).toContain("Customer Deductions — we'll create it (Expense) , for every reason");
    expect(offers(html, 'deductionsReceivable')).toEqual({ values: ['create', PREPAID.id], selected: 'create' });
    expect(offers(html, 'writeoff')).toEqual({ values: ['create', PROMO.id], selected: 'create' });
    expect(button(html)).not.toContain('disabled');
  });

  it('offers Change accounts and Split write-offs by reason as dropdowns of names, by type', () => {
    const html = render(setup([AR, PREPAID, PROMO, MISC]));
    expect(html).toContain('<summary>Change accounts</summary>');
    expect(html).toContain('<summary>Split write-offs by reason</summary>');
    expect(offers(html, 'ar')).toEqual({ values: [AR.id], selected: AR.id });
    // Each row lists only what a map accepts there: Other Current Asset for
    // the deductions held, Expense and Other Expense for a write-off.
    expect(offers(html, 'deductionsReceivable').values).toEqual(['create', PREPAID.id]);
    expect(offers(html, 'writeoff').values).toEqual(['create', MISC.id, PROMO.id]);
    for (const family of [...REASON_FAMILIES, 'unclassified']) {
      expect(offers(html, `split_${family}`), family).toEqual({
        values: ['same', 'create', MISC.id, PROMO.id],
        selected: 'same',
      });
    }
    expect(text(html)).toContain('Miscellaneous Losses');
  });

  it('leaves the receivable to the owner when there are several, with no default', () => {
    const html = render(setup([AR, AR_TWO, PREPAID, PROMO]));
    expect(offers(html, 'ar')).toEqual({ values: ['', AR_TWO.id, AR.id], selected: '' });
    expect(select(html, 'ar')).toContain('<option value="" disabled="" selected="">Choose an account</option>');
    expect(html.match(/name="ar"/g)).toHaveLength(1);
    expect(button(html)).not.toContain('disabled');
  });

  it('turns the button off, and says why, when the company has no receivable account', () => {
    const html = render(setup([{ ...AR, active: false }, PREPAID, PROMO]));
    expect(button(html)).toContain('disabled=""');
    expect(text(html)).toContain(
      'Your QuickBooks company has no active Accounts Receivable account, and we never create one.',
    );
    expect(html).not.toContain('<details');
  });

  it.each([
    [
      'an inactive account holds our name',
      [AR, { ...OURS_DR, active: false }, PROMO],
      'Not set: an inactive account in your QuickBooks is named Deductions Receivable',
      'We never reactivate an account',
    ],
    [
      'an account of another type holds our name',
      [AR, PREPAID, { ...OURS_WO, accountType: 'Income' }],
      'Not set: an account named Customer Deductions is in your QuickBooks and is not an Expense or Other Expense account',
      'We never change an account',
    ],
  ])('turns the button off, and says why, when %s', (_what, chart, row, why) => {
    const html = render(setup(chart));
    expect(button(html)).toContain('disabled=""');
    expect(text(html)).toContain(row);
    expect(text(html)).toContain(why);
    expect(html).not.toContain('<details');
  });

  it('says why nothing is proposed when QuickBooks cannot be read, and offers no button', () => {
    const unreadable = render(setup('unreadable'));
    expect(text(unreadable)).toContain('QuickBooks could not be read just now, so there is nothing to propose yet.');
    expect(unreadable).not.toContain('/settings/quickbooks/setup');
    const unconfigured = render(setup('not_configured'));
    expect(text(unconfigured)).toContain('This deployment cannot reach QuickBooks for this company');
    expect(unconfigured).not.toContain('<button');
  });

  it('says which two accounts we may create, and that we change none', () => {
    const said = text(render(setup([AR])));
    expect(said).toContain('The only accounts we ever create are Deductions Receivable and Customer Deductions');
    expect(said).toContain('We never change or delete an account.');
    // A count we could not keep is not promised: an account renamed after we
    // made it, with its answer lost, is one a later create cannot see.
    expect(said).not.toMatch(/at most two|never made twice/);
  });
});

describe('with a map saved: the switch, and the map by name', () => {
  it('shows the accounts by name and changes them by dropdown, never by a typed id', () => {
    const html = render(setup([AR, PREPAID, PROMO, OURS_DR, OURS_WO], { map: saved(), postingEnabled: true }));
    const said = text(html);
    expect(said).toContain('posting is on');
    expect(said).toContain('Receivable Trade Receivables');
    expect(said).toContain('Deductions held Deductions Receivable');
    expect(said).toContain('Write-offs Customer Deductions, for every reason');
    expect(html).toMatch(/<form[^>]* action="\/settings\/quickbooks\/posting" method="post"/);
    expect(said).toContain('Turn posting off');
    expect(html).toMatch(/<form action="\/settings\/quickbooks\/account-map" method="post">/);
    expect(offers(html, 'arAccountId')).toEqual({ values: [AR.id], selected: AR.id });
    expect(offers(html, 'deductionsReceivableAccountId')).toEqual({
      values: [OURS_DR.id, PREPAID.id],
      selected: OURS_DR.id,
    });
    for (const family of REASON_FAMILIES) {
      expect(offers(html, `writeoff_${family}`).selected, family).toBe(OURS_WO.id);
    }
    expect(offers(html, 'unclassifiedWriteoff').selected).toBe(OURS_WO.id);
    // The raw-id form is gone: every input is a hidden one.
    for (const input of html.match(/<input[^>]*>/g) ?? []) expect(input).toContain('type="hidden"');
    expect(html).not.toMatch(/inputmode/i);
    expect(html).not.toContain('/settings/quickbooks/setup');
  });

  it('asks again for a saved account the chart no longer lists as active, and shows no id', () => {
    const html = render(setup([AR, PREPAID, PROMO], { map: saved({ deductionsReceivableAccountId: '7999' }) }));
    expect(text(html)).toContain('Deductions held an account QuickBooks no longer lists as active');
    expect(offers(html, 'deductionsReceivableAccountId')).toEqual({ values: ['', PREPAID.id], selected: '' });
    expect(text(html)).toContain('Turn posting on');
  });

  it('says a map split by reason is split', () => {
    const map = saved({ writeoffByFamily: { ...saved().writeoffByFamily, freight: MISC.id } });
    const html = render(setup([AR, OURS_DR, OURS_WO, MISC], { map }));
    expect(text(html)).toContain('split by reason across 2 accounts');
    expect(offers(html, 'writeoff_freight').selected).toBe(MISC.id);
  });

  it('keeps the switch when QuickBooks cannot be read, and offers no change', () => {
    const html = render(setup('unreadable', { map: saved(), postingEnabled: true }));
    expect(text(html)).toContain('Turn posting off');
    expect(text(html)).toContain('its accounts cannot be changed here');
    expect(html).not.toContain('/settings/quickbooks/account-map');
  });
});

describe('an account id is never text on the page', () => {
  it.each([
    ['everything found', setup([AR, AR_TWO, PREPAID, PROMO, MISC, OURS_DR, OURS_WO])],
    ['everything to create', setup([AR, PREPAID, PROMO, MISC])],
    ['a name held', setup([AR, { ...OURS_DR, active: false }, PROMO])],
    ['a map saved', setup([AR, PREPAID, PROMO, MISC, OURS_DR, OURS_WO], { map: saved() })],
  ])('%s', (_what, connection) => {
    const said = text(render(connection));
    for (const id of IDS) expect(said, id).not.toContain(id);
  });
});

describe('the page', () => {
  const owner: Viewer = { email: 'owner@example.test', orgName: 'Acme', role: 'owner' };
  const analyst: Viewer = { email: 'analyst@example.test', orgName: 'Acme', role: 'analyst' };

  it('carries the posting card only when it is handed one', () => {
    const page = (posting?: readonly PostingConnectionSetup[]) =>
      renderToStaticMarkup(
        <LedgerConnectionPage
          viewer={owner}
          connections={[]}
          mayConnect
          deployment={{ environment: 'sandbox' }}
          today={new Date('2026-09-27T12:00:00Z')}
          posts
          posting={posting}
        />,
      );
    expect(page()).not.toContain('Posting to QuickBooks');
    const html = page([setup([AR, PREPAID, PROMO])]);
    expect(html).toContain('Posting to QuickBooks');
    expect(html).toContain('Turn on posting');
  });

  it('says the company is written to wherever this deployment posts, to every member, and never written to where it does not', () => {
    const page = (viewer: Viewer, posts: boolean) =>
      text(
        renderToStaticMarkup(
          <LedgerConnectionPage
            viewer={viewer}
            connections={[]}
            mayConnect={viewer.role === 'owner'}
            deployment={{ environment: 'production' }}
            today={new Date('2026-09-27T12:00:00Z')}
            posts={posts}
          />,
        ),
      );
    for (const viewer of [owner, analyst]) {
      const posting = page(viewer, true);
      expect(posting, viewer.role).toContain(
        'read once a day, and written to only if an owner turns posting on: then we create only the two ' +
          'accounts posting needs, and send nothing for a case until a second person approves it.',
      );
      expect(posting, viewer.role).not.toContain('never written to');
      expect(page(viewer, false), viewer.role).toContain('read once a day, never written to.');
    }
  });

  it('renders every setup notice in words, and none from the query string', () => {
    const page = (notice: string) =>
      renderToStaticMarkup(
        <LedgerConnectionPage
          viewer={owner}
          connections={[]}
          mayConnect
          deployment={{ environment: 'sandbox' }}
          today={new Date('2026-09-27T12:00:00Z')}
          posts
          notice={notice}
        />,
      );
    expect(text(page('posting_set_up_created_two'))).toContain('we created the two accounts your books were missing');
    expect(text(page('posting_setup_receivable_inactive'))).toContain('We never reactivate an account');
    expect(text(page('posting_setup_busy'))).toContain('another press of Turn on posting is running, so this one did nothing');
    expect(text(page('posting_setup_writeoff_renamed'))).toContain(
      'the Customer Deductions account we set up for this company earlier is still in your QuickBooks',
    );
    expect(text(page('posting_setup_chart_too_large'))).toContain('more accounts than setup reads');
    expect(text(page('posting_setup_unreachable'))).not.toContain('never made twice');
    expect(text(page('posting_setup_writeoff_read_back'))).toContain(
      'QuickBooks created the Customer Deductions account, but it did not read back as we asked for it',
    );
    expect(text(page('posting_setup_receivable_create_refused'))).toContain(
      'QuickBooks refused a request while we were creating the Deductions Receivable account',
    );
    expect(page('posting_setup_<b>x</b>')).not.toContain('<b>x</b>');
  });
});

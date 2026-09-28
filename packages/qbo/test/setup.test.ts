import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { QboClient, assertRequestId, type FetchLike } from '../src/client';
import {
  QboAccountReadBackError,
  QboAuthError,
  QboChartTooLarge,
  QboError,
  QboInvalidAccountSpec,
  QboMalformedResponse,
  QboRateLimited,
  QboRequestFailed,
} from '../src/errors';
import { PostingInputError } from '../src/posting';
import type { JsonObject } from '../src/reader';
import {
  SETUP_ACCOUNTS,
  SETUP_ROWS,
  postingSetupRequestId,
  proposePostingSetup,
  resolveSetupRow,
  type QboAccount,
  type SetupRow,
} from '../src/setup';
import { configFor, fixture, jsonResponse, recordingFetch, startPositionOf, REALM_ID } from './helpers';

// Synthetic fixtures (test/fixtures/posting/README.md): nothing here was recorded.

const CONNECTION = '0b7c4a52-6d7e-4f3a-9c1d-2e5f6a7b8c9d';
const OTHER_CONNECTION = '5d2e8f10-3a4b-4c5d-8e6f-7a8b9c0d1e2f';
const UUID_V8 = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TIME = '2026-09-27T10:00:00.000-07:00';

const AR_TYPES: readonly string[] = ['Accounts Receivable'];
const OCA_TYPES: readonly string[] = ['Other Current Asset'];
const WRITEOFF_TYPES: readonly string[] = ['Expense', 'Other Expense'];
const REUSABLE: Readonly<Record<SetupRow, readonly string[]>> = {
  deductions_receivable: OCA_TYPES,
  writeoff: WRITEOFF_TYPES,
};

/** A chart row as `listAccounts` hands it over. */
function account(
  id: string,
  name: string,
  accountType: string,
  options: { readonly active?: boolean; readonly parent?: string } = {},
): QboAccount {
  return {
    id,
    name,
    fullyQualifiedName: options.parent === undefined ? name : `${options.parent}:${name}`,
    accountType,
    accountSubType: undefined,
    active: options.active ?? true,
  };
}

/** An `Account` row as QuickBooks returns one. */
function accountRow(
  id: string,
  name: string,
  accountType: string,
  options: { readonly active?: boolean; readonly parent?: string; readonly subType?: string } = {},
): Record<string, unknown> {
  return {
    Id: id,
    Name: name,
    SubAccount: options.parent !== undefined,
    FullyQualifiedName: options.parent === undefined ? name : `${options.parent}:${name}`,
    Active: options.active ?? true,
    AccountType: accountType,
    ...(options.subType !== undefined ? { AccountSubType: options.subType } : {}),
  };
}

/**
 * A QuickBooks that makes whatever `POST /account` sends as account `id` and
 * reads it back as `edit` leaves it: an accountant's change, a cached answer
 * for another account, or nothing at all.
 */
function quickBooks(id: string, edit: (account: Record<string, unknown>) => void = () => {}) {
  let stored: Record<string, unknown> = {};
  return recordingFetch((request) => {
    if (request.method === 'POST') {
      const sent = JSON.parse(request.body ?? '') as Record<string, unknown>;
      stored = { ...sent, Id: id, FullyQualifiedName: sent['Name'], SubAccount: false, Active: true };
      return jsonResponse({ Account: stored, time: TIME });
    }
    const readBack = structuredClone(stored);
    edit(readBack);
    return jsonResponse({ Account: readBack, time: TIME });
  });
}

const AR = account('84', 'Accounts Receivable (A/R)', 'Accounts Receivable');
const CHECKING = account('35', 'Checking', 'Bank');
const PREPAID = account('88', 'Prepaid Expenses', 'Other Current Asset');
const ADVERTISING = account('120', 'Advertising', 'Expense');
const PENALTIES = account('131', 'Penalties & Settlements', 'Other Expense');
/** A company with one A/R account and neither account setup creates. */
const COMPANY: readonly QboAccount[] = [AR, CHECKING, PREPAID, ADVERTISING, PENALTIES];

describe('the two accounts setup may create', () => {
  it('are fixed: a name, a type and a detail type each, and never an A/R account', () => {
    expect(SETUP_ROWS).toEqual(['deductions_receivable', 'writeoff']);
    expect(SETUP_ACCOUNTS).toEqual({
      deductions_receivable: {
        name: 'Deductions Receivable',
        accountType: 'Other Current Asset',
        accountSubType: 'OtherCurrentAssets',
      },
      writeoff: {
        name: 'Customer Deductions',
        accountType: 'Expense',
        accountSubType: 'OtherMiscellaneousServiceCost',
      },
    });
    // What createAccount sends is compared against these, so nothing may move them.
    expect(Object.isFrozen(SETUP_ACCOUNTS)).toBe(true);
    expect(Object.isFrozen(SETUP_ACCOUNTS.deductions_receivable)).toBe(true);
    expect(Object.isFrozen(SETUP_ACCOUNTS.writeoff)).toBe(true);
  });
});

describe('postingSetupRequestId', () => {
  it('is UUID-shaped, version 8, and taken as a request id', () => {
    for (const row of SETUP_ROWS) {
      for (const attempt of [0, 1, 7]) {
        const id = postingSetupRequestId(CONNECTION, row, attempt);
        expect(id).toMatch(UUID_V8);
        expect(assertRequestId(id)).toBe(id);
      }
    }
  });

  it('is the same request every time one attempt is asked for, however the connection id is spelt', () => {
    expect(postingSetupRequestId(CONNECTION, 'writeoff', 0)).toBe(
      postingSetupRequestId(CONNECTION, 'writeoff', 0),
    );
    expect(postingSetupRequestId(CONNECTION.toUpperCase(), 'writeoff', 0)).toBe(
      postingSetupRequestId(CONNECTION, 'writeoff', 0),
    );
    expect(postingSetupRequestId(CONNECTION.toUpperCase(), 'writeoff', 1)).toBe(
      postingSetupRequestId(CONNECTION, 'writeoff', 1),
    );
  });

  it('is pinned: a changed derivation would make the next press a new request to Intuit', () => {
    // A first attempt is named by its connection and row alone, as every
    // create was before attempts were counted.
    expect(postingSetupRequestId(CONNECTION, 'deductions_receivable', 0)).toBe(
      '94fc375f-866b-81ae-bee4-15e8f55fb5a8',
    );
    expect(postingSetupRequestId(CONNECTION, 'writeoff', 0)).toBe(
      '9f848136-26c2-8fc4-ad1f-554cee987a4b',
    );
    expect(postingSetupRequestId(CONNECTION, 'deductions_receivable', 1)).toBe(
      'b8e1bd2b-3b42-801a-90f0-b32915d5efc4',
    );
    expect(postingSetupRequestId(CONNECTION, 'writeoff', 1)).toBe(
      'a80311ed-f029-848d-aa74-694862effb09',
    );
  });

  it('differs by row, by connection and by attempt', () => {
    const ids = [CONNECTION, OTHER_CONNECTION].flatMap((connection) =>
      SETUP_ROWS.flatMap((row) => [0, 1, 2].map((attempt) => postingSetupRequestId(connection, row, attempt))),
    );
    expect(new Set(ids).size).toBe(12);

    fc.assert(
      fc.property(fc.uuid(), fc.uuid(), fc.nat({ max: 1_000 }), fc.nat({ max: 1_000 }), (a, b, m, n) => {
        fc.pre(a.toLowerCase() !== b.toLowerCase() && m !== n);
        const eight = [a, b].flatMap((connection) =>
          SETUP_ROWS.flatMap((row) => [m, n].map((attempt) => postingSetupRequestId(connection, row, attempt))),
        );
        expect(new Set(eight).size).toBe(8);
        for (const id of eight) expect(id).toMatch(UUID_V8);
      }),
    );
  });

  it('refuses a connection id that is not a UUID, a row setup does not have, and an attempt that is not a count', () => {
    // A realm id is the likeliest wrong argument, and a different key per
    // company rather than per connection.
    expect(() => postingSetupRequestId(REALM_ID, 'writeoff', 0)).toThrow(PostingInputError);
    expect(() => postingSetupRequestId(`${CONNECTION}'`, 'writeoff', 0)).toThrow(PostingInputError);
    expect(() => postingSetupRequestId(CONNECTION, 'ar' as SetupRow, 0)).toThrow(PostingInputError);
    for (const attempt of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => postingSetupRequestId(CONNECTION, 'writeoff', attempt)).toThrow(PostingInputError);
    }
  });
});

describe('resolveSetupRow', () => {
  it('creates a row whose name no account holds', () => {
    expect(resolveSetupRow(COMPANY, 'deductions_receivable')).toEqual({ kind: 'create' });
    expect(resolveSetupRow(COMPANY, 'writeoff')).toEqual({ kind: 'create' });
    expect(resolveSetupRow([], 'writeoff')).toEqual({ kind: 'create' });
  });

  it('reuses an active account with the exact name and the right type', () => {
    const chart = [
      ...COMPANY,
      account('4001', 'Deductions Receivable', 'Other Current Asset'),
      account('4002', 'Customer Deductions', 'Expense'),
    ];
    expect(resolveSetupRow(chart, 'deductions_receivable')).toEqual({
      kind: 'existing',
      accountId: '4001',
    });
    expect(resolveSetupRow(chart, 'writeoff')).toEqual({ kind: 'existing', accountId: '4002' });
  });

  it('matches the name in any case', () => {
    const chart = [
      ...COMPANY,
      account('4001', 'DEDUCTIONS RECEIVABLE', 'Other Current Asset'),
      account('4002', 'customer deductions', 'Expense'),
    ];
    expect(resolveSetupRow(chart, 'deductions_receivable')).toEqual({
      kind: 'existing',
      accountId: '4001',
    });
    expect(resolveSetupRow(chart, 'writeoff')).toEqual({ kind: 'existing', accountId: '4002' });
  });

  it('reuses an Other Expense account for write-offs, though what it creates is an Expense', () => {
    const chart = [...COMPANY, account('4002', 'Customer Deductions', 'Other Expense')];
    expect(resolveSetupRow(chart, 'writeoff')).toEqual({ kind: 'existing', accountId: '4002' });
    expect(SETUP_ACCOUNTS.writeoff.accountType).toBe('Expense');
  });

  it('stops on a name held by an account of the wrong type, and names it', () => {
    expect(
      resolveSetupRow(
        [...COMPANY, account('4001', 'Deductions Receivable', 'Accounts Receivable')],
        'deductions_receivable',
      ),
    ).toEqual({ kind: 'blocked', reason: 'name_taken_wrong_type', accountId: '4001' });
    // An expense type is right for a write-off, not for the asset.
    expect(
      resolveSetupRow(
        [...COMPANY, account('4001', 'Deductions Receivable', 'Other Expense')],
        'deductions_receivable',
      ),
    ).toEqual({ kind: 'blocked', reason: 'name_taken_wrong_type', accountId: '4001' });
    expect(
      resolveSetupRow(
        [...COMPANY, account('4002', 'Customer Deductions', 'Cost of Goods Sold')],
        'writeoff',
      ),
    ).toEqual({ kind: 'blocked', reason: 'name_taken_wrong_type', accountId: '4002' });
  });

  it('stops on a name held by an inactive account, even one of the right type', () => {
    for (const accountType of ['Other Current Asset', 'Bank']) {
      expect(
        resolveSetupRow(
          [...COMPANY, account('4001', 'Deductions Receivable', accountType, { active: false })],
          'deductions_receivable',
        ),
      ).toEqual({ kind: 'blocked', reason: 'name_taken_inactive', accountId: '4001' });
    }
  });

  it('reuses what it may before stopping on what is in the way, and names an active account in the way first', () => {
    const inactive = account('50', 'Deductions Receivable', 'Other Current Asset', { active: false });
    const wrongType = account('60', 'deductions receivable', 'Bank');
    const right = account('4001', 'Deductions Receivable', 'Other Current Asset');
    expect(resolveSetupRow([inactive, wrongType, right], 'deductions_receivable')).toEqual({
      kind: 'existing',
      accountId: '4001',
    });
    expect(resolveSetupRow([inactive, wrongType], 'deductions_receivable')).toEqual({
      kind: 'blocked',
      reason: 'name_taken_wrong_type',
      accountId: '60',
    });
  });

  it('does not take a sub-account with the same last name for the account it would create', () => {
    const chart = [
      ...COMPANY,
      account('4001', 'Deductions Receivable', 'Other Current Asset', { parent: 'Assets' }),
      account('4002', 'Customer Deductions', 'Bank', { parent: 'Deductions', active: false }),
    ];
    // Neither reused nor in the way: `Assets:Deductions Receivable` is another account.
    expect(resolveSetupRow(chart, 'deductions_receivable')).toEqual({ kind: 'create' });
    expect(resolveSetupRow(chart, 'writeoff')).toEqual({ kind: 'create' });
  });

  it('names the lowest id of several, whatever order the chart came in', () => {
    const newer = account('4001', 'Deductions Receivable', 'Other Current Asset');
    const older = account('999', 'deductions receivable', 'Other Current Asset');
    for (const chart of [
      [newer, older],
      [older, newer],
    ]) {
      expect(resolveSetupRow(chart, 'deductions_receivable')).toEqual({
        kind: 'existing',
        accountId: '999',
      });
    }
  });

  it('refuses a list that is not a chart, and a row setup does not have', () => {
    expect(() => resolveSetupRow([AR, { ...PREPAID, id: '84' }], 'writeoff')).toThrow(
      PostingInputError,
    );
    expect(() => resolveSetupRow([{ ...AR, id: "84' or '1'='1" }], 'writeoff')).toThrow(
      PostingInputError,
    );
    expect(() => resolveSetupRow(COMPANY, 'ar' as SetupRow)).toThrow(PostingInputError);
  });
});

describe('proposePostingSetup', () => {
  it('proposes the one active A/R account and the two accounts to create', () => {
    expect(proposePostingSetup(COMPANY)).toEqual({
      ar: { kind: 'existing', accountId: '84' },
      deductionsReceivable: { kind: 'create' },
      writeoff: { kind: 'create' },
      options: {
        ar: [AR],
        otherCurrentAsset: [PREPAID],
        expense: [ADVERTISING, PENALTIES],
      },
    });
  });

  it('asks the owner to choose between two active A/R accounts, and counts no inactive one', () => {
    const distributors = account('85', 'A/R - Distributors', 'Accounts Receivable');
    const retired = account('86', 'Old A/R', 'Accounts Receivable', { active: false });

    const two = proposePostingSetup([...COMPANY, distributors, retired]);
    expect(two.ar).toEqual({ kind: 'choose' });
    expect(two.options.ar).toEqual([distributors, AR]);

    expect(proposePostingSetup([...COMPANY, retired]).ar).toEqual({
      kind: 'existing',
      accountId: '84',
    });
  });

  it('says A/R is missing when no active A/R account exists, and has nothing to create for it', () => {
    const noAr = COMPANY.filter((row) => row !== AR);
    for (const chart of [
      noAr,
      [...noAr, account('86', 'Old A/R', 'Accounts Receivable', { active: false })],
    ]) {
      const proposal = proposePostingSetup(chart);
      expect(proposal.ar).toEqual({ kind: 'missing' });
      expect(proposal.options.ar).toEqual([]);
    }
  });

  it('finds what an earlier press created, and creates nothing twice', () => {
    const proposal = proposePostingSetup([
      ...COMPANY,
      account('4001', 'Deductions Receivable', 'Other Current Asset'),
      account('4002', 'Customer Deductions', 'Expense'),
    ]);
    expect(proposal.deductionsReceivable).toEqual({ kind: 'existing', accountId: '4001' });
    expect(proposal.writeoff).toEqual({ kind: 'existing', accountId: '4002' });
  });

  it('carries a blocked row as it is, and offers the account in the way in no dropdown', () => {
    const proposal = proposePostingSetup([
      ...COMPANY,
      account('4001', 'Deductions Receivable', 'Other Current Asset', { active: false }),
    ]);
    expect(proposal.deductionsReceivable).toEqual({
      kind: 'blocked',
      reason: 'name_taken_inactive',
      accountId: '4001',
    });
    expect(proposal.options.otherCurrentAsset.map((row) => row.id)).toEqual(['88']);
  });

  it('offers only active accounts of each row\'s types, sorted by full name, sub-accounts under their parent', () => {
    const proposal = proposePostingSetup([
      account('201', 'zeta', 'Expense'),
      account('202', 'Freight', 'Expense', { parent: 'Deductions' }),
      account('203', 'Alpha', 'Expense'),
      account('204', 'Retired', 'Expense', { active: false }),
      account('205', 'Deductions', 'Expense'),
      account('206', 'Fines', 'Other Expense'),
      account('207', 'Sales', 'Income'),
      account('208', 'Inventory Asset', 'Other Current Asset'),
      account('209', 'Undeposited Funds', 'Other Current Asset', { active: false }),
      // Case aside, as a person reads a list: `bravo` before `Deductions`.
      account('210', 'bravo', 'Expense'),
    ]);
    expect(proposal.options.expense.map((row) => row.fullyQualifiedName)).toEqual([
      'Alpha',
      'bravo',
      'Deductions',
      'Deductions:Freight',
      'Fines',
      'zeta',
    ]);
    expect(proposal.options.otherCurrentAsset.map((row) => row.id)).toEqual(['208']);
    expect(proposal.options.ar).toEqual([]);
  });

  it('refuses a list that is not a chart', () => {
    expect(() => proposePostingSetup([AR, { ...ADVERTISING, id: '84' }])).toThrow(
      PostingInputError,
    );
  });
});

describe('proposePostingSetup over any chart', () => {
  const TYPES = [
    'Accounts Receivable',
    'Other Current Asset',
    'Expense',
    'Other Expense',
    'Bank',
    'Income',
    'Cost of Goods Sold',
    'Accounts Payable',
  ];
  const NAMES = [
    'Deductions Receivable',
    'deductions receivable',
    'DEDUCTIONS RECEIVABLE',
    'Deductions Receivable (deleted)',
    'Customer Deductions',
    'customer deductions',
    'CUSTOMER DEDUCTIONS',
    'Accounts Receivable (A/R)',
    'Prepaid Expenses',
    'Freight',
  ];

  /** Charts with unique ids, drawn so the setup names, sub-accounts and inactive accounts all turn up. */
  const charts: fc.Arbitrary<QboAccount[]> = fc
    .array(
      fc.record({
        name: fc.constantFrom(...NAMES),
        parent: fc.constantFrom<string | undefined>(undefined, 'Assets', 'Deductions'),
        accountType: fc.constantFrom(...TYPES),
        active: fc.boolean(),
      }),
      { maxLength: 30 },
    )
    .map((rows) =>
      rows.map((row, index) =>
        account(String(100 + index * 7), row.name, row.accountType, {
          active: row.active,
          ...(row.parent !== undefined ? { parent: row.parent } : {}),
        }),
      ),
    );

  it('never proposes an inactive account, or one of the wrong type', () => {
    fc.assert(
      fc.property(charts, (chart) => {
        const byId = new Map(chart.map((row) => [row.id, row]));
        const proposal = proposePostingSetup(chart);

        const proposed: { readonly id: string; readonly types: readonly string[] }[] = [
          ...proposal.options.ar.map((row) => ({ id: row.id, types: AR_TYPES })),
          ...proposal.options.otherCurrentAsset.map((row) => ({ id: row.id, types: OCA_TYPES })),
          ...proposal.options.expense.map((row) => ({ id: row.id, types: WRITEOFF_TYPES })),
        ];
        if (proposal.ar.kind === 'existing') {
          proposed.push({ id: proposal.ar.accountId, types: AR_TYPES });
        }
        if (proposal.deductionsReceivable.kind === 'existing') {
          proposed.push({ id: proposal.deductionsReceivable.accountId, types: OCA_TYPES });
        }
        if (proposal.writeoff.kind === 'existing') {
          proposed.push({ id: proposal.writeoff.accountId, types: WRITEOFF_TYPES });
        }

        for (const { id, types } of proposed) {
          const found = byId.get(id);
          expect(found?.active).toBe(true);
          expect(types).toContain(found?.accountType);
        }

        // And every account a dropdown could offer, it does.
        const offered = (types: readonly string[]) =>
          chart
            .filter((row) => row.active && types.includes(row.accountType))
            .map((row) => row.id)
            .sort();
        expect(proposal.options.ar.map((row) => row.id).sort()).toEqual(offered(AR_TYPES));
        expect(proposal.options.otherCurrentAsset.map((row) => row.id).sort()).toEqual(
          offered(OCA_TYPES),
        );
        expect(proposal.options.expense.map((row) => row.id).sort()).toEqual(
          offered(WRITEOFF_TYPES),
        );
        expect(proposal.ar.kind).toBe(
          proposal.options.ar.length === 0
            ? 'missing'
            : proposal.options.ar.length === 1
              ? 'existing'
              : 'choose',
        );
      }),
    );
  });

  it('creates only a name nobody holds, and stops only when nothing it may reuse holds it', () => {
    fc.assert(
      fc.property(charts, (chart) => {
        for (const row of SETUP_ROWS) {
          const name = SETUP_ACCOUNTS[row].name.toLowerCase();
          // Held by a top-level account: its full name is the name itself.
          const holders = chart.filter((acct) => acct.fullyQualifiedName.toLowerCase() === name);
          const reusable = holders.filter(
            (acct) => acct.active && REUSABLE[row].includes(acct.accountType),
          );
          const resolution = resolveSetupRow(chart, row);
          switch (resolution.kind) {
            case 'create':
              expect(holders).toEqual([]);
              break;
            case 'existing':
              expect(reusable.map((acct) => acct.id)).toContain(resolution.accountId);
              break;
            case 'blocked':
              expect(reusable).toEqual([]);
              expect(holders.map((acct) => acct.id)).toContain(resolution.accountId);
              expect(resolution.reason).toBe(
                holders.some((acct) => acct.active) ? 'name_taken_wrong_type' : 'name_taken_inactive',
              );
              break;
          }
        }
      }),
    );
  });

  it('does not depend on the order the chart was listed in', () => {
    fc.assert(
      fc.property(
        charts.chain((chart) =>
          fc.tuple(
            fc.constant(chart),
            fc.shuffledSubarray(chart, { minLength: chart.length, maxLength: chart.length }),
          ),
        ),
        ([chart, shuffled]) => {
          expect(proposePostingSetup(shuffled)).toEqual(proposePostingSetup(chart));
        },
      ),
    );
  });
});

describe('QboClient.listAccounts', () => {
  it('reads the whole chart, inactive accounts included, page by page', async () => {
    const pages = [
      [
        accountRow('84', 'Accounts Receivable (A/R)', 'Accounts Receivable', {
          subType: 'AccountsReceivable',
        }),
        accountRow('90', 'Deductions Receivable', 'Other Current Asset', {
          active: false,
          subType: 'OtherCurrentAssets',
        }),
      ],
      [
        accountRow('91', 'Freight', 'Expense', { parent: 'Deductions' }),
        accountRow('92', 'Customer Deductions', 'Expense', {
          subType: 'OtherMiscellaneousServiceCost',
        }),
      ],
    ];
    const recorder = recordingFetch(({ statement }) => {
      const page = pages[((startPositionOf(statement) ?? 1) - 1) / 2];
      return jsonResponse({ QueryResponse: page === undefined ? {} : { Account: page } });
    });

    const accounts = await new QboClient(
      configFor(recorder.fetchImpl, undefined, { pageSize: 2 }),
    ).listAccounts();

    expect(recorder.calls.map((call) => call.statement)).toEqual([
      'select * from Account where Active in (true, false) STARTPOSITION 1 MAXRESULTS 2',
      'select * from Account where Active in (true, false) STARTPOSITION 3 MAXRESULTS 2',
      'select * from Account where Active in (true, false) STARTPOSITION 5 MAXRESULTS 2',
    ]);
    expect(recorder.calls.every((call) => call.method === 'GET')).toBe(true);
    expect(new URL(recorder.calls[0]!.url).pathname).toBe(`/v3/company/${REALM_ID}/query`);
    // A read never shares an idempotency key: each page is its own request.
    expect(new Set(recorder.calls.map((call) => call.headers.get('Request-Id'))).size).toBe(3);

    expect(accounts).toStrictEqual([
      {
        id: '84',
        name: 'Accounts Receivable (A/R)',
        fullyQualifiedName: 'Accounts Receivable (A/R)',
        accountType: 'Accounts Receivable',
        accountSubType: 'AccountsReceivable',
        active: true,
      },
      {
        id: '90',
        name: 'Deductions Receivable',
        fullyQualifiedName: 'Deductions Receivable',
        accountType: 'Other Current Asset',
        accountSubType: 'OtherCurrentAssets',
        active: false,
      },
      {
        id: '91',
        name: 'Freight',
        fullyQualifiedName: 'Deductions:Freight',
        accountType: 'Expense',
        accountSubType: undefined,
        active: true,
      },
      {
        id: '92',
        name: 'Customer Deductions',
        fullyQualifiedName: 'Customer Deductions',
        accountType: 'Expense',
        accountSubType: 'OtherMiscellaneousServiceCost',
        active: true,
      },
    ]);
  });

  it('refuses by name a chart that has not ended by the pages its client allows, and reads no further', async () => {
    const chart = ['1', '2', '3', '4', '5'].map((id) => accountRow(id, `Account ${id}`, 'Expense'));
    const pagesOf = (rows: readonly Record<string, unknown>[]) =>
      recordingFetch(({ statement }) => {
        const start = (startPositionOf(statement) ?? 1) - 1;
        return jsonResponse({ QueryResponse: { Account: rows.slice(start, start + 2) } });
      });
    const bounded = { pageSize: 2, maxPages: 2 };

    const long = pagesOf(chart);
    const error = await new QboClient(configFor(long.fetchImpl, undefined, bounded))
      .listAccounts()
      .catch((caught: unknown) => caught);
    // Not a malformed answer, and never the part of the chart that was read:
    // a name missing from part of a chart is not missing from the company.
    expect(error).toBeInstanceOf(QboChartTooLarge);
    expect(error).toBeInstanceOf(QboError);
    expect(error).not.toBeInstanceOf(QboMalformedResponse);
    expect((error as QboChartTooLarge).name).toBe('QboChartTooLarge');
    expect((error as Error).message).toBe('the chart of accounts did not end within 2 pages of 2 accounts');
    expect(long.calls).toHaveLength(2);

    // A chart that ends on the last page allowed is read whole, in as many requests.
    const short = pagesOf(chart.slice(0, 3));
    const accounts = await new QboClient(configFor(short.fetchImpl, undefined, bounded)).listAccounts();
    expect(accounts.map((acct) => acct.id)).toEqual(['1', '2', '3']);
    expect(short.calls).toHaveLength(2);
  });

  it('reads an empty chart as no accounts, in one request', async () => {
    const recorder = recordingFetch(() => jsonResponse({ QueryResponse: {} }));
    await expect(new QboClient(configFor(recorder.fetchImpl)).listAccounts()).resolves.toEqual([]);
    expect(recorder.calls).toHaveLength(1);
  });

  it('refuses a row it cannot read, naming the field, rather than defaulting it', async () => {
    const base = accountRow('84', 'Accounts Receivable (A/R)', 'Accounts Receivable');
    const without = (key: string) => Object.fromEntries(Object.entries(base).filter(([k]) => k !== key));
    const cases: readonly (readonly [Record<string, unknown>, string])[] = [
      [{ ...base, Id: "84' or '1'='1" }, 'Account[0].Id'],
      [{ ...base, Id: 84 }, 'Account[0].Id'],
      [{ ...base, Active: 'true' }, 'Account[0].Active'],
      [without('Active'), 'Account[0].Active'],
      [without('AccountType'), 'Account[0].AccountType'],
      [without('FullyQualifiedName'), 'Account[0].FullyQualifiedName'],
      [without('Name'), 'Account[0].Name'],
    ];
    for (const [row, fieldPath] of cases) {
      const recorder = recordingFetch(() => jsonResponse({ QueryResponse: { Account: [row] } }));
      const error = await new QboClient(configFor(recorder.fetchImpl))
        .listAccounts()
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(QboMalformedResponse);
      expect((error as QboMalformedResponse).fieldPath).toBe(fieldPath);
    }
  });

  it('refuses an account listed twice rather than counting it twice', async () => {
    const pages = [
      [accountRow('84', 'Accounts Receivable (A/R)', 'Accounts Receivable'), accountRow('90', 'Checking', 'Bank')],
      [accountRow('84', 'Accounts Receivable (A/R)', 'Accounts Receivable')],
    ];
    const recorder = recordingFetch(({ statement }) => {
      const page = pages[((startPositionOf(statement) ?? 1) - 1) / 2];
      return jsonResponse({ QueryResponse: page === undefined ? {} : { Account: page } });
    });
    const error = await new QboClient(configFor(recorder.fetchImpl, undefined, { pageSize: 2 }))
      .listAccounts()
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(QboMalformedResponse);
    expect((error as QboMalformedResponse).fieldPath).toBe('Account[2].Id');
  });
});

describe('QboClient.createAccount', () => {
  it('sends exactly the fixed name, type and detail type under the given request id, then reads the account back by its id', async () => {
    const recorder = recordingFetch(() => jsonResponse(fixture('posting/account-created.json')));
    const requestId = postingSetupRequestId(CONNECTION, 'deductions_receivable', 0);

    const created = await new QboClient(configFor(recorder.fetchImpl)).createAccount(
      SETUP_ACCOUNTS.deductions_receivable,
      requestId,
    );

    expect(created).toStrictEqual({
      id: '4001',
      name: 'Deductions Receivable',
      fullyQualifiedName: 'Deductions Receivable',
      accountType: 'Other Current Asset',
      accountSubType: 'OtherCurrentAssets',
      active: true,
    });
    expect(recorder.calls.map((call) => call.method)).toEqual(['POST', 'GET']);
    const [post, get] = recorder.calls;
    expect(new URL(post!.url).pathname).toBe(`/v3/company/${REALM_ID}/account`);
    expect(new URL(post!.url).searchParams.get('requestid')).toBe(requestId);
    expect(post!.headers.get('Request-Id')).toBe(requestId);
    expect(post!.headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(post!.body ?? '')).toStrictEqual({
      Name: 'Deductions Receivable',
      AccountType: 'Other Current Asset',
      AccountSubType: 'OtherCurrentAssets',
    });
    expect(new URL(get!.url).pathname).toBe(`/v3/company/${REALM_ID}/account/4001`);
    expect(get!.headers.get('Request-Id')).not.toBe(requestId);
    expect(get!.body).toBeUndefined();
  });

  it('creates the write-off account as an Expense, and returns it as read back', async () => {
    // An accountant may change the detail type, and our check reads the type
    // only (ADR 0063): what comes back is what QuickBooks holds now.
    const recorder = quickBooks('4002', (acct) => {
      acct['AccountSubType'] = 'OtherBusinessExpenses';
    });
    const requestId = postingSetupRequestId(CONNECTION, 'writeoff', 0);

    const created = await new QboClient(configFor(recorder.fetchImpl)).createAccount(
      SETUP_ACCOUNTS.writeoff,
      requestId,
    );

    expect(JSON.parse(recorder.calls[0]!.body ?? '')).toStrictEqual({
      Name: 'Customer Deductions',
      AccountType: 'Expense',
      AccountSubType: 'OtherMiscellaneousServiceCost',
    });
    expect(recorder.calls[0]!.headers.get('Request-Id')).toBe(requestId);
    expect(created).toStrictEqual({
      id: '4002',
      name: 'Customer Deductions',
      fullyQualifiedName: 'Customer Deductions',
      accountType: 'Expense',
      accountSubType: 'OtherBusinessExpenses',
      active: true,
    });
  });

  it('throws QboAccountReadBackError naming each field that did not read back as sent, and changes nothing', async () => {
    const cases: readonly (readonly [(acct: Record<string, unknown>) => void, readonly string[]])[] = [
      [(acct) => void (acct['Name'] = 'Holdback - Sysco Baltimore'), ['Name']],
      [(acct) => void (acct['Name'] = 'deductions receivable'), ['Name']],
      [(acct) => void (acct['AccountType'] = 'Bank'), ['AccountType']],
      [(acct) => void (acct['Active'] = false), ['Active']],
      [(acct) => void delete acct['Active'], ['Active']],
      [(acct) => void (acct['Id'] = '4999'), ['Id']],
      [
        (acct) => {
          acct['Name'] = 'Holdback - Sysco Baltimore';
          acct['Active'] = false;
        },
        ['Name', 'Active'],
      ],
    ];
    for (const [edit, mismatch] of cases) {
      const recorder = quickBooks('4001', edit);
      const error = await new QboClient(configFor(recorder.fetchImpl))
        .createAccount(
          SETUP_ACCOUNTS.deductions_receivable,
          postingSetupRequestId(CONNECTION, 'deductions_receivable', 0),
        )
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(QboAccountReadBackError);
      expect(error).toBeInstanceOf(QboError);
      expect((error as QboAccountReadBackError).name).toBe('QboAccountReadBackError');
      expect((error as QboAccountReadBackError).accountId).toBe('4001');
      expect((error as QboAccountReadBackError).mismatch).toEqual(mismatch);
      // Ids and field names only: a name read back is the customer's text.
      expect((error as Error).message).not.toMatch(/Sysco|Holdback|Bank|deductions receivable/);
      // One create and one read: nothing renamed, reactivated or retried.
      expect(recorder.calls.map((call) => call.method)).toEqual(['POST', 'GET']);
    }
  });

  it('refuses, before sending anything, an account setup does not create and a request id that is not a UUID', async () => {
    const recorder = recordingFetch(() => jsonResponse(fixture('posting/account-created.json')));
    const client = new QboClient(configFor(recorder.fetchImpl));
    const requestId = postingSetupRequestId(CONNECTION, 'deductions_receivable', 0);

    for (const spec of [
      { ...SETUP_ACCOUNTS.deductions_receivable, accountType: 'Accounts Receivable' },
      { ...SETUP_ACCOUNTS.deductions_receivable, accountSubType: 'UndepositedFunds' },
      { ...SETUP_ACCOUNTS.writeoff, name: 'customer deductions' },
      { name: 'Accounts Receivable (A/R)', accountType: 'Accounts Receivable', accountSubType: 'AccountsReceivable' },
    ]) {
      await expect(client.createAccount(spec, requestId)).rejects.toThrow(QboInvalidAccountSpec);
    }
    await expect(
      client.createAccount(SETUP_ACCOUNTS.writeoff, 'deductions_receivable'),
    ).rejects.toThrow(/UUID/);
    expect(recorder.calls).toHaveLength(0);
  });

  it('throws a 5xx on the create as it came, retries nothing, and sends the same request when pressed again', async () => {
    let posts = 0;
    const recorder = recordingFetch((request) => {
      if (request.method === 'POST' && (posts += 1) === 1) {
        return jsonResponse({ Fault: { Error: [{ code: '6000' }], type: 'SystemFault' } }, 503);
      }
      return jsonResponse(fixture('posting/account-created.json'));
    });
    const client = new QboClient(configFor(recorder.fetchImpl));
    const requestId = postingSetupRequestId(CONNECTION, 'deductions_receivable', 0);

    const error = await client
      .createAccount(SETUP_ACCOUNTS.deductions_receivable, requestId)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(QboRequestFailed);
    expect((error as QboRequestFailed).status).toBe(503);
    expect(recorder.calls.map((call) => call.method)).toEqual(['POST']);

    // The owner presses again. No answer came, so it is the same attempt, and
    // its request id is derived, not drawn: Intuit sees the same request, and a
    // create that had landed is answered, not repeated.
    await client.createAccount(
      SETUP_ACCOUNTS.deductions_receivable,
      postingSetupRequestId(CONNECTION, 'deductions_receivable', 0),
    );
    const sent = recorder.calls.filter((call) => call.method === 'POST');
    expect(sent.map((call) => call.headers.get('Request-Id'))).toEqual([requestId, requestId]);
    expect(sent.map((call) => new URL(call.url).searchParams.get('requestid'))).toEqual([
      requestId,
      requestId,
    ]);
  });

  it('throws a create that times out as an unknown outcome, and reads nothing back', async () => {
    const sent: string[] = [];
    const hanging: FetchLike = (url, init) => {
      sent.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError')),
        );
      });
    };

    const error = await new QboClient(configFor(hanging, undefined, { timeoutMs: 20 }))
      .createAccount(SETUP_ACCOUNTS.writeoff, postingSetupRequestId(CONNECTION, 'writeoff', 0))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(QboRequestFailed);
    expect((error as QboRequestFailed).status).toBe(0);
    expect((error as Error).message).toMatch(/did not answer within 20ms/);
    expect(sent).toEqual([`POST /v3/company/${REALM_ID}/account`]);
  });

  it('throws a read-back that fails as it came, and sends nothing after it', async () => {
    const recorder = recordingFetch((request) =>
      request.method === 'POST'
        ? jsonResponse(fixture('posting/account-created.json'))
        : jsonResponse({ Fault: { Error: [{ code: '6000' }], type: 'SystemFault' } }, 500),
    );
    const error = await new QboClient(configFor(recorder.fetchImpl))
      .createAccount(
        SETUP_ACCOUNTS.deductions_receivable,
        postingSetupRequestId(CONNECTION, 'deductions_receivable', 0),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(QboRequestFailed);
    expect((error as QboRequestFailed).status).toBe(500);
    expect(recorder.calls.map((call) => call.method)).toEqual(['POST', 'GET']);
  });

  it('keeps a refused sign-in and a rate limit as their own classes', async () => {
    const refused = recordingFetch(() => jsonResponse(fixture('fault-authentication.json'), 401));
    await expect(
      new QboClient(configFor(refused.fetchImpl)).createAccount(
        SETUP_ACCOUNTS.writeoff,
        postingSetupRequestId(CONNECTION, 'writeoff', 0),
      ),
    ).rejects.toThrow(QboAuthError);
    expect(refused.calls).toHaveLength(1);

    const throttled = recordingFetch(() =>
      jsonResponse(fixture('fault-throttled.json'), 429, { 'retry-after': '30' }),
    );
    const error = await new QboClient(configFor(throttled.fetchImpl))
      .createAccount(SETUP_ACCOUNTS.writeoff, postingSetupRequestId(CONNECTION, 'writeoff', 0))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(QboRateLimited);
    expect((error as QboRateLimited).retryAfterMs).toBe(30_000);
    expect(throttled.calls).toHaveLength(1);
  });

  it('refuses a create answered with no id it can read back, and reads nothing', async () => {
    for (const echoed of [
      { Name: 'Deductions Receivable', AccountType: 'Other Current Asset', Active: true },
      { Id: "4001' or '1'='1", Name: 'Deductions Receivable' },
    ] as readonly JsonObject[]) {
      const recorder = recordingFetch(() => jsonResponse({ Account: echoed, time: TIME }));
      const error = await new QboClient(configFor(recorder.fetchImpl))
        .createAccount(
          SETUP_ACCOUNTS.deductions_receivable,
          postingSetupRequestId(CONNECTION, 'deductions_receivable', 0),
        )
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(QboMalformedResponse);
      expect((error as QboMalformedResponse).fieldPath).toBe('Account.Id');
      expect(recorder.calls.map((call) => call.method)).toEqual(['POST']);
    }
  });
});

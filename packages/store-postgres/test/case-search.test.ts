import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  CASE_SEARCH_MAX,
  CASE_SEARCH_QUERY_MAX,
  closeAllPools,
  PostgresStore,
  type CaseSearchResult,
} from '../src/store';

const connectionString = process.env.TEST_DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

/**
 * The case list's search, on Postgres as `app_rw` under RLS.
 *
 * The ledger's table filtered `listCases` in the browser, so a search reached
 * only the newest hundred cases. `searchCases` asks the database instead, and
 * what only the database can answer is here: that a year-old case behind a
 * hundred and five newer ones is found by its claim, by either of its invoices,
 * by its customer and by its id; that a typed `%`, `_` or `\` is a character
 * rather than a wildcard; that another tenant's cases never match and are never
 * counted; and that a `read_only` member gets the same answer.
 */
describeDb('the case search, on Postgres', () => {
  const admin = new Pool({ connectionString });
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const analystId = randomUUID();
  const readerId = randomUUID();
  const suffix = orgId.slice(0, 8).toUpperCase();
  let store: PostgresStore;
  let readOnlyStore: PostgresStore;
  let otherStore: PostgresStore;
  let oldId: string;
  let printedId: string;
  let theirsId: string;
  const literal: Record<string, string> = {};

  async function aCase(
    claimId: string,
    fields: {
      state?: string;
      debtorId?: string;
      printed?: string;
      createdAt?: string;
      org?: string;
    } = {},
  ): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `insert into deductions (org_id, claim_id, deduction_amount_cents, state, debtor_id,
                               retailer_name_as_printed, created_at)
       values ($1, $2, 1000, $3, $4, $5, coalesce($6::timestamptz, now()))
       returning id`,
      [
        fields.org ?? orgId,
        claimId,
        fields.state ?? 'classified',
        fields.debtorId ?? null,
        fields.printed ?? null,
        fields.createdAt ?? null,
      ],
    );
    return rows[0]?.id as string;
  }

  async function anInvoice(
    deductionId: string,
    invoice: string,
    firstSeenAt: string,
    org = orgId,
  ): Promise<void> {
    await admin.query(
      `insert into deduction_identifiers
         (org_id, deduction_id, source, identifier_kind, identifier, first_seen_at)
       values ($1, $2, 'web_upload', 'invoice_number', $3, $4)`,
      [org, deductionId, invoice, firstSeenAt],
    );
  }

  async function aDebtor(org: string, key: string, name: string): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `insert into debtors (org_id, retailer_key, display_name) values ($1, $2, $3) returning id`,
      [org, key, name],
    );
    return rows[0]?.id as string;
  }

  function ids(result: CaseSearchResult): string[] {
    return result.rows.map((row) => row.deductionId);
  }

  beforeAll(async () => {
    for (const [id, slug] of [
      [orgId, `cs-${suffix}`],
      [otherOrgId, `cs-other-${suffix}`],
    ] as const) {
      await admin.query(`insert into organizations (id, slug, name) values ($1,$2,'Search')`, [
        id,
        slug,
      ]);
      await admin.query(`insert into org_settings (org_id) values ($1)`, [id]);
    }
    await admin.query(`insert into users (id, email) values ($1,$2), ($3,$4)`, [
      analystId,
      `cs-a-${suffix}@example.test`,
      readerId,
      `cs-r-${suffix}@example.test`,
    ]);
    await admin.query(
      `insert into memberships (org_id, user_id, role)
       values ($1,$2,'analyst'), ($1,$3,'read_only'), ($4,$2,'analyst')`,
      [orgId, analystId, readerId, otherOrgId],
    );

    const debtor = await aDebtor(orgId, `harbor_${suffix}`, `Harbor Provisions ${suffix}`);
    // A year old: the case a newest-first hundred drops. Two invoices, so a
    // search reaches the one the list does not show as well as the one it does.
    oldId = await aCase(`OLD-${suffix}-4471`, {
      state: 'analyst_review',
      debtorId: debtor,
      createdAt: '2025-09-01T09:00:00Z',
    });
    await anInvoice(oldId, `INV-${suffix}-8812`, '2025-09-01T09:00:00Z');
    await anInvoice(oldId, `INV-${suffix}-8813`, '2025-09-02T09:00:00Z');
    // Also old, with a name nobody has claimed yet (ADR 0019).
    printedId = await aCase(`PRINTED-${suffix}`, {
      printed: `WALMART ${suffix} STORES, INC.`,
      createdAt: '2025-09-02T09:00:00Z',
    });
    // The wildcard characters, each beside the text an unescaped one would match.
    for (const claim of ['10%OFF', '10XOFF', 'A_B', 'AXB', 'C\\D', 'CD']) {
      literal[claim] = await aCase(`LIT-${suffix}-${claim}`, {
        createdAt: '2025-09-03T09:00:00Z',
      });
    }
    // A hundred and five newer cases.
    await admin.query(
      `insert into deductions (org_id, claim_id, deduction_amount_cents, state)
       select $1, 'NEWER-' || $2 || '-' || g, 100, 'lost' from generate_series(1, 105) g`,
      [orgId, suffix],
    );
    // Another tenant's case, answering to every search above.
    const theirDebtor = await aDebtor(otherOrgId, `harbor_${suffix}`, `Harbor Provisions ${suffix}`);
    theirsId = await aCase(`OLD-${suffix}-4471-THEIRS`, {
      org: otherOrgId,
      state: 'analyst_review',
      debtorId: theirDebtor,
      printed: `WALMART ${suffix} STORES, INC.`,
      createdAt: '2025-09-01T09:00:00Z',
    });
    await anInvoice(theirsId, `INV-${suffix}-8812-THEIRS`, '2025-09-01T09:00:00Z', otherOrgId);

    const config = { connectionString: connectionString as string };
    store = new PostgresStore(config, { orgId, userId: analystId });
    readOnlyStore = new PostgresStore(config, { orgId, userId: readerId });
    otherStore = new PostgresStore(config, { orgId: otherOrgId, userId: analystId });
  });

  afterAll(async () => {
    await closeAllPools();
    await store?.close();
    await readOnlyStore?.close();
    await otherStore?.close();
    await admin.end();
  });

  it('finds the case the newest hundred drops, by claim, invoice, customer and id', async () => {
    const newest = await store.listCases();
    expect(newest).toHaveLength(100);
    expect(newest.some((row) => row.deductionId === oldId)).toBe(false);

    for (const query of [
      `old-${suffix}-4471`, // the claim, in any case
      `INV-${suffix}-8812`, // the invoice the list shows
      `inv-${suffix}-8813`, // and the later one it does not
      `harbor provisions ${suffix}`, // the debtor
      oldId.slice(0, 8), // the id, as the list abbreviates it
    ]) {
      const found = await store.searchCases({ query });
      expect(ids(found), query).toEqual([oldId]);
      expect(found.total, query).toBe(1);
    }

    // The same row the list and the case page read.
    const [row] = (await store.searchCases({ query: `OLD-${suffix}-4471` })).rows;
    expect(row).toEqual(await store.caseSummary(oldId));
    expect(row?.invoiceNumber).toBe(`INV-${suffix}-8812`);
    expect(row?.debtorName).toBe(`Harbor Provisions ${suffix}`);
  });

  it('finds a retailer by the name the notice printed', async () => {
    const found = await store.searchCases({ query: `  walmart ${suffix} stores ` });
    expect(ids(found)).toEqual([printedId]);
  });

  it('reads %, _ and \\ as the characters they are', async () => {
    const one = async (query: string) => ids(await store.searchCases({ query }));
    expect(await one(`${suffix}-10%`)).toEqual([literal['10%OFF']]);
    expect(await one(`${suffix}-A_B`)).toEqual([literal['A_B']]);
    expect(await one(`${suffix}-C\\D`)).toEqual([literal['C\\D']]);
    // A lone wildcard is a character nobody's claim contains here.
    expect((await store.searchCases({ query: '%' })).total).toBe(1);
    expect((await store.searchCases({ query: '_' })).total).toBe(1);
  });

  it('filters by state, on its own or with the text', async () => {
    expect(ids(await store.searchCases({ query: suffix, state: 'analyst_review' }))).toEqual([
      oldId,
    ]);
    expect((await store.searchCases({ query: `OLD-${suffix}`, state: 'won' })).total).toBe(0);
    const lost = await store.searchCases({ state: 'lost' });
    expect(lost.total).toBe(105);
    expect(lost.rows).toHaveLength(100);
    expect(lost.rows.every((row) => row.state === 'lost')).toBe(true);
  });

  it('lists the newest matches, newest first, and counts every one', async () => {
    const newer = await store.searchCases({ query: `NEWER-${suffix}-` });
    expect(newer.total).toBe(105);
    expect(newer.rows).toHaveLength(100);
    expect(newer.limit).toBe(100);

    // Nothing asked for is the newest cases, as `listCases` reads them.
    const everything = await store.searchCases();
    expect(everything.total).toBe(113);
    expect(everything.rows).toHaveLength(100);
    expect(everything.rows.some((row) => row.deductionId === oldId)).toBe(false);

    const five = await store.searchCases({ query: `${suffix}`, limit: 5 });
    expect(five.rows).toHaveLength(5);
    expect(five.total).toBe(113);
    const created = five.rows.map((row) => row.createdAt);
    expect(created).toEqual([...created].sort().reverse());
  });

  it('never matches or counts another tenant’s cases', async () => {
    for (const query of [
      `OLD-${suffix}-4471`,
      `INV-${suffix}-8812`,
      `Harbor Provisions ${suffix}`,
      `WALMART ${suffix}`,
      theirsId.slice(0, 8),
    ]) {
      const ours = await store.searchCases({ query });
      expect(ids(ours), query).not.toContain(theirsId);
    }
    expect((await store.searchCases({ query: 'THEIRS' })).total).toBe(0);
    expect((await store.searchCases({ query: theirsId })).total).toBe(0);

    // And theirs finds theirs, and nothing of ours.
    const theirs = await otherStore.searchCases({ query: `OLD-${suffix}-4471` });
    expect(ids(theirs)).toEqual([theirsId]);
    expect((await otherStore.searchCases()).total).toBe(1);
  });

  it('gives a read-only member the same answer', async () => {
    for (const search of [
      { query: `OLD-${suffix}-4471` },
      { query: `INV-${suffix}-8813` },
      { query: `harbor provisions ${suffix}` },
      { query: `NEWER-${suffix}-`, state: 'lost' as const },
      {},
    ]) {
      expect(await readOnlyStore.searchCases(search)).toEqual(await store.searchCases(search));
    }
  });

  it('refuses a limit, a state or a query it was not written for', async () => {
    await expect(store.searchCases({ limit: 0 })).rejects.toBeInstanceOf(RangeError);
    await expect(store.searchCases({ limit: CASE_SEARCH_MAX + 1 })).rejects.toBeInstanceOf(
      RangeError,
    );
    await expect(
      store.searchCases({ state: 'nope' as unknown as 'won' }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      store.searchCases({ query: 'x'.repeat(CASE_SEARCH_QUERY_MAX + 1) }),
    ).rejects.toBeInstanceOf(RangeError);
  });
});

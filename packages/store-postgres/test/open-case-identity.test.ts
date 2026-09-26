import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  AmbiguousIdentityError,
  closeAllPools,
  DuplicateCaseError,
  PostgresStore,
} from '../src/store';

const connectionString = process.env.TEST_DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

/**
 * What `openCase` does with the identifiers a deduction is known by (ADR 0025).
 *
 * The rule under test is asymmetric on purpose. A second case for one deduction
 * is visible — two rows, one claim, and the money is still disputable. A wrong
 * merge is invisible: the arrival vanishes into another deduction's row, nothing
 * records that a second deduction was ever seen, and with post-audit claims
 * reaching back about two years we would find out long after the window closed.
 * So an exact identifier match is refused, two matches are a question for a
 * person, and a probable one opens the case and says so.
 *
 * Everything runs through `PostgresStore` as `app_rw` under the real policies,
 * because "it can only ever see this tenant's identifiers" is a claim about the
 * database and not about our code.
 */
describeDb('openCase: the identifiers a deduction is known by', () => {
  const admin = new Pool({ connectionString });
  const orgId = randomUUID();
  const userId = randomUUID();
  const suffix = orgId.slice(0, 8);
  let store: PostgresStore;
  let walmartId: string;

  beforeAll(async () => {
    await admin.query(`insert into organizations (id, slug, name) values ($1,$2,'Identity')`, [
      orgId,
      `identity-${suffix}`,
    ]);
    await admin.query(`insert into org_settings (org_id) values ($1)`, [orgId]);
    await admin.query(`insert into users (id, email) values ($1,$2)`, [
      userId,
      `identity-${suffix}@example.test`,
    ]);
    await admin.query(`insert into memberships (org_id, user_id, role) values ($1,$2,'analyst')`, [
      orgId,
      userId,
    ]);
    const { rows } = await admin.query<{ id: string }>(
      `insert into debtors (org_id, retailer_key, display_name)
       values ($1, 'walmart_apdp', 'Walmart (APDP)') returning id`,
      [orgId],
    );
    walmartId = rows[0]?.id as string;

    store = new PostgresStore({ connectionString: connectionString as string }, { orgId, userId });
  });

  afterAll(async () => {
    await closeAllPools();
    await store?.close();
    await admin.end();
  });

  async function identifiersFor(deductionId: string) {
    const { rows } = await admin.query<{
      source: string;
      identifier_kind: string;
      identifier: string;
    }>(
      `select source, identifier_kind, identifier from deduction_identifiers
        where deduction_id = $1 order by first_seen_at, id`,
      [deductionId],
    );
    return rows;
  }

  async function eventsFor(deductionId: string, eventType: string) {
    const { rows } = await admin.query<{ payload: Record<string, unknown> }>(
      `select payload from deduction_events
        where deduction_id = $1 and event_type = $2`,
      [deductionId, eventType],
    );
    return rows.map((row) => row.payload);
  }

  it('writes the claim id as an identifier, verbatim and under the notice’s own source', async () => {
    const claimId = `  APDP-${suffix}-Verbatim  `;
    const opened = await store.openCase({
      orgId,
      claimId,
      source: 'email_in',
      retailerName: 'Walmart (APDP)',
      deductionAmountCents: 312_000,
      deductionDate: '2026-08-14',
    });

    const rows = await identifiersFor(opened.deductionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.identifier_kind).toBe('claim_id');
    // The channel the notice arrived through, not the caller's guess at one.
    expect(rows[0]?.source).toBe('email_in');
    // Stored exactly as the page printed it; normalisation is a comparison.
    expect(rows[0]?.identifier).toBe(claimId);
  });

  it('refuses a second arrival of the same claim id, where the unique constraint cannot', async () => {
    // No debtor resolves for this retailer, so `unique (org_id, debtor_id,
    // claim_id)` never fires — null does not compare to null. This used to open
    // a second case silently; the identifier is what catches it now.
    const claimId = `APDP-${suffix}-again`;
    const first = await store.openCase({
      orgId,
      claimId,
      source: 'web_upload',
      retailerName: 'Costco Wholesale Corporation',
      deductionAmountCents: 100,
    });
    expect(first.debtorId).toBeUndefined();

    const again = store.openCase({
      orgId,
      claimId,
      source: 'web_upload',
      retailerName: 'Costco Wholesale Corporation',
      deductionAmountCents: 100,
    });
    await expect(again).rejects.toThrow(DuplicateCaseError);
    // The same sentence the constraint path gives, naming the case that holds it.
    await expect(again).rejects.toThrow(
      `claim ${claimId} is already open for this debtor as case ${first.deductionId}`,
    );

    // And it is refused rather than recorded: still one case, still one row.
    const { rows } = await admin.query<{ n: string }>(
      `select count(*) as n from deduction_identifiers where org_id = $1 and identifier = $2`,
      [orgId, claimId],
    );
    expect(rows[0]?.n).toBe('1');
  });

  it('matches an identifier from another source, not only the one that wrote it', async () => {
    // Two sources printing the same string is the normal case — the portal's
    // claim id is often the notice's — so the match is within a *kind*, across
    // sources.
    const claimId = `APDP-${suffix}-portal`;
    const seeded = randomUUID();
    await admin.query(
      `insert into deductions (id, org_id, claim_id, deduction_amount_cents) values ($1,$2,$3,100)`,
      [seeded, orgId, claimId],
    );
    await admin.query(
      `insert into deduction_identifiers (org_id, deduction_id, source, identifier_kind, identifier)
       values ($1,$2,'portal_fetch','claim_id',$3)`,
      [orgId, seeded, claimId],
    );

    const arriving = store.openCase({
      orgId,
      claimId: claimId.toLowerCase(),
      source: 'web_upload',
      deductionAmountCents: 100,
    });
    await expect(arriving).rejects.toThrow(DuplicateCaseError);
    await expect(arriving).rejects.toThrow(new RegExp(seeded));
  });

  it('refuses to choose when two cases already answer to one identifier', async () => {
    const claimId = `APDP-${suffix}-twins`;
    const left = randomUUID();
    const right = randomUUID();
    await admin.query(
      `insert into deductions (id, org_id, deduction_amount_cents) values ($1,$3,100), ($2,$3,100)`,
      [left, right, orgId],
    );
    // One identifier, two deductions — legal, because the constraint is per
    // source, and exactly the pair nobody but a person may resolve.
    await admin.query(
      `insert into deduction_identifiers (org_id, deduction_id, source, identifier_kind, identifier)
       values ($1,$2,'portal_fetch','claim_id',$4), ($1,$3,'erp_sync','claim_id',$4)`,
      [orgId, left, right, claimId],
    );

    const arriving = store.openCase({
      orgId,
      claimId,
      source: 'web_upload',
      deductionAmountCents: 100,
    });
    await expect(arriving).rejects.toThrow(AmbiguousIdentityError);
    const error = await arriving.catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(AmbiguousIdentityError);
    const ambiguous = error as AmbiguousIdentityError;
    expect([...ambiguous.deductionIds].sort()).toEqual([left, right].sort());
    expect(ambiguous.basis).toEqual(['claim_id']);
    expect(ambiguous.message).toContain(left);
    expect(ambiguous.message).toContain(right);

    // Nothing was created: the arrival is held, not merged and not opened.
    const { rows } = await admin.query<{ n: string }>(
      `select count(*) as n from deduction_identifiers where org_id = $1 and identifier = $2`,
      [orgId, claimId],
    );
    expect(rows[0]?.n).toBe('2');
  });

  it('opens the case and names the pair when the invoice, amount and date all agree', async () => {
    const seeded = randomUUID();
    const invoiceNumber = `INV-${suffix}-7781`;
    await admin.query(
      `insert into deductions (id, org_id, debtor_id, claim_id, deduction_amount_cents, deduction_date)
       values ($1,$2,$3,$4,88450,'2026-07-02')`,
      [seeded, orgId, walmartId, `APDP-${suffix}-ledger`],
    );
    // The invoice number lives on the identifier table — `deductions` has no
    // such column — which is how a later source (the ledger, an 812) says it.
    await admin.query(
      `insert into deduction_identifiers (org_id, deduction_id, source, identifier_kind, identifier)
       values ($1,$2,'erp_sync','invoice_number',$3)`,
      [orgId, seeded, invoiceNumber],
    );

    const opened = await store.openCase({
      orgId,
      // A different claim id: no exact match, so this is the probable branch.
      claimId: `APDP-${suffix}-probable`,
      invoiceNumber,
      source: 'web_upload',
      retailerName: 'Walmart (APDP)',
      deductionAmountCents: 88_450,
      deductionDate: '2026-07-05',
    });

    // Losing a deduction is the worse error, so the case is opened.
    expect(opened.deductionId).toBeTruthy();
    const payloads = await eventsFor(opened.deductionId, 'case.possible_duplicate');
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.of).toBe(seeded);
    // Which facts agreed, never what they said.
    expect(payloads[0]?.basis).toEqual([
      'invoice_number',
      'amount_cents',
      'deduction_date',
      'debtor_id',
    ]);
    expect(JSON.stringify(payloads[0])).not.toContain(invoiceNumber);

    // And its own claim id is recorded, so the next arrival can match it.
    const rows = await identifiersFor(opened.deductionId);
    expect(rows.map((row) => row.identifier_kind)).toEqual(['claim_id']);
  });

  it('writes no identifier row for a case that has no claim id', async () => {
    const opened = await store.openCase({
      orgId,
      source: 'web_upload',
      retailerName: 'Walmart (APDP)',
      deductionAmountCents: 4_500,
    });
    expect(await identifiersFor(opened.deductionId)).toEqual([]);
    expect(await eventsFor(opened.deductionId, 'case.possible_duplicate')).toEqual([]);
  });

  it('writes no identifier row for a notice whose arrival nothing recorded', async () => {
    // A document stored before provenance existed names no upload, so no source
    // can be given — and `deduction_identifiers.source` is not nullable. The
    // case still opens; what it does not do is file the identifier under a
    // guessed channel (ADR 0024).
    const opened = await store.openCase({
      orgId,
      claimId: `APDP-${suffix}-no-source`,
      retailerName: 'Walmart (APDP)',
      deductionAmountCents: 9_900,
    });
    expect(await identifiersFor(opened.deductionId)).toEqual([]);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { cents, resolveIdentity } from '@recouple/core-domain';
import { closeAllPools, PostgresStore } from '../src/store';

/**
 * The identity half of ADR 0028, against the database rather than a double.
 *
 * Three things can only be proved here. That the candidate query folds an
 * identifier the way `identifierMatchKey` does — a fold that drifts from the
 * matcher's hands back rows the matcher then refuses, which reads as "no
 * duplicate" and opens a second case for a deduction we already have. That
 * `recordIdentifiers` derives its `source` from the document's own arrival and
 * reports rather than guesses when there is none. And that the per-invoice claim
 * holds *between two connections*, which is what two machines look like from
 * here — the only shape in which two documents can race the resolve-then-open on
 * one invoice.
 *
 * `pnpm db:test` prepares the database; without `TEST_DATABASE_URL` there is nothing
 * to test against.
 */

const connectionString = process.env.TEST_DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

describeDb('an invoice, and the case it might already be', () => {
  const orgId = randomUUID();
  const analystId = randomUUID();
  const suffix = orgId.slice(0, 8);

  let admin: Pool;
  /** Two stores for one tenant: two identities' worth of connections. */
  let one: PostgresStore;
  let two: PostgresStore;

  /** A stored document with an arrival recorded, the way ingest leaves one. */
  async function documentWithArrival(source = 'web_upload'): Promise<string> {
    const uploadId = randomUUID();
    const documentId = randomUUID();
    await admin.query(
      `insert into uploads (id, org_id, source, created_by) values ($1,$2,$3,$4)`,
      [uploadId, orgId, source, analystId],
    );
    await admin.query(
      `insert into documents (id, org_id, upload_id, sha256, byte_size, mime_type, storage_ref, filename)
       values ($1,$2,$3,$4,2048,'application/pdf',$5,'advice.pdf')`,
      [documentId, orgId, uploadId, Buffer.from(randomUUID().replace(/-/g, ''), 'hex'), `db://${documentId}`],
    );
    return documentId;
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: connectionString as string });
    await admin.query(
      `insert into organizations (id, slug, name) values ($1,$2,'Remit')`,
      [orgId, `remit-${suffix}`],
    );
    await admin.query('insert into org_settings (org_id) values ($1)', [orgId]);
    await admin.query('insert into users (id, email) values ($1,$2)', [
      analystId,
      `remit-analyst-${suffix}@example.test`,
    ]);
    await admin.query(
      `insert into memberships (org_id, user_id, role) values ($1,$2,'analyst')`,
      [orgId, analystId],
    );

    const tenant = { orgId, userId: analystId };
    one = new PostgresStore({ connectionString: connectionString as string }, tenant);
    two = new PostgresStore({ connectionString: connectionString as string }, tenant);
  });

  afterAll(async () => {
    await admin?.end();
    await closeAllPools();
  });

  it('reads back an identifier written under the channel its document arrived through', async () => {
    const documentId = await documentWithArrival('email_in');
    const opened = await one.openCase({
      orgId,
      claimId: `ACH-1:${suffix}-INV-1`,
      discoveredVia: 'remittance_line',
      deductionAmountCents: 80_000,
      deductionDate: '2026-09-15',
    });

    const written = await one.recordIdentifiers({
      orgId,
      deductionId: opened.deductionId,
      documentId,
      identifiers: [
        { kind: 'claim_id', identifier: `ACH-1:${suffix}-INV-1` },
        { kind: 'invoice_number', identifier: `${suffix}-INV-1` },
      ],
    });
    expect(written).toEqual({ written: 2 });

    const { rows } = await admin.query<{ source: string; identifier_kind: string }>(
      `select source, identifier_kind from deduction_identifiers
        where deduction_id = $1 order by identifier_kind`,
      [opened.deductionId],
    );
    // Derived from the arrival, not from anything the caller said (ADR 0024).
    expect(rows.map((r) => [r.identifier_kind, r.source])).toEqual([
      ['claim_id', 'email_in'],
      ['invoice_number', 'email_in'],
    ]);
  });

  it('writes nothing, and says why, for a document that records no arrival', async () => {
    // A document stored before ingest wrote `uploads` rows: `upload_id` is null
    // and no `document_arrivals` row stands in for it. Nothing here may invent a
    // channel — but the case still stands, because an identifier row is an index
    // and the conservative failure is a second case somebody can see.
    const documentId = randomUUID();
    await admin.query(
      `insert into documents (id, org_id, sha256, byte_size, mime_type, storage_ref, filename)
       values ($1,$2,$3,2048,'application/pdf',$4,'old.pdf')`,
      [documentId, orgId, Buffer.from(randomUUID().replace(/-/g, ''), 'hex'), `db://${documentId}`],
    );
    const opened = await one.openCase({
      orgId,
      claimId: `${suffix}-ORPHAN`,
      deductionAmountCents: 1_000,
    });

    const written = await one.recordIdentifiers({
      orgId,
      deductionId: opened.deductionId,
      documentId,
      identifiers: [{ kind: 'claim_id', identifier: `${suffix}-ORPHAN` }],
    });
    expect(written.written).toBe(0);
    expect(written.skippedBecause).toContain('records no arrival');
    const { rowCount } = await admin.query(
      'select 1 from deduction_identifiers where deduction_id = $1',
      [opened.deductionId],
    );
    expect(rowCount).toBe(0);
  });

  it('folds a stored identifier the way the matcher folds an arriving one', async () => {
    // `identifierMatchKey` trims, collapses internal whitespace and case-folds,
    // and nothing else. The SQL has to agree letter for letter: a fold that
    // drifts hands back candidates the matcher refuses, and "no duplicate" is
    // how a second case for one deduction gets opened.
    const documentId = await documentWithArrival();
    const opened = await one.openCase({
      orgId,
      claimId: `${suffix}-FOLD`,
      discoveredVia: 'remittance_line',
      deductionAmountCents: 42_000,
      deductionDate: '2026-09-15',
    });
    await one.recordIdentifiers({
      orgId,
      deductionId: opened.deductionId,
      documentId,
      identifiers: [
        { kind: 'claim_id', identifier: `  ACH-9 : ${suffix}  ` },
        { kind: 'invoice_number', identifier: `  ${suffix}-Fold   Inv ` },
      ],
    });

    const candidates = await one.identityCandidates({
      orgId,
      // Written differently on the second document: padded, cased otherwise,
      // and with the internal run of spaces collapsed.
      identifiers: [{ kind: 'claim_id', identifier: `ach-9 : ${suffix}` }],
      invoiceNumber: `${suffix}-FOLD INV`,
    });

    expect(candidates.knownIdentifiers.map((i) => i.deductionId)).toEqual([opened.deductionId]);
    expect(candidates.knownDeductions.map((d) => d.deductionId)).toEqual([opened.deductionId]);
    // Stored verbatim all the same: normalisation is a comparison, not a
    // rewrite (ADR 0025 §4).
    expect(candidates.knownIdentifiers[0]?.identifier).toBe(`  ACH-9 : ${suffix}  `);

    // And the two together are what the matcher answers `exact` on.
    const resolution = resolveIdentity(
      {
        identifiers: [{ kind: 'claim_id', identifier: `ach-9 : ${suffix}` }],
        amountCents: cents(42_000),
        invoiceNumber: `${suffix}-FOLD INV`,
        deductionDate: '2026-09-15',
      },
      candidates.knownIdentifiers,
      candidates.knownDeductions,
      { dateToleranceDays: 30 },
    );
    expect(resolution.kind).toBe('exact');
  });

  it('does not offer another tenant’s case as a candidate', async () => {
    const otherOrgId = randomUUID();
    const outsiderId = randomUUID();
    await admin.query(`insert into organizations (id, slug, name) values ($1,$2,'Remit Other')`, [
      otherOrgId,
      `remit-other-${suffix}`,
    ]);
    await admin.query('insert into org_settings (org_id) values ($1)', [otherOrgId]);
    await admin.query('insert into users (id, email) values ($1,$2)', [
      outsiderId,
      `remit-outsider-${suffix}@example.test`,
    ]);
    await admin.query(
      `insert into memberships (org_id, user_id, role) values ($1,$2,'analyst')`,
      [otherOrgId, outsiderId],
    );
    const theirs = randomUUID();
    await admin.query(
      `insert into deductions (id, org_id, claim_id, deduction_amount_cents, discovered_via)
       values ($1,$2,$3,80000,'remittance_line')`,
      [theirs, otherOrgId, `SHARED-${suffix}`],
    );
    await admin.query(
      `insert into deduction_identifiers (org_id, deduction_id, source, identifier_kind, identifier)
       values ($1,$2,'web_upload','claim_id',$3), ($1,$2,'web_upload','invoice_number',$4)`,
      [otherOrgId, theirs, `SHARED-${suffix}`, `SHARED-INV-${suffix}`],
    );

    const candidates = await one.identityCandidates({
      orgId,
      identifiers: [{ kind: 'claim_id', identifier: `SHARED-${suffix}` }],
      invoiceNumber: `SHARED-INV-${suffix}`,
    });
    // RLS, not a `where org_id` this query remembered to write: the rows are
    // simply not there for this tenant (invariant 6).
    expect(candidates.knownIdentifiers).toEqual([]);
    expect(candidates.knownDeductions).toEqual([]);
  });

  it('holds one invoice against two connections, so two documents cannot double-file it', async () => {
    // The race the per-document claim does not cover: a notice and a remittance,
    // two different documents, both reaching resolve-then-open for one invoice.
    // Under READ COMMITTED both would see no existing case and both would
    // insert — and `unique (org_id, debtor_id, claim_id)` catches neither,
    // because the two build different claim ids and it does not fire at all
    // while `debtor_id` is null.
    const invoiceNumber = `${suffix}-RACE`;
    const order: string[] = [];

    let releaseFirst = (): void => undefined;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstIsInside = (): void => undefined;
    const insideFirst = new Promise<void>((resolve) => {
      firstIsInside = resolve;
    });

    const first = one.withInvoiceClaim(orgId, invoiceNumber, async () => {
      order.push('first in');
      firstIsInside();
      await firstMayFinish;
      order.push('first out');
    });

    await insideFirst;
    const second = two.withInvoiceClaim(orgId, invoiceNumber, async () => {
      order.push('second in');
    });

    // The second waits rather than being turned away — the opposite of
    // `withDocumentRead`, and for the opposite reason: there is no model call
    // inside this, and a caller that gave up would drop a deduction on the
    // floor rather than harmlessly skip a read (ADR 0028 §6).
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(order).toEqual(['first in']);

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first in', 'first out', 'second in']);
  });

  it('lets a different invoice through while one is held', async () => {
    // The claim is per invoice, not a global one: a dense advice would
    // otherwise serialise its forty-two lines behind every other read in the
    // deployment.
    let release = (): void => undefined;
    const mayFinish = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inside = (): void => undefined;
    const isInside = new Promise<void>((resolve) => {
      inside = resolve;
    });

    const held = one.withInvoiceClaim(orgId, `${suffix}-A`, async () => {
      inside();
      await mayFinish;
    });
    await isInside;

    await expect(two.withInvoiceClaim(orgId, `${suffix}-B`, async () => 'through')).resolves.toBe(
      'through',
    );

    release();
    await held;
  });

  it('releases the claim when the work throws, rather than holding it to the end of time', async () => {
    const boom = new Error('the read failed');
    await expect(
      one.withInvoiceClaim(orgId, `${suffix}-THROWS`, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    // The transaction rolled back, which is what releases an xact-scoped lock —
    // so the next caller gets it rather than waiting for a connection that has
    // already moved on.
    await expect(
      two.withInvoiceClaim(orgId, `${suffix}-THROWS`, async () => 'free'),
    ).resolves.toBe('free');
  });
});

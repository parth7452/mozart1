import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  buildLedgerExtract,
  cents,
  detectShortPays,
  type LedgerInvoice,
  type LedgerPayment,
} from '@recouple/core-domain';
import { closeAllPools, PostgresStore } from '../src/store';
import { PostgresDiscoveryStore } from '../src/discovery';

/**
 * The review page's list of documents, for a case the ledger sync opened.
 *
 * A ledger case's notice is the extract `buildLedgerExtract` renders (ADR
 * 0029), and no model reads it, so it has no `extraction_results` rows. The
 * page found a case's documents through their fields, so a ledger case showed
 * no original document at all and its packet named the extract "document 1".
 * `caseDocuments` lists it by its link, as `app_rw` through RLS.
 */

const connectionString = process.env.TEST_DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

const invoice: LedgerInvoice = {
  sourceKind: 'qbo',
  externalId: 'inv-1',
  invoiceNumber: 'INV-1001',
  customerExternalId: 'cust-9',
  customerName: 'Sysco Baltimore, LLC',
  issuedOn: '2026-07-01',
  totalCents: cents(1_000_000),
  balanceCents: cents(80_000),
  currency: 'USD',
};

const payment: LedgerPayment = {
  sourceKind: 'qbo',
  externalId: 'pay-1',
  customerExternalId: 'cust-9',
  receivedOn: '2026-07-20',
  totalCents: cents(920_000),
  reference: 'ACH-55512',
  memo: 'shortage',
  appliedTo: [{ invoiceExternalId: 'inv-1', amountCents: cents(920_000) }],
};

describeDb('the documents of a case the ledger sync opened', () => {
  const admin = new Pool({ connectionString });
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const analystId = randomUUID();
  const otherAnalystId = randomUUID();
  const suffix = orgId.slice(0, 8);
  let store: PostgresStore;
  let deductionId: string;
  let extractId: string;

  beforeAll(async () => {
    await admin.query(
      `insert into organizations (id, slug, name) values ($1,$2,'Ledger docs'), ($3,$4,'Ledger docs other')`,
      [orgId, `ledger-docs-${suffix}`, otherOrgId, `ledger-docs-other-${suffix}`],
    );
    await admin.query('insert into org_settings (org_id) values ($1), ($2)', [orgId, otherOrgId]);
    await admin.query('insert into users (id, email) values ($1,$2), ($3,$4)', [
      analystId,
      `ledger-docs-${suffix}@example.test`,
      otherAnalystId,
      `ledger-docs-other-${suffix}@example.test`,
    ]);
    await admin.query(
      `insert into memberships (org_id, user_id, role) values ($1,$2,'analyst'), ($3,$4,'analyst')`,
      [orgId, analystId, otherOrgId, otherAnalystId],
    );

    const config = { connectionString: connectionString as string };
    store = new PostgresStore(config, { orgId, userId: analystId });
    const discovery = new PostgresDiscoveryStore(config, { orgId, userId: analystId }, store);

    const candidate = detectShortPays([invoice], [payment], []).candidates[0];
    if (candidate === undefined) throw new Error('no short-pay in the ledger');
    const recorded = await discovery.recordLedgerCase({
      orgId,
      extract: buildLedgerExtract(candidate, invoice, [payment], []),
      identifiers: { ledgerInvoiceId: 'inv-1', invoiceNumber: 'INV-1001' },
      gapCents: 80_000,
      customerName: 'Sysco Baltimore, LLC',
      gapStatus: 'open',
      deductionDate: '2026-07-20',
    });
    deductionId = recorded.deductionId;
    extractId = recorded.documentId;
  });

  afterAll(async () => {
    await closeAllPools();
    await store?.close();
    await admin.end();
  });

  it('lists the extract as the notice, though nothing read it', async () => {
    expect(await store.caseDocuments(deductionId)).toEqual([
      {
        documentId: extractId,
        filename: 'ledger-extract-INV-1001.json',
        mimeType: 'application/json',
        // Known by construction, never classified (ADR 0029).
        docType: null,
        role: 'notice',
        read: false,
        readForCase: false,
        // Nothing scans it, and it is served: our own code wrote every byte
        // of it, and its arrival says so (`servingRefusal`).
        servingRefusal: null,
      },
    ]);
    // And it has no fields, which is why the list cannot come from them.
    expect(await store.fieldsForCase(deductionId)).toEqual([]);
  });

  it('shows another tenant nothing', async () => {
    const other = new PostgresStore(
      { connectionString: connectionString as string },
      { orgId: otherOrgId, userId: otherAnalystId },
    );
    try {
      expect(await other.caseDocuments(deductionId)).toEqual([]);
    } finally {
      await other.close();
    }
  });
});

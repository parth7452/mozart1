import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
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
 * A ledger case carries no reason code of its own. Once a person links the
 * payer's notice to it — Attach, or confirm-and-merge — the payer's terms are
 * derived at read time from the linked documents, and nothing is written to
 * `deductions`.
 */

const connectionString = process.env.TEST_DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

const invoice: LedgerInvoice = {
  sourceKind: 'qbo',
  externalId: 'inv-pt-1',
  invoiceNumber: 'INV-PT-1001',
  customerExternalId: 'cust-9',
  customerName: 'Sysco Baltimore, LLC',
  issuedOn: '2026-07-01',
  totalCents: cents(1_000_000),
  balanceCents: cents(80_000),
  currency: 'USD',
};

const payment: LedgerPayment = {
  sourceKind: 'qbo',
  externalId: 'pay-pt-1',
  customerExternalId: 'cust-9',
  receivedOn: '2026-07-20',
  totalCents: cents(920_000),
  reference: 'ACH-55512',
  memo: 'shortage',
  appliedTo: [{ invoiceExternalId: 'inv-pt-1', amountCents: cents(920_000) }],
};

describeDb("the payer's terms on a case, derived from its linked documents", () => {
  const admin = new Pool({ connectionString });
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const suffix = orgId.slice(0, 8);
  let store: PostgresStore;
  let otherStore: PostgresStore;
  let debtorId: string;

  beforeAll(async () => {
    await admin.query(
      `insert into organizations (id, slug, name) values ($1,$2,'Payer terms'), ($3,$4,'Payer terms other')`,
      [orgId, `payer-terms-${suffix}`, otherOrgId, `payer-terms-other-${suffix}`],
    );
    await admin.query('insert into org_settings (org_id) values ($1), ($2)', [orgId, otherOrgId]);
    await admin.query('insert into users (id, email) values ($1,$2), ($3,$4)', [
      userId,
      `payer-terms-${suffix}@example.test`,
      otherUserId,
      `payer-terms-other-${suffix}@example.test`,
    ]);
    await admin.query(
      `insert into memberships (org_id, user_id, role) values ($1,$2,'analyst'), ($3,$4,'analyst')`,
      [orgId, userId, otherOrgId, otherUserId],
    );
    const { rows } = await admin.query<{ id: string }>(
      `insert into debtors (org_id, retailer_key, display_name)
       values ($1, 'walmart_apdp', 'Walmart (APDP)') returning id`,
      [orgId],
    );
    debtorId = rows[0]?.id as string;
    const config = { connectionString: connectionString as string };
    store = new PostgresStore(config, { orgId, userId });
    otherStore = new PostgresStore(config, { orgId: otherOrgId, userId: otherUserId });
  });

  afterAll(async () => {
    await closeAllPools();
    await store?.close();
    await otherStore?.close();
    await admin.end();
  });

  /** A stored, classified notice whose line 0 prints a code, a reference and an amount. */
  async function readNotice(label: string, amount: string): Promise<string> {
    const upload = await store.recordUpload({ orgId, source: 'web_upload', createdBy: userId });
    const stored = await store.putDocument({
      orgId,
      sha256: createHash('sha256').update(`${suffix}:${label}`).digest('hex'),
      byteSize: 10,
      mimeType: 'application/pdf',
      filename: `${label}.pdf`,
      bytes: new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52, 10, 10]),
      requiresSplit: false,
      uploadId: upload.uploadId,
    });
    const documentId = stored.documentId;
    await admin.query(
      `insert into document_classifications (org_id, document_id, doc_type, confidence)
       values ($1,$2,'deduction_notice',0.97)`,
      [orgId, documentId],
    );
    for (const [path, value] of [
      ['lines[0].reason_code', 'SHORT-QTY'],
      ['lines[0].deduction_reference', 'CB-77'],
      ['lines[0].deduction_amount', amount],
    ] as const) {
      await admin.query(
        `insert into extraction_results
           (org_id, document_id, deduction_id, field_path, value_json, confidence,
            source_page, source_quote, quote_verified, extractor, schema_version, model_version)
         values ($1,$2,null,$3,$4::jsonb,0.98,1,$5,true,'test','1','test')`,
        [orgId, documentId, path, JSON.stringify(value), value],
      );
    }
    return documentId;
  }

  it('derives the code and reference once the notice is attached to a ledger case', async () => {
    const discovery = new PostgresDiscoveryStore(
      { connectionString: connectionString as string },
      { orgId, userId },
      store,
    );
    const candidate = detectShortPays([invoice], [payment], []).candidates[0];
    if (candidate === undefined) throw new Error('no short-pay in the ledger');
    const { deductionId } = await discovery.recordLedgerCase({
      orgId,
      extract: buildLedgerExtract(candidate, invoice, [payment], []),
      identifiers: { ledgerInvoiceId: 'inv-pt-1', invoiceNumber: 'INV-PT-1001' },
      gapCents: 80_000,
      customerName: 'Sysco Baltimore, LLC',
      gapStatus: 'open',
      deductionDate: '2026-07-20',
    });
    expect(await store.payerTermsForCase(deductionId)).toEqual({ kind: 'none' });

    const noticeId = await readNotice('ledger-notice', '$800.00');
    const before = await admin.query('select * from deductions where id = $1', [deductionId]);
    await store.attachEvidence({ orgId, deductionId, documentId: noticeId, docType: 'deduction_notice' });

    const answer = await store.payerTermsForCase(deductionId);
    expect(answer).toEqual({
      kind: 'derived',
      terms: {
        reasonCode: 'SHORT-QTY',
        deductionReference: 'CB-77',
        documentId: noticeId,
        fieldPath: 'lines[0].reason_code',
        quoteVerified: true,
      },
    });
    expect((await store.payerTermsForCases([deductionId])).get(deductionId)).toEqual(answer);
    // Derived, never written.
    const after = await admin.query('select * from deductions where id = $1', [deductionId]);
    expect(after.rows).toEqual(before.rows);

    // Another tenant sees nothing of it.
    expect(await otherStore.payerTermsForCase(deductionId)).toEqual({ kind: 'none' });
  });

  it('derives on the survivor of a merge, and not after the merge is undone', async () => {
    const older = randomUUID();
    const invoiceNumber = `PT-INV-${suffix}`;
    await admin.query(
      `insert into deductions (id, org_id, debtor_id, claim_id, deduction_amount_cents, deduction_date)
       values ($1,$2,$3,$4,42150,'2026-07-02')`,
      [older, orgId, debtorId, `PT-${suffix}-held`],
    );
    await admin.query(
      `insert into deduction_identifiers (org_id, deduction_id, source, identifier_kind, identifier)
       values ($1,$2,'erp_sync','invoice_number',$3), ($1,$2,'erp_sync','claim_id',$4)`,
      [orgId, older, invoiceNumber, `PT-${suffix}-held`],
    );
    const opened = await store.openCase({
      orgId,
      claimId: `PT-${suffix}-new`,
      invoiceNumber,
      source: 'web_upload',
      retailerName: 'Walmart (APDP)',
      deductionAmountCents: 42_150,
      deductionDate: '2026-07-05',
    });
    const noticeId = await readNotice('merge-notice', '$421.50');
    await store.attachEvidence({
      orgId,
      deductionId: opened.deductionId,
      documentId: noticeId,
      docType: 'deduction_notice',
    });
    expect(await store.payerTermsForCase(older)).toEqual({ kind: 'none' });

    const verdict = await store.recordDuplicateVerdict({
      deductionId: opened.deductionId,
      otherDeductionId: older,
      verdict: 'same',
      recordedBy: userId,
      merge: true,
    });
    expect(verdict.merge?.kind).toBe('merged');
    const merged = await store.payerTermsForCase(older);
    expect(merged).toMatchObject({ kind: 'derived', terms: { reasonCode: 'SHORT-QTY', documentId: noticeId } });
    expect((await store.payerTermsForCases([older])).get(older)).toEqual(merged);

    await store.undoMerge({ deductionId: opened.deductionId, undoneBy: userId });
    expect(await store.payerTermsForCase(older)).toEqual({ kind: 'none' });
  });

  it('answers own for a case that printed its code, and writes nothing', async () => {
    const id = randomUUID();
    await admin.query(
      `insert into deductions (id, org_id, claim_id, deduction_amount_cents, reason_code_as_printed)
       values ($1,$2,$3,5000,'PRINTED')`,
      [id, orgId, `PT-${suffix}-own`],
    );
    const before = await admin.query('select * from deductions where id = $1', [id]);
    expect(await store.payerTermsForCase(id)).toEqual({ kind: 'own' });
    expect((await store.payerTermsForCases([id])).get(id)).toEqual({ kind: 'own' });
    const after = await admin.query('select * from deductions where id = $1', [id]);
    expect(after.rows).toEqual(before.rows);
    expect(await otherStore.payerTermsForCase(id)).toEqual({ kind: 'none' });
  });
});

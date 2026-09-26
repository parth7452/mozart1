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
import {
  DiscoveryStoreError,
  PostgresDiscoveryStore,
  TRIAGE_DECIDED_BY,
  TRIAGE_DECIDED_BY_VERSION,
} from '../src/discovery';

const connectionString = process.env.TEST_DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

function invoice(overrides: Partial<LedgerInvoice> = {}): LedgerInvoice {
  return {
    sourceKind: 'qbo',
    externalId: 'inv-1',
    invoiceNumber: 'INV-1001',
    customerExternalId: 'cust-9',
    customerName: 'Sysco Baltimore, LLC',
    issuedOn: '2026-07-01',
    totalCents: cents(1_000_000),
    balanceCents: cents(80_000),
    currency: 'USD',
    ...overrides,
  };
}

function payment(overrides: Partial<LedgerPayment> = {}): LedgerPayment {
  return {
    sourceKind: 'qbo',
    externalId: 'pay-1',
    customerExternalId: 'cust-9',
    receivedOn: '2026-07-20',
    totalCents: cents(920_000),
    reference: 'ACH-55512',
    memo: 'shortage',
    appliedTo: [{ invoiceExternalId: 'inv-1', amountCents: cents(920_000) }],
    ...overrides,
  };
}

/** The extract for one invoice, built the way `syncLedger` builds it. */
function extractFor(invoices: readonly LedgerInvoice[], payments: readonly LedgerPayment[]) {
  const report = detectShortPays(invoices, payments, []);
  const candidate = report.candidates[0];
  const first = invoices[0];
  if (candidate === undefined || first === undefined) throw new Error('no candidate');
  return { candidate, extract: buildLedgerExtract(candidate, first, payments, []) };
}

/**
 * A short-pay the customer never surfaced, becoming a case.
 *
 * The point of these tests is what only the database can answer: that the
 * arrival is recorded as `erp_sync` and derivable from the case's own notice,
 * that the identifiers land under the constraints migration 0020 put on them,
 * and that running the same sync twice does not open a second case or count the
 * same dollars twice.
 */
describeDb('discovering a deduction in the ledger', () => {
  const admin = new Pool({ connectionString });
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const analystId = randomUUID();
  const suffix = orgId.slice(0, 8);
  let store: PostgresStore;
  let discovery: PostgresDiscoveryStore;
  /**
   * The first case this suite opens. The tests below run in file order and each
   * builds on the last — a case has to exist before anything can be a possible
   * duplicate of it, or decline it.
   */
  let firstDeductionId: string | undefined;

  function recorded0(): string {
    if (firstDeductionId === undefined) throw new Error('the first case was not opened');
    return firstDeductionId;
  }

  beforeAll(async () => {
    await admin.query(
      `insert into organizations (id, slug, name) values ($1,$2,'Ledger'), ($3,$4,'Ledger Other')`,
      [orgId, `led-${suffix}`, otherOrgId, `led-other-${suffix}`],
    );
    await admin.query(`insert into org_settings (org_id) values ($1), ($2)`, [orgId, otherOrgId]);
    await admin.query(`insert into users (id, email) values ($1,$2)`, [
      analystId,
      `led-a-${suffix}@example.test`,
    ]);
    await admin.query(`insert into memberships (org_id, user_id, role) values ($1,$2,'analyst')`, [
      orgId,
      analystId,
    ]);

    const config = { connectionString: connectionString as string };
    store = new PostgresStore(config, { orgId, userId: analystId });
    discovery = new PostgresDiscoveryStore(config, { orgId, userId: analystId }, store);
  });

  afterAll(async () => {
    await closeAllPools();
    await admin.end();
  });

  it('stores the extract as a notice that arrived through erp_sync', async () => {
    const { extract } = extractFor([invoice()], [payment()]);
    const recorded = await discovery.recordLedgerCase({
      orgId,
      extract,
      identifiers: { ledgerInvoiceId: 'inv-1', invoiceNumber: 'INV-1001' },
      gapCents: 80_000,
      customerName: 'Sysco Baltimore, LLC',
      gapStatus: 'open',
      deductionDate: '2026-07-20',
    });

    expect(recorded.reused).toBe(false);
    firstDeductionId = recorded.deductionId;

    const { rows } = await admin.query<{
      source: string;
      created_by: string | null;
      role: string;
      amount: string;
      retailer: string | null;
      deduction_date: string | null;
      mime_type: string;
    }>(
      `select u.source, u.created_by, dd.role,
              d.deduction_amount_cents::text as amount,
              d.retailer_name_as_printed as retailer,
              to_char(d.deduction_date, 'YYYY-MM-DD') as deduction_date,
              doc.mime_type
         from deduction_documents dd
         join documents doc on doc.id = dd.document_id
         join uploads u on u.id = doc.upload_id
         join deductions d on d.id = dd.deduction_id
        where dd.deduction_id = $1`,
      [recorded.deductionId],
    );
    const row = rows[0];
    expect(row?.source).toBe('erp_sync');
    // No member put this in front of the pipeline: a job read a third party's
    // API, and `From:`-style attribution would be an invention.
    expect(row?.created_by).toBeNull();
    expect(row?.role).toBe('notice');
    expect(row?.amount).toBe('80000');
    expect(row?.retailer).toBe('Sysco Baltimore, LLC');
    expect(row?.deduction_date).toBe('2026-07-20');
    expect(row?.mime_type).toBe('application/json');
  });

  /**
   * ADR 0043 §2: a ledger extract's type is known by construction, so the case
   * crosses `discovered → classified` in the transaction that links it — and
   * the case page's decide and decline cards, which a `discovered` case never
   * gets, are there on the day it opens.
   */
  it('opens the case classified, with the event that says the sync did it', async () => {
    const { rows } = await admin.query<{ state: string }>(
      `select state from deductions where id = $1`,
      [recorded0()],
    );
    expect(rows[0]?.state).toBe('classified');

    const { rows: events } = await admin.query<{ event_type: string; payload: Record<string, unknown> }>(
      `select event_type, payload from deduction_events where deduction_id = $1 order by id asc`,
      [recorded0()],
    );
    expect(events.map((e) => e.event_type)).toEqual(['case.discovered', 'case.classified']);
    expect(events[1]?.payload).toEqual({ classified_by: 'ledger_sync', source: 'erp_sync' });
  });

  it('records the names the ledger knows it by, and the discovery event', async () => {
    const { extract } = extractFor(
      [invoice({ externalId: 'inv-2', invoiceNumber: 'INV-1002' })],
      [payment({ externalId: 'pay-2', appliedTo: [{ invoiceExternalId: 'inv-2', amountCents: cents(920_000) }] })],
    );
    const recorded = await discovery.recordLedgerCase({
      orgId,
      extract,
      identifiers: { ledgerInvoiceId: 'inv-2', invoiceNumber: 'INV-1002' },
      gapCents: 80_000,
      customerName: 'US Foods',
      gapStatus: 'open',
      deductionDate: '2026-07-20',
      possibleDuplicateOf: { deductionId: recorded0(), basis: ['invoice_number', 'amount_cents'] },
    });

    const { rows: identifiers } = await admin.query<{ kind: string; identifier: string; source: string }>(
      `select identifier_kind as kind, identifier, source
         from deduction_identifiers where deduction_id = $1 order by identifier_kind`,
      [recorded.deductionId],
    );
    expect(identifiers.map((r) => [r.kind, r.identifier, r.source])).toEqual([
      ['invoice_number', 'INV-1002', 'erp_sync'],
      ['ledger_invoice_id', 'inv-2', 'erp_sync'],
    ]);

    const { rows: events } = await admin.query<{ event_type: string; payload: Record<string, unknown> }>(
      `select event_type, payload from deduction_events
        where deduction_id = $1 order by id asc`,
      [recorded.deductionId],
    );
    expect(events.map((e) => e.event_type)).toEqual([
      'case.discovered',
      'case.classified',
      'case.possible_duplicate',
    ]);
    expect(events[0]?.payload.source).toBe('erp_sync');
    expect(events[2]?.payload.basis).toEqual(['invoice_number', 'amount_cents']);
  });

  it('reuses the case when the same ledger state is synced again', async () => {
    const { extract } = extractFor(
      [invoice({ externalId: 'inv-3', invoiceNumber: 'INV-1003' })],
      [payment({ externalId: 'pay-3', appliedTo: [{ invoiceExternalId: 'inv-3', amountCents: cents(920_000) }] })],
    );
    const input = {
      orgId,
      extract,
      identifiers: { ledgerInvoiceId: 'inv-3', invoiceNumber: 'INV-1003' },
      gapCents: 80_000,
      customerName: 'PFG',
      gapStatus: 'open' as const,
      deductionDate: '2026-07-20',
    };
    const first = await discovery.recordLedgerCase(input);
    const second = await discovery.recordLedgerCase(input);

    expect(second.reused).toBe(true);
    expect(second.deductionId).toBe(first.deductionId);
    expect(second.documentId).toBe(first.documentId);

    const { rows } = await admin.query<{ count: string }>(
      // Scoped to this org: dedupe is per tenant (`findDocumentByHash` takes an
      // org), and this database is shared with every other suite and every
      // earlier run of this one.
      `select count(*)::text as count from documents where org_id = $1 and sha256 = $2`,
      [orgId, Buffer.from(extract.sha256, 'hex')],
    );
    expect(rows[0]?.count).toBe('1');
  });

  /**
   * The cases opened before ADR 0043 are still `discovered` (production holds
   * two). The sweep moves exactly those: a case whose notice arrived through
   * `erp_sync`. A notice another channel delivered is left to its own read, a
   * case with no notice at all (ADR 0029's crash window) is left alone, and so
   * is another tenant's.
   */
  it('moves the ledger cases stuck in discovered, and nothing else, once', async () => {
    async function stuckCase(
      org: string,
      label: string,
      source: 'erp_sync' | 'web_upload' | undefined,
    ): Promise<string> {
      const { rows } = await admin.query<{ id: string }>(
        `insert into deductions (org_id, claim_id, deduction_amount_cents, state)
         values ($1, $2, 4_500, 'discovered') returning id`,
        [org, `STUCK-${suffix}-${label}`],
      );
      const deductionId = rows[0]?.id as string;
      if (source === undefined) return deductionId;
      const uploadId = randomUUID();
      const documentId = randomUUID();
      await admin.query(`insert into uploads (id, org_id, source, created_by) values ($1,$2,$3,$4)`, [
        uploadId,
        org,
        source,
        source === 'web_upload' ? analystId : null,
      ]);
      await admin.query(
        `insert into documents (id, org_id, upload_id, sha256, byte_size, mime_type, storage_ref, filename)
         values ($1,$2,$3,$4,64,$5,$6,$7)`,
        [
          documentId,
          org,
          uploadId,
          Buffer.from(randomUUID().replace(/-/g, ''), 'hex'),
          source === 'erp_sync' ? 'application/json' : 'application/pdf',
          `db://${documentId}`,
          source === 'erp_sync' ? 'ledger.json' : 'notice.pdf',
        ],
      );
      await admin.query(
        `insert into deduction_documents (org_id, deduction_id, document_id, role)
         values ($1,$2,$3,'notice')`,
        [org, deductionId, documentId],
      );
      return deductionId;
    }

    const ledger = await stuckCase(orgId, 'ledger', 'erp_sync');
    const notice = await stuckCase(orgId, 'notice', 'web_upload');
    const orphan = await stuckCase(orgId, 'orphan', undefined);
    const theirs = await stuckCase(otherOrgId, 'theirs', 'erp_sync');

    expect(await discovery.classifyLedgerCases(orgId)).toEqual([ledger]);
    // Idempotent: the next run finds nothing and writes nothing.
    expect(await discovery.classifyLedgerCases(orgId)).toEqual([]);

    const { rows } = await admin.query<{ id: string; state: string; classified: string }>(
      `select d.id::text as id, d.state,
              (select count(*) from deduction_events e
                where e.deduction_id = d.id and e.event_type = 'case.classified')::text as classified
         from deductions d where d.id = any ($1::uuid[])`,
      [[ledger, notice, orphan, theirs]],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(ledger)).toMatchObject({ state: 'classified', classified: '1' });
    expect(byId.get(notice)).toMatchObject({ state: 'discovered', classified: '0' });
    expect(byId.get(orphan)).toMatchObject({ state: 'discovered', classified: '0' });
    expect(byId.get(theirs)).toMatchObject({ state: 'discovered', classified: '0' });
  });

  it('declines a candidate that never became a case, and only once', async () => {
    const identifiers = { ledgerInvoiceId: 'inv-tiny', invoiceNumber: 'INV-TINY' };
    const first = await discovery.declineCandidate({
      orgId,
      reason: 'below_economic_floor',
      estimatedRecoverableCents: 12,
      identifiers,
      customerExternalId: 'cust-9',
      customerName: 'Sysco Baltimore, LLC',
      detail: 'the gap of 12 cents is below the 2500-cent dispute floor',
    });
    expect(first.written).toBe(true);

    const second = await discovery.declineCandidate({
      orgId,
      reason: 'below_economic_floor',
      estimatedRecoverableCents: 12,
      identifiers,
      customerExternalId: 'cust-9',
      customerName: 'Sysco Baltimore, LLC',
    });
    expect(second.written).toBe(false);
    expect(second.declinedCandidateId).toBe(first.declinedCandidateId);

    const { rows } = await admin.query<{
      deduction_id: string | null;
      discovered_from: string;
      reason: string;
      amount: string;
      decided_by: string;
      decided_by_version: string;
      external_ids: Record<string, string>;
    }>(
      `select deduction_id, discovered_from, reason,
              estimated_recoverable_cents::text as amount,
              decided_by, decided_by_version, external_ids
         from declined_candidates where id = $1`,
      [first.declinedCandidateId],
    );
    const row = rows[0];
    // Null on purpose: migration 0014 made the column nullable for exactly this
    // — a candidate triage declined that never reached extraction.
    expect(row?.deduction_id).toBeNull();
    expect(row?.discovered_from).toBe('erp_sync');
    expect(row?.reason).toBe('below_economic_floor');
    expect(row?.amount).toBe('12');
    expect(row?.decided_by).toBe(TRIAGE_DECIDED_BY);
    expect(row?.decided_by_version).toBe(TRIAGE_DECIDED_BY_VERSION);
    // Who deducted, verbatim and recorded now, because a candidate that never
    // became a case has no debtor_id and a per-debtor cut of coverage cannot be
    // reconstructed from anything else on the row (ADR 0030 §7).
    expect(row?.external_ids).toEqual({
      ledger_invoice_id: 'inv-tiny',
      invoice_number: 'INV-TINY',
      customer_external_id: 'cust-9',
      customer_name: 'Sysco Baltimore, LLC',
    });
  });

  it('hands back the identity state a later sync matches against', async () => {
    const identifiers = await discovery.knownIdentifiers(orgId);
    expect(identifiers.some((i) => i.identifier === 'inv-1' && i.kind === 'ledger_invoice_id')).toBe(
      true,
    );
    expect(identifiers.every((i) => i.source === 'erp_sync')).toBe(true);

    const deductions = await discovery.knownDeductions(orgId);
    const opened = deductions.find((d) => d.deductionId === recorded0());
    expect(opened?.amountCents).toBe(80_000);
    expect(opened?.invoiceNumber).toBe('INV-1001');
    expect(opened?.deductionDate).toBe('2026-07-20');
  });

  /**
   * The whole reason a ledger extract is a document (ADR 0029 §1): the case is
   * declinable on the day it is opened, and the channel is derived from its own
   * notice rather than taken from a caller.
   */
  it('lets declineCase attribute the case to erp_sync without being told', async () => {
    const declined = await store.declineCase({
      deductionId: recorded0(),
      reason: 'deduction_valid',
      decidedBy: analystId,
    });
    expect(declined.discoveredFrom).toBe('erp_sync');
    expect(declined.provenanceKind).toBe('observed');
    expect(declined.estimatedRecoverableCents).toBe(80_000);
  });

  it('refuses to act for another tenant', async () => {
    await expect(discovery.knownIdentifiers(otherOrgId)).rejects.toThrow(DiscoveryStoreError);
    await expect(discovery.classifyLedgerCases(otherOrgId)).rejects.toThrow(DiscoveryStoreError);
    await expect(
      discovery.declineCandidate({
        orgId: otherOrgId,
        reason: 'below_economic_floor',
        estimatedRecoverableCents: 1,
        identifiers: { ledgerInvoiceId: 'x', invoiceNumber: 'y' },
        customerExternalId: 'cust-x',
        customerName: 'Somebody Else',
      }),
    ).rejects.toThrow(DiscoveryStoreError);
  });
});

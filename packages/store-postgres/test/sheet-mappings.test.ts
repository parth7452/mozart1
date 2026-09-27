import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { ResultCell } from '@recouple/pipeline';
import { closeAllPools, PostgresStore } from '../src/store';

/**
 * Sheet mappings and the cell each field came from (ADR 0056, migration 0036),
 * through `PostgresStore` as `app_rw`: a mapping versions per (org, debtor,
 * fingerprint), the lookup is the latest effective version with an exactly
 * equal fingerprint, and a cell cannot be written into another tenant.
 */

const connectionString = process.env.TEST_DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

describeDb('sheet mappings and result cells, on Postgres', () => {
  const admin = new Pool({ connectionString });
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const analystId = randomUUID();
  const otherAnalystId = randomUUID();
  const debtorId = randomUUID();
  const suffix = orgId.slice(0, 8);
  const config = { connectionString: connectionString as string };
  let store: PostgresStore;
  let other: PostgresStore;

  async function extractionResult(org: string): Promise<string> {
    const { rows: docs } = await admin.query<{ id: string }>(
      `insert into documents (org_id, sha256, byte_size, mime_type, storage_ref, filename)
       values ($1, $2, 4, 'text/csv', $3, 'r.csv') returning id`,
      [org, Buffer.from(randomUUID().replace(/-/g, '').padEnd(64, '0'), 'hex'), `doc/${randomUUID()}`],
    );
    const { rows } = await admin.query<{ id: string }>(
      `insert into extraction_results (org_id, document_id, field_path, value_json, confidence,
         source_page, source_quote, quote_verified, extractor, model_version, schema_version)
       values ($1, $2, 'lines[0].deduction_amount', '"500.00"', 1, 1, '500.00', true,
               'sheet', 'none', '1.0.0') returning id::text`,
      [org, docs[0]?.id],
    );
    return rows[0]?.id as string;
  }

  function cell(extractionResultId: string): ResultCell {
    return {
      extractionResultId,
      sheetName: 'Sheet1',
      rowNumber: 2,
      columnNumber: 3,
      cellRef: 'C2',
      cellType: 'number',
      numberFormat: '#,##0.00',
      wasFormula: true,
    };
  }

  const base = {
    headerRow: 1,
    sheetName: 'Sheet1',
    headerFingerprint: ['Invoice', 'Amount'],
    shape: 'remittance' as const,
    columns: { invoice_number: 1, deduction_amount: 2 },
    nonLineRule: { blankColumn: 1 },
    sign: 'deductions_positive' as const,
    currency: 'USD',
    dateOrder: 'mdy' as const,
    sourceDocumentId: null,
  };

  beforeAll(async () => {
    await admin.query(
      `insert into organizations (id, slug, name) values ($1,$2,'Sheet'), ($3,$4,'Sheet Other')`,
      [orgId, `sheet-${suffix}`, otherOrgId, `sheet-other-${suffix}`],
    );
    await admin.query('insert into org_settings (org_id) values ($1), ($2)', [orgId, otherOrgId]);
    await admin.query('insert into users (id, email) values ($1,$2), ($3,$4)', [
      analystId,
      `sheet-analyst-${suffix}@example.test`,
      otherAnalystId,
      `sheet-other-${suffix}@example.test`,
    ]);
    await admin.query(
      `insert into memberships (org_id, user_id, role) values ($1,$2,'analyst'), ($3,$4,'analyst')`,
      [orgId, analystId, otherOrgId, otherAnalystId],
    );
    await admin.query(
      `insert into debtors (id, org_id, retailer_key, display_name) values ($1, $2, 'sysco', 'Sysco')`,
      [debtorId, orgId],
    );
    store = new PostgresStore(config, { orgId, userId: analystId });
    other = new PostgresStore(config, { orgId: otherOrgId, userId: otherAnalystId });
  });

  afterAll(async () => {
    await admin.end();
    await closeAllPools();
  });

  it('records versions and finds the latest effective one by exact fingerprint', async () => {
    const v1 = await store.recordSheetMapping({
      ...base,
      orgId,
      debtorId,
      effectiveFrom: '2026-09-01',
      confirmedBy: analystId,
    });
    const v2 = await store.recordSheetMapping({
      ...base,
      orgId,
      debtorId,
      effectiveFrom: '2026-09-20',
      columns: { invoice_number: 1, deduction_amount: 3 },
      confirmedBy: analystId,
    });
    expect([v1.version, v2.version]).toEqual([1, 2]);
    expect(await store.sheetMappingFor(orgId, ['Invoice', 'Amount'], '2026-09-27')).toEqual(v2);
    expect((await store.sheetMappingFor(orgId, ['Invoice', 'Amount'], '2026-09-10'))?.version).toBe(1);
    expect(await store.sheetMappingFor(orgId, ['Invoice', 'Amount'], '2026-08-01')).toBeUndefined();
    expect(await store.sheetMappingFor(orgId, ['Invoice'], '2026-09-27')).toBeUndefined();
    expect(await store.sheetMappingFor(orgId, ['Amount', 'Invoice'], '2026-09-27')).toBeUndefined();
    expect(await other.sheetMappingFor(orgId, ['Invoice', 'Amount'], '2026-09-27')).toBeUndefined();
  });

  it('refuses a mapping confirmed in someone else\'s name', async () => {
    await expect(
      store.recordSheetMapping({
        ...base,
        orgId,
        debtorId,
        effectiveFrom: '2026-09-01',
        confirmedBy: otherAnalystId,
      }),
    ).rejects.toThrow(/confirmed_by/);
  });

  it('records and reads back cells, and refuses one into another tenant', async () => {
    const mine = await extractionResult(orgId);
    await store.recordResultCells(orgId, [cell(mine)]);
    expect(await store.resultCellsFor([mine])).toEqual([cell(mine)]);
    expect(await other.resultCellsFor([mine])).toEqual([]);

    const theirs = await extractionResult(orgId);
    await expect(other.recordResultCells(orgId, [cell(theirs)])).rejects.toThrow(/row-level security/);
    await expect(other.recordResultCells(otherOrgId, [cell(theirs)])).rejects.toThrow(/foreign key/);
  });
});

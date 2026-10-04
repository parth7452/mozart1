import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  CANONICAL_REASON_CODE_LIST,
  isCanonicalReasonCode,
  resolveCanonicalCode,
  type CanonicalReasonCode,
  type PayerTermsAnswer,
} from '@recouple/core-domain';
import { closeAllPools, PostgresStore } from '../src/store';
import {
  PayerCodeMapRefusedError,
  PostgresPayerCodeMapStore,
  type NewPayerCodeMap,
} from '../src/payer-code-maps';

/**
 * Payer code mappings (ADR 0066, migration 0040) through
 * `PostgresPayerCodeMapStore` as `app_rw`, with two tenants.
 *
 * Four things are held here that a list of strings or a suite of SQL cannot:
 *
 * 1. the canonical list in the check constraint equals `CANONICAL_REASON_CODES`
 *    in both directions, read off `pg_constraint` (as `doc-types.test.ts` does
 *    for document types), so a code added to the taxonomy needs a migration;
 * 2. who may write, as the store names the refusal;
 * 3. `app.payer_code_maps_as_of()` and `resolveCanonicalCode` give one answer
 *    for every date across a supersession and an expiry;
 * 4. the case read and the reconciliation list, with a code derived from a
 *    linked notice by the real `payerTermsForCases`.
 */

const connectionString = process.env.TEST_DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

describeDb('payer code maps, on Postgres', () => {
  const admin = new Pool({ connectionString });
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const approverId = randomUUID();
  const analystId = randomUUID();
  const otherApproverId = randomUUID();
  const debtorId = randomUUID();
  const secondDebtorId = randomUUID();
  const otherDebtorId = randomUUID();
  const suffix = orgId.slice(0, 8);
  const config = { connectionString: connectionString as string };
  let approver: PostgresPayerCodeMapStore;
  let analyst: PostgresPayerCodeMapStore;
  let other: PostgresPayerCodeMapStore;
  let cases: PostgresStore;

  const base: Omit<NewPayerCodeMap, 'payerCode' | 'canonicalCode' | 'effectiveFrom'> = {
    debtorId,
    source: 'customer_confirmed',
    confidence: 'high',
  };

  beforeAll(async () => {
    await admin.query(
      `insert into organizations (id, slug, name) values ($1,$2,'Codes'), ($3,$4,'Codes Other')`,
      [orgId, `codes-${suffix}`, otherOrgId, `codes-other-${suffix}`],
    );
    await admin.query('insert into org_settings (org_id) values ($1), ($2)', [orgId, otherOrgId]);
    await admin.query('insert into users (id, email) values ($1,$2), ($3,$4), ($5,$6)', [
      approverId,
      `codes-approver-${suffix}@example.test`,
      analystId,
      `codes-analyst-${suffix}@example.test`,
      otherApproverId,
      `codes-other-${suffix}@example.test`,
    ]);
    await admin.query(
      `insert into memberships (org_id, user_id, role)
       values ($1,$2,'approver'), ($1,$3,'analyst'), ($4,$5,'owner')`,
      [orgId, approverId, analystId, otherOrgId, otherApproverId],
    );
    await admin.query(
      `insert into debtors (id, org_id, retailer_key, display_name)
       values ($1,$2,'unfi','UNFI'), ($3,$2,'kehe','KeHE'), ($4,$5,'unfi','UNFI')`,
      [debtorId, orgId, secondDebtorId, otherDebtorId, otherOrgId],
    );
    approver = new PostgresPayerCodeMapStore(config, { orgId, userId: approverId });
    analyst = new PostgresPayerCodeMapStore(config, { orgId, userId: analystId });
    other = new PostgresPayerCodeMapStore(config, { orgId: otherOrgId, userId: otherApproverId });
    cases = new PostgresStore(config, { orgId, userId: analystId });
  });

  afterAll(async () => {
    await cases?.close();
    await closeAllPools();
    await admin.end();
  });

  it('admits exactly the canonical reason codes, and no others', async () => {
    const { rows } = await admin.query<{ def: string }>(
      `select pg_get_constraintdef(c.oid) as def
         from pg_constraint c
        where c.conrelid = 'payer_code_maps'::regclass
          and c.conname = 'payer_code_maps_canonical_code_check'`,
    );
    const def = rows[0]?.def;
    expect(def, 'payer_code_maps_canonical_code_check exists').toBeDefined();
    const admitted = [...(def as string).matchAll(/'([a-z0-9_]+)'::text/g)].map((m) => m[1] as string);

    // Both directions, separately, so a failure says which way the drift went.
    expect(
      CANONICAL_REASON_CODE_LIST.filter((code) => !admitted.includes(code)),
      'the constraint admits every canonical code: a code added to the taxonomy needs a migration',
    ).toEqual([]);
    expect(
      admitted.filter((code) => !isCanonicalReasonCode(code)),
      'and admits nothing the taxonomy does not have',
    ).toEqual([]);
    expect(new Set(admitted).size, 'with no code listed twice').toBe(admitted.length);
    expect([...admitted].sort()).toEqual([...CANONICAL_REASON_CODE_LIST].sort());
  });

  it('records a mapping normalised, as the member who wrote it', async () => {
    const row = await approver.recordPayerCodeMap({
      ...base,
      payerCode: '  cb-203 ',
      canonicalCode: 'price_discrepancy',
      effectiveFrom: '2026-01-01',
      sourceNote: 'AP lead, by phone',
    });
    expect(row).toMatchObject({
      orgId,
      debtorId,
      payerCode: 'CB-203',
      canonicalCode: 'price_discrepancy',
      effectiveFrom: '2026-01-01',
      source: 'customer_confirmed',
      sourceNote: 'AP lead, by phone',
      confidence: 'high',
      recordedBy: approverId,
    });
    expect(row.effectiveTo).toBeUndefined();
  });

  it('refuses an analyst, by name, and writes nothing', async () => {
    const refusal = analyst.recordPayerCodeMap({
      ...base,
      payerCode: 'ANALYST-1',
      canonicalCode: 'price_discrepancy',
      effectiveFrom: '2026-01-01',
    });
    await expect(refusal).rejects.toBeInstanceOf(PayerCodeMapRefusedError);
    await expect(refusal).rejects.toMatchObject({ refusal: 'not_permitted' });
    const { rows } = await admin.query(
      `select 1 from payer_code_maps where org_id = $1 and payer_code = 'ANALYST-1'`,
      [orgId],
    );
    expect(rows).toHaveLength(0);
    // An analyst still reads them.
    expect((await analyst.payerCodeMapsFor(debtorId)).map((r) => r.payerCode)).toContain('CB-203');
  });

  it('refuses another tenant\'s debtor, a repeat and a field the table would not take', async () => {
    await expect(
      approver.recordPayerCodeMap({
        ...base,
        debtorId: otherDebtorId,
        payerCode: 'CB-203',
        canonicalCode: 'price_discrepancy',
        effectiveFrom: '2026-01-01',
      }),
    ).rejects.toMatchObject({ refusal: 'unknown_debtor' });
    await expect(
      approver.recordPayerCodeMap({
        ...base,
        payerCode: 'cb-203',
        canonicalCode: 'shortage_carton',
        effectiveFrom: '2026-01-01',
      }),
    ).rejects.toMatchObject({ refusal: 'already_recorded' });
    await expect(
      approver.recordPayerCodeMap({
        ...base,
        payerCode: '   ',
        canonicalCode: 'price_discrepancy',
        effectiveFrom: '2026-01-01',
      }),
    ).rejects.toMatchObject({ refusal: 'invalid', field: 'payerCode' });
    await expect(
      approver.recordPayerCodeMap({
        ...base,
        payerCode: 'X',
        canonicalCode: 'premium_noauth' as CanonicalReasonCode,
        effectiveFrom: '2026-01-01',
      }),
    ).rejects.toMatchObject({ refusal: 'invalid', field: 'canonicalCode' });
    await expect(
      approver.recordPayerCodeMap({
        ...base,
        payerCode: 'X',
        canonicalCode: 'price_discrepancy',
        effectiveFrom: '2026-02-01',
        effectiveTo: '2026-01-01',
      }),
    ).rejects.toMatchObject({ refusal: 'invalid', field: 'effectiveTo' });
    await expect(
      approver.recordPayerCodeMap({
        ...base,
        payerCode: 'X',
        canonicalCode: 'price_discrepancy',
        effectiveFrom: '2026-02-30',
      }),
    ).rejects.toMatchObject({ refusal: 'invalid', field: 'effectiveFrom' });
  });

  it('supersedes with a later row, lets a dated row expire, and agrees with the pure rule on every date', async () => {
    await approver.recordPayerCodeMap({
      ...base,
      payerCode: 'CB-203',
      canonicalCode: 'unauthorised_deduction_no_basis',
      effectiveFrom: '2026-03-01',
      effectiveTo: '2026-03-31',
      source: 'operator',
      confidence: 'medium',
    });
    await approver.recordPayerCodeMap({
      ...base,
      payerCode: 'CB-203',
      canonicalCode: 'promo_not_agreed',
      effectiveFrom: '2026-06-01',
      source: 'payer_guide_url',
      confidence: 'low',
    });
    await approver.recordPayerCodeMap({
      ...base,
      payerCode: 'MCB',
      canonicalCode: 'promo_allowance_claimed',
      effectiveFrom: '2026-02-01',
      effectiveTo: '2026-02-28',
    });

    const history = await approver.payerCodeMapsFor(debtorId);
    expect(history.filter((r) => r.payerCode === 'CB-203').map((r) => r.effectiveFrom)).toEqual([
      '2026-06-01',
      '2026-03-01',
      '2026-01-01',
    ]);

    const at = async (asOf: string) =>
      Object.fromEntries((await approver.currentPayerCodeMaps(debtorId, asOf)).map((r) => [r.payerCode, r.canonicalCode]));
    expect(await at('2025-12-31')).toEqual({});
    expect(await at('2026-01-01')).toEqual({ 'CB-203': 'price_discrepancy' });
    expect(await at('2026-02-10')).toEqual({ 'CB-203': 'price_discrepancy', MCB: 'promo_allowance_claimed' });
    // The dated row wins through its last day, then never again.
    expect(await at('2026-03-31')).toEqual({ 'CB-203': 'unauthorised_deduction_no_basis' });
    expect(await at('2026-04-01')).toEqual({ 'CB-203': 'price_discrepancy' });
    expect(await at('2026-06-01')).toEqual({ 'CB-203': 'promo_not_agreed' });

    // One rule, two statements of it: SQL's and core-domain's.
    for (const asOf of [
      '2025-12-31', '2026-01-01', '2026-01-31', '2026-02-01', '2026-02-28', '2026-03-01',
      '2026-03-31', '2026-04-01', '2026-05-31', '2026-06-01', '2027-01-01',
    ]) {
      const sql = await approver.currentPayerCodeMaps(debtorId, asOf);
      for (const payerCode of ['CB-203', 'MCB', 'NEVER']) {
        expect(
          resolveCanonicalCode(history, { payerCode, asOf })?.id,
          `${payerCode} as of ${asOf}`,
        ).toBe(sql.find((r) => r.payerCode === payerCode)?.id);
      }
    }

    const listed = await approver.allCurrentPayerCodeMaps('2026-06-01');
    expect(listed.map((r) => [r.debtorName, r.payerCode, r.canonicalCode])).toEqual([
      ['UNFI', 'CB-203', 'promo_not_agreed'],
    ]);
  });

  it('keeps one tenant\'s mappings from another', async () => {
    expect(await other.payerCodeMapsFor(debtorId)).toEqual([]);
    expect(await other.currentPayerCodeMaps(debtorId, '2026-06-01')).toEqual([]);
    expect(await other.allCurrentPayerCodeMaps('2026-06-01')).toEqual([]);
    expect((await other.mappableDebtors()).map((d) => d.debtorId)).toEqual([otherDebtorId]);
    expect((await approver.mappableDebtors()).map((d) => d.displayName)).toEqual(['KeHE', 'UNFI']);

    // The same code in the other tenant is the other tenant's own row.
    const theirs = await other.recordPayerCodeMap({
      debtorId: otherDebtorId,
      payerCode: 'CB-203',
      canonicalCode: 'shortage_carton',
      effectiveFrom: '2026-01-01',
      source: 'operator',
      confidence: 'low',
    });
    expect(theirs.orgId).toBe(otherOrgId);
    expect((await approver.currentPayerCodeMaps(debtorId, '2026-06-01'))[0]?.canonicalCode).toBe(
      'promo_not_agreed',
    );
  });

  it('refuses UPDATE and DELETE to the app role', async () => {
    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query('set local role app_rw');
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ org_id: orgId, sub: approverId }),
      ]);
      await expect(
        client.query(`update payer_code_maps set canonical_code = 'shortage_carton'`),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
  });

  async function openCase(input: {
    debtor: string | null;
    code: string | null;
    amountCents: number;
    date: string | null;
    printedName?: string;
  }): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `insert into deductions (org_id, debtor_id, claim_id, deduction_amount_cents, deduction_date,
         state, reason_code_as_printed, retailer_name_as_printed)
       values ($1,$2,$3,$4,$5::date,'classified',$6,$7) returning id`,
      [orgId, input.debtor, `CLM-${randomUUID()}`, input.amountCents, input.date, input.code, input.printedName ?? null],
    );
    return rows[0]?.id as string;
  }

  /** A classified notice whose line 0 prints a code and an amount, linked to a case. */
  async function linkNotice(deductionId: string, code: string, amount: string): Promise<void> {
    const upload = await cases.recordUpload({ orgId, source: 'web_upload', createdBy: analystId });
    const stored = await cases.putDocument({
      orgId,
      sha256: createHash('sha256').update(`${suffix}:${deductionId}`).digest('hex'),
      byteSize: 10,
      mimeType: 'application/pdf',
      filename: 'notice.pdf',
      bytes: new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52, 10, 10]),
      requiresSplit: false,
      uploadId: upload.uploadId,
    });
    await admin.query(
      `insert into document_classifications (org_id, document_id, doc_type, confidence)
       values ($1,$2,'deduction_notice',0.97)`,
      [orgId, stored.documentId],
    );
    for (const [path, value] of [
      ['lines[0].reason_code', code],
      ['lines[0].deduction_amount', amount],
    ] as const) {
      await admin.query(
        `insert into extraction_results
           (org_id, document_id, deduction_id, field_path, value_json, confidence,
            source_page, source_quote, quote_verified, extractor, schema_version, model_version)
         values ($1,$2,null,$3,$4::jsonb,0.98,1,$5,true,'test','1','test')`,
        [orgId, stored.documentId, path, JSON.stringify(value), value],
      );
    }
    await cases.attachEvidence({ orgId, deductionId, documentId: stored.documentId, docType: 'deduction_notice' });
  }

  it('answers what a case\'s payer code maps to, on the day its deduction was taken', async () => {
    const inMarch = await openCase({ debtor: debtorId, code: 'cb-203', amountCents: 10_000, date: '2026-03-15' });
    const inJuly = await openCase({ debtor: debtorId, code: 'CB-203', amountCents: 20_000, date: '2026-07-01' });
    const early = await openCase({ debtor: debtorId, code: 'CB-203', amountCents: 30_000, date: '2025-11-01' });
    const unseen = await openCase({ debtor: debtorId, code: 'PREMIUM-NOAUTH', amountCents: 40_000, date: '2026-07-01' });
    const noDebtor = await openCase({ debtor: null, code: 'CB-203', amountCents: 50_000, date: '2026-07-01', printedName: 'UNFI West' });
    const noCode = await openCase({ debtor: debtorId, code: null, amountCents: 60_000, date: '2026-07-01' });
    const tooLong = await openCase({ debtor: debtorId, code: 'X'.repeat(80), amountCents: 100, date: '2026-07-01' });

    const march = await approver.payerCodeMappingForCase(inMarch, { kind: 'own' });
    expect(march).toMatchObject({
      kind: 'mapped',
      payerCode: 'CB-203',
      asOf: '2026-03-15',
      map: { canonicalCode: 'unauthorised_deduction_no_basis', source: 'operator', confidence: 'medium' },
    });
    expect(await approver.payerCodeMappingForCase(inJuly, { kind: 'own' })).toMatchObject({
      kind: 'mapped',
      map: { canonicalCode: 'promo_not_agreed' },
    });
    expect(await approver.payerCodeMappingForCase(early, { kind: 'own' })).toEqual({
      kind: 'unmapped',
      payerCode: 'CB-203',
      debtorId,
      asOf: '2025-11-01',
      mappable: true,
    });
    expect(await approver.payerCodeMappingForCase(unseen, undefined)).toMatchObject({
      kind: 'unmapped',
      payerCode: 'PREMIUM-NOAUTH',
      mappable: true,
    });
    expect(await approver.payerCodeMappingForCase(noDebtor, { kind: 'own' })).toEqual({
      kind: 'no_debtor',
      payerCode: 'CB-203',
    });
    expect(await approver.payerCodeMappingForCase(noCode, { kind: 'none' })).toEqual({ kind: 'no_code' });
    expect(await approver.payerCodeMappingForCase(tooLong, { kind: 'own' })).toMatchObject({
      kind: 'unmapped',
      mappable: false,
    });
    // A derived code is used when the case printed none of its own.
    const derived: PayerTermsAnswer = {
      kind: 'derived',
      terms: { reasonCode: 'cb-203', documentId: randomUUID(), fieldPath: 'lines[0].reason_code', quoteVerified: true },
    };
    expect(await approver.payerCodeMappingForCase(noCode, derived)).toMatchObject({
      kind: 'mapped',
      payerCode: 'CB-203',
    });
    // Another tenant's case is no case.
    expect(await other.payerCodeMappingForCase(inJuly, { kind: 'own' })).toEqual({ kind: 'no_code' });
  });

  it('lists the payer codes with no mapping, with their cases and dollars', async () => {
    // Two more for PREMIUM-NOAUTH (one in other spacing and case), one on the
    // second debtor, and a ledger-style case whose code comes from its notice.
    await openCase({ debtor: debtorId, code: ' premium-noauth', amountCents: 5_000, date: '2026-08-01' });
    await openCase({ debtor: secondDebtorId, code: 'CB-203', amountCents: 7_500, date: '2026-08-01' });
    const fromNotice = await openCase({ debtor: secondDebtorId, code: null, amountCents: 80_000, date: '2026-08-01' });
    await linkNotice(fromNotice, 'Spoils', '$800.00');

    const list = await approver.unmappedPayerCodes(cases);
    expect(list.truncated).toBe(false);
    expect(list.casesExamined).toBe(10);
    expect(list.casesWithCode).toBe(9);
    // CB-203 on UNFI in March and in July.
    expect(list.casesMapped).toBe(2);
    expect(list.rows).toEqual([
      { payerCode: 'SPOILS', debtorId: secondDebtorId, debtorName: 'KeHE', caseCount: 1, totalCents: 80_000, mappable: true },
      { payerCode: 'CB-203', printedName: 'UNFI West', caseCount: 1, totalCents: 50_000, mappable: false },
      { payerCode: 'PREMIUM-NOAUTH', debtorId, debtorName: 'UNFI', caseCount: 2, totalCents: 45_000, mappable: true },
      // The November case: CB-203 had no mapping in force yet.
      { payerCode: 'CB-203', debtorId, debtorName: 'UNFI', caseCount: 1, totalCents: 30_000, mappable: true },
      { payerCode: 'CB-203', debtorId: secondDebtorId, debtorName: 'KeHE', caseCount: 1, totalCents: 7_500, mappable: true },
      { payerCode: 'X'.repeat(80), debtorId, debtorName: 'UNFI', caseCount: 1, totalCents: 100, mappable: false },
    ]);

    // Mapping it takes it off the list, and only for the debtor it was mapped for.
    await approver.recordPayerCodeMap({
      ...base,
      payerCode: 'Premium-NoAuth',
      canonicalCode: 'unauthorised_deduction_no_basis',
      effectiveFrom: '2026-01-01',
    });
    const after = await approver.unmappedPayerCodes(cases);
    expect(after.rows.some((r) => r.payerCode === 'PREMIUM-NOAUTH')).toBe(false);
    expect(after.casesMapped).toBe(4);
    expect(after.rows.filter((r) => r.payerCode === 'CB-203')).toHaveLength(3);

    // The other tenant has no cases, so nothing to reconcile.
    const otherCases = new PostgresStore(config, { orgId: otherOrgId, userId: otherApproverId });
    try {
      expect(await other.unmappedPayerCodes(otherCases)).toEqual({
        rows: [],
        casesExamined: 0,
        casesWithCode: 0,
        casesMapped: 0,
        truncated: false,
      });
    } finally {
      await otherCases.close();
    }
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { Pool } from 'pg';
import { isCanonicalReasonCode, isStorablePayerCode, proposedPayerCodeMapsFromDraft } from '@recouple/core-domain';
import { closeAllPools } from '@recouple/store-postgres';
import { seedPayerCodes } from '../seed-payer-codes-run';

/**
 * What the four Glimpse playbook drafts actually hold, read through the loader
 * `pnpm seed:payer-codes` uses. Pinned so a draft edited to carry a pair the
 * loader cannot place, or a loader change that starts proposing shapes, shows
 * up here (ADR 0067, "What the four Glimpse drafts actually hold"). Then the
 * command's database half, against the scratch database.
 */

const DRAFTS = join(__dirname, '..', '..', 'docs', 'competitive', 'glimpse', 'playbook-drafts');
const load = (name: string) =>
  proposedPayerCodeMapsFromDraft(parse(readFileSync(join(DRAFTS, `${name}.yaml`), 'utf8')));

describe('the Glimpse playbook drafts, as proposed payer code maps', () => {
  it("proposes Chewy's sixteen printed names, each at low confidence from the guide", () => {
    const table = load('chewy');
    expect(table.retailerKey).toBe('chewy');
    expect(table.skipped).toEqual([]);
    expect(table.proposed).toHaveLength(16);
    expect(table.proposed.find((r) => r.printed === 'No Call No Show (NCNS)')).toMatchObject({
      payerCode: 'NO CALL NO SHOW (NCNS)',
      canonicalCode: 'compliance_appointment_missed',
      source: 'glimpse_guide',
      confidence: 'low',
    });
    for (const row of table.proposed) {
      expect(isCanonicalReasonCode(row.canonicalCode)).toBe(true);
      expect(isStorablePayerCode(row.payerCode)).toBe(true);
      expect(row.sourceNote).toContain('tryglimpse.com');
    }
  });

  it('proposes nothing for UNFI: every mapped entry is a shape, not a code', () => {
    const table = load('unfi');
    expect(table.proposed).toEqual([]);
    expect(table.skipped.filter((s) => s.reason === 'shape_not_code').map((s) => s.printed)).toEqual([
      'UOI(mmyy)',
      'MCB(yyyymmdd)',
      '[DC#]CNDM(mmmyy)',
      'LCPV(PO#)',
      'LCP(PO#)',
      'LCBOL(PO#)',
      'AVL(PO#)',
    ]);
    expect(table.skipped.filter((s) => s.reason === 'unmapped_in_draft')).toHaveLength(4);
    expect(table.skipped).toHaveLength(11);
  });

  it('finds no pairs in KeHE or Walgreens, which list categories only', () => {
    expect(load('kehe')).toEqual({ retailerKey: 'kehe', proposed: [], skipped: [] });
    expect(load('walgreens')).toMatchObject({ proposed: [], skipped: [] });
  });
});

const connectionString = process.env.TEST_DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

describeDb('pnpm seed:payer-codes, against Postgres', () => {
  const admin = new Pool({ connectionString });
  const orgId = randomUUID();
  const ownerId = randomUUID();
  const analystId = randomUUID();
  const debtorId = randomUUID();
  const suffix = orgId.slice(0, 8);
  const slug = `seed-codes-${suffix}`;
  const config = { connectionString: connectionString as string };
  const count = async (): Promise<number> => {
    const { rows } = await admin.query<{ n: number }>(
      `select count(*)::int as n from payer_code_maps where org_id = $1`,
      [orgId],
    );
    return rows[0]?.n ?? -1;
  };
  const run = (over: Partial<Parameters<typeof seedPayerCodes>[0]> = {}) =>
    seedPayerCodes({
      config,
      slug,
      actorEmail: `seed-owner-${suffix}@example.test`,
      debtor: 'chewy',
      table: load('chewy'),
      effectiveFrom: '2026-10-01',
      write: false,
      today: '2026-10-04',
      log: () => undefined,
      ...over,
    });

  beforeAll(async () => {
    await admin.query(`insert into organizations (id, slug, name) values ($1,$2,'Seed codes')`, [orgId, slug]);
    await admin.query('insert into org_settings (org_id) values ($1)', [orgId]);
    await admin.query('insert into users (id, email) values ($1,$2), ($3,$4)', [
      ownerId,
      `seed-owner-${suffix}@example.test`,
      analystId,
      `seed-analyst-${suffix}@example.test`,
    ]);
    await admin.query(
      `insert into memberships (org_id, user_id, role) values ($1,$2,'owner'), ($1,$3,'analyst')`,
      [orgId, ownerId, analystId],
    );
    await admin.query(
      `insert into debtors (id, org_id, retailer_key, display_name) values ($1,$2,'chewy','Chewy')`,
      [debtorId, orgId],
    );
  });

  afterAll(async () => {
    await closeAllPools();
    await admin.end();
  });

  it('writes nothing on a dry run, which is the default', async () => {
    expect(await run()).toEqual({ inserted: 0, alreadyMapped: 0, wouldInsert: 16, refused: 0 });
    expect(await count()).toBe(0);
  });

  it('refuses an analyst, an unknown debtor and a write with no start date', async () => {
    await expect(run({ actorEmail: `seed-analyst-${suffix}@example.test`, write: true })).rejects.toThrow(
      /only an owner or approver/,
    );
    await expect(run({ debtor: 'no_such_payer', write: true })).rejects.toThrow(/never creates one/);
    await expect(run({ effectiveFrom: undefined, write: true })).rejects.toThrow(/effective-from/);
    expect(await count()).toBe(0);
  });

  it('inserts the proposals as the member, at low confidence, and leaves them alone the second time', async () => {
    expect(await run({ write: true, debtor: debtorId })).toEqual({
      inserted: 16,
      alreadyMapped: 0,
      wouldInsert: 0,
      refused: 0,
    });
    const { rows } = await admin.query(
      `select distinct source, confidence, recorded_by, effective_from::text as effective_from
         from payer_code_maps where org_id = $1 and debtor_id = $2`,
      [orgId, debtorId],
    );
    expect(rows).toEqual([
      { source: 'glimpse_guide', confidence: 'low', recorded_by: ownerId, effective_from: '2026-10-01' },
    ]);
    expect(await run({ write: true })).toEqual({ inserted: 0, alreadyMapped: 16, wouldInsert: 0, refused: 0 });
    expect(await count()).toBe(16);
  });
});

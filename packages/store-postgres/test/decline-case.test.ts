import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { AlreadyDeclinedError, closeAllPools, PostgresStore } from '../src/store';

const connectionString = process.env.DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

/**
 * Declining a case writes a row, it does not remove one.
 *
 * Coverage is a ratio of dollars: what we recovered over what was there to
 * recover. Deleting the cases we chose not to fight would raise that ratio
 * every time we gave up, so a decline has to leave behind what it was worth and
 * what was missing (docs/STRATEGY.md, ADD-1).
 */
describeDb('declining a case', () => {
  const admin = new Pool({ connectionString });
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const analystId = randomUUID();
  const readerId = randomUUID();
  const otherAnalystId = randomUUID();
  const suffix = orgId.slice(0, 8);
  let store: PostgresStore;
  let deductionId: string;
  // A second case, never declined, so the tests about who may decline are not
  // answered by the case already having been declined.
  let undeclinedId: string;

  beforeAll(async () => {
    await admin.query(
      `insert into organizations (id, slug, name) values ($1,$2,'Decline'), ($3,$4,'Decline Other')`,
      [orgId, `dec-${suffix}`, otherOrgId, `dec-other-${suffix}`],
    );
    await admin.query(`insert into org_settings (org_id) values ($1), ($2)`, [orgId, otherOrgId]);
    await admin.query(`insert into users (id, email) values ($1,$2), ($3,$4), ($5,$6)`, [
      analystId, `dec-a-${suffix}@example.test`,
      readerId, `dec-r-${suffix}@example.test`,
      otherAnalystId, `dec-o-${suffix}@example.test`,
    ]);
    await admin.query(
      `insert into memberships (org_id, user_id, role)
       values ($1,$2,'analyst'), ($1,$3,'read_only'), ($4,$5,'analyst')`,
      [orgId, analystId, readerId, otherOrgId, otherAnalystId],
    );

    store = new PostgresStore(
      { connectionString: connectionString as string },
      { orgId, userId: analystId },
    );
    const opened = await store.openCase({ orgId, claimId: 'APDP-1', deductionAmountCents: 312_000 });
    deductionId = opened.deductionId;
    const second = await store.openCase({
      orgId,
      claimId: 'APDP-2',
      deductionAmountCents: 45_000,
    });
    undeclinedId = second.deductionId;
  });

  afterAll(async () => {
    await closeAllPools();
    await store?.close();
    await admin.end();
  });

  it('records what the case was worth, taken from the case rather than the caller', async () => {
    const declined = await store.declineCase({
      deductionId,
      reason: 'below_economic_floor',
      decidedBy: `dec-a-${suffix}@example.test`,
      assumedDiscoveredFrom: 'web_upload',
      missingEvidence: ['proof_of_delivery'],
      detail: 'Recovery would not cover the work.',
    });

    // What it was worth is a fact about the case. A reviewer does not get to
    // type a number that later gets added up as coverage.
    expect(declined.estimatedRecoverableCents).toBe(312_000);
    expect(declined.reason).toBe('below_economic_floor');
    expect(declined.missingEvidence).toEqual(['proof_of_delivery']);
    expect(declined.decidedByVersion).toBe('human/v1');
  });

  it('leaves the case itself standing — a decline is not a delete', async () => {
    const stillThere = await store.getCase(deductionId);
    expect(stillThere?.deductionId).toBe(deductionId);
  });

  it('falls back to the stated assumption, because nothing records provenance yet', async () => {
    // This is the honest state of the system, pinned so it cannot drift
    // silently: `documents.upload_id` is never set, because nothing writes the
    // `uploads` table. The day ingest records provenance, this test should be
    // changed to assert the derived value instead — and the fact that it has to
    // be changed is the point.
    const { rows } = await admin.query<{ discovered_from: string; upload_rows: string }>(
      `select dc.discovered_from, (select count(*)::text from uploads) as upload_rows
         from declined_candidates dc where dc.deduction_id = $1`,
      [deductionId],
    );
    expect(rows[0]?.discovered_from).toBe('web_upload');
    expect(rows[0]?.upload_rows).toBe('0');
  });

  it('writes exactly one row and one event, and touches nothing else', async () => {
    // Append-only, and appended once. A second decline would be a second row —
    // the pair being the history — but one decline must not write two.
    const { rows } = await admin.query<{ declines: string; events: string }>(
      `select (select count(*)::text from declined_candidates where deduction_id = $1) as declines,
              (select count(*)::text from deduction_events
                where deduction_id = $1 and event_type = 'case.declined') as events`,
      [deductionId],
    );
    expect(rows[0]?.declines).toBe('1');
    expect(rows[0]?.events).toBe('1');

    // The event says what the row says, so the case's own timeline is enough to
    // know what was given up and what it was worth.
    const { rows: events } = await admin.query<{ payload: Record<string, unknown> }>(
      `select payload from deduction_events
        where deduction_id = $1 and event_type = 'case.declined'`,
      [deductionId],
    );
    expect(events[0]?.payload).toMatchObject({
      reason: 'below_economic_floor',
      estimated_recoverable_cents: 312_000,
      discovered_from: 'web_upload',
      decided_by_version: 'human/v1',
    });
  });

  it('refuses a second decline, because coverage would count the dollars twice', async () => {
    // `coverage_by_period` sums every declined row. A double-clicked form would
    // otherwise move the one number this feature exists to produce.
    await expect(
      store.declineCase({
        deductionId,
        reason: 'deadline_passed',
        decidedBy: `dec-a-${suffix}@example.test`,
        assumedDiscoveredFrom: 'web_upload',
      }),
    ).rejects.toThrow(AlreadyDeclinedError);

    const { rows } = await admin.query<{ declines: string }>(
      `select count(*)::text as declines from declined_candidates where deduction_id = $1`,
      [deductionId],
    );
    expect(rows[0]?.declines).toBe('1');
  });

  it('refuses an evidence type nothing could ever add up', async () => {
    await expect(
      store.declineCase({
        deductionId: undeclinedId,
        reason: 'evidence_unavailable',
        decidedBy: `dec-a-${suffix}@example.test`,
        assumedDiscoveredFrom: 'web_upload',
        // Not a canonical type. The column is a plain text[], so nothing below
        // this would refuse it and nothing above would ever count it.
        missingEvidence: ['no POD' as never],
      }),
    ).rejects.toThrow(/add up/);

    const { rows } = await admin.query<{ declines: string }>(
      `select count(*)::text as declines from declined_candidates where deduction_id = $1`,
      [undeclinedId],
    );
    expect(rows[0]?.declines).toBe('0');
  });

  it('refuses a reader, because the write policy does not care what the UI showed', async () => {
    const reader = new PostgresStore(
      { connectionString: connectionString as string },
      { orgId, userId: readerId },
    );
    try {
      // A case nobody has declined, so this is the policy refusing the insert
      // rather than the one-decline-per-case check getting there first.
      await expect(
        reader.declineCase({
          deductionId: undeclinedId,
          reason: 'other',
          decidedBy: `dec-r-${suffix}@example.test`,
          assumedDiscoveredFrom: 'web_upload',
        }),
      ).rejects.toThrow(/row-level security|permission denied/i);
    } finally {
      await reader.close();
    }
  });

  it('cannot decline another tenant’s case, and does not leak that it exists', async () => {
    const other = new PostgresStore(
      { connectionString: connectionString as string },
      { orgId: otherOrgId, userId: otherAnalystId },
    );
    try {
      await expect(
        other.declineCase({
          deductionId,
          reason: 'other',
          decidedBy: `dec-o-${suffix}@example.test`,
          assumedDiscoveredFrom: 'web_upload',
        }),
      ).rejects.toThrow(/not visible to this tenant/);
    } finally {
      await other.close();
    }
  });
});

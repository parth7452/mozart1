import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { manualEntryFromForm } from '@recouple/core-domain';
import type { ManualEntryForm } from '@recouple/core-domain';
import { DuplicateCaseError, NothingToSendError } from '@recouple/pipeline';
import { closeAllPools, ManualCaseRefusedError, PostgresStore } from '../src/store';

const connectionString = process.env.TEST_DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

/**
 * A person opens a case by hand (ADR 0070). Everything runs as `app_rw`
 * through the real policies: the entry is a document arriving as
 * `manual_entry`, the case opens `classified`, and a refused duplicate leaves
 * nothing behind.
 */
describeDb('a case opened by hand', () => {
  const admin = new Pool({ connectionString });
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const userId = randomUUID();
  const colleagueId = randomUUID();
  const otherUserId = randomUUID();
  const suffix = orgId.slice(0, 8);
  let store: PostgresStore;
  let otherDebtorId: string;

  beforeAll(async () => {
    await admin.query(
      `insert into organizations (id, slug, name) values ($1,$2,'Manual'), ($3,$4,'Manual Other')`,
      [orgId, `manual-${suffix}`, otherOrgId, `manual-other-${suffix}`],
    );
    await admin.query(`insert into org_settings (org_id) values ($1), ($2)`, [orgId, otherOrgId]);
    await admin.query(
      `insert into users (id, email, full_name) values ($1,$2,null), ($3,$4,'Colleague'), ($5,$6,null)`,
      [
        userId,
        `manual-${suffix}@example.test`,
        colleagueId,
        `manual-colleague-${suffix}@example.test`,
        otherUserId,
        `manual-other-${suffix}@example.test`,
      ],
    );
    await admin.query(
      `insert into memberships (org_id, user_id, role)
       values ($1,$2,'analyst'), ($1,$3,'analyst'), ($4,$5,'analyst')`,
      [orgId, userId, colleagueId, otherOrgId, otherUserId],
    );
    const { rows } = await admin.query<{ id: string }>(
      `insert into debtors (org_id, retailer_key, display_name) values ($1, 'sysco', 'Sysco')
       returning id`,
      [otherOrgId],
    );
    otherDebtorId = rows[0]?.id as string;
    store = new PostgresStore({ connectionString: connectionString as string }, { orgId, userId });
  });

  afterAll(async () => {
    await closeAllPools();
    await store?.close();
    await admin.end();
  });

  function entry(debtorId: string, over: Partial<ManualEntryForm> = {}) {
    return manualEntryFromForm({
      debtorId,
      deductionReference: `CB-${suffix}`,
      amount: '$1,250.00',
      deductionDate: '2026-09-30',
      reasonCode: 'PREMIUM-NOAUTH',
      invoiceNumbers: `INV-${suffix}-1, INV-${suffix}-2`,
      ...over,
    });
  }

  async function count(table: string): Promise<number> {
    const { rows } = await admin.query<{ n: string }>(
      `select count(*) as n from ${table} where org_id = $1`,
      [orgId],
    );
    return Number(rows[0]?.n);
  }

  let debtorId: string;
  let deductionId: string;

  it('adds a payer once, and returns the same one for a name that folds to it', async () => {
    const first = await store.createDebtor({ displayName: '  Walmart Inc ' });
    expect(first.created).toBe(true);
    expect(first.displayName).toBe('Walmart Inc');
    const again = await store.createDebtor({ displayName: 'WALMART, INC.' });
    expect(again).toEqual({ debtorId: first.debtorId, displayName: 'Walmart Inc', created: false });
    const { rows } = await admin.query(
      `select actor_id, payload from audit_log where org_id = $1 and action = 'debtor.created'`,
      [orgId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_id: userId, payload: { retailer_key: 'walmart' } });
    await expect(store.createDebtor({ displayName: '   ' })).rejects.toBeInstanceOf(
      ManualCaseRefusedError,
    );
    await expect(store.createDebtor({ displayName: '!!!' })).rejects.toMatchObject({
      refusal: 'invalid',
      field: 'displayName',
    });
    const listed = await store.listDebtors();
    expect(listed).toEqual([{ debtorId: first.debtorId, displayName: 'Walmart Inc' }]);
    debtorId = first.debtorId;
  });

  it('opens the case classified, with its entry as an observed notice', async () => {
    const opened = await store.openManualCase({
      entry: entry(debtorId, {
        notes: 'Seen on the payer portal.',
        assigneeId: colleagueId,
        disputeAmount: '1000',
      }),
      now: new Date('2026-10-07T10:00:00Z'),
    });
    deductionId = opened.deductionId;

    const { rows: cases } = await admin.query(
      `select state, discovered_via, debtor_id, claim_id, reason_code_as_printed,
              deduction_amount_cents::text as amount
         from deductions where id = $1`,
      [deductionId],
    );
    expect(cases[0]).toEqual({
      state: 'classified',
      discovered_via: 'manual',
      debtor_id: debtorId,
      claim_id: `CB-${suffix}`,
      reason_code_as_printed: 'PREMIUM-NOAUTH',
      amount: '125000',
    });

    const { rows: links } = await admin.query(
      `select dd.document_id, dd.role, d.mime_type, d.filename, u.source, u.created_by
         from deduction_documents dd
         join documents d on d.id = dd.document_id
         join uploads u on u.id = d.upload_id
        where dd.deduction_id = $1`,
      [deductionId],
    );
    expect(links).toEqual([
      {
        document_id: opened.documentId,
        role: 'notice',
        mime_type: 'application/json',
        filename: 'manual-entry.json',
        source: 'manual_entry',
        created_by: userId,
      },
    ]);

    const { rows: ids } = await admin.query<{ identifier_kind: string; identifier: string }>(
      `select identifier_kind, identifier from deduction_identifiers
        where deduction_id = $1 and source = 'manual_entry' order by identifier_kind, identifier`,
      [deductionId],
    );
    expect(ids).toEqual([
      { identifier_kind: 'claim_id', identifier: `CB-${suffix}` },
      { identifier_kind: 'invoice_number', identifier: `INV-${suffix}-1` },
      { identifier_kind: 'invoice_number', identifier: `INV-${suffix}-2` },
    ]);

    const { rows: events } = await admin.query<{ event_type: string; payload: Record<string, unknown> }>(
      `select event_type, payload from deduction_events where deduction_id = $1 order by id`,
      [deductionId],
    );
    expect(events.map((e) => e.event_type)).toEqual([
      'case.discovered',
      'case.note_added',
      'case.assigned',
      'case.classified',
    ]);
    expect(events[0]?.payload).toMatchObject({
      document_id: opened.documentId,
      source: 'manual_entry',
      discovered_via: 'manual',
      entered_by: userId,
      dispute_amount_cents: 100000,
      deadline: 'no_payer_window_on_record',
    });
    expect(events[0]?.payload).not.toHaveProperty('notes');
  });

  it('refuses the same payer and reference again, and leaves nothing behind', async () => {
    const before = [await count('deductions'), await count('documents'), await count('uploads')];
    await expect(store.openManualCase({ entry: entry(debtorId) })).rejects.toBeInstanceOf(
      DuplicateCaseError,
    );
    expect([await count('deductions'), await count('documents'), await count('uploads')]).toEqual(
      before,
    );
  });

  it("refuses another tenant's payer, end retailer or a stranger as assignee", async () => {
    await expect(
      store.openManualCase({ entry: entry(otherDebtorId, { deductionReference: 'X-1' }) }),
    ).rejects.toMatchObject({ refusal: 'unknown_debtor', field: 'debtorId' });
    await expect(
      store.openManualCase({
        entry: entry(debtorId, { deductionReference: 'X-2', endRetailerDebtorId: otherDebtorId }),
      }),
    ).rejects.toMatchObject({ refusal: 'unknown_end_retailer' });
    await expect(
      store.openManualCase({
        entry: entry(debtorId, { deductionReference: 'X-3', assigneeId: otherUserId }),
      }),
    ).rejects.toMatchObject({ refusal: 'unknown_assignee' });
  });

  it('summarises what was typed, with no evidence yet', async () => {
    const summary = await store.manualEntryFor(deductionId);
    expect(summary).toMatchObject({
      deductionId,
      enteredBy: userId,
      invoiceNumbers: [`INV-${suffix}-1`, `INV-${suffix}-2`],
      disputeAmountCents: 100000,
      assignee: { userId: colleagueId, fullName: 'Colleague' },
      notes: [{ note: 'Seen on the payer portal.', by: userId }],
      evidenceCount: 0,
    });
  });

  it('cannot assemble a packet from the entry alone', async () => {
    const { decisionId } = await store.recordHumanDecision({
      deductionId,
      preparedBy: userId,
      reason: 'shortage_never_received',
      rationale: 'The buyer approved it by phone.',
    });
    await expect(
      store.assemblePacket({ deductionId, decisionId, assembledBy: userId }),
    ).rejects.toBeInstanceOf(NothingToSendError);
  });

  it('declines with the channel derived from the entry', async () => {
    const opened = await store.openManualCase({
      entry: entry(debtorId, { deductionReference: `CB-${suffix}-2`, invoiceNumbers: 'X' }),
    });
    expect(await store.manualEntryFor(opened.deductionId)).toMatchObject({ evidenceCount: 0 });
    const declined = await store.declineCase({
      deductionId: opened.deductionId,
      reason: 'tenant_declined',
      decidedBy: userId,
    });
    expect(declined).toMatchObject({ discoveredFrom: 'manual_entry' });
    const { rows } = await admin.query(
      `select discovered_from, provenance_kind from declined_candidates where deduction_id = $1`,
      [opened.deductionId],
    );
    expect(rows[0]).toEqual({ discovered_from: 'manual_entry', provenance_kind: 'observed' });
  });

  it('answers undefined for a case not opened by hand', async () => {
    expect(await store.manualEntryFor(randomUUID())).toBeUndefined();
  });
});

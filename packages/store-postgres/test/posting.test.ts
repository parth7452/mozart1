import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { REASON_FAMILIES, cents } from '@recouple/core-domain';
import type { LedgerAccountMap } from '@recouple/qbo';
import { OwnerRequiredError } from '../src/connections';
import {
  AccountMapRequiredError,
  AccountMapTypeError,
  PostgresPostingStore,
  WritebackExistsError,
  WritebackNotApprovedError,
  WriteoffAmountMismatchError,
  type AccountTypeReader,
} from '../src/posting';
import { closeAllPools, PostgresStore } from '../src/store';

const connectionString = process.env.TEST_DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

/**
 * The posting store against a real database (ADR 0060 §§2–4): the map, the
 * switch, the settlement decision, the writeback row and its attempts. The
 * database is the referee for owner-only writes and the approval gate; this
 * asks that the store's own checks and translations line up with it.
 */
describeDb('posting a deduction to QuickBooks, the store half', () => {
  const admin = new Pool({ connectionString });
  const config = { connectionString: connectionString as string };
  const orgId = randomUUID();
  const ownerId = randomUUID();
  const approverId = randomUUID();
  const analystId = randomUUID();
  const connectionId = randomUUID();
  const bareConnectionId = randomUUID();
  const caseId = randomUUID();
  const suffix = orgId.slice(0, 8);
  const amount = 50_000;

  const map: LedgerAccountMap = {
    arAccountId: '84',
    deductionsReceivableAccountId: '90',
    writeoffByFamily: Object.fromEntries(REASON_FAMILIES.map((f, i) => [f, String(200 + i)])) as never,
    unclassifiedWriteoff: '299',
  };
  const types: AccountTypeReader = async (ids) =>
    new Map(
      ids.map((id) => [
        id,
        id === '84' ? 'Accounts Receivable' : id === '90' ? 'Other Current Asset' : 'Expense',
      ]),
    );

  const as = (userId: string) => new PostgresPostingStore(config, { orgId, userId });
  let disputeId: string;

  async function inSession<T>(userId: string, work: (q: Pool['query']) => Promise<T>): Promise<T> {
    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query('set local role app_rw');
      await client.query('select set_config($1, $2, true)', [
        'request.jwt.claims',
        JSON.stringify({ org_id: orgId, sub: userId }),
      ]);
      const result = await work(client.query.bind(client) as Pool['query']);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  const approveAs = (decisionId: string, action: 'writeback' | 'writeoff') =>
    inSession(approverId, (q) =>
      q(`insert into approvals (org_id, decision_id, approver_id, action_type) values ($1,$2,$3,$4)`, [
        orgId,
        decisionId,
        approverId,
        action,
      ]),
    );

  beforeAll(async () => {
    await admin.query(`insert into organizations (id, slug, name) values ($1,$2,'Posting')`, [
      orgId,
      `post-${suffix}`,
    ]);
    await admin.query(`insert into org_settings (org_id) values ($1)`, [orgId]);
    await admin.query(`insert into users (id, email) values ($1,$2), ($3,$4), ($5,$6)`, [
      ownerId, `post-o-${suffix}@example.test`,
      approverId, `post-p-${suffix}@example.test`,
      analystId, `post-a-${suffix}@example.test`,
    ]);
    await admin.query(
      `insert into memberships (org_id, user_id, role)
       values ($1,$2,'owner'), ($1,$3,'approver'), ($1,$4,'analyst')`,
      [orgId, ownerId, approverId, analystId],
    );
    await admin.query(
      `insert into accounting_connections (id, org_id, provider, provider_account_id, created_by, enabled)
       values ($1,$2,'qbo',$3,$4,true), ($5,$2,'qbo',$6,$4,false)`,
      [connectionId, orgId, `realm-${suffix}`, ownerId, bareConnectionId, `realm-bare-${suffix}`],
    );
    await admin.query(
      `insert into deductions (id, org_id, claim_id, deduction_amount_cents) values ($1,$2,$3,$4)`,
      [caseId, orgId, `POST-${suffix}`, amount],
    );
    await admin.query(
      `insert into deduction_identifiers (org_id, deduction_id, source, identifier_kind, identifier)
       values ($1,$2,'erp_sync','ledger_invoice_id','71')`,
      [orgId, caseId],
    );
    disputeId = await inSession(analystId, async (q) => {
      const { rows } = await q(
        `insert into decisions (org_id, deduction_id, schema_id, schema_version, provider,
                                model_version, input_state_hash, questions, result,
                                raw_probabilities, confidence, latency_ms, prepared_by)
         values ($1,$2,'B','human-1','human','human', digest('post', 'sha256'),
                 '{}'::jsonb, '{"dispute_reason":"shortage_quantity","rationale":"r"}'::jsonb,
                 '{}'::jsonb, 1, 0, $3)
         returning id`,
        [orgId, caseId, analystId],
      );
      return (rows[0] as { id: string }).id;
    });
  });

  afterAll(async () => {
    await closeAllPools();
    await admin.end();
  });

  it('saves a map only with the right account types, and only as an owner', async () => {
    await expect(
      as(ownerId).saveAccountMap(connectionId, map, async (ids) => new Map(ids.map((id) => [id, 'Bank']))),
    ).rejects.toBeInstanceOf(AccountMapTypeError);
    await expect(as(analystId).saveAccountMap(connectionId, map, types)).rejects.toBeInstanceOf(
      OwnerRequiredError,
    );
    const { mapId } = await as(ownerId).saveAccountMap(connectionId, map, types);
    expect(mapId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('turns posting on only as an owner, only with a map, with one audit row per change', async () => {
    const { rows: before } = await admin.query(
      `select posting_enabled from accounting_connections where id = $1`,
      [connectionId],
    );
    expect(before[0]?.posting_enabled).toBe(false);
    await expect(as(analystId).setPostingEnabled(connectionId, true)).rejects.toBeInstanceOf(
      OwnerRequiredError,
    );
    await expect(as(ownerId).setPostingEnabled(bareConnectionId, true)).rejects.toBeInstanceOf(
      AccountMapRequiredError,
    );
    await as(ownerId).setPostingEnabled(connectionId, true);
    await as(ownerId).setPostingEnabled(connectionId, true);
    const { rows } = await admin.query(
      `select count(*)::int as n from audit_log
        where org_id = $1 and subject_id = $2 and action = 'accounting_connection.posting_enabled'`,
      [orgId, connectionId],
    );
    expect(rows[0]?.n).toBe(1);
  });

  it('inserts a writeback only under an approval, pending with its own id as the request id, once', async () => {
    const input = { decisionId: disputeId, method: 'journal_entry' as const, connectionId };
    await expect(as(approverId).insertWriteback(input)).rejects.toBeInstanceOf(WritebackNotApprovedError);
    await approveAs(disputeId, 'writeback');
    const { writebackId } = await as(approverId).insertWriteback(input);
    const { rows } = await admin.query(
      `select status, request_id, amount_cents::int as amount, lines from writebacks where id = $1`,
      [writebackId],
    );
    expect(rows[0]).toMatchObject({ status: 'pending', request_id: writebackId, amount });
    expect(rows[0]?.lines).toEqual([
      { accountId: '90', side: 'Debit', amountCents: amount },
      { accountId: '84', side: 'Credit', amountCents: amount },
    ]);
    await expect(as(approverId).insertWriteback(input)).rejects.toBeInstanceOf(WritebackExistsError);

    const row = await as(approverId).writebackForPosting(writebackId);
    expect(row).toMatchObject({
      schemaId: 'B',
      method: 'journal_entry',
      status: 'pending',
      postingEnabled: true,
      invoiceId: '71',
      family: 'shortage',
      realmId: `realm-${suffix}`,
    });

    await as(approverId).recordWritebackAttempt({
      writebackId,
      status: 'succeeded',
      qboTxnId: '301',
      reason: 'sent',
    });
    const after = await as(approverId).writebackForPosting(writebackId);
    expect(after).toMatchObject({ status: 'succeeded', qboTxnId: '301' });
    const { rows: events } = await admin.query(
      `select payload from deduction_events where deduction_id = $1 and event_type = 'writeback.attempted'`,
      [caseId],
    );
    expect(events).toHaveLength(1);

    // A payment on the same decision now knows the entry it applies.
    const payment = await as(approverId).insertWriteback({
      decisionId: disputeId,
      method: 'payment_application',
      connectionId,
    });
    expect(await as(approverId).writebackForPosting(payment.writebackId)).toMatchObject({
      journalEntryId: '301',
      amountCents: amount,
    });
  });

  it('keeps the dispute decision as the workflow decision, and refuses a write-off of the wrong amount', async () => {
    const { decisionId } = await as(analystId).prepareSettlementDecision({
      deductionId: caseId,
      preparedBy: analystId,
      outcome: 'partial',
      recoveredCents: cents(20_000),
      family: 'shortage',
      invoiceId: '71',
    });
    const workflow = await new PostgresStore(config, { orgId, userId: analystId }).getWorkflow(caseId);
    expect(workflow?.decision?.decisionId).toBe(disputeId);

    await approveAs(decisionId, 'writeoff');
    await expect(
      as(approverId).insertWriteoff({ decisionId, amountCents: cents(50_000) }),
    ).rejects.toBeInstanceOf(WriteoffAmountMismatchError);
    await expect(
      as(approverId).insertWriteoff({ decisionId, amountCents: cents(30_000) }),
    ).resolves.toMatchObject({ writeoffId: expect.any(String) });
  });

  it('uses the map latest at the approval, never a later one', async () => {
    const approvedAt = new Date();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await as(ownerId).saveAccountMap(connectionId, { ...map, arAccountId: '85' }, async (ids) =>
      new Map(
        ids.map((id) => [id, id === '85' ? 'Accounts Receivable' : id === '90' ? 'Other Current Asset' : 'Expense']),
      ),
    );
    expect((await as(ownerId).mapAtApproval(connectionId, approvedAt))?.arAccountId).toBe('84');
    expect((await as(ownerId).mapAtApproval(connectionId, new Date()))?.arAccountId).toBe('85');
  });
});

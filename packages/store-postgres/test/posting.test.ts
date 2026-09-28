import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { REASON_FAMILIES, cents } from '@recouple/core-domain';
import { postingSetupRequestId, type LedgerAccountMap } from '@recouple/qbo';
import { OwnerRequiredError } from '../src/connections';
import {
  AccountMapRequiredError,
  AccountMapTypeError,
  POSTING_SETUP_LOCK_SEED,
  PostgresPostingStore,
  WritebackExistsError,
  WritebackNotApprovedError,
  WriteoffAmountMismatchError,
  type AccountTypeReader,
  PostingDecisionError,
} from '../src/posting';
import { withLedgerAccountLock } from '../src/ledger-lock';
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

    // A connection turned off keeps its posting switch, and posts nothing.
    await admin.query(`update accounting_connections set enabled = false where id = $1`, [connectionId]);
    expect(await as(approverId).writebackForPosting(payment.writebackId)).toMatchObject({ postingEnabled: false });
    await admin.query(`update accounting_connections set enabled = true where id = $1`, [connectionId]);
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

  it('approves a settlement as a second person only, and puts a failed posting back for a retry', async () => {
    const { decisionId } = await as(analystId).prepareSettlementDecision({
      deductionId: caseId,
      preparedBy: analystId,
      outcome: 'lost',
      recoveredCents: cents(0),
      family: 'shortage',
      invoiceId: '71',
    });
    await expect(as(analystId).approveSettlement(decisionId)).rejects.toMatchObject({
      name: 'SettlementApprovalRefusedError',
      reason: 'preparer',
    });
    await expect(as(approverId).approveSettlement(decisionId)).resolves.toEqual({
      deductionId: caseId,
      writeoffCents: amount,
    });
    const { rows: approvals } = await admin.query(
      `select action_type from approvals where decision_id = $1 order by action_type`,
      [decisionId],
    );
    expect(approvals.map((r) => r.action_type)).toEqual(['writeback', 'writeoff']);
    await expect(as(ownerId).approveSettlement(decisionId)).rejects.toMatchObject({ reason: 'duplicate' });

    const seen = await as(analystId).postingForCase(caseId);
    expect(seen.connection).toMatchObject({ connectionId, hasMap: true });
    expect(seen.ledgerInvoiceId).toBe('71');
    expect(seen.settlement).toMatchObject({ decisionId, outcome: 'lost', preparedBy: analystId, approved: true });

    const { writebackId } = await as(approverId).insertWriteback({
      decisionId,
      method: 'journal_entry',
      connectionId,
    });
    await expect(as(analystId).requeueWriteback(writebackId)).rejects.toBeInstanceOf(PostingDecisionError);
    await as(approverId).recordWritebackAttempt({ writebackId, status: 'failed', reason: 'unknown_outcome' });
    await expect(as(analystId).requeueWriteback(writebackId)).resolves.toEqual({
      deductionId: caseId,
      connectionId,
    });
    const { rows } = await admin.query(`select status, request_id from writebacks where id = $1`, [writebackId]);
    expect(rows[0]).toEqual({ status: 'pending', request_id: writebackId });
    const { rows: asked } = await admin.query(
      `select payload->>'requested_by' as who from deduction_events
        where deduction_id = $1 and event_type = 'writeback.retry_requested'`,
      [caseId],
    );
    expect(asked).toEqual([{ who: analystId }]);
    expect((await as(ownerId).postingConnections()).map((c) => c.connectionId)).toEqual([connectionId]);
  });

  /** A company of its own, so the audit rows one test writes are not another's. */
  async function setupConnection(label: string): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `insert into accounting_connections (id, org_id, provider, provider_account_id, created_by, enabled)
       values ($1,$2,'qbo',$3,$4,false)`,
      [id, orgId, `realm-${label}-${suffix}`, ownerId],
    );
    return id;
  }

  it('records an account a setup press created as one audit row, ids only, and only for an owner', async () => {
    const made = await setupConnection('made');
    expect(await as(ownerId).memberIsOwner()).toBe(true);
    expect(await as(approverId).memberIsOwner()).toBe(false);
    expect(await as(analystId).memberIsOwner()).toBe(false);

    // An approver may write the audit log as themselves, and still records
    // nothing here: the store asks for an owner first.
    await expect(
      as(approverId).recordAccountCreated(made, { row: 'writeoff', qboAccountId: '301' }),
    ).rejects.toBeInstanceOf(OwnerRequiredError);
    // An account's name is not its id, and a row setup never makes is no row.
    await expect(
      as(ownerId).recordAccountCreated(made, { row: 'writeoff', qboAccountId: 'Customer Deductions' }),
    ).rejects.toMatchObject({ name: 'QboInvalidId' });
    await expect(
      as(ownerId).recordAccountCreated(made, { row: 'ar' as never, qboAccountId: '301' }),
    ).rejects.toThrow(/deductions_receivable or writeoff/);
    await expect(
      as(ownerId).recordAccountCreated(randomUUID(), { row: 'writeoff', qboAccountId: '301' }),
    ).rejects.toMatchObject({ name: 'PostingConnectionNotFoundError' });
    // A read-back names at least one field it compared, and only those.
    await expect(
      as(ownerId).recordAccountCreated(made, { row: 'writeoff', qboAccountId: '301', readBackMismatch: [] }),
    ).rejects.toThrow(/at least one of Id, Name, AccountType, Active/);
    await expect(
      as(ownerId).recordAccountCreated(made, {
        row: 'writeoff',
        qboAccountId: '301',
        readBackMismatch: ['Customer Deductions' as never],
      }),
    ).rejects.toThrow(/at least one of Id, Name, AccountType, Active/);
    // An answer names the request it answers: with none asked for, there is none to give.
    await expect(
      as(ownerId).recordAccountCreated(made, { row: 'writeoff', qboAccountId: '301' }),
    ).rejects.toThrow(/no writeoff account was asked for/);

    const receivable = await as(ownerId).recordAccountCreateRequested(made, 'deductions_receivable');
    await as(ownerId).recordAccountCreated(made, { row: 'deductions_receivable', qboAccountId: '300' });
    // One QuickBooks made and did not read back as sent: in the books all the
    // same, so on the record, with the fields that differed and not their values.
    const writeoff = await as(ownerId).recordAccountCreateRequested(made, 'writeoff');
    await as(ownerId).recordAccountCreated(made, {
      row: 'writeoff',
      qboAccountId: '302',
      readBackMismatch: ['Active', 'Name'],
    });
    expect(receivable).toBe(postingSetupRequestId(made, 'deductions_receivable', 0));
    expect(writeoff).toBe(postingSetupRequestId(made, 'writeoff', 0));
    const { rows } = await admin.query(
      `select actor_id, subject_table, subject_id, payload from audit_log
        where org_id = $1 and subject_id = $2 and action = 'accounting_connection.account_created' order by id`,
      [orgId, made],
    );
    expect(rows).toEqual([
      {
        actor_id: ownerId,
        subject_table: 'accounting_connections',
        subject_id: made,
        payload: {
          provider_account_id: `realm-made-${suffix}`,
          row: 'deductions_receivable',
          qbo_account_id: '300',
          request_id: receivable,
        },
      },
      {
        actor_id: ownerId,
        subject_table: 'accounting_connections',
        subject_id: made,
        payload: {
          provider_account_id: `realm-made-${suffix}`,
          row: 'writeoff',
          qbo_account_id: '302',
          request_id: writeoff,
          read_back_mismatch: ['Active', 'Name'],
        },
      },
    ]);
  });

  it('puts a setup create on the record before it is sent, under the request id it goes out with, owner only', async () => {
    const asked = await setupConnection('asked');
    await expect(as(approverId).recordAccountCreateRequested(asked, 'writeoff')).rejects.toBeInstanceOf(
      OwnerRequiredError,
    );
    await expect(as(ownerId).recordAccountCreateRequested(asked, 'ar' as never)).rejects.toThrow(
      /deductions_receivable or writeoff/,
    );
    await expect(as(ownerId).recordAccountCreateRequested(randomUUID(), 'writeoff')).rejects.toMatchObject({
      name: 'PostingConnectionNotFoundError',
    });

    // Derived here, never passed in, and handed back for the create to go out with.
    const requestId = await as(ownerId).recordAccountCreateRequested(asked, 'writeoff');
    expect(requestId).toBe(postingSetupRequestId(asked, 'writeoff', 0));
    const { rows } = await admin.query(
      `select actor_id, subject_table, subject_id, payload from audit_log
        where org_id = $1 and subject_id = $2 and action = 'accounting_connection.account_create_requested'
        order by id`,
      [orgId, asked],
    );
    expect(rows).toEqual([
      {
        actor_id: ownerId,
        subject_table: 'accounting_connections',
        subject_id: asked,
        payload: {
          provider_account_id: `realm-asked-${suffix}`,
          row: 'writeoff',
          request_id: requestId,
        },
      },
    ]);
  });

  it('names each attempt at a row: the same request until it is answered, and a new one after', async () => {
    const attempts = await setupConnection('attempts');
    const owner = as(ownerId);
    expect(await owner.recordedSetupAccounts(attempts)).toEqual({ deductions_receivable: [], writeoff: [] });

    // Asked, and no answer came: asking again is the same request to Intuit.
    const first = await owner.recordAccountCreateRequested(attempts, 'deductions_receivable');
    expect(await owner.recordAccountCreateRequested(attempts, 'deductions_receivable')).toBe(first);
    expect(await owner.unansweredAccountCreates(attempts)).toEqual([
      { row: 'deductions_receivable', requestId: first },
    ]);

    // Answered: the next create of that row is a new request, which Intuit
    // cannot answer with the account the first one made.
    await owner.recordAccountCreated(attempts, { row: 'deductions_receivable', qboAccountId: '500' });
    const second = await owner.recordAccountCreateRequested(attempts, 'deductions_receivable');
    expect(second).toBe(postingSetupRequestId(attempts, 'deductions_receivable', 1));
    expect(second).not.toBe(first);
    // An account found for a request that had no answer answers it as well.
    await owner.recordAccountFound(attempts, { row: 'deductions_receivable', qboAccountId: '501' });
    expect(await owner.recordAccountCreateRequested(attempts, 'deductions_receivable')).toBe(
      postingSetupRequestId(attempts, 'deductions_receivable', 2),
    );
    // Each row counts its own answers.
    expect(await owner.recordAccountCreateRequested(attempts, 'writeoff')).toBe(
      postingSetupRequestId(attempts, 'writeoff', 0),
    );

    // Every answer names the request it answered.
    const { rows } = await admin.query(
      `select action, payload->>'qbo_account_id' as account, payload->>'request_id' as request
         from audit_log
        where org_id = $1 and subject_id = $2
          and action in ('accounting_connection.account_created', 'accounting_connection.account_found')
        order by id`,
      [orgId, attempts],
    );
    expect(rows).toEqual([
      { action: 'accounting_connection.account_created', account: '500', request: first },
      { action: 'accounting_connection.account_found', account: '501', request: second },
    ]);

    // What every press reads before it plans a create: the accounts setup has
    // recorded for each row, oldest first — a read any member may make, and
    // another tenant sees none of.
    const recorded = { deductions_receivable: ['500', '501'], writeoff: [] };
    expect(await owner.recordedSetupAccounts(attempts)).toEqual(recorded);
    expect(await as(analystId).recordedSetupAccounts(attempts)).toEqual(recorded);
    expect(
      await new PostgresPostingStore(config, { orgId: randomUUID(), userId: ownerId }).recordedSetupAccounts(attempts),
    ).toEqual({ deductions_receivable: [], writeoff: [] });
  });

  it('holds one setup press per connection, answers a second at once, and lets go however the first ends', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = as(ownerId).withSetupClaim(connectionId, async () => {
      entered();
      await gate;
      return 'first';
    });
    await inside;

    // Another request for the same connection: refused at once, its work never run.
    let ran = false;
    await expect(
      as(approverId).withSetupClaim(connectionId, async () => {
        ran = true;
        return 'second';
      }),
    ).resolves.toEqual({ held: false, reason: 'held' });
    expect(ran).toBe(false);
    // Another connection is a claim of its own, and the seed is the setup's
    // own: a document read keyed on the same text is not held by it.
    await expect(as(ownerId).withSetupClaim(bareConnectionId, async () => 'other')).resolves.toEqual({
      held: true,
      result: 'other',
    });
    const reads = new PostgresStore(config, { orgId, userId: ownerId });
    await expect(reads.withDocumentRead(connectionId, async () => 'read')).resolves.toEqual({
      held: true,
      result: 'read',
    });

    release();
    await expect(first).resolves.toEqual({ held: true, result: 'first' });
    // Released by the commit once the work ended, and by the rollback when it threw.
    await expect(as(ownerId).withSetupClaim(connectionId, async () => 'again')).resolves.toEqual({
      held: true,
      result: 'again',
    });
    await expect(
      as(ownerId).withSetupClaim(connectionId, async () => {
        throw new Error('refused');
      }),
    ).rejects.toThrow('refused');
    await expect(as(ownerId).withSetupClaim(connectionId, async () => 'after')).resolves.toEqual({
      held: true,
      result: 'after',
    });
    expect(POSTING_SETUP_LOCK_SEED).toBe(5);
  });

  it("holds a setup claim on a pool of its own, so the press's own token refresh still gets a lock connection", async () => {
    // One lock connection in all. Were the claim held on the lock pool, the
    // company's lock — what a press's token refresh takes, inside the press —
    // would wait for the connection the press itself holds, and fail.
    const single = { ...config, max: 1 };
    const tenant = { orgId, userId: ownerId };
    const claimed = await new PostgresPostingStore(single, tenant).withSetupClaim(connectionId, () =>
      withLedgerAccountLock(single, tenant, { provider: 'qbo', providerAccountId: `realm-${suffix}` }, async () =>
        'refreshed',
      ),
    );
    expect(claimed).toEqual({ held: true, result: 'refreshed' });
  });

  it('names the setup rows whose create was asked for and never answered, and records one found as found', async () => {
    const settling = await setupConnection('settle');
    const owner = as(ownerId);
    expect(await owner.unansweredAccountCreates(settling)).toEqual([]);

    const writeoff = await owner.recordAccountCreateRequested(settling, 'writeoff');
    const receivable = await owner.recordAccountCreateRequested(settling, 'deductions_receivable');
    const both = [
      { row: 'deductions_receivable', requestId: receivable },
      { row: 'writeoff', requestId: writeoff },
    ];
    // In SETUP_ROWS' order, whatever order they were asked in, each with the
    // request id it went out under. A read of the tenant's own audit log: any
    // member may make it, and another tenant sees none.
    expect(await owner.unansweredAccountCreates(settling)).toEqual(both);
    expect(await as(analystId).unansweredAccountCreates(settling)).toEqual(both);
    expect(
      await new PostgresPostingStore(config, { orgId: randomUUID(), userId: ownerId }).unansweredAccountCreates(settling),
    ).toEqual([]);

    // Found after a request that had no answer: its own action, owner only,
    // ids only, and never a name where an id goes or a row setup never makes.
    await expect(
      as(approverId).recordAccountFound(settling, { row: 'writeoff', qboAccountId: '401' }),
    ).rejects.toBeInstanceOf(OwnerRequiredError);
    await expect(
      owner.recordAccountFound(settling, { row: 'writeoff', qboAccountId: 'Customer Deductions' }),
    ).rejects.toMatchObject({ name: 'QboInvalidId' });
    await expect(owner.recordAccountFound(settling, { row: 'ar' as never, qboAccountId: '401' })).rejects.toThrow(
      /deductions_receivable or writeoff/,
    );
    await expect(
      owner.recordAccountFound(randomUUID(), { row: 'writeoff', qboAccountId: '401' }),
    ).rejects.toMatchObject({ name: 'PostingConnectionNotFoundError' });
    await owner.recordAccountFound(settling, { row: 'writeoff', qboAccountId: '401' });
    expect(await owner.unansweredAccountCreates(settling)).toEqual([both[0]]);
    // A creation QuickBooks answered settles a request as well.
    await owner.recordAccountCreated(settling, { row: 'deductions_receivable', qboAccountId: '400' });
    expect(await owner.unansweredAccountCreates(settling)).toEqual([]);

    // Only an answer after a request answers it: one asked for again is
    // unanswered again — a new attempt, since the last one was answered.
    const again = await owner.recordAccountCreateRequested(settling, 'writeoff');
    expect(again).toBe(postingSetupRequestId(settling, 'writeoff', 1));
    expect(await owner.unansweredAccountCreates(settling)).toEqual([{ row: 'writeoff', requestId: again }]);
    expect(await owner.unansweredAccountCreates(bareConnectionId)).toEqual([]);

    // A found account is never recorded as created: a count of what setup
    // made in a customer's books reads `account_created` alone.
    const { rows } = await admin.query(
      `select actor_id, action, payload from audit_log
        where org_id = $1 and subject_id = $2
          and action in ('accounting_connection.account_created', 'accounting_connection.account_found')
        order by id`,
      [orgId, settling],
    );
    expect(rows).toEqual([
      {
        actor_id: ownerId,
        action: 'accounting_connection.account_found',
        payload: {
          provider_account_id: `realm-settle-${suffix}`,
          row: 'writeoff',
          qbo_account_id: '401',
          request_id: writeoff,
        },
      },
      {
        actor_id: ownerId,
        action: 'accounting_connection.account_created',
        payload: {
          provider_account_id: `realm-settle-${suffix}`,
          row: 'deductions_receivable',
          qbo_account_id: '400',
          request_id: receivable,
        },
      },
    ]);
  });
});

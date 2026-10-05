import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { REASON_FAMILIES, cents, type SettlementChartAccount, type SettlementLineInput } from '@recouple/core-domain';
import type { LedgerAccountMap } from '@recouple/qbo';
import {
  PostgresPostingStore,
  PostingDecisionError,
  SettlementAlreadyApprovedError,
  SettlementLinesRefusedError,
  type AccountTypeReader,
} from '../src/posting';
import { closeAllPools } from '../src/store';

const connectionString = process.env.TEST_DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

/**
 * A settlement decision carries its journal lines (ADR 0068, migration 0041),
 * against a real database: the store's checks, and the database's own where
 * the store is stepped around.
 */
describeDb("a settlement's lines are what the approver approves", () => {
  const admin = new Pool({ connectionString });
  const config = { connectionString: connectionString as string };
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const ownerId = randomUUID();
  const approverId = randomUUID();
  const analystId = randomUUID();
  const strangerId = randomUUID();
  const connectionId = randomUUID();
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
      ids.map((id) => [id, id === '84' ? 'Accounts Receivable' : id === '90' ? 'Other Current Asset' : 'Expense']),
    );
  const chart: readonly SettlementChartAccount[] = [
    { externalId: '84', name: 'Accounts Receivable (A/R)', accountType: 'Accounts Receivable', active: true },
    { externalId: '90', name: 'Deductions Receivable', accountType: 'Other Current Asset', active: true },
    ...REASON_FAMILIES.map((f, i) => ({
      externalId: String(200 + i),
      name: `Write-off ${f}`,
      accountType: 'Expense',
      active: true,
    })),
    { externalId: '299', name: 'Customer Deductions', accountType: 'Expense', active: true },
    { externalId: '300', name: 'Trade spend', accountType: 'Expense', active: true },
    { externalId: '35', name: 'Checking', accountType: 'Bank', active: true },
  ];
  let chartReads = 0;
  const readChart = async () => {
    chartReads += 1;
    return chart;
  };

  const as = (userId: string) => new PostgresPostingStore(config, { orgId, userId });

  /** A statement block as `app_rw` with a member's claims, committed. */
  async function inSession<T>(
    claims: { orgId: string; userId: string },
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query('set local role app_rw');
      await client.query('select set_config($1, $2, true)', [
        'request.jwt.claims',
        JSON.stringify({ org_id: claims.orgId, sub: claims.userId }),
      ]);
      const result = await work(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async function newCase(): Promise<string> {
    const caseId = randomUUID();
    await admin.query(
      `insert into deductions (id, org_id, claim_id, deduction_amount_cents) values ($1,$2,$3,$4)`,
      [caseId, orgId, `SL-${caseId.slice(0, 8)}`, amount],
    );
    await admin.query(
      `insert into deduction_identifiers (org_id, deduction_id, source, identifier_kind, identifier)
       values ($1,$2,'erp_sync','ledger_invoice_id',$3)`,
      [orgId, caseId, String(1000 + Math.floor(Math.random() * 1_000_000))],
    );
    return caseId;
  }

  const lost = (caseId: string, lines: readonly SettlementLineInput[] | undefined) =>
    as(analystId).prepareSettlementDecision({
      deductionId: caseId,
      preparedBy: analystId,
      outcome: 'lost',
      recoveredCents: cents(0),
      family: 'shortage',
      invoiceId: '71',
      ...(lines === undefined ? {} : { lines: { connectionId, lines, readChart } }),
    });

  const edited: readonly SettlementLineInput[] = [
    { accountExternalId: '300', debitCents: 30_000, creditCents: 0, memo: ' Agreed with the buyer ' },
    { accountExternalId: '200', debitCents: 20_000, creditCents: 0 },
    { accountExternalId: '90', debitCents: 0, creditCents: 50_000 },
  ];

  const insertLine = (
    client: PoolClient,
    claims: { orgId: string; userId: string },
    decisionId: string,
    lineNo: number,
    debit: number,
    credit: number,
  ) =>
    client.query(
      `insert into settlement_lines (org_id, decision_id, line_no, account_external_id,
         account_name_as_reported, account_type_as_reported, debit_cents, credit_cents, created_by)
       values ($1,$2,$3,'300','Trade spend','Expense',$4,$5,$6)`,
      [claims.orgId, decisionId, lineNo, debit, credit, claims.userId],
    );

  beforeAll(async () => {
    await admin.query(
      `insert into organizations (id, slug, name) values ($1,$2,'Settlement'), ($3,$4,'Other')`,
      [orgId, `sl-${suffix}`, otherOrgId, `sl-other-${suffix}`],
    );
    await admin.query(`insert into org_settings (org_id) values ($1), ($2)`, [orgId, otherOrgId]);
    await admin.query(`insert into users (id, email) values ($1,$2), ($3,$4), ($5,$6), ($7,$8)`, [
      ownerId, `sl-o-${suffix}@example.test`,
      approverId, `sl-p-${suffix}@example.test`,
      analystId, `sl-a-${suffix}@example.test`,
      strangerId, `sl-s-${suffix}@example.test`,
    ]);
    await admin.query(
      `insert into memberships (org_id, user_id, role)
       values ($1,$2,'owner'), ($1,$3,'approver'), ($1,$4,'analyst'), ($5,$6,'owner')`,
      [orgId, ownerId, approverId, analystId, otherOrgId, strangerId],
    );
    await admin.query(
      `insert into accounting_connections (id, org_id, provider, provider_account_id, created_by, enabled)
       values ($1,$2,'qbo',$3,$4,true)`,
      [connectionId, orgId, `realm-sl-${suffix}`, ownerId],
    );
    await as(ownerId).saveAccountMap(connectionId, map, types);
    await as(ownerId).setPostingEnabled(connectionId, true);
  });

  afterAll(async () => {
    await closeAllPools();
    await admin.end();
  });

  it('writes the decision and its lines together, with the names and types the chart reported', async () => {
    const caseId = await newCase();
    const { decisionId } = await lost(caseId, edited);

    const { rows } = await admin.query(
      `select result, encode(input_state_hash, 'hex') as hash from decisions where id = $1`,
      [decisionId],
    );
    expect(rows[0]?.result).toMatchObject({ outcome: 'lost', line_count: 3 });

    const lines = await as(approverId).settlementLinesFor(decisionId);
    expect(lines).toEqual([
      {
        lineNo: 1,
        accountExternalId: '300',
        accountNameAsReported: 'Trade spend',
        accountTypeAsReported: 'Expense',
        debitCents: 30_000,
        creditCents: 0,
        memo: 'Agreed with the buyer',
      },
      {
        lineNo: 2,
        accountExternalId: '200',
        accountNameAsReported: 'Write-off shortage',
        accountTypeAsReported: 'Expense',
        debitCents: 20_000,
        creditCents: 0,
        memo: undefined,
      },
      {
        lineNo: 3,
        accountExternalId: '90',
        accountNameAsReported: 'Deductions Receivable',
        accountTypeAsReported: 'Other Current Asset',
        debitCents: 0,
        creditCents: 50_000,
        memo: undefined,
      },
    ]);

    // The event says how many and that they were edited; never a memo or a name.
    const { rows: events } = await admin.query(
      `select payload from deduction_events
        where deduction_id = $1 and event_type = 'settlement.prepared'`,
      [caseId],
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ decision_id: decisionId, line_count: 3, lines_edited: true });
    expect(JSON.stringify(events[0]?.payload)).not.toMatch(/Agreed|Trade spend/);

    const seen = await as(approverId).postingForCase(caseId);
    expect(seen.settlement).toMatchObject({ decisionId, approved: false, family: 'shortage' });
    expect(seen.settlement?.lines).toEqual(lines);
    expect(seen.settlement?.computedLines).toEqual([
      { lineNo: 1, accountExternalId: '200', debitCents: 50_000, creditCents: 0, memo: undefined },
      { lineNo: 2, accountExternalId: '90', debitCents: 0, creditCents: 50_000, memo: undefined },
    ]);
  });

  it('a different set of lines is a different decision hash', async () => {
    const one = await lost(await newCase(), edited);
    const hash = async (id: string) =>
      (await admin.query(`select encode(input_state_hash, 'hex') as h, deduction_id from decisions where id = $1`, [id]))
        .rows[0] as { h: string; deduction_id: string };
    const first = await hash(one.decisionId);
    // The same case, prepared again with one memo changed.
    const again = await lost(first.deduction_id, [{ ...edited[0]!, memo: 'Agreed with the buyer, by phone' }, edited[1]!, edited[2]!]);
    expect((await hash(again.decisionId)).h).not.toBe(first.h);
  });

  it('refuses an account the chart does not report, a bank account, and lines that do not balance — and writes nothing', async () => {
    const caseId = await newCase();
    const refused = async (lines: readonly SettlementLineInput[], code: string) => {
      const error = await lost(caseId, lines).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SettlementLinesRefusedError);
      expect((error as SettlementLinesRefusedError).problems.map((p) => p.code)).toContain(code);
    };
    await refused([{ ...edited[0]!, accountExternalId: '9999' }, edited[1]!, edited[2]!], 'account_unknown');
    await refused([{ ...edited[0]!, accountExternalId: '35' }, edited[1]!, edited[2]!], 'account_type_refused');
    await refused([{ ...edited[0]!, debitCents: 30_001 }, edited[1]!, edited[2]!], 'unbalanced');
    await refused([{ ...edited[0]!, debitCents: 300.5 }, edited[1]!, edited[2]!], 'not_integer_cents');
    await refused(
      [
        { accountExternalId: '84', debitCents: 50_000, creditCents: 0 },
        { accountExternalId: '90', debitCents: 0, creditCents: 50_000 },
      ],
      'receivable_changed',
    );
    const { rows } = await admin.query(
      `select count(*)::int as n from decisions where deduction_id = $1`,
      [caseId],
    );
    expect(rows[0]?.n).toBe(0);
    const { rows: lines } = await admin.query(
      `select count(*)::int as n from settlement_lines l join decisions d on d.id = l.decision_id
        where d.deduction_id = $1`,
      [caseId],
    );
    expect(lines[0]?.n).toBe(0);
  });

  it('reads the chart before it opens the transaction, and writes nothing when the chart cannot be read', async () => {
    const caseId = await newCase();
    await expect(
      as(analystId).prepareSettlementDecision({
        deductionId: caseId,
        preparedBy: analystId,
        outcome: 'lost',
        recoveredCents: cents(0),
        family: 'shortage',
        invoiceId: '71',
        lines: {
          connectionId,
          lines: edited,
          readChart: async () => {
            throw new Error('QuickBooks is down');
          },
        },
      }),
    ).rejects.toThrow('QuickBooks is down');
    const { rows } = await admin.query(`select count(*)::int as n from decisions where deduction_id = $1`, [caseId]);
    expect(rows[0]?.n).toBe(0);
  });

  it('the database refuses, at commit, lines that do not balance or do not match the count', async () => {
    const caseId = await newCase();
    const claims = { orgId, userId: analystId };
    const decision = (client: PoolClient, lineCount: number | undefined) =>
      client
        .query<{ id: string }>(
          `insert into decisions (org_id, deduction_id, schema_id, schema_version, provider,
             model_version, input_state_hash, questions, result, raw_probabilities, confidence,
             latency_ms, prepared_by)
           values ($1,$2,'S','settlement-1','human','human', digest('x','sha256'), '{}'::jsonb,
                   $3::jsonb, '{}'::jsonb, 1, 0, $4) returning id`,
          [
            orgId,
            caseId,
            JSON.stringify({
              outcome: 'lost',
              recovered_cents: 0,
              family: null,
              invoice_id: '71',
              ...(lineCount === undefined ? {} : { line_count: lineCount }),
            }),
            analystId,
          ],
        )
        .then((r) => r.rows[0]!.id);

    // One cent out: every statement succeeds, and COMMIT is what refuses.
    await expect(
      inSession(claims, async (client) => {
        const id = await decision(client, 2);
        await insertLine(client, claims, id, 1, 50_000, 0);
        await insertLine(client, claims, id, 2, 0, 49_999);
      }),
    ).rejects.toThrow(/does not balance/);

    // A decision that pins lines and brings none.
    await expect(inSession(claims, (client) => decision(client, 2))).rejects.toThrow(/pins 2 lines and has 0/);

    // Fewer than it pins.
    await expect(
      inSession(claims, async (client) => {
        const id = await decision(client, 3);
        await insertLine(client, claims, id, 1, 50_000, 0);
        await insertLine(client, claims, id, 2, 0, 50_000);
      }),
    ).rejects.toThrow(/pins 3 lines and has 2/);

    // A decision that pins no count is accepted as before, and never gains a line.
    const plain = await inSession(claims, (client) => decision(client, undefined));
    await expect(
      inSession(claims, (client) => insertLine(client, claims, plain, 1, 50_000, 0)),
    ).rejects.toThrow(/carries no line_count/);

    const { rows } = await admin.query(
      `select count(*)::int as n from decisions where deduction_id = $1`,
      [caseId],
    );
    expect(rows[0]?.n).toBe(1);
  });

  it('a line added after the decision committed is refused, by its preparer too', async () => {
    const caseId = await newCase();
    const { decisionId } = await lost(caseId, edited);
    const claims = { orgId, userId: analystId };
    await expect(
      inSession(claims, (client) => insertLine(client, claims, decisionId, 4, 1, 0)),
    ).rejects.toThrow(/pins 3 lines and has 4/);
    await expect(
      inSession(claims, async (client) => {
        await insertLine(client, claims, decisionId, 4, 1, 0);
        await insertLine(client, claims, decisionId, 5, 0, 1);
      }),
    ).rejects.toThrow(/pins 3 lines and has 5/);
    await expect(
      inSession(claims, (client) =>
        client.query(`update settlement_lines set memo = 'changed' where decision_id = $1`, [decisionId]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      admin.query(`update settlement_lines set debit_cents = 1 where decision_id = $1`, [decisionId]),
    ).rejects.toThrow(/append-only/);
    expect(await as(analystId).settlementLinesFor(decisionId)).toHaveLength(3);
  });

  it('another tenant reads none of the lines, prepares nothing on the case and hangs no line on the decision', async () => {
    const caseId = await newCase();
    const { decisionId } = await lost(caseId, edited);
    const stranger = new PostgresPostingStore(config, { orgId: otherOrgId, userId: strangerId });
    expect(await stranger.settlementLinesFor(decisionId)).toEqual([]);
    await expect(
      stranger.prepareSettlementDecision({
        deductionId: caseId,
        preparedBy: strangerId,
        outcome: 'lost',
        recoveredCents: cents(0),
        family: 'shortage',
        invoiceId: '71',
        lines: { connectionId, lines: edited, readChart },
      }),
    ).rejects.toBeInstanceOf(PostingDecisionError);
    const theirs = { orgId: otherOrgId, userId: strangerId };
    await expect(
      inSession(theirs, (client) => insertLine(client, theirs, decisionId, 4, 1, 0)),
    ).rejects.toThrow(/not this tenant's/);
    // Claiming our org without being in it.
    const forged = { orgId, userId: strangerId };
    await expect(
      inSession(forged, (client) => insertLine(client, forged, decisionId, 4, 1, 0)),
    ).rejects.toThrow(/prepared by someone else|row-level security/);
    // A colleague who did not prepare it writes none either.
    const colleague = { orgId, userId: approverId };
    await expect(
      inSession(colleague, (client) => insertLine(client, colleague, decisionId, 4, 1, 0)),
    ).rejects.toThrow(/prepared by someone else/);
  });

  it('a later decision supersedes an unapproved one; an approved settlement takes no other', async () => {
    const caseId = await newCase();
    const first = await lost(caseId, edited);
    const second = await lost(caseId, [
      { accountExternalId: '300', debitCents: 50_000, creditCents: 0, memo: 'All to trade spend' },
      { accountExternalId: '90', debitCents: 0, creditCents: 50_000 },
    ]);
    expect(second.decisionId).not.toBe(first.decisionId);

    // Both stay on the record, each with its own lines.
    expect(await as(approverId).settlementLinesFor(first.decisionId)).toHaveLength(3);
    expect(await as(approverId).settlementLinesFor(second.decisionId)).toHaveLength(2);
    expect((await as(approverId).postingForCase(caseId)).settlement).toMatchObject({
      decisionId: second.decisionId,
      approved: false,
    });

    // The superseded decision cannot be approved; no approval row is written for it.
    await expect(as(approverId).approveSettlement(first.decisionId)).rejects.toMatchObject({
      name: 'SettlementApprovalRefusedError',
      reason: 'superseded',
    });
    const { rows: none } = await admin.query(`select count(*)::int as n from approvals where decision_id = $1`, [
      first.decisionId,
    ]);
    expect(none[0]?.n).toBe(0);

    // The preparer is still refused by the database, and a second person approves.
    await expect(as(analystId).approveSettlement(second.decisionId)).rejects.toMatchObject({ reason: 'preparer' });
    // The write-off is what the outcome left unrecovered, whichever accounts carry it.
    await expect(as(approverId).approveSettlement(second.decisionId)).resolves.toEqual({
      deductionId: caseId,
      writeoffCents: amount,
    });

    // Approved: nothing more is prepared, with lines or without.
    await expect(lost(caseId, edited)).rejects.toBeInstanceOf(SettlementAlreadyApprovedError);
    await expect(lost(caseId, undefined)).rejects.toBeInstanceOf(SettlementAlreadyApprovedError);
    // And its lines take no addition, at the statement.
    const claims = { orgId, userId: analystId };
    await expect(
      inSession(claims, (client) => insertLine(client, claims, second.decisionId, 3, 1, 0)),
    ).rejects.toThrow(/already approved/);
    const { rows } = await admin.query(
      `select count(*)::int as n from decisions where deduction_id = $1 and schema_id = 'S'`,
      [caseId],
    );
    expect(rows[0]?.n).toBe(2);
  });

  it("the approval's writeback row carries the stored lines, and the job is handed them with their memos", async () => {
    const caseId = await newCase();
    const { decisionId } = await lost(caseId, edited);
    await as(approverId).approveSettlement(decisionId);
    const { writebackId } = await as(approverId).insertWriteback({
      decisionId,
      method: 'journal_entry',
      connectionId,
    });
    const { rows } = await admin.query(
      `select amount_cents::int as amount, lines from writebacks where id = $1`,
      [writebackId],
    );
    // Account ids, sides and cents: the memo is not copied here.
    expect(rows[0]).toEqual({
      amount,
      lines: [
        { accountId: '300', side: 'Debit', amountCents: 30_000 },
        { accountId: '200', side: 'Debit', amountCents: 20_000 },
        { accountId: '90', side: 'Credit', amountCents: 50_000 },
      ],
    });
    const row = await as(approverId).writebackForPosting(writebackId);
    expect(row?.settlementLines).toEqual([
      { accountId: '300', side: 'Debit', amountCents: 30_000, memo: 'Agreed with the buyer' },
      { accountId: '200', side: 'Debit', amountCents: 20_000 },
      { accountId: '90', side: 'Credit', amountCents: 50_000 },
    ]);
    expect(row?.lines).toEqual(rows[0]?.lines);

    // No event on the case carries the memo.
    const { rows: events } = await admin.query(
      `select payload from deduction_events where deduction_id = $1`,
      [caseId],
    );
    expect(JSON.stringify(events)).not.toContain('Agreed');

    // A map saved since changes nothing: the lines were approved, not the map.
    await as(ownerId).saveAccountMap(connectionId, { ...map, unclassifiedWriteoff: '300' }, types);
    expect((await as(approverId).writebackForPosting(writebackId))?.settlementLines).toEqual(row?.settlementLines);
  });

  it('a settlement prepared without lines carries none and is posted from the computed ones', async () => {
    const caseId = await newCase();
    const { decisionId } = await lost(caseId, undefined);
    expect(await as(analystId).settlementLinesFor(decisionId)).toEqual([]);
    const seen = await as(analystId).postingForCase(caseId);
    expect(seen.settlement?.lines).toBeUndefined();
    await as(approverId).approveSettlement(decisionId);
    const { writebackId } = await as(approverId).insertWriteback({
      decisionId,
      method: 'journal_entry',
      connectionId,
    });
    const row = await as(approverId).writebackForPosting(writebackId);
    expect(row?.settlementLines).toBeUndefined();
    expect(row?.lines).toEqual([
      { accountId: '200', side: 'Debit', amountCents: amount },
      { accountId: '90', side: 'Credit', amountCents: amount },
    ]);
  });

  it('reads the chart once per prepare', async () => {
    const before = chartReads;
    await lost(await newCase(), edited);
    expect(chartReads).toBe(before + 1);
  });
});

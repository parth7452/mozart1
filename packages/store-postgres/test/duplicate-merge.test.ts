import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  buildLedgerExtract,
  cents,
  detectShortPays,
  resolveIdentity,
  type LedgerInvoice,
  type LedgerPayment,
} from '@recouple/core-domain';
import {
  ActorIsNotTheSessionError,
  CaseMergedAwayError,
  CaseNotVisibleError,
  DuplicateCaseError,
  MergeRefusedError,
  WrongCaseStateError,
  WrongRoleError,
} from '@recouple/pipeline';
import { closeAllPools, PostgresStore } from '../src/store';
import { PostgresDiscoveryStore } from '../src/discovery';

const connectionString = process.env.DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

/**
 * Merging a confirmed duplicate, and undoing it (ADR 0042), through
 * `PostgresStore` as `app_rw` under the real policies and triggers.
 *
 * The database decides almost everything here — which case survives, whether
 * the pair may be merged, the state move, the events — so what these tests
 * check is that the store asks it, names what it refuses, and that every read
 * that feeds identity resolution treats a merged-away case as its survivor.
 */
describeDb('merging a confirmed duplicate', () => {
  const admin = new Pool({ connectionString });
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const userId = randomUUID();
  const readerId = randomUUID();
  const suffix = orgId.slice(0, 8);
  let store: PostgresStore;
  let readOnlyStore: PostgresStore;
  let otherStore: PostgresStore;
  let debtorId: string;
  let pairs = 0;

  beforeAll(async () => {
    for (const [id, slug] of [
      [orgId, `merge-${suffix}`],
      [otherOrgId, `merge-other-${suffix}`],
    ] as const) {
      await admin.query(`insert into organizations (id, slug, name) values ($1,$2,'Merges')`, [
        id,
        slug,
      ]);
      await admin.query(`insert into org_settings (org_id) values ($1)`, [id]);
    }
    await admin.query(`insert into users (id, email) values ($1,$2), ($3,$4)`, [
      userId,
      `merge-${suffix}@example.test`,
      readerId,
      `merge-reader-${suffix}@example.test`,
    ]);
    await admin.query(
      `insert into memberships (org_id, user_id, role)
       values ($1,$2,'analyst'), ($1,$3,'read_only'), ($4,$2,'analyst')`,
      [orgId, userId, readerId, otherOrgId],
    );
    const { rows } = await admin.query<{ id: string }>(
      `insert into debtors (org_id, retailer_key, display_name)
       values ($1, 'walmart_apdp', 'Walmart (APDP)') returning id`,
      [orgId],
    );
    debtorId = rows[0]?.id as string;

    const config = { connectionString: connectionString as string };
    store = new PostgresStore(config, { orgId, userId });
    readOnlyStore = new PostgresStore(config, { orgId, userId: readerId });
    otherStore = new PostgresStore(config, { orgId: otherOrgId, userId });
  });

  afterAll(async () => {
    await closeAllPools();
    await store?.close();
    await readOnlyStore?.close();
    await otherStore?.close();
    await admin.end();
  });

  /**
   * A probable pair the way the pipeline makes one: a case we hold whose
   * invoice and claim id are identifiers, and a notice that agrees on invoice,
   * amount and date and prints a claim id of its own — through the real
   * `openCase`, so `case.possible_duplicate` is the pipeline's own.
   */
  async function probablePair(amountCents = 42_150): Promise<{
    older: string;
    newer: string;
    olderClaim: string;
    newerClaim: string;
    invoiceNumber: string;
  }> {
    pairs += 1;
    const older = randomUUID();
    const invoiceNumber = `MRG-INV-${suffix}-${pairs}`;
    const olderClaim = `MRG-${suffix}-${pairs}-held`;
    await admin.query(
      `insert into deductions (id, org_id, debtor_id, claim_id, deduction_amount_cents, deduction_date)
       values ($1,$2,$3,$4,$5,'2026-07-02')`,
      [older, orgId, debtorId, olderClaim, amountCents],
    );
    await admin.query(
      `insert into deduction_identifiers (org_id, deduction_id, source, identifier_kind, identifier)
       values ($1,$2,'erp_sync','invoice_number',$3), ($1,$2,'erp_sync','claim_id',$4)`,
      [orgId, older, invoiceNumber, olderClaim],
    );
    const newerClaim = `MRG-${suffix}-${pairs}-new`;
    const opened = await store.openCase({
      orgId,
      claimId: newerClaim,
      invoiceNumber,
      source: 'web_upload',
      retailerName: 'Walmart (APDP)',
      deductionAmountCents: amountCents,
      deductionDate: '2026-07-05',
    });
    return { older, newer: opened.deductionId, olderClaim, newerClaim, invoiceNumber };
  }

  async function stateOf(deductionId: string): Promise<string> {
    const { rows } = await admin.query<{ state: string }>(
      `select state from deductions where id = $1`,
      [deductionId],
    );
    return rows[0]?.state as string;
  }

  async function eventsOf(deductionId: string, type: string): Promise<Record<string, unknown>[]> {
    const { rows } = await admin.query<{ payload: Record<string, unknown> }>(
      `select payload from deduction_events where deduction_id = $1 and event_type = $2 order by id`,
      [deductionId, type],
    );
    return rows.map((row) => row.payload);
  }

  async function storedDocument(label: string): Promise<string> {
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
    return stored.documentId;
  }

  it('merges on "Same deduction", in one transaction, and the database moves the state', async () => {
    const pair = await probablePair();
    expect(await store.possibleDuplicates({ deductionId: pair.newer })).toHaveLength(1);

    const verdict = await store.recordDuplicateVerdict({
      deductionId: pair.newer,
      otherDeductionId: pair.older,
      verdict: 'same',
      recordedBy: userId,
      merge: true,
    });

    expect(verdict.merge?.kind).toBe('merged');
    if (verdict.merge?.kind !== 'merged') throw new Error('not merged');
    expect(verdict.merge.merge).toMatchObject({
      mergedDeductionId: pair.newer,
      survivingDeductionId: pair.older,
      stateBefore: 'discovered',
      recordedBy: userId,
    });
    expect(verdict.survivingDeductionId).toBe(pair.older);

    expect(await stateOf(pair.newer)).toBe('merged');
    expect(await stateOf(pair.older)).toBe('discovered');
    expect(await eventsOf(pair.newer, 'case.merged_into')).toEqual([
      expect.objectContaining({ into: pair.older, state_before: 'discovered', recorded_by: userId }),
    ]);
    expect(await eventsOf(pair.older, 'case.absorbed')).toEqual([
      expect.objectContaining({ from: pair.newer, recorded_by: userId }),
    ]);

    expect(await store.possibleDuplicates({ deductionId: pair.newer })).toEqual([]);

    const loserPage = await store.mergesFor(pair.newer);
    expect(loserPage.mergedInto).toMatchObject({
      deductionId: pair.older,
      claimId: pair.olderClaim,
      deductionAmountCents: 42_150,
      mergedBy: userId,
    });
    expect(loserPage.absorbed).toEqual([]);
    const survivorPage = await store.mergesFor(pair.older);
    expect(survivorPage.mergedInto).toBeUndefined();
    expect(survivorPage.absorbed).toEqual([
      expect.objectContaining({ deductionId: pair.newer, claimId: pair.newerClaim, state: 'merged' }),
    ]);
    expect(survivorPage.confirmedNotMerged).toEqual([]);
  });

  it('sends every later arrival to the survivor', async () => {
    const pair = await probablePair();
    const arrival = {
      identifiers: [
        { kind: 'claim_id' as const, identifier: pair.olderClaim },
        { kind: 'claim_id' as const, identifier: pair.newerClaim },
      ],
    };

    // Before: an arrival naming both halves is held as ambiguous (ADR 0032).
    const before = await store.identityCandidates({ orgId, identifiers: arrival.identifiers });
    expect(resolveIdentity(arrival, before.knownIdentifiers, before.knownDeductions).kind).toBe(
      'ambiguous',
    );

    await store.recordDuplicateVerdict({
      deductionId: pair.older,
      otherDeductionId: pair.newer,
      verdict: 'same',
      recordedBy: userId,
      merge: true,
    });

    // After: one exact match, on the survivor.
    const after = await store.identityCandidates({ orgId, identifiers: arrival.identifiers });
    expect(resolveIdentity(arrival, after.knownIdentifiers, after.knownDeductions)).toMatchObject({
      kind: 'exact',
      deductionId: pair.older,
    });

    // A notice printing the merged-away case's claim is a duplicate of the survivor.
    const again = store.openCase({
      orgId,
      claimId: pair.newerClaim,
      source: 'web_upload',
      deductionAmountCents: 42_150,
    });
    await expect(again).rejects.toBeInstanceOf(DuplicateCaseError);
    await expect(again).rejects.toMatchObject({ existingDeductionId: pair.older });

    // A probable candidate by invoice is the survivor, never the merged-away case.
    const byInvoice = await store.identityCandidates({
      orgId,
      identifiers: [],
      invoiceNumber: pair.invoiceNumber,
    });
    expect(byInvoice.knownDeductions.map((d) => d.deductionId)).toEqual([pair.older]);
  });

  it('refuses work on the merged-away case, by name', async () => {
    const pair = await probablePair();
    const notice = await storedDocument(`notice-${pairs}`);
    await store.linkDocument(pair.newer, notice, 'notice');
    await store.recordDuplicateVerdict({
      deductionId: pair.newer,
      otherDeductionId: pair.older,
      verdict: 'same',
      recordedBy: userId,
      merge: true,
    });

    // Where a document of the merged-away case is, now: on the survivor.
    expect(await store.caseForDocument(notice)).toBe(pair.older);

    const evidence = await storedDocument(`evidence-${pairs}`);
    await expect(store.linkDocument(pair.newer, evidence, 'evidence')).rejects.toBeInstanceOf(
      CaseMergedAwayError,
    );
    await expect(store.linkDocument(pair.newer, evidence, 'evidence')).rejects.toMatchObject({
      deductionId: pair.newer,
      table: 'deduction_documents',
    });
    await expect(
      store.declineCase({
        deductionId: pair.newer,
        reason: 'duplicate_of_other',
        decidedBy: `merge-${suffix}@example.test`,
      }),
    ).rejects.toBeInstanceOf(CaseMergedAwayError);
    await expect(
      store.recordHumanDecision({
        deductionId: pair.newer,
        preparedBy: userId,
        reason: 'price_discrepancy',
        rationale: 'the price was agreed',
      }),
    ).rejects.toBeInstanceOf(WrongCaseStateError);
  });

  it('keeps the case somebody worked on, even when it is the newer one', async () => {
    const pair = await probablePair();
    await admin.query(
      `insert into decisions (org_id, deduction_id, schema_id, schema_version, provider,
                              model_version, input_state_hash, questions, result,
                              raw_probabilities, confidence, latency_ms, prepared_by)
       values ($1,$2,'B','1.0.0','jev','jev-latest',digest($4,'sha256'),
               '{}'::jsonb,'{}'::jsonb,'{}'::jsonb,0.5,1,$3)`,
      [orgId, pair.newer, userId, `worked-${pair.newer}`],
    );
    const verdict = await store.recordDuplicateVerdict({
      deductionId: pair.older,
      otherDeductionId: pair.newer,
      verdict: 'same',
      recordedBy: userId,
      merge: true,
    });
    expect(verdict.merge).toMatchObject({
      kind: 'merged',
      merge: { mergedDeductionId: pair.older, survivingDeductionId: pair.newer },
    });
    expect(verdict.survivingDeductionId).toBe(pair.newer);
    expect(await stateOf(pair.older)).toBe('merged');
  });

  it('keeps the verdict and says why when the pair cannot be merged', async () => {
    const pair = await probablePair();
    // Two deductions that happen to agree on every probable fact but the cent.
    await admin.query(
      `update deductions set deduction_amount_cents = 42149 where id = $1`,
      [pair.older],
    );
    const verdict = await store.recordDuplicateVerdict({
      deductionId: pair.newer,
      otherDeductionId: pair.older,
      verdict: 'same',
      recordedBy: userId,
      merge: true,
    });
    expect(verdict.merge).toEqual({ kind: 'not_merged', reason: 'amounts_disagree' });
    expect(await stateOf(pair.newer)).toBe('discovered');
    expect(await eventsOf(pair.newer, 'case.duplicate_confirmed')).toHaveLength(1);
    expect((await store.mergesFor(pair.newer)).confirmedNotMerged).toEqual([
      expect.objectContaining({ deductionId: pair.older, refusal: 'amounts_disagree' }),
    ]);
    await expect(
      store.mergeConfirmedDuplicate({
        deductionId: pair.newer,
        otherDeductionId: pair.older,
        mergedBy: userId,
      }),
    ).rejects.toMatchObject({ reason: 'amounts_disagree' });
  });

  it('merges a pair confirmed earlier, from the Merge button', async () => {
    const pair = await probablePair();
    await store.recordDuplicateVerdict({
      deductionId: pair.newer,
      otherDeductionId: pair.older,
      verdict: 'same',
      recordedBy: userId,
    });
    expect((await store.mergesFor(pair.older)).confirmedNotMerged).toEqual([
      expect.objectContaining({ deductionId: pair.newer }),
    ]);
    expect((await store.mergesFor(pair.older)).confirmedNotMerged[0]?.refusal).toBeUndefined();

    const merged = await store.mergeConfirmedDuplicate({
      deductionId: pair.older,
      otherDeductionId: pair.newer,
      mergedBy: userId,
    });
    expect(merged.mergedDeductionId).toBe(pair.newer);
  });

  it('names every refusal', async () => {
    const pair = await probablePair();
    const unconfirmed = store.mergeConfirmedDuplicate({
      deductionId: pair.newer,
      otherDeductionId: pair.older,
      mergedBy: userId,
    });
    await expect(unconfirmed).rejects.toBeInstanceOf(MergeRefusedError);
    await expect(unconfirmed).rejects.toMatchObject({ reason: 'not_confirmed' });

    await store.recordDuplicateVerdict({
      deductionId: pair.newer,
      otherDeductionId: pair.older,
      verdict: 'same',
      recordedBy: userId,
    });
    await expect(
      store.mergeConfirmedDuplicate({
        deductionId: pair.newer,
        otherDeductionId: pair.older,
        mergedBy: readerId,
      }),
    ).rejects.toBeInstanceOf(ActorIsNotTheSessionError);
    await expect(
      readOnlyStore.mergeConfirmedDuplicate({
        deductionId: pair.newer,
        otherDeductionId: pair.older,
        mergedBy: readerId,
      }),
    ).rejects.toBeInstanceOf(WrongRoleError);
    await expect(
      otherStore.mergeConfirmedDuplicate({
        deductionId: pair.newer,
        otherDeductionId: pair.older,
        mergedBy: userId,
      }),
    ).rejects.toBeInstanceOf(CaseNotVisibleError);

    const notMerged = store.undoMerge({ deductionId: pair.newer, undoneBy: userId });
    await expect(notMerged).rejects.toBeInstanceOf(MergeRefusedError);
    await expect(notMerged).rejects.toMatchObject({ reason: 'not_merged' });
    await expect(otherStore.undoMerge({ deductionId: pair.newer, undoneBy: userId })).rejects.toBeInstanceOf(
      CaseNotVisibleError,
    );
  });

  it('undoes a merge once, back where it was, and reopens the question', async () => {
    const pair = await probablePair();
    await store.recordDuplicateVerdict({
      deductionId: pair.newer,
      otherDeductionId: pair.older,
      verdict: 'same',
      recordedBy: userId,
      merge: true,
    });

    const undone = await store.undoMerge({ deductionId: pair.newer, undoneBy: userId });
    expect(undone).toMatchObject({
      mergedDeductionId: pair.newer,
      survivingDeductionId: pair.older,
      restoredState: 'discovered',
    });
    expect(await stateOf(pair.newer)).toBe('discovered');
    expect(await eventsOf(pair.newer, 'case.duplicate_verdict_withdrawn')).toHaveLength(1);
    expect(await eventsOf(pair.older, 'case.duplicate_verdict_withdrawn')).toHaveLength(1);

    // The verdict went with the merge, so the pair is a question again.
    expect(await store.possibleDuplicates({ deductionId: pair.newer })).toHaveLength(1);
    expect((await store.mergesFor(pair.newer)).mergedInto).toBeUndefined();

    // Answered "same" a second time, it stands and is not merged: a pair is
    // merged at most once.
    const again = await store.recordDuplicateVerdict({
      deductionId: pair.newer,
      otherDeductionId: pair.older,
      verdict: 'same',
      recordedBy: userId,
      merge: true,
    });
    expect(again.merge).toEqual({ kind: 'not_merged', reason: 'merged_before' });
    await expect(store.undoMerge({ deductionId: pair.newer, undoneBy: userId })).rejects.toMatchObject({
      reason: 'not_merged',
    });
  });

  it('lets exactly one of two racing merges of one case through', async () => {
    const one = await probablePair(51_000);
    // A second case the newer one is also confirmed to be.
    const third = randomUUID();
    await admin.query(
      `insert into deductions (id, org_id, debtor_id, claim_id, deduction_amount_cents, created_at)
       values ($1,$2,$3,$4,51000, now() - interval '1 day')`,
      [third, orgId, debtorId, `MRG-${suffix}-third`],
    );
    await admin.query(
      `insert into deduction_events (org_id, deduction_id, event_type, payload, event_time)
       values ($1,$2,'case.possible_duplicate',$3::jsonb,now())`,
      [orgId, one.newer, JSON.stringify({ of: third, basis: ['amount_cents'] })],
    );
    for (const other of [one.older, third]) {
      await store.recordDuplicateVerdict({
        deductionId: one.newer,
        otherDeductionId: other,
        verdict: 'same',
        recordedBy: userId,
      });
    }

    const results = await Promise.allSettled([
      store.mergeConfirmedDuplicate({ deductionId: one.newer, otherDeductionId: one.older, mergedBy: userId }),
      store.mergeConfirmedDuplicate({ deductionId: one.newer, otherDeductionId: third, mergedBy: userId }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected');
    expect(refused?.status === 'rejected' && refused.reason).toBeInstanceOf(MergeRefusedError);
    expect(refused?.status === 'rejected' && (refused.reason as MergeRefusedError).reason).toBe(
      'already_merged',
    );
    const { rows } = await admin.query<{ count: string }>(
      `select count(*)::text as count from deduction_merges where merged_deduction_id = $1`,
      [one.newer],
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('makes a link that starts during a merge wait for it, then refuses it', async () => {
    const pair = await probablePair();
    await store.recordDuplicateVerdict({
      deductionId: pair.newer,
      otherDeductionId: pair.older,
      verdict: 'same',
      recordedBy: userId,
    });
    const evidence = await storedDocument(`race-${pairs}`);

    // The merge, held open on a connection of its own.
    const merging = await admin.connect();
    try {
      await merging.query('begin');
      await merging.query('set local role app_rw');
      await merging.query('select set_config($1, $2, true)', [
        'request.jwt.claims',
        JSON.stringify({ org_id: orgId, sub: userId }),
      ]);
      await merging.query(
        `insert into deduction_merges (org_id, merged_deduction_id, surviving_deduction_id, action,
                                       state_before, amount_cents, verdict_event_id, recorded_by)
         select $1, d.id, $3::uuid, 'merge', d.state, d.deduction_amount_cents,
                (select v.event_id from duplicate_pair_verdicts v
                  where v.low_id in ($2::text, $3::text) and v.high_id in ($2::text, $3::text)),
                $4
           from deductions d where d.id = $2::uuid`,
        [orgId, pair.newer, pair.older, userId],
      );

      const link = store.linkDocument(pair.newer, evidence, 'evidence');
      const settled = link.then(
        () => 'linked',
        (error: unknown) => error,
      );
      const early = await Promise.race([
        settled,
        new Promise((resolve) => setTimeout(() => resolve('waiting'), 300)),
      ]);
      expect(early).toBe('waiting');

      await merging.query('commit');
      expect(await settled).toBeInstanceOf(CaseMergedAwayError);
    } finally {
      await merging.query('rollback').catch(() => undefined);
      merging.release();
    }
  });

  it('lands a ledger re-sync of a merged-away case on its survivor', async () => {
    const discovery = new PostgresDiscoveryStore(
      { connectionString: connectionString as string },
      { orgId, userId },
      store,
    );
    const invoiceId = `inv-${suffix}`;
    const ledgerInvoice: LedgerInvoice = {
      sourceKind: 'qbo',
      externalId: invoiceId,
      invoiceNumber: `LEDGER-${suffix}`,
      customerExternalId: 'cust-1',
      customerName: 'Sysco Baltimore, LLC',
      issuedOn: '2026-07-01',
      totalCents: cents(1_000_000),
      balanceCents: cents(80_000),
      currency: 'USD',
    };
    const ledgerPayment: LedgerPayment = {
      sourceKind: 'qbo',
      externalId: `pay-${suffix}`,
      customerExternalId: 'cust-1',
      receivedOn: '2026-07-20',
      totalCents: cents(920_000),
      reference: 'ACH-1',
      memo: 'short',
      appliedTo: [{ invoiceExternalId: invoiceId, amountCents: cents(920_000) }],
    };
    const report = detectShortPays([ledgerInvoice], [ledgerPayment], []);
    const candidate = report.candidates[0];
    if (candidate === undefined) throw new Error('no short-pay');
    const input = {
      orgId,
      extract: buildLedgerExtract(candidate, ledgerInvoice, [ledgerPayment], []),
      identifiers: { ledgerInvoiceId: invoiceId, invoiceNumber: `LEDGER-${suffix}` },
      gapCents: 80_000,
      customerName: 'Sysco Baltimore, LLC',
      gapStatus: 'open' as const,
      deductionDate: '2026-07-20',
    };
    const fromLedger = await discovery.recordLedgerCase(input);

    const held = randomUUID();
    await admin.query(
      `insert into deductions (id, org_id, claim_id, deduction_amount_cents, created_at)
       values ($1,$2,$3,80000, now() - interval '1 day')`,
      [held, orgId, `MRG-${suffix}-ledger-held`],
    );
    await admin.query(
      `insert into deduction_events (org_id, deduction_id, event_type, payload, event_time)
       values ($1,$2,'case.possible_duplicate',$3::jsonb,now())`,
      [orgId, fromLedger.deductionId, JSON.stringify({ of: held, basis: ['amount_cents'] })],
    );
    const verdict = await store.recordDuplicateVerdict({
      deductionId: fromLedger.deductionId,
      otherDeductionId: held,
      verdict: 'same',
      recordedBy: userId,
      merge: true,
    });
    expect(verdict.merge).toMatchObject({ kind: 'merged', merge: { survivingDeductionId: held } });

    const again = await discovery.recordLedgerCase(input);
    expect(again).toMatchObject({ reused: true, deductionId: held });
  });
});

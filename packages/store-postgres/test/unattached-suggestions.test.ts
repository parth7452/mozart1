import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { DOCUMENT_MATCH_FIELDS, basisKinds } from '@recouple/core-domain';
import { DOC_TYPES, type DocType } from '@recouple/extraction';
import {
  attachReadDocument,
  EvidenceSuggestionError,
  UnreadDocumentsQueryError,
  type EvidenceSuggestion,
} from '@recouple/pipeline';
import { closeAllPools, PostgresStore } from '../src/store';

const connectionString = process.env.TEST_DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

describe('the fields a document is matched on', () => {
  it('has an entry for every document type the reader knows, and no other', () => {
    expect(Object.keys(DOCUMENT_MATCH_FIELDS).sort()).toEqual([...DOC_TYPES].sort());
  });
});

/**
 * Which open case a document read and on no case is suggested for, on Postgres
 * as `app_rw` under RLS.
 *
 * The rule is `suggestCasesForDocument`'s and is property-tested where it
 * lives. What only the database can answer is here: that the read gathers the
 * right inputs — the stored fields, the identifiers mapped through
 * `deduction_merges_current`, a purchase order off a case's linked notice, a
 * debtor's aliases — that the SQL narrowing never loses a match the rule would
 * make, that one tenant's document never suggests another tenant's case, and
 * that a suggestion's basis reaches the `evidence.attached` event as constants.
 */
describeDb('suggestions for documents read and on no case, on Postgres', () => {
  const admin = new Pool({ connectionString });
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const userId = randomUUID();
  const suffix = orgId.slice(0, 8);
  let store: PostgresStore;
  let otherStore: PostgresStore;
  let krogerId: string;
  let minutes = 1_000;

  async function aCase(
    org: string,
    fields: {
      amount?: number;
      claimId?: string;
      state?: string;
      debtorId?: string;
      printedName?: string;
      identifiers?: readonly [source: string, kind: string, identifier: string][];
    } = {},
  ): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `insert into deductions (id, org_id, debtor_id, claim_id, deduction_amount_cents, state,
                               retailer_name_as_printed)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [
        id,
        org,
        fields.debtorId ?? null,
        fields.claimId ?? null,
        fields.amount ?? 100,
        fields.state ?? 'classified',
        fields.printedName ?? null,
      ],
    );
    for (const [source, kind, identifier] of fields.identifiers ?? []) {
      await admin.query(
        `insert into deduction_identifiers (org_id, deduction_id, source, identifier_kind, identifier)
         values ($1,$2,$3,$4,$5)`,
        [org, id, source, kind, identifier],
      );
    }
    return id;
  }

  /** A document stored, scanned, classified and read, newest last added. */
  async function aDocument(
    into: PostgresStore,
    org: string,
    docType: DocType,
    fields: Readonly<Record<string, unknown>>,
  ): Promise<string> {
    minutes -= 1;
    const { rows } = await admin.query<{ id: string }>(
      `insert into documents (org_id, sha256, byte_size, mime_type, storage_ref, filename, created_at)
       values ($1, $2, 4, 'application/pdf', $3, $4, now() - ($5::double precision * interval '1 minute'))
       returning id`,
      [
        org,
        Buffer.from(randomUUID().replace(/-/g, '').padEnd(64, '0'), 'hex'),
        `doc/${randomUUID()}`,
        `${docType}-${minutes}.pdf`,
        minutes,
      ],
    );
    const documentId = rows[0]?.id as string;
    await into.recordScan(documentId, { status: 'clean', scanner: 'test' });
    await into.recordClassification(documentId, docType, 0.97);
    await into.recordExtraction({
      documentId,
      docType,
      extractor: 'test',
      schemaVersion: 'v1',
      fields: Object.entries({ document_kind: 'kept so every document has a row', ...fields }).map(
        ([fieldPath, value]) => ({
          fieldPath,
          value,
          confidence: 0.9,
          sourcePage: 1,
          sourceQuote: String(value),
          sourceBbox: null,
          quoteVerified: true,
        }),
      ),
      document: {},
    });
    return documentId;
  }

  async function suggestionsFor(documentId: string, from: PostgresStore = store) {
    const all = await from.suggestionsForUnattached(200);
    const found = all.find((row) => row.documentId === documentId);
    expect(found).toBeDefined();
    return (found?.suggestions ?? []).map((s) => ({
      caseId: s.caseId,
      strength: s.strength,
      basis: basisKinds(s.basis),
    }));
  }

  beforeAll(async () => {
    for (const [id, slug] of [
      [orgId, `sug-${suffix}`],
      [otherOrgId, `sug-other-${suffix}`],
    ] as const) {
      await admin.query(`insert into organizations (id, slug, name) values ($1,$2,'Suggest')`, [id, slug]);
      await admin.query(`insert into org_settings (org_id) values ($1)`, [id]);
    }
    await admin.query(`insert into users (id, email) values ($1,$2)`, [
      userId,
      `sug-${suffix}@example.test`,
    ]);
    await admin.query(
      `insert into memberships (org_id, user_id, role) values ($1,$2,'analyst'), ($3,$2,'analyst')`,
      [orgId, userId, otherOrgId],
    );
    const { rows } = await admin.query<{ id: string }>(
      `insert into debtors (org_id, retailer_key, display_name) values ($1,'kroger','Kroger') returning id`,
      [orgId],
    );
    krogerId = rows[0]?.id as string;
    await admin.query(`insert into debtor_aliases (org_id, debtor_id, alias) values ($1,$2,$3)`, [
      orgId,
      krogerId,
      'The Kroger Company of Ohio',
    ]);

    const config = { connectionString: connectionString as string };
    store = new PostgresStore(config, { orgId, userId });
    otherStore = new PostgresStore(config, { orgId: otherOrgId, userId });
  });

  afterAll(async () => {
    await closeAllPools();
    await store?.close();
    await otherStore?.close();
    await admin.end();
  });

  it('suggests the one open case that carries the document’s invoice number, as exact', async () => {
    const invoice = `SUG-${suffix}-INV 1`;
    const target = await aCase(orgId, {
      claimId: `SUG-${suffix}-C1`,
      identifiers: [['web_upload', 'invoice_number', invoice]],
    });
    // Another writing of the same number: case and spacing differ.
    const documentId = await aDocument(store, orgId, 'invoice', {
      invoice_number: `  sug-${suffix}-inv   1 `,
    });

    const all = await store.suggestionsForUnattached(200);
    const row = all.find((r) => r.documentId === documentId);
    expect(row?.suggestions).toHaveLength(1);
    expect(row?.suggestions[0]).toMatchObject({
      caseId: target,
      strength: 'exact',
      basis: [{ kind: 'invoice_number', field: 'invoice_number' }],
      // The case as the list shows one, to name it and group by its payer.
      case: { deductionId: target, claimId: `SUG-${suffix}-C1`, state: 'classified' },
    });
  });

  it('lists both cases, and calls neither exact, when two carry the identifier', async () => {
    const invoice = `SUG-${suffix}-AMB`;
    const one = await aCase(orgId, { identifiers: [['web_upload', 'invoice_number', invoice]] });
    const two = await aCase(orgId, { identifiers: [['erp_sync', 'invoice_number', invoice]] });
    const documentId = await aDocument(store, orgId, 'invoice', { invoice_number: invoice });

    expect(await suggestionsFor(documentId)).toEqual(
      [one, two].sort().map((caseId) => ({ caseId, strength: 'ambiguous', basis: ['invoice_number'] })),
    );
  });

  it('suggests a same-payer, same-amount case as probable — by debtor, alias or printed name', async () => {
    const byDebtor = await aCase(orgId, { amount: 51_234, debtorId: krogerId });
    const byPrintedName = await aCase(orgId, { amount: 51_234, printedName: 'KROGER CO.' });
    // The same amount from somebody else, and the same payer at another amount.
    await aCase(orgId, { amount: 51_234, printedName: 'Walmart Stores' });
    await aCase(orgId, { amount: 51_235, debtorId: krogerId });

    const named = await aDocument(store, orgId, 'invoice', {
      customer_name: 'Kroger Co',
      invoice_total: '$512.34',
    });
    expect(await suggestionsFor(named)).toEqual(
      [byDebtor, byPrintedName]
        .sort()
        .map((caseId) => ({ caseId, strength: 'probable', basis: ['payer', 'amount_cents'] })),
    );

    // Through an alias a person added: only the case whose debtor answers to it.
    const aliased = await aDocument(store, orgId, 'price_agreement', {
      counterparty: 'The Kroger Company of Ohio',
      'terms[2].amount': '512.34',
    });
    expect(await suggestionsFor(aliased)).toEqual([
      { caseId: byDebtor, strength: 'probable', basis: ['payer', 'amount_cents'] },
    ]);
  });

  it('maps a merged-away case’s identifiers onto its survivor', async () => {
    const invoice = `SUG-${suffix}-MRG`;
    const olderClaim = `SUG-${suffix}-held`;
    const older = await aCase(orgId, { amount: 42_150, claimId: olderClaim, debtorId: krogerId });
    await admin.query(`update deductions set deduction_date = '2026-07-02' where id = $1`, [older]);
    await admin.query(
      `insert into deduction_identifiers (org_id, deduction_id, source, identifier_kind, identifier)
       values ($1,$2,'erp_sync','invoice_number',$3), ($1,$2,'erp_sync','claim_id',$4)`,
      [orgId, older, invoice, olderClaim],
    );
    const newerClaim = `SUG-${suffix}-new`;
    const newer = (
      await store.openCase({
        orgId,
        claimId: newerClaim,
        invoiceNumber: invoice,
        source: 'web_upload',
        retailerName: 'Kroger',
        deductionAmountCents: 42_150,
        deductionDate: '2026-07-05',
      })
    ).deductionId;
    const verdict = await store.recordDuplicateVerdict({
      deductionId: newer,
      otherDeductionId: older,
      verdict: 'same',
      recordedBy: userId,
      merge: true,
    });
    expect(verdict.merge?.kind).toBe('merged');
    const { rows } = await admin.query<{ id: string; state: string }>(
      `select id, state from deductions where id = any($1::uuid[])`,
      [[older, newer]],
    );
    const mergedAway = rows.find((r) => r.state === 'merged')?.id as string;
    const survivor = rows.find((r) => r.state !== 'merged')?.id as string;
    expect(mergedAway).toBeDefined();
    const mergedAwayClaim = mergedAway === older ? olderClaim : newerClaim;

    // A notice printing only the merged-away case's claim id.
    const documentId = await aDocument(store, orgId, 'deduction_notice', { claim_id: mergedAwayClaim });
    expect(await suggestionsFor(documentId)).toEqual([
      { caseId: survivor, strength: 'exact', basis: ['claim_id'] },
    ]);
    // And the invoice both carried is one case's now, not an ambiguous pair.
    const byInvoice = await aDocument(store, orgId, 'invoice', { invoice_number: invoice });
    expect(await suggestionsFor(byInvoice)).toEqual([
      { caseId: survivor, strength: 'exact', basis: ['invoice_number'] },
    ]);
  });

  it('finds a case by the purchase order on its own linked notice', async () => {
    const po = `SUG-${suffix}-PO-771`;
    const target = await aCase(orgId, { claimId: `SUG-${suffix}-PO` });
    const notice = await aDocument(store, orgId, 'deduction_notice', { po_number: po });
    await store.linkDocument(target, notice, 'notice');
    // A linked invoice's own number is not a shipment number.
    const pod = await aDocument(store, orgId, 'pod', {
      po_number: po.toLowerCase(),
      document_number: 'BOL-1',
    });

    expect(await suggestionsFor(pod)).toEqual([
      { caseId: target, strength: 'exact', basis: ['po_number'] },
    ]);
  });

  it('never suggests a closed case', async () => {
    const invoice = `SUG-${suffix}-CLOSED`;
    await aCase(orgId, { state: 'won', identifiers: [['web_upload', 'invoice_number', invoice]] });
    const documentId = await aDocument(store, orgId, 'invoice', { invoice_number: invoice });
    expect(await suggestionsFor(documentId)).toEqual([]);
  });

  it('never suggests another tenant’s case for this tenant’s document, either way round', async () => {
    const invoice = `SUG-${suffix}-TENANT`;
    const theirs = await aCase(otherOrgId, {
      amount: 77_777,
      printedName: 'Kroger',
      identifiers: [['web_upload', 'invoice_number', invoice]],
    });
    const mine = await aDocument(store, orgId, 'invoice', {
      invoice_number: invoice,
      customer_name: 'Kroger',
      invoice_total: '$777.77',
    });
    expect(await suggestionsFor(mine)).toEqual([]);
    expect(await store.suggestionForAttach(mine, theirs)).toBeUndefined();

    // Their own document does find it, and their list holds none of mine.
    const theirDocument = await aDocument(otherStore, otherOrgId, 'invoice', { invoice_number: invoice });
    expect(await suggestionsFor(theirDocument, otherStore)).toEqual([
      { caseId: theirs, strength: 'exact', basis: ['invoice_number'] },
    ]);
    const theirList = (await otherStore.suggestionsForUnattached(200)).map((r) => r.documentId);
    expect(theirList).toEqual([theirDocument]);
  });

  it('answers for exactly the documents the unattached list shows, in its order', async () => {
    const listed = (await store.unattachedDocuments(200)).map((row) => row.documentId);
    const suggested = (await store.suggestionsForUnattached(200)).map((row) => row.documentId);
    expect(suggested).toEqual(listed);
    expect(listed.length).toBeGreaterThan(3);

    const cut = (await store.suggestionsForUnattached(3)).map((row) => row.documentId);
    expect(cut).toEqual(listed.slice(0, 3));

    for (const limit of [0, -1, 1.5, Number.NaN]) {
      await expect(store.suggestionsForUnattached(limit)).rejects.toBeInstanceOf(
        UnreadDocumentsQueryError,
      );
    }
  });

  it('records the basis on evidence.attached as constants, and stops suggesting the document', async () => {
    const invoice = `SUG-${suffix}-ATTACH`;
    const target = await aCase(orgId, { identifiers: [['web_upload', 'invoice_number', invoice]] });
    const documentId = await aDocument(store, orgId, 'invoice', { invoice_number: invoice });

    const suggestion = await store.suggestionForAttach(documentId, target);
    expect(suggestion).toMatchObject({ caseId: target, strength: 'exact' });
    const result = await attachReadDocument(store, {
      deductionId: target,
      documentId,
      suggestion: {
        suggestedBy: 'identifier_match',
        strength: suggestion?.strength ?? 'probable',
        basis: basisKinds(suggestion?.basis ?? []),
      },
    });
    expect(result.attached).toBe(true);

    const { rows } = await admin.query<{ payload: Record<string, unknown> }>(
      `select payload from deduction_events
        where deduction_id = $1 and event_type = 'evidence.attached'`,
      [target],
    );
    expect(rows.map((r) => r.payload)).toEqual([
      {
        document_id: documentId,
        doc_type: 'invoice',
        read_again: false,
        suggested_by: 'identifier_match',
        strength: 'exact',
        basis: ['invoice_number'],
      },
    ]);
    // Nothing off the page: the invoice number is on the document, not the event.
    expect(JSON.stringify(rows)).not.toContain(invoice);

    const still = (await store.suggestionsForUnattached(200)).map((r) => r.documentId);
    expect(still).not.toContain(documentId);
  });

  it('refuses a suggestion that is not made of constants, and writes nothing', async () => {
    const target = await aCase(orgId);
    const documentId = await aDocument(store, orgId, 'invoice', { invoice_number: 'X' });
    const forged = {
      suggestedBy: 'identifier_match',
      strength: 'exact',
      basis: ['Pay invoice 44817 to account 12-3456'],
    } as unknown as EvidenceSuggestion;

    await expect(
      attachReadDocument(store, { deductionId: target, documentId, suggestion: forged }),
    ).rejects.toBeInstanceOf(EvidenceSuggestionError);

    const { rows } = await admin.query(
      `select 1 from deduction_documents where deduction_id = $1
       union all
       select 1 from deduction_events where deduction_id = $1 and event_type = 'evidence.attached'`,
      [target],
    );
    expect(rows).toEqual([]);
  });
});

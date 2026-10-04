import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { DocType } from '@recouple/extraction';
import { SUGGESTION_CANDIDATES_LIMIT } from '../src/document-match';
import { closeAllPools, PostgresStore } from '../src/store';

const connectionString = process.env.TEST_DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

/**
 * What a suggestion says when the candidate read is cut at its limit.
 *
 * `suggestionsForUnattached` hands one pool of candidate cases to the rule for
 * every listed document, newest first, at most `SUGGESTION_CANDIDATES_LIMIT`.
 * `exact` means one open case carries the document's identifier. When the
 * limit cuts a case that carries one, the second carrier that makes an
 * identifier `ambiguous` may be the row that went, and the page told a person
 * "Matches case … (exact)" beside a link that cannot be undone. The read now
 * suggests nothing rather than answer over part of the carriers.
 *
 * In an org of its own: a thousand cases in the shared fixtures' org would
 * withhold every other test's suggestions.
 */
describeDb('suggestions when more cases carry an identifier than one read returns', () => {
  const admin = new Pool({ connectionString });
  const orgId = randomUUID();
  const userId = randomUUID();
  const suffix = orgId.slice(0, 8);
  const invoice = `CUT-${suffix}-INV`;
  const claim = `CUT-${suffix}-CLAIM`;
  let store: PostgresStore;
  let minutes = 1_000;
  let older: string;
  let newer: string;
  let invoiceDocument: string;

  async function aCaseCarrying(source: string, hoursAgo: number): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `insert into deductions (id, org_id, deduction_amount_cents, state, created_at)
       values ($1, $2, 100, 'classified', now() - ($3::int * interval '1 hour'))`,
      [id, orgId, hoursAgo],
    );
    await admin.query(
      `insert into deduction_identifiers (org_id, deduction_id, source, identifier_kind, identifier)
       values ($1, $2, $3, 'invoice_number', $4)`,
      [orgId, id, source, invoice],
    );
    return id;
  }

  async function aDocument(docType: DocType, fields: Readonly<Record<string, unknown>>): Promise<string> {
    minutes -= 1;
    const { rows } = await admin.query<{ id: string }>(
      `insert into documents (org_id, sha256, byte_size, mime_type, storage_ref, filename, created_at)
       values ($1, $2, 4, 'application/pdf', $3, $4, now() - ($5::double precision * interval '1 minute'))
       returning id`,
      [
        orgId,
        Buffer.from(randomUUID().replace(/-/g, '').padEnd(64, '0'), 'hex'),
        `doc/${randomUUID()}`,
        `${docType}-${minutes}.pdf`,
        minutes,
      ],
    );
    const documentId = rows[0]?.id as string;
    await store.recordScan(documentId, { status: 'clean', scanner: 'test' });
    await store.recordClassification(documentId, docType, 0.97);
    await store.recordExtraction({
      documentId,
      docType,
      extractor: 'test',
      schemaVersion: 'v1',
      fields: Object.entries(fields).map(([fieldPath, value]) => ({
        fieldPath,
        value,
        confidence: 0.9,
        sourcePage: 1,
        sourceQuote: String(value),
        sourceBbox: null,
        quoteVerified: true,
      })),
      document: {},
    });
    return documentId;
  }

  async function strengthsFor(documentId: string): Promise<readonly string[]> {
    const all = await store.suggestionsForUnattached(200);
    const found = all.find((row) => row.documentId === documentId);
    expect(found).toBeDefined();
    return (found?.suggestions ?? []).map((s) => s.strength);
  }

  beforeAll(async () => {
    await admin.query(`insert into organizations (id, slug, name) values ($1, $2, 'Cut')`, [
      orgId,
      `cut-${suffix}`,
    ]);
    await admin.query(`insert into org_settings (org_id) values ($1)`, [orgId]);
    await admin.query(`insert into users (id, email) values ($1, $2)`, [
      userId,
      `cut-${suffix}@example.test`,
    ]);
    await admin.query(`insert into memberships (org_id, user_id, role) values ($1, $2, 'analyst')`, [
      orgId,
      userId,
    ]);
    store = new PostgresStore({ connectionString: connectionString as string }, { orgId, userId });

    // Two open cases carry one invoice number: the document that prints it is
    // ambiguous between them.
    older = await aCaseCarrying('web_upload', 3);
    newer = await aCaseCarrying('erp_sync', 2);
    invoiceDocument = await aDocument('invoice', { invoice_number: invoice });
  });

  afterAll(async () => {
    await closeAllPools();
    await store?.close();
    await admin.end();
  });

  it('calls the match ambiguous while every carrier fits in the read', async () => {
    expect(await strengthsFor(invoiceDocument)).toEqual(['ambiguous', 'ambiguous']);
  });

  it('suggests nothing, and never exact, once the limit cuts a case that carries the identifier', async () => {
    // Newer open cases that a second unattached document names, enough that
    // with the two above one carrier no longer fits: the older of the two is
    // the row the limit cuts.
    await admin.query(
      `insert into deductions (org_id, claim_id, deduction_amount_cents, state)
       select $1, $2, 200, 'classified' from generate_series(1, $3::int)`,
      [orgId, claim, SUGGESTION_CANDIDATES_LIMIT - 1],
    );
    const noticeDocument = await aDocument('deduction_notice', { claim_id: claim });

    expect(await strengthsFor(invoiceDocument)).toEqual([]);
    expect(await strengthsFor(noticeDocument)).toEqual([]);

    // The attach route's own question is about one document, whose two
    // carriers both fit: it still answers, and still says ambiguous.
    expect((await store.suggestionForAttach(invoiceDocument, newer))?.strength).toBe('ambiguous');
    expect((await store.suggestionForAttach(invoiceDocument, older))?.strength).toBe('ambiguous');
  });
});

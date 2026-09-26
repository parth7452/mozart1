import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg, { Pool } from 'pg';
import type { ScanStatus } from '@recouple/ingest';
import {
  BlobRefUnrecognisedError,
  closeAllPools,
  PostgresBlobStore,
  PostgresStore,
} from '../src/store';

const connectionString = process.env.TEST_DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

/**
 * Whether a document's bytes may be handed to a browser, as the database
 * answers it: the latest scan verdict and the arrival, under the tenant's
 * claims, with no bytes fetched (`documentServing`), and the same answer on
 * each of a case's documents (`caseDocuments`).
 */
describeDb('whether a stored document may be served', () => {
  const admin = new Pool({ connectionString });
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const analystId = randomUUID();
  const otherAnalystId = randomUUID();
  const suffix = orgId.slice(0, 8);
  let store: PostgresStore;
  const ids: Record<string, string> = {};

  async function stored(
    name: string,
    source: 'web_upload' | 'email_in' | 'erp_sync',
    verdicts: readonly ScanStatus[],
  ): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `insert into uploads (org_id, source, created_by) values ($1, $2, $3) returning id`,
      [orgId, source, source === 'web_upload' ? analystId : null],
    );
    const document = await store.putDocument({
      orgId,
      sha256: randomUUID().replace(/-/g, '').padEnd(64, '0'),
      filename: `${name}.pdf`,
      mimeType: 'application/pdf',
      byteSize: 8,
      bytes: new TextEncoder().encode('%PDF-1.7'),
      uploadId: rows[0]?.id as string,
      requiresSplit: false,
    });
    for (const status of verdicts) {
      await store.recordScan(document.documentId, { status, scanner: 'test' });
    }
    return document.documentId;
  }

  beforeAll(async () => {
    await admin.query(
      `insert into organizations (id, slug, name) values ($1,$2,'Serving'), ($3,$4,'Serving Other')`,
      [orgId, `serving-${suffix}`, otherOrgId, `serving-other-${suffix}`],
    );
    await admin.query(`insert into org_settings (org_id) values ($1), ($2)`, [orgId, otherOrgId]);
    await admin.query(`insert into users (id, email) values ($1,$2), ($3,$4)`, [
      analystId, `serving-a-${suffix}@example.test`,
      otherAnalystId, `serving-b-${suffix}@example.test`,
    ]);
    await admin.query(
      `insert into memberships (org_id, user_id, role) values ($1,$2,'analyst'), ($3,$4,'analyst')`,
      [orgId, analystId, otherOrgId, otherAnalystId],
    );
    store = new PostgresStore(
      { connectionString: connectionString as string },
      { orgId, userId: analystId },
    );

    ids.clean = await stored('clean', 'web_upload', ['clean']);
    ids.infected = await stored('infected', 'email_in', ['infected']);
    ids.unscanned = await stored('unscanned', 'web_upload', []);
    ids.scanError = await stored('scan-error', 'web_upload', ['error']);
    // The latest verdict decides, both ways: an error then a clean rescan
    // serves, a clean then an infected verdict does not.
    ids.rescannedClean = await stored('rescanned-clean', 'web_upload', ['error', 'clean']);
    ids.laterInfected = await stored('later-infected', 'web_upload', ['clean', 'infected']);
    ids.ledgerExtract = await stored('ledger-extract', 'erp_sync', []);
  });

  afterAll(async () => {
    await closeAllPools();
    await store?.close();
    await admin.end();
  });

  it('answers each document by its latest verdict and its arrival', async () => {
    const answers = Object.fromEntries(
      await Promise.all(
        Object.entries(ids).map(async ([name, id]) => [name, await store.documentServing(id)] as const),
      ),
    );
    expect(answers).toEqual({
      clean: { refusal: undefined },
      infected: { refusal: 'infected' },
      unscanned: { refusal: 'unscanned' },
      scanError: { refusal: 'unscanned' },
      rescannedClean: { refusal: undefined },
      laterInfected: { refusal: 'infected' },
      ledgerExtract: { refusal: undefined },
    });
  });

  it('asks the whole packet in one query, answering only what the tenant can see', async () => {
    const hidden = randomUUID();
    const answers = await store.documentsServing([
      ids.clean as string,
      ids.infected as string,
      (ids.unscanned as string).toUpperCase(),
      hidden,
    ]);
    expect([...answers.entries()]).toEqual([
      [ids.clean, { refusal: undefined }],
      [ids.infected, { refusal: 'infected' }],
      [(ids.unscanned as string).toUpperCase(), { refusal: 'unscanned' }],
    ]);
    expect((await store.documentsServing([])).size).toBe(0);
  });

  it('serves the bytes of a servable document, and only the verdict of a refused one', async () => {
    const clean = await store.servableDocument(ids.clean as string);
    expect(clean?.refusal).toBeUndefined();
    expect(clean?.document?.filename).toBe('clean.pdf');
    expect(clean?.document?.mimeType).toBe('application/pdf');
    expect(new TextDecoder().decode(clean?.document?.bytes)).toBe('%PDF-1.7');
    expect((await store.servableDocument(ids.ledgerExtract as string))?.document).toBeDefined();

    for (const [name, refusal] of [
      ['infected', 'infected'],
      ['unscanned', 'unscanned'],
      ['scanError', 'unscanned'],
      ['laterInfected', 'infected'],
    ] as const) {
      expect(await store.servableDocument(ids[name] as string)).toEqual({ refusal });
    }

    const other = new PostgresStore(
      { connectionString: connectionString as string },
      { orgId: otherOrgId, userId: otherAnalystId },
    );
    try {
      expect(await other.servableDocument(ids.clean as string)).toBeUndefined();
    } finally {
      await other.close();
    }
  });

  it('decides and fetches in one transaction, one snapshot, and never selects a refused document’s bytes', async () => {
    // Every statement any pooled client sends, with the client that sent it.
    const sent: { client: unknown; text: string }[] = [];
    const original = pg.Client.prototype.query;
    const spy = vi
      .spyOn(pg.Client.prototype, 'query')
      .mockImplementation(function (this: unknown, ...args: unknown[]) {
        const first = args[0];
        const text = typeof first === 'string' ? first : (first as { text?: string })?.text ?? '';
        sent.push({ client: this, text });
        return (original as (...a: unknown[]) => unknown).apply(this, args);
      } as typeof original);
    try {
      await store.servableDocument(ids.clean as string);
      const served = [...sent];
      sent.length = 0;
      await store.servableDocument(ids.infected as string);
      const refused = [...sent];

      // Served: the verdict and the bytes on one client, inside one
      // repeatable-read transaction, with no commit between them.
      const begins = served.filter((q) => /^begin/i.test(q.text));
      expect(begins.map((q) => q.text)).toEqual(['begin isolation level repeatable read']);
      const verdictAt = served.findIndex((q) => /from documents d/.test(q.text));
      const bytesAt = served.findIndex((q) => /from document_blobs/.test(q.text));
      const commitAt = served.findIndex((q) => /^commit/i.test(q.text));
      expect(verdictAt).toBeGreaterThan(-1);
      expect(bytesAt).toBeGreaterThan(verdictAt);
      expect(commitAt).toBeGreaterThan(bytesAt);
      expect(served[bytesAt]?.client).toBe(served[verdictAt]?.client);
      expect(served[commitAt]?.client).toBe(served[verdictAt]?.client);

      // Refused: the bytes were never selected.
      expect(refused.some((q) => /from documents d/.test(q.text))).toBe(true);
      expect(refused.some((q) => /document_blobs/.test(q.text))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('answers nothing for another tenant’s document, as RLS leaves it', async () => {
    const other = new PostgresStore(
      { connectionString: connectionString as string },
      { orgId: otherOrgId, userId: otherAnalystId },
    );
    try {
      expect(await other.documentServing(ids.clean as string)).toBeUndefined();
      expect(await other.documentServing(ids.infected as string)).toBeUndefined();
      expect(await store.documentServing(randomUUID())).toBeUndefined();
    } finally {
      await other.close();
    }
  });

  it('says the same on each of a case’s documents', async () => {
    const opened = await store.openCase({ orgId, deductionAmountCents: 10_000 });
    await admin.query(
      `insert into deduction_documents (org_id, deduction_id, document_id, role)
       values ($1, $2, $3, 'notice'), ($1, $2, $4, 'evidence'), ($1, $2, $5, 'evidence')`,
      [orgId, opened.deductionId, ids.infected, ids.clean, ids.unscanned],
    );
    const documents = await store.caseDocuments(opened.deductionId);
    expect(
      Object.fromEntries(documents.map((d) => [d.documentId, d.servingRefusal] as const)),
    ).toEqual({
      [ids.infected as string]: 'infected',
      [ids.clean as string]: null,
      [ids.unscanned as string]: 'unscanned',
    });
  });
});

describe('the Postgres blob store', () => {
  it('refuses a ref it cannot key, rather than keeping nothing and saying nothing', async () => {
    // No query is sent: the refusal comes before a connection is asked for,
    // so this holds without a database.
    const pool = new Pool({ connectionString: 'postgres://nobody@127.0.0.1:1/none' });
    const blobs = new PostgresBlobStore(pool, { orgId: randomUUID(), userId: randomUUID() }, 'app_rw');
    try {
      for (const ref of ['s3://bucket/key', 'pgblob://not-a-uuid', randomUUID(), '']) {
        await expect(blobs.put(ref, new Uint8Array([1]))).rejects.toBeInstanceOf(
          BlobRefUnrecognisedError,
        );
      }
      await expect(blobs.put('s3://bucket/secret-key', new Uint8Array([1]))).rejects.toThrow(
        /storage ref \(s3:\/\/\) is not a pgblob:\/\/<document id> ref/,
      );
    } finally {
      await pool.end();
    }
  });
});

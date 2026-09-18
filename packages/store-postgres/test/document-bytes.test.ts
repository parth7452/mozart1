import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { allFixtureDocuments } from '@recouple/fixtures';
import { PostgresStore } from '../src/store';

const connectionString = process.env.DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

/**
 * A case whose evidence cannot be produced is not a case. These assert the thing
 * `InMemoryBlobStore` could never do: the bytes are still there when the process
 * that stored them is gone — simulated here by a second store over a second pool,
 * which is as close to a cold start as a test gets.
 */
describeDb('a stored document’s bytes', () => {
  const admin = new Pool({ connectionString });
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const analystId = randomUUID();
  const otherAnalystId = randomUUID();
  const readerId = randomUUID();
  const suffix = orgId.slice(0, 8);
  let store: PostgresStore;
  let documentId: string;
  const notice = allFixtureDocuments().find((d) => d.filename === 'walmart-apdp-notice.pdf');

  beforeAll(async () => {
    await admin.query(
      `insert into organizations (id, slug, name) values ($1,$2,'Bytes'), ($3,$4,'Bytes Other')`,
      [orgId, `bytes-${suffix}`, otherOrgId, `bytes-other-${suffix}`],
    );
    await admin.query(`insert into org_settings (org_id) values ($1), ($2)`, [orgId, otherOrgId]);
    await admin.query(`insert into users (id, email) values ($1,$2), ($3,$4), ($5,$6)`, [
      analystId, `bytes-a-${suffix}@example.test`,
      otherAnalystId, `bytes-b-${suffix}@example.test`,
      readerId, `bytes-r-${suffix}@example.test`,
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
    const stored = await store.putDocument({
      orgId,
      sha256: 'b'.repeat(64),
      filename: 'walmart-apdp-notice.pdf',
      mimeType: 'application/pdf',
      byteSize: notice?.bytes.byteLength ?? 0,
      bytes: notice?.bytes ?? new Uint8Array(),
      requiresSplit: false,
    });
    documentId = stored.documentId;
  });

  afterAll(async () => {
    await store?.close();
    await admin.end();
  });

  it('comes back byte for byte from a store that never saw the upload', async () => {
    const coldStart = new PostgresStore(
      { connectionString: connectionString as string },
      { orgId, userId: analystId },
    );
    try {
      const found = await coldStart.findDocumentByHash(orgId, 'b'.repeat(64));
      expect(found?.documentId).toBe(documentId);
      expect(found?.bytes.byteLength).toBe(notice?.bytes.byteLength);
      expect(Buffer.from(found?.bytes ?? []).equals(Buffer.from(notice?.bytes ?? []))).toBe(true);
    } finally {
      await coldStart.close();
    }
  });

  it('is invisible to another tenant, like the row that points at it', async () => {
    const other = new PostgresStore(
      { connectionString: connectionString as string },
      { orgId: otherOrgId, userId: otherAnalystId },
    );
    try {
      expect(await other.findDocumentByHash(otherOrgId, 'b'.repeat(64))).toBeUndefined();
      const { rows } = await admin.query<{ n: string }>(
        `select count(*)::text as n from document_blobs where document_id = $1`,
        [documentId],
      );
      // The owner can see it; the other tenant's store cannot. Both matter: a
      // missing row would make the first assertion pass for the wrong reason.
      expect(Number(rows[0]?.n)).toBe(1);
    } finally {
      await other.close();
    }
  });

  it('can be read by a read_only member, who reviews but does not ingest', async () => {
    const reader = new PostgresStore(
      { connectionString: connectionString as string },
      { orgId, userId: readerId },
    );
    try {
      const found = await reader.findDocumentByHash(orgId, 'b'.repeat(64));
      expect(found?.bytes.byteLength).toBe(notice?.bytes.byteLength);
    } finally {
      await reader.close();
    }
  });

  it('cannot be rewritten once stored', async () => {
    await expect(
      admin.query(`update document_blobs set bytes = $1 where document_id = $2`, [
        Buffer.from([0]),
        documentId,
      ]),
    ).rejects.toThrow(/append-only|denied|immutable/i);
  });
});

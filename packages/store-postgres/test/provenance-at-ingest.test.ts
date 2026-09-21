import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  ingestDocument,
  type IngestSource,
  type PipelineDeps,
  type PipelineStore,
} from '@recouple/pipeline';
import { InMemoryStore } from '@recouple/pipeline/testing';
import { closeAllPools, PostgresStore } from '../src/store';

/**
 * Where a document came from is recorded when it arrives, and both stores say
 * the same thing about it.
 *
 * `declined_candidates.discovered_from` is what coverage is grouped by: of the
 * dollars each channel surfaced, how many did we fight for. Until this existed
 * nothing wrote the `uploads` table at all, so `documents.upload_id` was null
 * on every row and the channel was whatever the calling code assumed. The
 * assumption is gone; this is the suite that keeps it gone, and keeps the
 * in-memory store from answering a question the real one would answer
 * differently.
 */

const connectionString = process.env.DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

/** What the contract needs: a store, and a tenant it may write in. */
interface Harness {
  readonly store: PipelineStore;
  readonly orgId: string;
  /** A member of that tenant who may write — `uploads.created_by`. */
  readonly memberId: string;
  close(): Promise<void>;
}

type RegisterSuite = (name: string, body: () => void) => void;

/** Deps enough to run `ingestDocument`: nothing here classifies or extracts. */
function depsFor(store: PipelineStore): PipelineDeps {
  return {
    store,
    scanner: {
      name: 'test',
      async scan() {
        return { status: 'clean' as const, scanner: 'test' };
      },
    },
    // Neither is reached: `ingestDocument` stores and scans and stops.
    classifier: {
      async classify() {
        throw new Error('the ingest half does not classify');
      },
    } as unknown as PipelineDeps['classifier'],
    extractor: {
      async extract() {
        throw new Error('the ingest half does not extract');
      },
    } as unknown as PipelineDeps['extractor'],
    now: () => new Date('2026-09-21T00:00:00.000Z'),
  };
}

/** A distinct PDF per call, so two ingests are two arrivals and not a dedupe. */
function pdf(marker: number): Uint8Array {
  const header = Buffer.from(`%PDF-1.4\n% recouple provenance fixture ${marker}\n%%EOF\n`);
  return new Uint8Array(header);
}

function provenanceContract(
  name: string,
  register: RegisterSuite,
  create: () => Promise<Harness>,
): void {
  register(`provenance at ingest: ${name}`, () => {
    let h: Harness;
    beforeAll(async () => {
      h = await create();
    });
    afterAll(async () => {
      await h?.close();
    });

    it('writes the arrival before the document, and the document names it', async () => {
      const { document } = await ingestDocument(
        {
          orgId: h.orgId,
          filename: 'notice.pdf',
          bytes: pdf(1),
          source: 'web_upload',
          uploadedBy: h.memberId,
        },
        depsFor(h.store),
      );

      expect(document.uploadId).toBeDefined();
      expect(await h.store.uploadSourceFor(document.documentId)).toBe('web_upload');
    });

    it('records the channel the document actually came through', async () => {
      // Three channels, three answers. A store that returned the same word for
      // all of them would make every per-channel number identical and true of
      // nothing (STRATEGY CH-4).
      const sources: readonly IngestSource[] = ['web_upload', 'email_in', 'email_body'];
      let marker = 10;
      for (const source of sources) {
        marker += 1;
        const bytes =
          source === 'email_body'
            ? new TextEncoder().encode(
                'Deduction notice. Claim APDP-9100. '.repeat(10) +
                  'Invoice 55512 was short-paid by $3,120.00 against PO 7781004.',
              )
            : pdf(marker);
        const { document } = await ingestDocument(
          {
            orgId: h.orgId,
            filename: `${source}.pdf`,
            bytes,
            source,
            // A person for the upload, nobody for either email: `From:` is
            // forgeable and the sender is not one of our members.
            ...(source === 'web_upload' ? { uploadedBy: h.memberId } : {}),
          },
          depsFor(h.store),
        );
        expect(await h.store.uploadSourceFor(document.documentId)).toBe(source);
      }
    });

    it('keeps the first arrival when the same bytes come back', async () => {
      // A re-upload is not a second discovery. The document keeps the
      // `upload_id` its first arrival wrote, and nothing new is recorded —
      // otherwise the channel that re-sent a document we already had would be
      // credited with finding it.
      const bytes = pdf(2);
      const first = await ingestDocument(
        { orgId: h.orgId, filename: 'twice.pdf', bytes, source: 'web_upload', uploadedBy: h.memberId },
        depsFor(h.store),
      );
      const again = await ingestDocument(
        { orgId: h.orgId, filename: 'twice.pdf', bytes, source: 'email_in' },
        depsFor(h.store),
      );

      expect(again.deduplicated).toBe(true);
      expect(again.document.documentId).toBe(first.document.documentId);
      expect(again.document.uploadId).toBe(first.document.uploadId);
      // The channel is still the one that found it, not the one that re-sent it.
      expect(await h.store.uploadSourceFor(first.document.documentId)).toBe('web_upload');
    });

    it('says nothing rather than something plausible for a document with no arrival', async () => {
      // The rows that predate this. `undefined` is the answer; a caller that
      // needs the channel to be true refuses on it (`declineCase`) rather than
      // filling in the common case.
      const stored = await h.store.putDocument({
        orgId: h.orgId,
        sha256: 'b'.repeat(64),
        filename: 'before-provenance.pdf',
        mimeType: 'application/pdf',
        byteSize: 4,
        bytes: new Uint8Array([37, 80, 68, 70]),
        requiresSplit: false,
      });
      expect(stored.uploadId).toBeUndefined();
      expect(await h.store.uploadSourceFor(stored.documentId)).toBeUndefined();
    });

    it('says nothing for a document this tenant does not have', async () => {
      expect(await h.store.uploadSourceFor(randomUUID())).toBeUndefined();
    });
  });
}

provenanceContract('in memory', describe, async () => {
  const store = new InMemoryStore();
  const orgId = randomUUID();
  const memberId = randomUUID();
  store.addMember(orgId, memberId, 'analyst');
  return { store, orgId, memberId, close: async () => undefined };
});

const pgAdmin = connectionString === undefined ? undefined : new Pool({ connectionString });

provenanceContract('on postgres', describeDb, async () => {
  const admin = pgAdmin as Pool;
  const orgId = randomUUID();
  const memberId = randomUUID();
  const suffix = orgId.slice(0, 8);
  await admin.query(`insert into organizations (id, slug, name) values ($1,$2,'Provenance')`, [
    orgId,
    `prov-${suffix}`,
  ]);
  await admin.query(`insert into org_settings (org_id) values ($1)`, [orgId]);
  await admin.query(`insert into users (id, email) values ($1,$2)`, [
    memberId,
    `prov-${suffix}@example.test`,
  ]);
  await admin.query(`insert into memberships (org_id, user_id, role) values ($1,$2,'analyst')`, [
    orgId,
    memberId,
  ]);
  const store = new PostgresStore(
    { connectionString: connectionString as string },
    { orgId, userId: memberId },
  );
  return {
    store,
    orgId,
    memberId,
    close: async () => {
      await store.close();
      await closeAllPools();
      await admin.end();
    },
  };
});

describeDb('the uploads row itself', () => {
  const admin = new Pool({ connectionString });
  const orgId = randomUUID();
  const readerOrgId = randomUUID();
  const analystId = randomUUID();
  const readerId = randomUUID();
  const suffix = orgId.slice(0, 8);
  let store: PostgresStore;

  beforeAll(async () => {
    await admin.query(
      `insert into organizations (id, slug, name) values ($1,$2,'Uploads'), ($3,$4,'Uploads RO')`,
      [orgId, `up-${suffix}`, readerOrgId, `up-ro-${suffix}`],
    );
    await admin.query(`insert into org_settings (org_id) values ($1), ($2)`, [orgId, readerOrgId]);
    await admin.query(`insert into users (id, email) values ($1,$2), ($3,$4)`, [
      analystId,
      `up-a-${suffix}@example.test`,
      readerId,
      `up-r-${suffix}@example.test`,
    ]);
    await admin.query(
      `insert into memberships (org_id, user_id, role) values ($1,$2,'analyst'), ($1,$3,'read_only')`,
      [orgId, analystId, readerId],
    );
    store = new PostgresStore(
      { connectionString: connectionString as string },
      { orgId, userId: analystId },
    );
  });

  afterAll(async () => {
    await closeAllPools();
    await store?.close();
    await admin.end();
  });

  it('carries the tenant, the channel and the member who added it', async () => {
    const upload = await store.recordUpload({
      orgId,
      source: 'web_upload',
      createdBy: analystId,
    });
    const { rows } = await admin.query<{
      org_id: string;
      source: string;
      created_by: string | null;
      received_at: Date;
    }>(`select org_id, source, created_by, received_at from uploads where id = $1`, [
      upload.uploadId,
    ]);
    expect(rows[0]?.org_id).toBe(orgId);
    expect(rows[0]?.source).toBe('web_upload');
    expect(rows[0]?.created_by).toBe(analystId);
    expect(rows[0]?.received_at).toBeInstanceOf(Date);
  });

  it('leaves created_by null for an arrival no member made', async () => {
    // Email. The sender is not one of our users and `From:` is forgeable, so
    // the column says nobody rather than naming somebody on a header's word.
    const upload = await store.recordUpload({ orgId, source: 'email_in' });
    const { rows } = await admin.query<{ created_by: string | null }>(
      `select created_by from uploads where id = $1`,
      [upload.uploadId],
    );
    expect(rows[0]?.created_by).toBeNull();
  });

  it('is written under the tenant’s own claims, so a reader cannot record one', async () => {
    // Not this code's check: `tenant_insert` on `uploads` is gated on
    // `app.member_may_write()` (migration 0010), and the store runs as `app_rw`
    // with the caller's claims like everything else. The service role is
    // nowhere near this path (invariant 6).
    const reader = new PostgresStore(
      { connectionString: connectionString as string },
      { orgId, userId: readerId },
    );
    try {
      await expect(
        reader.recordUpload({ orgId, source: 'web_upload', createdBy: readerId }),
      ).rejects.toThrow(/row-level security|permission denied/i);
    } finally {
      await reader.close();
    }
  });
});

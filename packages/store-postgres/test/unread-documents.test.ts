import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { UnreadDocumentsStore } from '@recouple/pipeline';
import { InMemoryStore } from '@recouple/pipeline/testing';
import { closeAllPools, PostgresStore } from '../src/store';

/**
 * The documents that were queued and never read, and the contract both stores
 * answer identically.
 *
 * This read exists because of a production failure with no error in it: an
 * upload was stored, scanned clean and announced to the queue, the function was
 * invoked once and never came back to run its step, and nothing anywhere said
 * so. The document sat in the database, correct and complete and unread, while
 * the reviewer was told it was being read. What was missing was not a retry —
 * the steps were always re-runnable — it was a way to *see* that there was
 * something to retry.
 *
 * So the question this answers has to be the same question in both stores, or
 * the in-memory tests are describing a list the product does not have. Written
 * once, run twice: the memory half needs no database and always runs, and the
 * Postgres half is the one that proves the SQL — the latest-verdict subquery,
 * the age arithmetic, and RLS keeping one tenant's stuck documents out of
 * another's list.
 */

const connectionString = process.env.DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

/** How a document got into the state the test wants it in. */
interface Given {
  readonly filename: string;
  /** How long ago it was stored. */
  readonly ageMinutes: number;
  /** The last verdict recorded for it; `none` records no verdict at all. */
  readonly scan: 'clean' | 'infected' | 'error' | 'none';
  /** Whether a read was ever recorded against it. */
  readonly read?: boolean;
  /** Whether it is filed against a case. */
  readonly onCase?: boolean;
}

interface Harness {
  store(): UnreadDocumentsStore;
  /** A second tenant's store, to prove the list is scoped rather than filtered. */
  otherStore(): UnreadDocumentsStore;
  add(given: Given): Promise<string>;
  /** The same, for the other tenant. */
  addForOther(given: Given): Promise<string>;
  close(): Promise<void>;
}

type RegisterSuite = (name: string, body: () => void) => void;

function unreadContract(
  name: string,
  register: RegisterSuite,
  create: () => Promise<Harness>,
): void {
  register(`the unread-documents contract: ${name}`, () => {
    let h: Harness;
    let stuck: string;
    let recent: string;
    let onCase: string;

    beforeAll(async () => {
      h = await create();
      stuck = await h.add({ filename: 'walmart-apdp-notice.pdf', ageMinutes: 42, scan: 'clean' });
      recent = await h.add({ filename: 'just-uploaded.pdf', ageMinutes: 0, scan: 'clean' });
      onCase = await h.add({
        filename: 'signed-bol.pdf',
        ageMinutes: 90,
        scan: 'clean',
        onCase: true,
      });
      await h.add({ filename: 'already-read.pdf', ageMinutes: 90, scan: 'clean', read: true });
      await h.add({ filename: 'infected.pdf', ageMinutes: 90, scan: 'infected' });
      await h.add({ filename: 'scanner-errored.pdf', ageMinutes: 90, scan: 'error' });
      await h.add({ filename: 'never-scanned.pdf', ageMinutes: 90, scan: 'none' });
    });

    afterAll(async () => {
      await h?.close();
    });

    it('lists what is stored, scanned clean and unread, oldest first', async () => {
      const rows = await h.store().unreadDocuments(5);
      expect(rows.map((row) => row.filename)).toEqual(['signed-bol.pdf', 'walmart-apdp-notice.pdf']);
      expect(rows.map((row) => row.documentId)).toEqual([onCase, stuck]);
    });

    it('leaves out a document that was read, whatever else is true of it', async () => {
      // The same record `readDocumentJob`'s guard consults. A document this
      // list offers is exactly a document a re-drive would actually read.
      const rows = await h.store().unreadDocuments(5);
      expect(rows.map((row) => row.filename)).not.toContain('already-read.pdf');
    });

    it('leaves out a document the gate stopped, and one with no verdict at all', async () => {
      // Infected and error are refusals the gate made on purpose, and a
      // document with no verdict may not be read by anything (invariant 4).
      // None of the three is waiting for a re-drive, so none of them is here.
      const rows = await h.store().unreadDocuments(5);
      const names = rows.map((row) => row.filename);
      expect(names).not.toContain('infected.pdf');
      expect(names).not.toContain('scanner-errored.pdf');
      expect(names).not.toContain('never-scanned.pdf');
    });

    it('leaves out a document that has only just arrived', async () => {
      // It is not stuck, it is being read. A list that said otherwise would
      // teach a reviewer to ignore it.
      const rows = await h.store().unreadDocuments(5);
      expect(rows.map((row) => row.documentId)).not.toContain(recent);

      // And with no threshold at all it is there, which is what says the
      // filtering above is the age and not something else.
      const all = await h.store().unreadDocuments(0);
      expect(all.map((row) => row.documentId)).toContain(recent);
    });

    it('says how long each one has been waiting, and whether it is on a case', async () => {
      const rows = await h.store().unreadDocuments(5);
      const bol = rows.find((row) => row.documentId === onCase);
      const notice = rows.find((row) => row.documentId === stuck);

      expect(bol?.onCase).toBe(true);
      expect(notice?.onCase).toBe(false);
      // Whole minutes, never negative, and close to what was asked for — the
      // Postgres half measures against the database's clock and the memory half
      // against this process's, so this is a range rather than an equality.
      expect(bol?.ageMinutes).toBeGreaterThanOrEqual(89);
      expect(bol?.ageMinutes).toBeLessThanOrEqual(92);
      expect(notice?.ageMinutes).toBeGreaterThanOrEqual(41);
      expect(notice?.ageMinutes).toBeLessThanOrEqual(44);
      expect(Date.parse(notice?.createdAt ?? '')).toBeLessThan(Date.now() + 1);
    });

    it('answers with the same shape from both stores', async () => {
      // Not merely the same values: a caller that can tell the two apart by
      // their keys is a caller whose memory tests are about a different object.
      const rows = await h.store().unreadDocuments(5);
      expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
        'ageMinutes',
        'createdAt',
        'documentId',
        'filename',
        'onCase',
      ]);
    });

    it('honours a limit', async () => {
      const rows = await h.store().unreadDocuments(5, 1);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.documentId).toBe(onCase);
    });

    it('refuses an age that is not one, rather than answering nothing', async () => {
      // `now() - NaN` is not an empty list, it is a lie that reads exactly like
      // "nothing is stuck".
      for (const age of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
        await expect(h.store().unreadDocuments(age)).rejects.toThrow(/whole minutes/);
      }
    });

    it('shows one tenant nothing of another tenant’s', async () => {
      const theirs = await h.addForOther({
        filename: 'their-notice.pdf',
        ageMinutes: 90,
        scan: 'clean',
      });

      const mine = await h.store().unreadDocuments(5);
      expect(mine.map((row) => row.documentId)).not.toContain(theirs);

      const theirList = await h.otherStore().unreadDocuments(5);
      expect(theirList.map((row) => row.documentId)).toEqual([theirs]);
    });
  });
}

// ---------------------------------------------------------------------------
// The in-memory half
// ---------------------------------------------------------------------------

unreadContract('in memory', describe, async () => {
  const ORG = randomUUID();
  const OTHER_ORG = randomUUID();
  // Two stores, because the in-memory store is per-tenant the way the Postgres
  // one is: its scoping is the object, where Postgres's is the policy.
  const store = new InMemoryStore();
  const other = new InMemoryStore();

  const add = async (into: InMemoryStore, orgId: string, given: Given): Promise<string> => {
    const document = await into.putDocument({
      orgId,
      sha256: randomUUID().replace(/-/g, '').padEnd(64, '0'),
      filename: given.filename,
      mimeType: 'application/pdf',
      byteSize: 4,
      bytes: new Uint8Array([1, 2, 3, 4]),
      requiresSplit: false,
    });
    into.documentCreatedAt.set(
      document.documentId,
      new Date(Date.now() - given.ageMinutes * 60_000),
    );
    if (given.scan !== 'none') {
      await into.recordScan(document.documentId, { status: given.scan, scanner: 'test' });
    }
    if (given.read === true) {
      await into.recordExtraction({
        documentId: document.documentId,
        docType: 'deduction_notice',
        extractor: 'test',
        schemaVersion: 'v1',
        fields: [],
        document: {},
      });
    }
    if (given.onCase === true) {
      const opened = await into.openCase({ orgId, claimId: `C-${document.documentId.slice(0, 8)}` });
      await into.linkDocument(opened.deductionId, document.documentId, 'evidence');
    }
    return document.documentId;
  };

  return {
    store: () => store,
    otherStore: () => other,
    add: (given) => add(store, ORG, given),
    addForOther: (given) => add(other, OTHER_ORG, given),
    close: async () => undefined,
  };
});

// ---------------------------------------------------------------------------
// The Postgres half
// ---------------------------------------------------------------------------

unreadContract('on postgres', describeDb, async () => {
  const admin = new Pool({ connectionString: connectionString as string });
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const analystId = randomUUID();
  const outsiderId = randomUUID();
  const suffix = orgId.slice(0, 8);

  await admin.query(
    `insert into organizations (id, slug, name) values ($1,$2,'Unread'), ($3,$4,'Unread Other')`,
    [orgId, `unread-${suffix}`, otherOrgId, `unread-other-${suffix}`],
  );
  await admin.query('insert into org_settings (org_id) values ($1), ($2)', [orgId, otherOrgId]);
  await admin.query('insert into users (id, email) values ($1,$2), ($3,$4)', [
    analystId,
    `unread-analyst-${suffix}@example.test`,
    outsiderId,
    `unread-outsider-${suffix}@example.test`,
  ]);
  await admin.query(
    `insert into memberships (org_id, user_id, role) values ($1,$2,'analyst'), ($3,$4,'analyst')`,
    [orgId, analystId, otherOrgId, outsiderId],
  );

  const store = new PostgresStore({ connectionString: connectionString as string }, {
    orgId,
    userId: analystId,
  });
  const other = new PostgresStore({ connectionString: connectionString as string }, {
    orgId: otherOrgId,
    userId: outsiderId,
  });

  /**
   * The `documents` row is inserted by the owning connection with an explicit
   * `created_at`, because `documents` is append-only: there is no UPDATE to
   * backdate one with, by design (invariant 2). Everything after it — the
   * verdict, the extraction, the case and the link — goes through the store as
   * `app_rw` under the tenant's claims, which is the point of testing here.
   */
  const add = async (
    into: PostgresStore,
    org: string,
    given: Given,
  ): Promise<string> => {
    const { rows } = await admin.query<{ id: string }>(
      `insert into documents (org_id, sha256, byte_size, mime_type, storage_ref, filename, created_at)
       values ($1, $2, 4, 'application/pdf', $3, $4, now() - ($5::double precision * interval '1 minute'))
       returning id`,
      [
        org,
        Buffer.from(randomUUID().replace(/-/g, '').padEnd(64, '0'), 'hex'),
        `doc/${randomUUID()}`,
        given.filename,
        given.ageMinutes,
      ],
    );
    const documentId = rows[0]?.id as string;

    if (given.scan !== 'none') {
      await into.recordScan(documentId, { status: given.scan, scanner: 'test' });
    }
    if (given.read === true) {
      await into.recordExtraction({
        documentId,
        docType: 'deduction_notice',
        extractor: 'test',
        schemaVersion: 'v1',
        fields: [
          {
            fieldPath: 'claim_id',
            value: 'APDP-1',
            confidence: 0.9,
            sourcePage: 1,
            sourceQuote: 'Claim APDP-1',
            sourceBbox: null,
            quoteVerified: true,
          },
        ],
        document: { claimId: 'APDP-1' },
      });
    }
    if (given.onCase === true) {
      const opened = await into.openCase({ orgId: org, claimId: `C-${documentId.slice(0, 8)}` });
      await into.linkDocument(opened.deductionId, documentId, 'evidence');
    }
    return documentId;
  };

  return {
    store: () => store,
    otherStore: () => other,
    add: (given) => add(store, orgId, given),
    addForOther: (given) => add(other, otherOrgId, given),
    close: async () => {
      await admin.end();
      await closeAllPools();
    },
  };
});

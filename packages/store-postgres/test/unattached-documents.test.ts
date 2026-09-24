import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { DocType } from '@recouple/extraction';
import {
  attachReadDocument,
  UNREAD_DOCUMENTS_MAX_LIMIT,
  UnreadDocumentsQueryError,
  type EvidenceAttachStore,
  type PipelineStore,
  type UnreadDocumentsStore,
} from '@recouple/pipeline';
import { InMemoryStore } from '@recouple/pipeline/testing';
import { closeAllPools, PostgresStore } from '../src/store';

/**
 * The documents that were read and that no case holds, and filing one against
 * a case without reading it again — the same contract from both stores.
 *
 * The production failure behind it: a delivery receipt and a rate confirmation
 * uploaded from the case list were read, opened nothing because they are
 * evidence, and appeared nowhere. Written once, run twice, for
 * `unread-documents.test.ts`'s reason: the in-memory half always runs, and the
 * Postgres half is the one that proves the SQL — the two `exists` conditions,
 * the latest classification, the conditional link and its event in one
 * transaction, and RLS keeping one tenant's documents out of another's list.
 */

const connectionString = process.env.DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

interface Given {
  readonly filename: string;
  readonly ageMinutes: number;
  /** What it was read as; absent means it was never read. */
  readonly readAs?: DocType;
  /** Filed against a new case in this role. */
  readonly onCase?: 'notice' | 'evidence';
}

type ContractStore = UnreadDocumentsStore &
  EvidenceAttachStore &
  Pick<PipelineStore, 'recordHold' | 'documentHold'>;

interface Harness {
  store(): ContractStore;
  otherStore(): ContractStore;
  add(given: Given): Promise<string>;
  addForOther(given: Given): Promise<string>;
  /** A case in this tenant, and the id of the notice it was opened from. */
  openCase(): Promise<{ deductionId: string; noticeId: string }>;
  /** Every `evidence.attached` event on a case, as the store recorded it. */
  attachedEvents(deductionId: string): Promise<readonly Record<string, unknown>[]>;
  /** Holds a document of this tenant's for a person, below the default floor (ADR 0044). */
  hold(documentId: string): Promise<void>;
  close(): Promise<void>;
}

type RegisterSuite = (name: string, body: () => void) => void;

function unattachedContract(
  name: string,
  register: RegisterSuite,
  create: () => Promise<Harness>,
): void {
  register(`the unattached-documents contract: ${name}`, () => {
    let h: Harness;
    let receipt: string;
    let rate: string;
    let unread: string;
    let evidenceOnCase: string;

    beforeAll(async () => {
      h = await create();
      receipt = await h.add({ filename: '08_log-202.jpg', ageMinutes: 10, readAs: 'pod' });
      rate = await h.add({ filename: '10_log-202.pdf', ageMinutes: 20, readAs: 'price_agreement' });
      unread = await h.add({ filename: 'not-read-yet.pdf', ageMinutes: 30 });
      evidenceOnCase = await h.add({
        filename: 'signed-bol.pdf',
        ageMinutes: 40,
        readAs: 'bol',
        onCase: 'evidence',
      });
      await h.add({
        filename: 'notice-that-opened.pdf',
        ageMinutes: 50,
        readAs: 'deduction_notice',
        onCase: 'notice',
      });
    });

    afterAll(async () => {
      await h?.close();
    });

    it('lists what was read and is on no case, newest first, with what it was read as', async () => {
      const rows = await h.store().unattachedDocuments();
      expect(rows.map((row) => [row.documentId, row.filename, row.docType])).toEqual([
        [receipt, '08_log-202.jpg', 'pod'],
        [rate, '10_log-202.pdf', 'price_agreement'],
      ]);
    });

    it('leaves out a document nobody has read, and one a case already holds in either role', async () => {
      const ids = (await h.store().unattachedDocuments()).map((row) => row.documentId);
      expect(ids).not.toContain(unread);
      expect(ids).not.toContain(evidenceOnCase);
    });

    it('answers with the same shape from both stores', async () => {
      const rows = await h.store().unattachedDocuments();
      expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
        // The classification's confidence joined the row with ADR 0044, from
        // the same classification row the type comes from — to show beside a
        // hold, never to decide with. `hold` is absent on a row with none,
        // which is every row here; the hold case below has one.
        'confidence',
        'createdAt',
        'docType',
        'documentId',
        'filename',
      ]);
      // As recorded (`add` classifies at 0.95), from both stores alike.
      expect(rows.every((row) => row.confidence === 0.95)).toBe(true);
    });

    it('carries a standing hold, the same from both stores (ADR 0044)', async () => {
      const held = await h.add({
        filename: 'held-remittance.pdf',
        ageMinutes: 1,
        readAs: 'remittance_advice',
      });
      const before = (await h.store().unattachedDocuments()).find((r) => r.documentId === held);
      expect(before).toBeDefined();
      expect(before).not.toHaveProperty('hold');

      await h.hold(held);

      const row = (await h.store().unattachedDocuments()).find((r) => r.documentId === held);
      expect(row?.hold).toMatchObject({
        documentId: held,
        docType: 'remittance_advice',
        confidence: 0.92,
        floor: 0.95,
        reason: 'below_floor',
      });
      expect(Object.keys(row?.hold ?? {}).sort()).toEqual(
        ['confidence', 'docType', 'documentId', 'floor', 'heldAt', 'orgId', 'reason'].concat(
          row?.hold?.heldBy === undefined ? [] : ['heldBy'],
        ).sort(),
      );
      expect(await h.store().documentHold(held)).toEqual(row?.hold);
    });

    it('honours a limit, and refuses one that is not one', async () => {
      expect(await h.store().unattachedDocuments(1)).toHaveLength(1);
      for (const limit of [0, -1, 1.5, Number.NaN, UNREAD_DOCUMENTS_MAX_LIMIT + 1]) {
        await expect(h.store().unattachedDocuments(limit)).rejects.toBeInstanceOf(
          UnreadDocumentsQueryError,
        );
      }
    });

    it('files a listed document on a case once, with one event, and then stops listing it', async () => {
      const { deductionId } = await h.openCase();

      const first = await attachReadDocument(h.store(), { deductionId, documentId: receipt });
      const second = await attachReadDocument(h.store(), { deductionId, documentId: receipt });

      expect(first).toEqual({ deductionId, documentId: receipt, docType: 'pod', attached: true });
      expect(second.attached).toBe(false);
      expect(await h.attachedEvents(deductionId)).toEqual([
        { document_id: receipt, doc_type: 'pod', read_again: false },
      ]);
      const ids = (await h.store().unattachedDocuments()).map((row) => row.documentId);
      expect(ids).not.toContain(receipt);
      expect(ids).toContain(rate);
    });

    it('does not file a case’s own notice against it again as evidence', async () => {
      const { deductionId, noticeId } = await h.openCase();

      const result = await attachReadDocument(h.store(), { deductionId, documentId: noticeId });

      expect(result.attached).toBe(false);
      expect(await h.attachedEvents(deductionId)).toEqual([]);
    });

    it('shows one tenant nothing of another’s, and will not file across tenants', async () => {
      const theirs = await h.addForOther({
        filename: 'their-receipt.jpg',
        ageMinutes: 5,
        readAs: 'pod',
      });

      const mine = (await h.store().unattachedDocuments()).map((row) => row.documentId);
      expect(mine).not.toContain(theirs);
      const theirList = (await h.otherStore().unattachedDocuments()).map((row) => row.documentId);
      expect(theirList).toEqual([theirs]);

      // Their document on my case: not visible to me, so not found — refused
      // before anything is written.
      const { deductionId } = await h.openCase();
      await expect(
        attachReadDocument(h.store(), { deductionId, documentId: theirs }),
      ).rejects.toThrow(/no document/);
    });
  });
}

// ---------------------------------------------------------------------------
// The in-memory half
// ---------------------------------------------------------------------------

unattachedContract('in memory', describe, async () => {
  const ORG = randomUUID();
  const OTHER_ORG = randomUUID();
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
    into.documentCreatedAt.set(document.documentId, new Date(Date.now() - given.ageMinutes * 60_000));
    await into.recordScan(document.documentId, { status: 'clean', scanner: 'test' });
    if (given.readAs !== undefined) {
      await into.recordClassification(document.documentId, given.readAs, 0.95);
      await into.recordExtraction({
        documentId: document.documentId,
        docType: given.readAs,
        extractor: 'test',
        schemaVersion: 'v1',
        fields: [],
        document: {},
      });
    }
    if (given.onCase !== undefined) {
      const opened = await into.openCase({ orgId, claimId: `C-${document.documentId.slice(0, 8)}` });
      await into.linkDocument(opened.deductionId, document.documentId, given.onCase);
    }
    return document.documentId;
  };

  return {
    store: () => store,
    otherStore: () => other,
    add: (given) => add(store, ORG, given),
    addForOther: (given) => add(other, OTHER_ORG, given),
    async openCase() {
      const noticeId = await add(store, ORG, {
        filename: `notice-${randomUUID().slice(0, 8)}.pdf`,
        ageMinutes: 1,
        readAs: 'deduction_notice',
      });
      const opened = await store.openCase({ orgId: ORG, claimId: `CASE-${noticeId.slice(0, 8)}` });
      await store.linkDocument(opened.deductionId, noticeId, 'notice');
      return { deductionId: opened.deductionId, noticeId };
    },
    async attachedEvents(deductionId) {
      return store.events
        .filter((e) => e.deductionId === deductionId && e.eventType === 'evidence.attached')
        .map((e) => e.payload);
    },
    hold: (documentId) =>
      store.recordHold({
        documentId,
        orgId: ORG,
        docType: 'remittance_advice',
        confidence: 0.92,
        floor: 0.95,
        reason: 'below_floor',
      }),
    close: async () => undefined,
  };
});

// ---------------------------------------------------------------------------
// The Postgres half
// ---------------------------------------------------------------------------

unattachedContract('on postgres', describeDb, async () => {
  const admin = new Pool({ connectionString: connectionString as string });
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const analystId = randomUUID();
  const outsiderId = randomUUID();
  const suffix = orgId.slice(0, 8);

  await admin.query(
    `insert into organizations (id, slug, name) values ($1,$2,'Loose'), ($3,$4,'Loose Other')`,
    [orgId, `loose-${suffix}`, otherOrgId, `loose-other-${suffix}`],
  );
  await admin.query('insert into org_settings (org_id) values ($1), ($2)', [orgId, otherOrgId]);
  await admin.query('insert into users (id, email) values ($1,$2), ($3,$4)', [
    analystId,
    `loose-analyst-${suffix}@example.test`,
    outsiderId,
    `loose-outsider-${suffix}@example.test`,
  ]);
  await admin.query(
    `insert into memberships (org_id, user_id, role) values ($1,$2,'analyst'), ($3,$4,'analyst')`,
    [orgId, analystId, otherOrgId, outsiderId],
  );

  const config = { connectionString: connectionString as string };
  const store = new PostgresStore(config, { orgId, userId: analystId });
  const other = new PostgresStore(config, { orgId: otherOrgId, userId: outsiderId });

  /**
   * The `documents` row by the owning connection with an explicit
   * `created_at` (append-only, so there is nothing to backdate with), and
   * everything after it through the store as `app_rw` under the tenant's
   * claims — the scan, the classification, the extraction, the case, the link.
   */
  const add = async (into: PostgresStore, org: string, given: Given): Promise<string> => {
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
    await into.recordScan(documentId, { status: 'clean', scanner: 'test' });
    if (given.readAs !== undefined) {
      await into.recordClassification(documentId, given.readAs, 0.95);
      await into.recordExtraction({
        documentId,
        docType: given.readAs,
        extractor: 'test',
        schemaVersion: 'v1',
        fields: [
          {
            fieldPath: 'document_number',
            value: 'D-1',
            confidence: 0.9,
            sourcePage: 1,
            sourceQuote: 'D-1',
            sourceBbox: null,
            quoteVerified: true,
          },
        ],
        document: {},
      });
    }
    if (given.onCase !== undefined) {
      const opened = await into.openCase({ orgId: org, claimId: `C-${documentId.slice(0, 8)}` });
      await into.linkDocument(opened.deductionId, documentId, given.onCase);
    }
    return documentId;
  };

  return {
    store: () => store,
    otherStore: () => other,
    add: (given) => add(store, orgId, given),
    addForOther: (given) => add(other, otherOrgId, given),
    async openCase() {
      const noticeId = await add(store, orgId, {
        filename: `notice-${randomUUID().slice(0, 8)}.pdf`,
        ageMinutes: 1,
        readAs: 'deduction_notice',
      });
      const opened = await store.openCase({ orgId, claimId: `CASE-${noticeId.slice(0, 8)}` });
      await store.linkDocument(opened.deductionId, noticeId, 'notice');
      return { deductionId: opened.deductionId, noticeId };
    },
    async attachedEvents(deductionId) {
      const { rows } = await admin.query<{ payload: Record<string, unknown> }>(
        `select payload from deduction_events
          where deduction_id = $1 and event_type = 'evidence.attached' order by id`,
        [deductionId],
      );
      return rows.map((row) => row.payload);
    },
    hold: (documentId) =>
      store.recordHold({
        documentId,
        orgId,
        docType: 'remittance_advice',
        confidence: 0.92,
        floor: 0.95,
        reason: 'below_floor',
      }),
    close: async () => {
      await admin.end();
      await closeAllPools();
    },
  };
});

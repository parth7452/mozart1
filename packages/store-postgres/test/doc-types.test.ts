import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  buildExtractionResult,
  DOC_TYPES,
  type Classifier,
  type ClassificationResult,
  type DocType,
  type DocumentPayload,
  type Extractor,
  type ExtractionResult,
  type OcrProvider,
  type OcrResult,
} from '@recouple/extraction';
import { allFixtureDocuments, expectedExtraction } from '@recouple/fixtures';
import {
  ClassificationRefusedError,
  processUpload,
  type PipelineDeps,
} from '@recouple/pipeline';
import { closeAllPools, PostgresStore } from '../src/store';

/**
 * The two lists of document types, kept identical — and what happens when they
 * are not.
 *
 * `DOC_TYPES` in `packages/extraction/src/ports.ts` is what a classifier may
 * answer with. `document_classifications_doc_type_check` is what the database
 * will store. They drifted: `correspondence` was added to the first and not to
 * the second, and a dispatch-note JPEG classified as one was read, extracted,
 * refused at its last statement, and then read three more times because nothing
 * recognised the refusal as settled (ADR 0025).
 *
 * Three things are asserted here, and only the first of them is about
 * `correspondence`:
 *
 * 1. the sets are equal, read off `pg_constraint` — so adding a thirteenth type
 *    to the code without a migration fails CI, before production;
 * 2. a type the database will not take raises `ClassificationRefusedError`
 *    rather than a driver error nothing can tell apart from an outage;
 * 3. a read that ends that way records exactly one set of model calls, because
 *    what it cost is true whether or not it finished, and it is not paid for a
 *    second time.
 *
 * `supabase/tests/16_every_document_type.sql` is the other half of (1): it
 * proves from SQL that each of the twelve actually inserts, which comparing two
 * lists of strings cannot.
 */

const connectionString = process.env.DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

/** A classifier that says whatever the test told it to say. */
class SaysClassifier implements Classifier {
  constructor(private readonly docType: DocType) {}
  async classify(document: DocumentPayload): Promise<ClassificationResult> {
    return {
      docType: this.docType,
      confidence: 0.91,
      call: {
        purpose: 'classify',
        provider: 'anthropic',
        modelVersion: 'fixture-haiku',
        documentId: document.documentId,
        costMicros: 1_300,
        latencyMs: 9,
        outcome: 'ok',
      },
    };
  }
}

/**
 * A text layer the way Reducto gives one: a call of its own, billed of its own.
 *
 * Here so the read under test costs all three of the calls the production read
 * cost — OCR, classify, extract — rather than the two a document that arrives
 * with a text layer costs. The JPEG this was found on had no text layer, and
 * the OCR pass was the first thing each of the four retries paid for again.
 * Like the real provider, it records its work as `purpose: 'extract'` under its
 * own provider name rather than inventing a purpose (ADR 0009), so the
 * assertions below group by both.
 */
class FixtureOcr implements OcrProvider {
  readonly name = 'fixture-reducto';
  constructor(private readonly pages: readonly string[]) {}
  async ocr(document: DocumentPayload): Promise<OcrResult> {
    return {
      provider: this.name,
      pages: this.pages.map((text, i) => ({ page: i + 1, text })),
      blocks: [],
      call: {
        purpose: 'extract',
        provider: 'reducto',
        modelVersion: 'fixture-ocr',
        documentId: document.documentId,
        costMicros: 4_000,
        latencyMs: 120,
        outcome: 'ok',
      },
    };
  }
}

class FixtureExtractor implements Extractor {
  readonly name = 'fixture';
  async extract(document: DocumentPayload, docType: DocType): Promise<ExtractionResult> {
    const fixture = allFixtureDocuments().find((d) => d.filename === document.filename);
    if (fixture === undefined) throw new Error(`no fixture ${document.filename}`);
    return buildExtractionResult({
      docType,
      extractor: this.name,
      document: expectedExtraction(fixture),
      pageText: document.pageText,
      call: {
        purpose: 'extract',
        provider: 'anthropic',
        modelVersion: 'fixture-sonnet',
        documentId: document.documentId,
        costMicros: 12_700,
        latencyMs: 40,
        outcome: 'ok',
      },
    });
  }
}

describeDb('the document types the database admits', () => {
  const admin = new Pool({ connectionString });
  const orgId = randomUUID();
  const analystId = randomUUID();
  const slug = `doctypes-${orgId.slice(0, 8)}`;
  let store: PostgresStore;

  beforeAll(async () => {
    await admin.query(`insert into organizations (id, slug, name) values ($1, $2, 'Doc Types')`, [
      orgId,
      slug,
    ]);
    await admin.query(`insert into org_settings (org_id) values ($1)`, [orgId]);
    await admin.query(`insert into users (id, email) values ($1, $2)`, [
      analystId,
      `analyst-${analystId}@example.test`,
    ]);
    await admin.query(`insert into memberships (org_id, user_id, role) values ($1, $2, 'analyst')`, [
      orgId,
      analystId,
    ]);
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

  /** One stored document to hang classifications off. */
  async function aDocument(): Promise<string> {
    const stored = await store.putDocument({
      orgId,
      sha256: randomUUID().replace(/-/g, '').padEnd(64, '0'),
      filename: 'dispatch-note.jpg',
      mimeType: 'image/jpeg',
      byteSize: 4,
      bytes: new Uint8Array([1, 2, 3, 4]),
      requiresSplit: false,
    });
    return stored.documentId;
  }

  it('admits exactly the types the reader can answer with, and no others', async () => {
    // Read off the constraint's own definition rather than off a list repeated
    // in this file, because a list repeated in this file is the bug.
    const { rows } = await admin.query<{ def: string }>(
      `select pg_get_constraintdef(c.oid) as def
         from pg_constraint c
        where c.conrelid = 'document_classifications'::regclass
          and c.conname = 'document_classifications_doc_type_check'`,
    );
    const def = rows[0]?.def;
    // A missing constraint is not "no restriction", it is a schema this test
    // cannot speak about — say so rather than passing vacuously.
    expect(def, 'document_classifications_doc_type_check exists').toBeDefined();

    const admitted = [...(def as string).matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]);

    // Set equality, asserted in both directions separately so a failure says
    // which way the drift went — they are different bugs with different fixes.
    expect(
      [...admitted].sort(),
      'the constraint admits every DOC_TYPES value: a type added to the code needs a migration',
    ).toEqual([...DOC_TYPES].sort());
    expect(
      admitted.filter((t) => !(DOC_TYPES as readonly string[]).includes(t as DocType)),
      'and admits nothing DOC_TYPES does not: a value no classifier can produce',
    ).toEqual([]);

    // Named on purpose. This is the value that was missing, and a regression
    // that dropped it again would otherwise be one line of a diff of twelve.
    expect(admitted).toContain('correspondence');
  });

  it('stores a classification for every one of them', async () => {
    const documentId = await aDocument();
    for (const docType of DOC_TYPES) {
      await expect(store.recordClassification(documentId, docType, 0.9)).resolves.toBeUndefined();
    }

    const { rows } = await admin.query<{ n: string }>(
      `select count(distinct doc_type)::text as n
         from document_classifications where document_id = $1`,
      [documentId],
    );
    expect(Number(rows[0]?.n)).toBe(DOC_TYPES.length);
  });

  it('names the refusal when a type is one the database has never heard of', async () => {
    const documentId = await aDocument();
    // What a code-ahead-of-database state looks like from here: a doc type the
    // TypeScript would accept if it were in DOC_TYPES, and the database would
    // not. Cast, because the whole point is that the compiler is not the thing
    // being relied on.
    const unknown = 'dispatch_note' as DocType;

    const refusal = store.recordClassification(documentId, unknown, 0.9);
    await expect(refusal).rejects.toBeInstanceOf(ClassificationRefusedError);
    // The message carries the ids a person needs and nothing off the page: no
    // filename, no quote, no page (invariant 4).
    await expect(refusal).rejects.toThrow(documentId);
    await expect(refusal).rejects.toThrow(unknown);
    await expect(refusal).rejects.not.toThrow(/dispatch-note\.jpg/);

    const { rows } = await admin.query<{ n: string }>(
      `select count(*)::text as n from document_classifications where document_id = $1`,
      [documentId],
    );
    expect(Number(rows[0]?.n), 'and nothing was stored').toBe(0);
  });

  it('records one set of model calls for a read the database refuses, and one only', async () => {
    const notice = allFixtureDocuments().find((d) => d.filename === 'walmart-apdp-notice.pdf');
    if (notice === undefined) throw new Error('no walmart-apdp-notice.pdf fixture');

    const deps: PipelineDeps = {
      store,
      scanner: {
        name: 'test',
        async scan() {
          return { status: 'clean', scanner: 'test' };
        },
      },
      // The production shape: the classifier answers with a type the database
      // will not take.
      classifier: new SaysClassifier('dispatch_note' as DocType),
      extractor: new FixtureExtractor(),
      ocr: new FixtureOcr(notice.pageText),
      now: () => new Date(),
    };

    // No `pageText`: the document arrives as pixels, so the read begins by
    // paying for a text layer, exactly as the JPEG in production did.
    const upload = {
      orgId,
      filename: notice.filename,
      bytes: notice.bytes,
      source: 'web_upload' as const,
    };

    await expect(processUpload(upload, deps)).rejects.toBeInstanceOf(ClassificationRefusedError);

    const documentId = (
      await admin.query<{ id: string }>(
        `select id from documents where org_id = $1 and filename = $2`,
        [orgId, notice.filename],
      )
    ).rows[0]?.id;
    expect(documentId).toBeDefined();

    // The spend the read actually incurred, all of it, exactly once. All three
    // calls are here — the OCR, the classify and the extract — because
    // `recordTheRead` records the calls before the first row the database can
    // refuse. The extract call is the one that used to be lost: it was recorded
    // alongside the extraction rows, on the far side of the statement that
    // raised (ADR 0025).
    const spend = async (): Promise<Record<string, number>> => {
      // By provider as well as purpose: an OCR pass is told apart by its
      // provider, not by a purpose of its own, so `extract` alone would count
      // two different calls as one.
      const { rows } = await admin.query<{ purpose: string; provider: string; n: string }>(
        `select purpose, provider, count(*)::text as n from model_calls
          where org_id = $1 and document_id = $2
          group by purpose, provider`,
        [orgId, documentId],
      );
      return Object.fromEntries(rows.map((r) => [`${r.provider}:${r.purpose}`, Number(r.n)]));
    };
    expect(await spend()).toEqual({
      'reducto:extract': 1,
      'anthropic:classify': 1,
      'anthropic:extract': 1,
    });

    // And nothing that depended on the refused row. The document is stored,
    // scanned and paid for, and it has no classification and no extraction —
    // which is exactly what puts it in "Documents waiting to be read", where a
    // person can re-drive it once the constraint admits the type.
    const after = await admin.query<{ classifications: string; extractions: string }>(
      `select (select count(*)::text from document_classifications where document_id = $1)
                as classifications,
              (select count(*)::text from extraction_results where document_id = $1)
                as extractions`,
      [documentId],
    );
    expect(after.rows[0]).toEqual({ classifications: '0', extractions: '0' });

    // A second attempt is what a second set of rows costs — which is why the
    // queue must not make one by itself. `asJobFailure` turns this error into a
    // `NonRetriableError` (apps/web/test/inngest-job.test.tsx).
    await expect(processUpload(upload, deps)).rejects.toBeInstanceOf(ClassificationRefusedError);
    // Two of the three are paid again. The OCR is not: its pages were stored on
    // the first attempt, so the second read has a text layer and never reaches
    // the provider. That is the cheapest a retry can be here, and it is still
    // two model calls for an answer that cannot change — four retries is what
    // this cost in production (ADR 0025).
    expect(await spend()).toEqual({
      'reducto:extract': 1,
      'anthropic:classify': 2,
      'anthropic:extract': 2,
    });
  });
});

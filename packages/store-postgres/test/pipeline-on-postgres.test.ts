import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  buildExtractionResult,
  type Classifier,
  type ClassificationResult,
  type DocType,
  type DocumentPayload,
  type Extractor,
  type ExtractionResult,
} from '@recouple/extraction';
import {
  allFixtureDocuments,
  expectedExtraction,
  type FixtureDocument,
} from '@recouple/fixtures';
import { processUpload, reconcileCase, type PipelineDeps } from '@recouple/pipeline';
import { PostgresStore } from '../src/store';

const connectionString = process.env.DATABASE_URL;

/**
 * These run against a real database with the real migrations applied, so they
 * test what the in-memory store cannot: that the schema, its constraints and its
 * RLS policies actually support the pipeline. `pnpm db:test` prepares the
 * database; without DATABASE_URL there is nothing to test against.
 */
const describeDb = connectionString === undefined ? describe.skip : describe;

function fixtureFor(filename: string): FixtureDocument {
  const found = allFixtureDocuments().find((d) => d.filename === filename);
  if (found === undefined) throw new Error(`no fixture ${filename}`);
  return found;
}

class FixtureClassifier implements Classifier {
  async classify(document: DocumentPayload): Promise<ClassificationResult> {
    const fixture = fixtureFor(document.filename);
    return {
      docType: fixture.docType as DocType,
      confidence: 0.99,
      call: {
        purpose: 'classify',
        provider: 'anthropic',
        modelVersion: 'fixture',
        documentId: document.documentId,
        costMicros: 1_300,
        latencyMs: 10,
        outcome: 'ok',
      },
    };
  }
}

class FixtureExtractor implements Extractor {
  readonly name = 'fixture';
  async extract(document: DocumentPayload, docType: DocType): Promise<ExtractionResult> {
    const fixture = fixtureFor(document.filename);
    return buildExtractionResult({
      docType,
      extractor: this.name,
      document: expectedExtraction(fixture),
      pageText: document.pageText,
      call: {
        purpose: 'extract',
        provider: 'anthropic',
        modelVersion: 'fixture',
        documentId: document.documentId,
        costMicros: 12_700,
        latencyMs: 40,
        outcome: 'ok',
      },
    });
  }
}

describeDb('the pipeline against a real database', () => {
  const admin = new Pool({ connectionString });
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const slug = `it-${orgId.slice(0, 8)}`;
  let store: PostgresStore;
  let otherStore: PostgresStore;
  let deps: PipelineDeps;

  beforeAll(async () => {
    // Seeded as the owner: a tenant cannot create itself under RLS.
    await admin.query(`insert into organizations (id, slug, name) values ($1, $2, 'Integration')`, [
      orgId,
      slug,
    ]);
    await admin.query(`insert into organizations (id, slug, name) values ($1, $2, 'Other')`, [
      otherOrgId,
      `${slug}-other`,
    ]);
    await admin.query(`insert into org_settings (org_id) values ($1), ($2)`, [orgId, otherOrgId]);

    store = new PostgresStore({ connectionString: connectionString as string }, { orgId });
    otherStore = new PostgresStore(
      { connectionString: connectionString as string },
      { orgId: otherOrgId },
    );
    deps = {
      store,
      scanner: { name: 'test', async scan() { return { status: 'clean', scanner: 'test' }; } },
      classifier: new FixtureClassifier(),
      extractor: new FixtureExtractor(),
      now: () => new Date(),
    };
  });

  afterAll(async () => {
    await store?.close();
    await otherStore?.close();
    await admin.end();
  });

  const upload = (fixture: FixtureDocument) => ({
    orgId,
    filename: fixture.filename,
    bytes: fixture.bytes,
    source: 'web_upload' as const,
    pageText: fixture.pageText,
  });

  let deductionId: string;

  it('writes a notice through the real constraints and opens a case', async () => {
    const notice = fixtureFor('walmart-apdp-notice.pdf');
    const result = await processUpload(upload(notice), deps);

    expect(result.classification?.docType).toBe('deduction_notice');
    expect(result.case?.state).toBe('classified');
    expect(result.case?.claimId).toBe('APDP-99812');
    deductionId = result.case?.deductionId as string;

    const { rows } = await admin.query<{ n: string }>(
      `select count(*)::text as n from extraction_results where org_id = $1`,
      [orgId],
    );
    expect(Number(rows[0]?.n)).toBeGreaterThan(10);
  });

  it('keeps every field’s provenance in the database', async () => {
    const { rows } = await admin.query<{
      field_path: string;
      source_page: number;
      source_quote: string;
      quote_verified: boolean | null;
    }>(
      `select field_path, source_page, source_quote, quote_verified
         from extraction_results where org_id = $1 and field_path = 'claim_id'`,
      [orgId],
    );
    const field = rows[0];
    expect(field?.source_page).toBe(1);
    expect(field?.source_quote).toContain('APDP-99812');
    expect(field?.quote_verified).toBe(true);
  });

  it('remembers what the file was called', async () => {
    const { rows } = await admin.query<{ filename: string }>(
      `select filename from documents where org_id = $1`,
      [orgId],
    );
    expect(rows[0]?.filename).toBe('walmart-apdp-notice.pdf');
  });

  it('dedupes on content hash at the database, not just in memory', async () => {
    const notice = fixtureFor('walmart-apdp-notice.pdf');
    const again = await processUpload(upload(notice), deps);
    expect(again.ingest.deduplicated).toBe(true);

    const { rows } = await admin.query<{ n: string }>(
      `select count(*)::text as n from documents where org_id = $1`,
      [orgId],
    );
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it('reconciles a case rebuilt from its stored field rows', async () => {
    for (const filename of ['walmart-po.pdf', 'harborline-invoice.pdf', 'carrier-bol.pdf']) {
      await processUpload(upload(fixtureFor(filename)), deps, { attachToCase: deductionId });
    }

    // The typed documents here were rebuilt out of extraction_results, so this
    // passing means nothing was lost on the way into the database.
    const reconciliation = await reconcileCase(deductionId, deps);
    expect(reconciliation?.claimedTotalCents).toBe(312_000);
    expect(reconciliation?.lines[0]?.verdict).toBe('matches');
    expect(reconciliation?.findings.map((f) => f.code)).toContain('delivery_confirms_shortage');
  });

  it('records what every model call cost', async () => {
    expect(await store.totalCostMicros()).toBeGreaterThan(0);
  });

  it('refuses a submission with no approval row, from the application role', async () => {
    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query('set local role app_rw');
      await client.query('select set_config($1, $2, true)', [
        'request.jwt.claims',
        JSON.stringify({ org_id: orgId }),
      ]);

      const { rows } = await client.query<{ id: string }>(
        `insert into decisions (org_id, deduction_id, schema_id, schema_version, provider,
                                model_version, input_state_hash, questions, result,
                                raw_probabilities, confidence, latency_ms)
         values ($1, $2, 'B', '1.0.0', 'jev', 'jev-latest', digest('s','sha256'),
                 '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 0.97, 100)
         returning id`,
        [orgId, deductionId],
      );
      const decisionId = rows[0]?.id;

      // The gate that matters, exercised as the application role rather than as
      // the owner: no approval row, no outbound record.
      await expect(
        client.query(
          `insert into submissions (org_id, deduction_id, decision_id, channel)
           values ($1, $2, $3, 'manual_portal')`,
          [orgId, deductionId, decisionId],
        ),
      ).rejects.toThrow(/no submit approval row/);
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
  });

  it('shows another tenant nothing at all', async () => {
    const otherDeps: PipelineDeps = { ...deps, store: otherStore };
    expect(await otherStore.getCase(deductionId)).toBeUndefined();
    expect(await reconcileCase(deductionId, otherDeps)).toBeUndefined();
    expect(await otherStore.totalCostMicros()).toBe(0);
    expect(
      await otherStore.findDocumentByHash(orgId, 'a'.repeat(64)),
    ).toBeUndefined();
  });
});

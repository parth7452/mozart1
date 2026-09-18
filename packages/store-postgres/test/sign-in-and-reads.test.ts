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
import { allFixtureDocuments, expectedExtraction, type FixtureDocument } from '@recouple/fixtures';
import { processUpload, type PipelineDeps } from '@recouple/pipeline';
import { PostgresStore } from '../src/store';
import { resolveSession } from '../src/session';

const connectionString = process.env.DATABASE_URL;
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

/**
 * The web app's two database entry points: the sign-in path that turns a verified
 * identity into a tenant, and the reads the case list and review route make.
 *
 * Both run as `app_rw`, so what they can see is what RLS lets them see — which is
 * the only reason a definer function is involved at all.
 */
describeDb('signing in, and the reads the web app makes', () => {
  const admin = new Pool({ connectionString });
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const analystId = randomUUID();
  const otherAnalystId = randomUUID();
  const readerId = randomUUID();
  const suffix = orgId.slice(0, 8);
  const analystEmail = `analyst-${suffix}@example.test`;
  const readerEmail = `reader-${suffix}@example.test`;
  const otherEmail = `other-${suffix}@example.test`;
  const authAnalyst = randomUUID();
  const authOther = randomUUID();
  let store: PostgresStore;
  let deductionId: string;

  beforeAll(async () => {
    await admin.query(
      `insert into organizations (id, slug, name) values ($1, $2, 'Reads'), ($3, $4, 'Reads Other')`,
      [orgId, `reads-${suffix}`, otherOrgId, `reads-other-${suffix}`],
    );
    await admin.query(`insert into org_settings (org_id) values ($1), ($2)`, [orgId, otherOrgId]);
    await admin.query(
      `insert into users (id, email) values ($1,$2), ($3,$4), ($5,$6)`,
      [analystId, analystEmail, readerId, readerEmail, otherAnalystId, otherEmail],
    );
    await admin.query(
      `insert into memberships (org_id, user_id, role)
       values ($1,$2,'analyst'), ($1,$3,'read_only'), ($4,$5,'analyst')`,
      [orgId, analystId, readerId, otherOrgId, otherAnalystId],
    );
    await admin.query(
      `insert into debtors (org_id, retailer_key, display_name)
       values ($1, 'walmart_apdp', 'Walmart (APDP)')`,
      [orgId],
    );

    store = new PostgresStore(
      { connectionString: connectionString as string },
      { orgId, userId: analystId },
    );
    const deps: PipelineDeps = {
      store,
      scanner: { name: 'test', async scan() { return { status: 'clean', scanner: 'test' }; } },
      classifier: new FixtureClassifier(),
      extractor: new FixtureExtractor(),
      now: () => new Date(),
    };

    const notice = fixtureFor('walmart-apdp-notice.pdf');
    const first = await processUpload(
      {
        orgId,
        filename: notice.filename,
        bytes: notice.bytes,
        declaredMimeType: 'application/pdf',
        source: 'web_upload',
        pageText: notice.pageText,
      },
      deps,
    );
    deductionId = first.case?.deductionId as string;
    for (const filename of ['walmart-po.pdf', 'carrier-bol.pdf']) {
      const fixture = fixtureFor(filename);
      await processUpload(
        {
          orgId,
          filename: fixture.filename,
          bytes: fixture.bytes,
          declaredMimeType: 'application/pdf',
          source: 'web_upload',
          pageText: fixture.pageText,
        },
        deps,
        { attachToCase: deductionId },
      );
    }
  });

  afterAll(async () => {
    await store?.close();
    await admin.end();
  });

  it('links a verified identity to the invited user, once', async () => {
    const first = await resolveSession({ connectionString: connectionString as string }, {
      authUserId: authAnalyst,
      email: analystEmail,
    });
    expect(first.userId).toBe(analystId);
    expect(first.orgs.map((o) => o.orgId)).toEqual([orgId]);
    expect(first.orgs[0]?.role).toBe('analyst');

    const again = await resolveSession({ connectionString: connectionString as string }, {
      authUserId: authAnalyst,
      email: analystEmail.toUpperCase(),
    });
    expect(again.userId).toBe(analystId);
  });

  it('refuses a verified session with no invitation', async () => {
    await expect(
      resolveSession({ connectionString: connectionString as string }, {
        authUserId: randomUUID(),
        email: `stranger-${suffix}@example.test`,
      }),
    ).rejects.toThrow(/no invitation/);
  });

  it('refuses a second identity claiming an account already linked', async () => {
    await expect(
      resolveSession({ connectionString: connectionString as string }, {
        authUserId: randomUUID(),
        email: analystEmail,
      }),
    ).rejects.toThrow(/already linked/);
  });

  it('shows a member only their own tenants', async () => {
    const other = await resolveSession({ connectionString: connectionString as string }, {
      authUserId: authOther,
      email: otherEmail,
    });
    expect(other.orgs.map((o) => o.orgId)).toEqual([otherOrgId]);
  });

  it('lists the tenant’s cases with the deadline and the evidence count', async () => {
    const cases = await store.listCases();
    const found = cases.find((c) => c.deductionId === deductionId);
    expect(found).toBeDefined();
    expect(found?.documentCount).toBe(3);
    expect(found?.deductionAmountCents).toBeGreaterThan(0);
    expect(found?.state).toBe('classified');
  });

  it('hands dates back as strings, not as whatever the driver parsed', async () => {
    // `pg` turns `date` and `timestamptz` into Date objects, so a store that
    // declares strings and passes them through is lying — and the first thing to
    // call `.slice` on one crashes the page rather than the test. The deadline is
    // a calendar day, so it comes back as one.
    await admin.query(
      `update deductions set deduction_date = '2026-09-08', dispute_deadline = '2026-12-07'
        where id = $1`,
      [deductionId],
    );
    const found = (await store.listCases()).find((row) => row.deductionId === deductionId);
    expect(found?.disputeDeadline).toBe('2026-12-07');
    expect(found?.deductionDate).toBe('2026-09-08');
    expect(typeof found?.createdAt).toBe('string');
  });

  it('shows another tenant no cases at all', async () => {
    const otherStore = new PostgresStore(
      { connectionString: connectionString as string },
      { orgId: otherOrgId, userId: otherAnalystId },
    );
    try {
      expect(await otherStore.listCases()).toEqual([]);
      expect(await otherStore.fieldsForCase(deductionId)).toEqual([]);
      expect(await otherStore.costForCase(deductionId)).toBe(0);
    } finally {
      await otherStore.close();
    }
  });

  it('returns every field of a case with the provenance a reviewer follows', async () => {
    const fields = await store.fieldsForCase(deductionId);
    expect(fields.length).toBeGreaterThan(20);

    // Three documents' worth, each field naming the one it came from.
    expect(new Set(fields.map((f) => f.documentId)).size).toBe(3);
    expect(new Set(fields.map((f) => f.docType))).toEqual(
      new Set(['deduction_notice', 'po', 'bol']),
    );

    for (const field of fields) {
      expect(field.sourcePage).toBeGreaterThan(0);
      expect(field.sourceQuote.length).toBeGreaterThan(0);
      expect(field.confidence).toBeGreaterThan(0);
      expect(field.filename.length).toBeGreaterThan(0);
    }

    // Provenance is the product here: a field a reviewer cannot trace is one
    // they have to take on faith, which is the thing this system does not do.
    // `false` would mean a quote was looked for in the page and was not there —
    // none of these fixtures has one, and a run where one appeared would be
    // telling us something real.
    expect(fields.filter((f) => f.quoteVerified === false)).toEqual([]);
    expect(fields.every((f) => f.quoteVerified === true)).toBe(true);
  });

  it('adds up what the case has cost', async () => {
    expect(await store.costForCase(deductionId)).toBeGreaterThan(0);
  });

  it('a read_only member can read the case list', async () => {
    const readerStore = new PostgresStore(
      { connectionString: connectionString as string },
      { orgId, userId: readerId },
    );
    try {
      const cases = await readerStore.listCases();
      expect(cases.some((c) => c.deductionId === deductionId)).toBe(true);
      expect((await readerStore.fieldsForCase(deductionId)).length).toBeGreaterThan(20);
    } finally {
      await readerStore.close();
    }
  });
});

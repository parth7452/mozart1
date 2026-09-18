/**
 * Renders the web app's two views to standalone HTML, from a real database.
 *
 * The pages themselves need a signed-in Supabase session, which a script cannot
 * have. The views are pure functions of what the store returned, so this seeds a
 * tenant, runs the real pipeline over the fixture case, reads it back through
 * `app_rw` under RLS, and renders exactly what a reviewer would see — with the
 * notice inlined as a data URL so the page stands alone.
 *
 *   DATABASE_URL=… pnpm render:web
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
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
import { processUpload, reconcileCase, type PipelineDeps } from '@recouple/pipeline';
import { PostgresStore } from '@recouple/store-postgres';
import { CaseList } from '../apps/web/components/case-list';
import { CaseReview } from '../apps/web/components/case-review';

// Paths come from the working directory, not from `import.meta.url`: this file is
// bundled before it runs (see scripts/render-web.sh), so its own location moves.
const root = process.cwd();
if (!existsSync(path.join(root, 'apps', 'web', 'app', 'globals.css'))) {
  throw new Error('run this from the recouple root, via `pnpm render:web`');
}
const css = readFileSync(path.join(root, 'apps', 'web', 'app', 'globals.css'), 'utf8');
const outDir = path.join(root, 'apps', 'web', 'preview');

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined) throw new Error('set DATABASE_URL');

const fixtureFor = (filename: string): FixtureDocument => {
  const found = allFixtureDocuments().find((d) => d.filename === filename);
  if (found === undefined) throw new Error(`no fixture ${filename}`);
  return found;
};

class FixtureClassifier implements Classifier {
  async classify(document: DocumentPayload): Promise<ClassificationResult> {
    const fixture = fixtureFor(document.filename);
    return {
      docType: fixture.docType as DocType,
      confidence: 0.99,
      call: {
        purpose: 'classify', provider: 'anthropic', modelVersion: 'fixture',
        documentId: document.documentId, costMicros: 1_300, latencyMs: 10, outcome: 'ok',
      },
    };
  }
}

class FixtureExtractor implements Extractor {
  readonly name = 'fixture';
  async extract(document: DocumentPayload, docType: DocType): Promise<ExtractionResult> {
    const fixture = fixtureFor(document.filename);
    return buildExtractionResult({
      docType, extractor: this.name, document: expectedExtraction(fixture),
      pageText: document.pageText,
      call: {
        purpose: 'extract', provider: 'anthropic', modelVersion: 'fixture',
        documentId: document.documentId, costMicros: 12_700, latencyMs: 40, outcome: 'ok',
      },
    });
  }
}

const admin = new Pool({ connectionString });
const orgId = randomUUID();
const analystId = randomUUID();
const suffix = orgId.slice(0, 8);

await admin.query(`insert into organizations (id, slug, name) values ($1, $2, 'Harborline Foods')`, [
  orgId, `preview-${suffix}`,
]);
await admin.query(`insert into org_settings (org_id) values ($1)`, [orgId]);
await admin.query(`insert into users (id, email) values ($1, $2)`, [
  analystId, `ap-${suffix}@harborline.test`,
]);
await admin.query(`insert into memberships (org_id, user_id, role) values ($1, $2, 'analyst')`, [
  orgId, analystId,
]);
const { rows: debtorRows } = await admin.query<{ id: string }>(
  `insert into debtors (org_id, retailer_key, display_name)
   values ($1, 'walmart_apdp', 'Walmart (APDP)') returning id`,
  [orgId],
);

const store = new PostgresStore({ connectionString }, { orgId, userId: analystId });
const deps: PipelineDeps = {
  store,
  scanner: { name: 'preview', async scan() { return { status: 'clean', scanner: 'preview' }; } },
  classifier: new FixtureClassifier(),
  extractor: new FixtureExtractor(),
  now: () => new Date(),
};

const upload = (fixture: FixtureDocument) => ({
  orgId,
  filename: fixture.filename,
  bytes: fixture.bytes,
  source: 'web_upload' as const,
  pageText: fixture.pageText,
});

const notice = await processUpload(upload(fixtureFor('walmart-apdp-notice.pdf')), deps);
const deductionId = notice.case?.deductionId;
if (deductionId === undefined) throw new Error('the notice did not open a case');

for (const filename of ['walmart-po.pdf', 'harborline-invoice.pdf', 'carrier-bol.pdf']) {
  await processUpload(upload(fixtureFor(filename)), deps, { attachToCase: deductionId });
}

// A deadline and a debtor, the way a playbook will compute them in Phase 2.
await admin.query(
  `update deductions set debtor_id = $1, deduction_date = current_date - 10,
          dispute_deadline = current_date + 80 where id = $2`,
  [debtorRows[0]?.id, deductionId],
);

const viewer = {
  email: `ap-${suffix}@harborline.test`,
  orgName: 'Harborline Foods',
  role: 'analyst',
};
const today = new Date();

const cases = await store.listCases();
const summary = cases.find((row) => row.deductionId === deductionId);
if (summary === undefined) throw new Error('the case did not come back through RLS');

const fields = await store.fieldsForCase(deductionId);
const costMicros = await store.costForCase(deductionId);
const reconciliation = await reconcileCase(deductionId, deps);
const noticeDocument = await store.getDocument(fields[0]?.documentId ?? '');

const page = (title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>${title}</title><style>${css}</style></head><body>${body}</body></html>`;

writeFileSync(
  path.join(outDir, 'case-list.html'),
  page('Recouple — cases', renderToStaticMarkup(
    <CaseList viewer={viewer} cases={cases} today={today} mayUpload />,
  )),
);

// The route serves the bytes from `document_blobs`; a standalone file inlines
// them, which also proves they came back out of the database intact.
const dataUrl =
  noticeDocument === undefined
    ? ''
    : `data:${noticeDocument.mimeType};base64,${Buffer.from(noticeDocument.bytes).toString('base64')}`;

writeFileSync(
  path.join(outDir, 'case-review.html'),
  page('Recouple — case review', renderToStaticMarkup(
    <CaseReview
      viewer={viewer}
      summary={summary}
      fields={fields}
      reconciliation={reconciliation}
      costMicros={costMicros}
      today={today}
    />,
  )).replace(`/api/document/${noticeDocument?.documentId ?? ''}`, dataUrl),
);

console.log(
  `case-list.html: ${cases.length} case(s)\n` +
    `case-review.html: ${fields.length} fields across ` +
    `${new Set(fields.map((f) => f.documentId)).size} documents, ` +
    `${reconciliation?.findings.length ?? 0} findings, ` +
    `notice inlined ${noticeDocument === undefined ? 'NOT FOUND' : `${noticeDocument.bytes.byteLength} bytes`}`,
);

await store.close();
await admin.end();

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { CassetteClassifier, CassetteExtractor, type Cassette } from '@recouple/extraction';
import { logisticsDocuments, type FixtureDocument } from '@recouple/fixtures';
import { attachReadDocument, processUpload, type PipelineDeps } from '@recouple/pipeline';
import { closeAllPools, PostgresStore } from '../src/store';

/**
 * The review page's field read, for a case a remittance line opened.
 *
 * Running the LOG-001 demo on 2026-09-23, the case `01_short_pay_remittance.pdf`
 * opened said "No document has been read for this case yet". The remittance's
 * rows carry no `deduction_id` — one read can open many cases, and its spend is
 * nobody's in particular (ADR 0028) — and `fieldsForCase` selected by that
 * column. The remittance *is* on the case, in `deduction_documents` as its
 * notice; this proves the read now goes by that link, as `app_rw` through RLS,
 * while the spend stays exactly where ADR 0028 put it.
 *
 * The readings are the recorded ones `pnpm eval` scores, so the rows are the
 * rows production would have written.
 */

const connectionString = process.env.DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

const cassetteDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'cassettes',
);

function fixture(key: string): FixtureDocument {
  const found = logisticsDocuments().find((d) => d.key === key);
  if (found === undefined) throw new Error(`no fixture ${key}`);
  return found;
}

const REMITTANCE = fixture('log-001-short-pay-remittance');
const INVOICE = fixture('log-001-carrier-invoice');
const CORRESPONDENCE = fixture('log-001-appointment-change');

describeDb('the fields of a case a remittance line opened', () => {
  const admin = new Pool({ connectionString });
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const analystId = randomUUID();
  const otherAnalystId = randomUUID();
  const suffix = orgId.slice(0, 8);
  let store: PostgresStore;
  let deps: PipelineDeps;
  let deductionId: string;
  let remittanceId: string;
  let invoiceId: string;
  let correspondenceId: string;

  async function upload(document: FixtureDocument, attachToCase?: string) {
    return processUpload(
      {
        orgId,
        filename: document.filename,
        bytes: document.bytes,
        declaredMimeType: 'application/pdf',
        source: 'web_upload',
        pageText: document.pageText,
      },
      deps,
      attachToCase === undefined ? {} : { attachToCase },
    );
  }

  beforeAll(async () => {
    await admin.query(
      `insert into organizations (id, slug, name) values ($1,$2,'Remit fields'), ($3,$4,'Remit other')`,
      [orgId, `remit-fields-${suffix}`, otherOrgId, `remit-other-${suffix}`],
    );
    await admin.query('insert into org_settings (org_id) values ($1), ($2)', [orgId, otherOrgId]);
    await admin.query('insert into users (id, email) values ($1,$2), ($3,$4)', [
      analystId,
      `remit-fields-${suffix}@example.test`,
      otherAnalystId,
      `remit-other-${suffix}@example.test`,
    ]);
    await admin.query(
      `insert into memberships (org_id, user_id, role) values ($1,$2,'analyst'), ($3,$4,'analyst')`,
      [orgId, analystId, otherOrgId, otherAnalystId],
    );

    store = new PostgresStore(
      { connectionString: connectionString as string },
      { orgId, userId: analystId },
    );
    const byFilename = new Map<string, Cassette>(
      [REMITTANCE, INVOICE, CORRESPONDENCE].map((d) => [
        d.filename,
        JSON.parse(readFileSync(path.join(cassetteDir, `${d.key}.json`), 'utf8')) as Cassette,
      ]),
    );
    const key = (payload: { readonly filename: string }) => payload.filename;
    deps = {
      store,
      scanner: { name: 'test', async scan() { return { status: 'clean', scanner: 'test' }; } },
      classifier: new CassetteClassifier(byFilename, key),
      extractor: new CassetteExtractor(byFilename, key),
      now: () => new Date('2026-09-23T12:00:00Z'),
    };

    // §1 of the demo: the remittance from the case list opens one case.
    const first = await upload(REMITTANCE);
    const opened = first.remittance?.opened;
    if (opened?.length !== 1) throw new Error('the remittance did not open exactly one case');
    deductionId = opened[0]?.deductionId as string;
    remittanceId = first.ingest.document.documentId;

    // §2: evidence attached from the case page, read against this case.
    invoiceId = (await upload(INVOICE, deductionId)).ingest.document.documentId;

    // And evidence read against no case, then attached from "Read, not on a
    // case" — the other way a document reaches a case with its rows unowned.
    const loose = await upload(CORRESPONDENCE);
    correspondenceId = loose.ingest.document.documentId;
    await attachReadDocument(store, { deductionId, documentId: correspondenceId });
  });

  afterAll(async () => {
    await closeAllPools();
    await store?.close();
    await admin.end();
  });

  it('starts from rows that belong to no case, which is what the old read missed', async () => {
    const { rows } = await admin.query<{ n: string }>(
      `select count(*)::text as n from extraction_results
        where document_id = $1 and deduction_id is not null`,
      [remittanceId],
    );
    expect(rows[0]?.n).toBe('0');
  });

  it('shows the remittance, first, as the document the case was opened from', async () => {
    const fields = await store.fieldsForCase(deductionId);
    expect(fields[0]?.documentId).toBe(remittanceId);

    const remittance = fields.filter((f) => f.documentId === remittanceId);
    expect(remittance.every((f) => f.role === 'notice')).toBe(true);
    expect(remittance.every((f) => f.docType === 'remittance_advice')).toBe(true);
    expect(remittance.every((f) => f.filename === REMITTANCE.filename)).toBe(true);

    // The line that opened it, each value with the quote a reviewer clicks.
    const byPath = new Map(remittance.map((f) => [f.fieldPath, f]));
    expect(byPath.get('lines[0].invoice_number')?.value).toBe('INV-AFS-260814');
    expect(byPath.get('lines[0].deduction_amount')?.value).toBe('$600.00');
    expect(byPath.get('lines[0].reason_code')?.value).toBe('LATE-DEL');
    for (const field of remittance) {
      expect(field.sourcePage).toBeGreaterThan(0);
      expect(field.sourceQuote.length).toBeGreaterThan(0);
      expect(field.quoteVerified, field.fieldPath).toBe(true);
    }
  });

  it('shows every document on the case, in the order it was put there', async () => {
    const fields = await store.fieldsForCase(deductionId);
    const order = [...new Set(fields.map((f) => f.documentId))];
    expect(order).toEqual([remittanceId, invoiceId, correspondenceId]);
    expect(fields.filter((f) => f.documentId !== remittanceId).every((f) => f.role === 'evidence'))
      .toBe(true);
  });

  it('says which reads were paid for this case, and still counts only those', async () => {
    const fields = await store.fieldsForCase(deductionId);
    const paid = new Map(fields.map((f) => [f.documentId, f.readForCase]));
    // The remittance's one read serves every case it opens (ADR 0028); the
    // correspondence was read before it was on any case. The invoice was read
    // for this one.
    expect(paid).toEqual(
      new Map([
        [remittanceId, false],
        [invoiceId, true],
        [correspondenceId, false],
      ]),
    );

    const { rows } = await admin.query<{ total: string }>(
      `select coalesce(sum(cost_micros), 0)::text as total from model_calls where document_id = $1`,
      [invoiceId],
    );
    expect(await store.costForCase(deductionId)).toBe(Number(rows[0]?.total));
  });

  it('lists a field once when its document has been read twice', async () => {
    // The same invoice uploaded again for another case is read again, and its
    // rows then name that case. On this case it is still one set of fields —
    // the ones `latestExtraction` rebuilds from — not two.
    const second = await store.openCase({
      orgId,
      claimId: `SECOND-${suffix}`,
      deductionAmountCents: 1_000,
    });
    await upload(INVOICE, second.deductionId);
    const { rows } = await admin.query<{ n: string }>(
      `select count(distinct deduction_id)::text as n from extraction_results where document_id = $1`,
      [invoiceId],
    );
    expect(rows[0]?.n).toBe('2');

    for (const caseId of [deductionId, second.deductionId]) {
      const fields = (await store.fieldsForCase(caseId)).filter((f) => f.documentId === invoiceId);
      const paths = fields.map((f) => f.fieldPath);
      expect(paths.length).toBeGreaterThan(0);
      expect(new Set(paths).size).toBe(paths.length);
    }
  });

  it('shows another tenant nothing', async () => {
    const other = new PostgresStore(
      { connectionString: connectionString as string },
      { orgId: otherOrgId, userId: otherAnalystId },
    );
    try {
      expect(await other.fieldsForCase(deductionId)).toEqual([]);
    } finally {
      await other.close();
    }
  });
});

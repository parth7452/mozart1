import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import type { IngestSource } from '@recouple/pipeline';
import { closeAllPools, PostgresStore } from '../src/store';

/**
 * Coverage, split by the channel that found the deduction.
 *
 * `coverage_by_period` (migration 0014) answers "of what reached us, how much
 * did we fight for" per tenant per month. The number it is built from —
 * `declined_candidates.discovered_from` — could not be grouped by until now:
 * nothing wrote the `uploads` table, so every decline was stored under whatever
 * the calling code assumed, and a query grouping by it would have produced one
 * bar labelled `web_upload` however the deduction actually arrived.
 *
 * This is the test that a web upload and an inbound email land in different
 * channels, that the split can be reported per `provenance_kind` as well —
 * whether the channel was observed at ingest or asserted afterwards (ADR 0024
 * §4) — and that both add up to what the view reports. The view itself carries
 * neither column: giving it one is a migration, and this needs none, because the
 * grouping is over the table the view reads.
 */

const connectionString = process.env.TEST_DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

describeDb('coverage attributed by channel', () => {
  const admin = new Pool({ connectionString });
  const orgId = randomUUID();
  const analystId = randomUUID();
  const suffix = orgId.slice(0, 8);
  let store: PostgresStore;
  let documents = 0;

  /**
   * Reads as the tenant would: `app_rw`, with the claims set
   * transaction-locally, so what comes back is what the policies allow rather
   * than what a superuser can see. The view is `security_invoker` (ADR 0010)
   * and answers per tenant through exactly this.
   */
  async function asTenant<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query('set local role app_rw');
      await client.query('select set_config($1, $2, true)', [
        'request.jwt.claims',
        JSON.stringify({ org_id: orgId, sub: analystId }),
      ]);
      const result = await work(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** A case with a notice that arrived through `source`, and its decline. */
  async function declineOneThatArrivedBy(
    source: IngestSource,
    amountCents: number,
  ): Promise<string> {
    documents += 1;
    const opened = await store.openCase({
      orgId,
      claimId: `COV-${suffix}-${documents}`,
      deductionAmountCents: amountCents,
    });
    const upload = await store.recordUpload({
      orgId,
      source,
      ...(source === 'web_upload' ? { createdBy: analystId } : {}),
    });
    const stored = await store.putDocument({
      orgId,
      sha256: `${suffix}${documents}`.padEnd(64, 'c').slice(0, 64),
      filename: `notice-${documents}.pdf`,
      mimeType: 'application/pdf',
      byteSize: 1024,
      bytes: new Uint8Array([37, 80, 68, 70]),
      uploadId: upload.uploadId,
      requiresSplit: false,
    });
    await store.linkDocument(opened.deductionId, stored.documentId, 'notice');
    await store.declineCase({
      deductionId: opened.deductionId,
      reason: 'below_economic_floor',
      decidedBy: `cov-${suffix}@example.test`,
    });
    return opened.deductionId;
  }

  /**
   * The same thing for a case whose notice predates provenance: no `uploads`
   * row on the document, and an operator's assertion afterwards standing in for
   * one (ADR 0024 §3).
   *
   * Written through the admin pool because `putDocument` with no `uploadId` is
   * how a pre-2026-09-21 document looks and `documents` is append-only, so the
   * row has to be right when it is inserted.
   */
  async function declineOneAssertedToHaveArrivedBy(
    source: IngestSource,
    amountCents: number,
  ): Promise<string> {
    documents += 1;
    const opened = await store.openCase({
      orgId,
      claimId: `COV-${suffix}-${documents}`,
      deductionAmountCents: amountCents,
    });
    const documentId = randomUUID();
    await admin.query(
      `insert into documents
         (id, org_id, sha256, byte_size, mime_type, storage_ref, filename, created_at)
       values ($1, $2, $3, 1024, 'application/pdf', $4, $5, '2026-09-01T09:00:00Z')`,
      [
        documentId,
        orgId,
        Buffer.from(`${suffix}${documents}`.padEnd(64, 'd').slice(0, 64), 'hex'),
        `doc/${documentId}`,
        `legacy-${documents}.pdf`,
      ],
    );
    await store.linkDocument(opened.deductionId, documentId, 'notice');
    await store.recordDocumentArrival({
      documentId,
      source,
      recordedBy: analystId,
      detail: 'pre-Postmark: the only door open',
    });
    await store.declineCase({
      deductionId: opened.deductionId,
      reason: 'below_economic_floor',
      decidedBy: `cov-${suffix}@example.test`,
    });
    return opened.deductionId;
  }

  beforeAll(async () => {
    await admin.query(`insert into organizations (id, slug, name) values ($1,$2,'Coverage')`, [
      orgId,
      `cov-${suffix}`,
    ]);
    await admin.query(`insert into org_settings (org_id) values ($1)`, [orgId]);
    await admin.query(`insert into users (id, email) values ($1,$2)`, [
      analystId,
      `cov-${suffix}@example.test`,
    ]);
    await admin.query(`insert into memberships (org_id, user_id, role) values ($1,$2,'analyst')`, [
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

  it('puts a declined web upload and a declined email-in case in different channels', async () => {
    await declineOneThatArrivedBy('web_upload', 312_000);
    await declineOneThatArrivedBy('email_in', 45_000);
    await declineOneThatArrivedBy('email_body', 12_500);

    const { rows } = await asTenant(async (client) =>
      client.query<{ discovered_from: string; declines: string; cents: string }>(
        `select discovered_from,
                count(*)::text as declines,
                sum(estimated_recoverable_cents)::text as cents
           from declined_candidates
          group by discovered_from
          order by discovered_from`,
      ),
    );

    // Three arrivals, three channels, three sums. Before provenance was
    // recorded this query answered with one row saying `web_upload` and the
    // whole of the money, whatever had actually found it.
    expect(rows.map((row) => row.discovered_from)).toEqual([
      'email_body',
      'email_in',
      'web_upload',
    ]);
    expect(rows.map((row) => row.cents)).toEqual(['12500', '45000', '312000']);
    expect(rows.every((row) => row.declines === '1')).toBe(true);
  });

  it('can report the split per provenance kind, not only per channel', async () => {
    // Two `web_upload` declines that reached that word two different ways: the
    // one above, whose notice named its own `uploads` row, and this one, whose
    // notice records none and whose channel a person asserted through
    // `document_arrivals`. Before `provenance_kind` they were indistinguishable
    // in this table and anybody quoting the split had to be told, in an ADR, to
    // go and ask three other tables. Now the query answers it (ADR 0024 §4).
    await declineOneAssertedToHaveArrivedBy('web_upload', 20_000);

    const { rows } = await asTenant(async (client) =>
      client.query<{
        discovered_from: string;
        provenance_kind: string;
        declines: string;
        cents: string;
      }>(
        `select discovered_from,
                provenance_kind,
                count(*)::text as declines,
                sum(estimated_recoverable_cents)::text as cents
           from declined_candidates
          group by discovered_from, provenance_kind
          order by discovered_from, provenance_kind`,
      ),
    );

    expect(
      rows.map((row) => [row.discovered_from, row.provenance_kind, row.cents]),
    ).toEqual([
      ['email_body', 'observed', '12500'],
      ['email_in', 'observed', '45000'],
      ['web_upload', 'asserted', '20000'],
      ['web_upload', 'observed', '312000'],
    ]);

    // And the channel-only split is still the same number it was: the kind is a
    // second dimension over the same rows, not a second set of them.
    const { rows: byChannel } = await asTenant(async (client) =>
      client.query<{ cents: string }>(
        `select sum(estimated_recoverable_cents)::text as cents
           from declined_candidates
          where discovered_from = 'web_upload'`,
      ),
    );
    expect(byChannel[0]?.cents).toBe('332000');
  });

  it('adds up to what coverage_by_period reports for the same tenant', async () => {
    // The split is a breakdown of the view's own number, not a second number
    // beside it. If these ever disagreed, one of the two would be what somebody
    // quoted (docs/STRATEGY.md, ADD-1).
    const { rows } = await asTenant(async (client) =>
      client.query<{ view_cents: string | null; channel_cents: string | null }>(
        `select (select sum(declined_cents)::text from coverage_by_period) as view_cents,
                (select sum(cents)::text
                   from (select sum(estimated_recoverable_cents) as cents
                           from declined_candidates
                          group by discovered_from) by_channel) as channel_cents`,
      ),
    );
    expect(rows[0]?.view_cents).toBe('389500');
    expect(rows[0]?.channel_cents).toBe(rows[0]?.view_cents);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  ingestDocument,
  readInboundEmailJob,
  receiveInboundEmail,
  type PipelineDeps,
} from '@recouple/pipeline';
import { parsePostmarkInbound, type ScanVerdict } from '@recouple/ingest';
import {
  buildExtractionResult,
  type ClassificationResult,
  type DocType,
  type DocumentPayload,
  type ExtractionResult,
} from '@recouple/extraction';
import { allFixtureDocuments, expectedExtraction } from '@recouple/fixtures';
import {
  InboundAddressRefusedError,
  InboundRecordRefusedError,
  PostgresInboundStore,
  inboundAddressFor,
} from '../src/inbound';
import { closeAllPools, PostgresStore } from '../src/store';

const connectionString = process.env.DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

/**
 * Email-in's database half against a real database (ADR 0047, migration 0034).
 *
 * Suite 30 asks the schema its questions in SQL. This asks the ones only the
 * driver can answer: does the claimless lookup clear a pooled connection's
 * claims, does the JSON this code hands `app.record_inbound_message()` line up
 * with what it reads, is a refusal a named error rather than a driver string,
 * and does the message claim hold, release and refuse on its own small pool.
 * No email test had touched Postgres before this one.
 */
describeDb('email-in on Postgres', () => {
  const admin = new Pool({ connectionString });
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const ownerId = randomUUID();
  const secondOwnerId = randomUUID();
  const analystId = randomUUID();
  const otherOwnerId = randomUUID();
  const suffix = orgId.slice(0, 8);
  const config = { connectionString: connectionString as string };

  let owner: PostgresInboundStore;
  let secondOwner: PostgresInboundStore;
  let analyst: PostgresInboundStore;
  let other: PostgresInboundStore;

  beforeAll(async () => {
    await admin.query(
      `insert into organizations (id, slug, name) values ($1,$2,'Inbound'), ($3,$4,'Inbound Other')`,
      [orgId, `inb-${suffix}`, otherOrgId, `inb-other-${suffix}`],
    );
    await admin.query(`insert into org_settings (org_id) values ($1), ($2)`, [orgId, otherOrgId]);
    await admin.query(`insert into users (id, email) values ($1,$2), ($3,$4), ($5,$6), ($7,$8)`, [
      ownerId, `inb-o-${suffix}@example.test`,
      secondOwnerId, `inb-o2-${suffix}@example.test`,
      analystId, `inb-a-${suffix}@example.test`,
      otherOwnerId, `inb-x-${suffix}@example.test`,
    ]);
    await admin.query(
      `insert into memberships (org_id, user_id, role)
       values ($1,$2,'owner'), ($1,$3,'owner'), ($1,$4,'analyst'), ($5,$6,'owner')`,
      [orgId, ownerId, secondOwnerId, analystId, otherOrgId, otherOwnerId],
    );
    owner = new PostgresInboundStore(config, { orgId, userId: ownerId });
    secondOwner = new PostgresInboundStore(config, { orgId, userId: secondOwnerId });
    analyst = new PostgresInboundStore(config, { orgId, userId: analystId });
    other = new PostgresInboundStore(config, { orgId: otherOrgId, userId: otherOwnerId });
  });

  afterAll(async () => {
    await admin.end();
    await closeAllPools();
  });

  /** A document that arrived by email, stored as the member the email acts as. */
  async function emailedDocument(actingAs: string, bytes: Uint8Array): Promise<string> {
    const store = new PostgresStore(config, { orgId, userId: actingAs });
    const upload = await store.recordUpload({ orgId, source: 'email_in' });
    const stored = await store.putDocument({
      orgId,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      filename: 'notice.pdf',
      mimeType: 'application/pdf',
      byteSize: bytes.byteLength,
      bytes,
      uploadId: upload.uploadId,
      requiresSplit: false,
    });
    return stored.documentId;
  }

  it('issues an address only to an owner, with a token the database chose', async () => {
    const issued = await owner.issueAddress();
    expect(issued.token).toMatch(/^[0-9a-f]{32}$/);
    await expect(analyst.issueAddress()).rejects.toBeInstanceOf(InboundAddressRefusedError);
  });

  it('turns a token into its tenant and acting member with no claims, and nothing else', async () => {
    const { addressId, token } = await owner.issueAddress();
    expect(await inboundAddressFor(config, token)).toEqual({
      addressId,
      orgId,
      actingMember: ownerId,
      retired: false,
    });

    await secondOwner.adoptAddress(addressId);
    expect((await inboundAddressFor(config, token))?.actingMember).toBe(secondOwnerId);

    expect(await inboundAddressFor(config, '0'.repeat(32))).toBeUndefined();
    expect(await inboundAddressFor(config, `u-inb-${suffix}`)).toBeUndefined();
    expect(await inboundAddressFor(config, token.toUpperCase())).toBeUndefined();

    const { token: otherToken } = await other.issueAddress();
    expect((await inboundAddressFor(config, otherToken))?.orgId).toBe(otherOrgId);
  });

  it('records an email and its parts once, as the member the address acts as', async () => {
    const { addressId } = await owner.issueAddress();
    const documentId = await emailedDocument(ownerId, new TextEncoder().encode(`%PDF-1.4 ${randomUUID()}`));
    const messageId = randomUUID();

    expect(await owner.receivedMessage('postmark', messageId)).toBeUndefined();
    const recorded = await owner.recordInboundMessage(
      {
        addressId,
        provider: 'postmark',
        providerMessageId: messageId,
        outcome: 'received',
        verdict: {
          authenticated: true,
          dkim: 'pass',
          dmarc: 'unknown',
          spf: 'pass',
          verdictSource: 'postmark_spamassassin',
          senderDomain: 'example.com',
        },
      },
      [
        { ordinal: 0, kind: 'attachment', filename: 'notice.pdf', outcome: 'stored', documentId },
        { ordinal: 1, kind: 'inline', filename: 'logo.png', outcome: 'inline_image' },
      ],
    );
    expect(await owner.receivedMessage('postmark', messageId)).toBe(recorded);
    expect(await owner.inboundMessageParts(recorded)).toEqual([
      { inboundMessageId: recorded, ordinal: 0, kind: 'attachment', filename: 'notice.pdf', outcome: 'stored', documentId },
      { inboundMessageId: recorded, ordinal: 1, kind: 'inline', filename: 'logo.png', outcome: 'inline_image' },
    ]);
    expect(await owner.inboundReadsLastDay(new Date())).toBeGreaterThanOrEqual(1);

    // A second record of the same email writes nothing and says which row it was.
    const again = await owner.recordInboundMessage(
      { addressId, provider: 'postmark', providerMessageId: messageId, outcome: 'received',
        verdict: { authenticated: false, dkim: 'none', dmarc: 'unknown', spf: 'none',
                   verdictSource: 'postmark_spamassassin' } },
      [],
    );
    expect(again).toBe(recorded);

    // Another tenant sees none of it.
    expect(await other.receivedMessage('postmark', messageId)).toBeUndefined();
  });

  it('refuses, by name, a record written as anyone but the acting member', async () => {
    const { addressId } = await owner.issueAddress();
    await expect(
      analyst.recordInboundMessage(
        { addressId, provider: 'postmark', providerMessageId: randomUUID(), outcome: 'not_received',
          providerReceivedAt: new Date('2026-09-24T10:00:00Z') },
        [],
      ),
    ).rejects.toBeInstanceOf(InboundRecordRefusedError);
  });

  it('records a refusal at a retired address as its retirer, and nothing received', async () => {
    const { addressId, token } = await owner.issueAddress();
    await owner.retireAddress(addressId);
    expect(await inboundAddressFor(config, token)).toMatchObject({ retired: true, actingMember: ownerId });
    await expect(
      owner.recordInboundMessage(
        { addressId, provider: 'postmark', providerMessageId: randomUUID(), outcome: 'received',
          verdict: { authenticated: false, dkim: 'none', dmarc: 'unknown', spf: 'none',
                     verdictSource: 'postmark_spamassassin' } },
        [],
      ),
    ).rejects.toBeInstanceOf(InboundRecordRefusedError);
    const refused = await owner.recordInboundMessage(
      { addressId, provider: 'postmark', providerMessageId: randomUUID(), outcome: 'refused_retired' },
      [],
    );
    expect(refused).toMatch(/^[0-9a-f-]{36}$/);
    const listed = (await owner.addresses()).find((a) => a.addressId === addressId);
    expect(listed).toMatchObject({ refusedSinceRetired: 1, retiredBy: ownerId });
  });

  it('holds one delivery of a message at a time, and releases it after', async () => {
    const messageId = randomUUID();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const first = owner.withMessageClaim('postmark', messageId, async () => {
      await held;
      return 'first';
    });
    // Give the first claim a moment to be taken.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = await owner.withMessageClaim('postmark', messageId, async () => 'second');
    expect(second).toEqual({ claimed: false, reason: 'held' });
    release();
    expect(await first).toEqual({ claimed: true, result: 'first' });
    expect(await owner.withMessageClaim('postmark', messageId, async () => 'third')).toEqual({
      claimed: true,
      result: 'third',
    });
  });

  it('answers at once when its own two connections are busy, and touches no other pool', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const a = owner.withMessageClaim('postmark', randomUUID(), async () => held);
    const b = owner.withMessageClaim('postmark', randomUUID(), async () => held);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const started = Date.now();
    const third = await owner.withMessageClaim('postmark', randomUUID(), async () => 'never');
    expect(third).toEqual({ claimed: false, reason: 'no_connection' });
    expect(Date.now() - started).toBeLessThan(5_000);
    // The ordinary pool still answers while the inbound pool is full.
    expect(await owner.receivedMessage('postmark', randomUUID())).toBeUndefined();
    release();
    await Promise.all([a, b]);
  });

  it('receives an email, reads it in a job, and holds its notice for a person (§7, §8)', async () => {
    const notice = allFixtureDocuments().find((d) => d.key === 'walmart-apdp-notice')!;
    const { addressId, token } = await owner.issueAddress();
    const resolved = await inboundAddressFor(config, token);
    expect(resolved?.addressId).toBe(addressId);

    const reader = {
      name: 'fixture',
      classify: async (document: DocumentPayload): Promise<ClassificationResult> => ({
        docType: 'deduction_notice',
        confidence: 0.99,
        call: { purpose: 'classify', provider: 'anthropic', modelVersion: 'fixture',
                documentId: document.documentId, costMicros: 1, latencyMs: 1, outcome: 'ok' },
      }),
      extract: async (document: DocumentPayload, docType: DocType): Promise<ExtractionResult> =>
        buildExtractionResult({
          docType, extractor: 'fixture', document: expectedExtraction(notice),
          pageText: document.pageText,
          call: { purpose: 'extract', provider: 'anthropic', modelVersion: 'fixture',
                  documentId: document.documentId, costMicros: 1, latencyMs: 1, outcome: 'ok' },
        }),
    };
    const store = new PostgresStore(config, { orgId, userId: ownerId });
    const deps = {
      store,
      inbound: owner,
      scanner: { name: 'clean', scan: async (): Promise<ScanVerdict> => ({ status: 'clean', scanner: 'clean' }) },
      classifier: reader,
      extractor: reader,
      now: () => new Date(),
    };
    const cover = `Please see the attached deduction notice. ${'We will follow up. '.repeat(12)}${randomUUID()}`;
    const email = parsePostmarkInbound(
      {
        MessageID: randomUUID(),
        FromFull: { Email: 'ap@walmart.example' },
        From: 'ap@walmart.example',
        OriginalRecipient: `${token}@in.example.test`,
        TextBody: cover,
        Headers: [],
        Attachments: [{ Name: notice.filename, ContentType: 'application/pdf',
                        Content: Buffer.from(notice.bytes).toString('base64') }],
      },
      'in.example.test',
    );

    const receipt = await receiveInboundEmail(email, resolved!, deps);
    expect(receipt).toMatchObject({ kind: 'recorded', alreadyRecorded: false });
    if (receipt.kind !== 'recorded') return;
    const parts = await owner.inboundMessageParts(receipt.inboundMessageId);
    expect(parts.map((p) => [p.kind, p.outcome])).toEqual([
      ['attachment', 'stored'],
      ['body', 'stored'],
    ]);
    const sources = await admin.query<{ source: string; created_by: string | null }>(
      `select u.source, u.created_by from documents d join uploads u on u.id = d.upload_id
        where d.id = any($1::uuid[]) order by u.source`,
      [parts.map((p) => p.documentId)],
    );
    expect(sources.rows).toEqual([
      { source: 'email_body', created_by: null },
      { source: 'email_in', created_by: null },
    ]);

    const read = await readInboundEmailJob(deps, {
      orgId, userId: ownerId, inboundMessageId: receipt.inboundMessageId,
    });
    expect(read.reads[0]).toMatchObject({ docType: 'deduction_notice', held: 'by_email', deductionId: null });
    expect(read.bodyRead).toBe(false);
    const cases = await admin.query(`select 1 from deductions where org_id = $1`, [orgId]);
    expect(cases.rowCount).toBe(0);

    // The cover note was not read, and is not presented as a stalled read.
    const waiting = await store.unreadDocuments(0, 50);
    expect(waiting.map((w) => w.documentId)).not.toContain(parts[1]?.documentId);
  });

  it('scans a stored document again when its first scan gave no verdict (ADR 0047 §10)', async () => {
    const store = new PostgresStore(config, { orgId, userId: ownerId });
    const bytes = new TextEncoder().encode(`%PDF-1.4 rescan ${randomUUID()}`);
    const scanner = (status: ScanVerdict['status']) => ({
      name: `scanner-${status}`,
      scan: async (): Promise<ScanVerdict> => ({ status, scanner: `scanner-${status}` }),
    });
    const deps = (s: PipelineDeps['scanner']) =>
      ({ store, scanner: s }) as unknown as PipelineDeps;
    const input = { orgId, filename: 'n.pdf', bytes, source: 'email_in' as const };

    const first = await ingestDocument(input, deps(scanner('error')));
    expect(first.verdict.status).toBe('error');
    const second = await ingestDocument(input, deps(scanner('clean')));
    expect(second.deduplicated).toBe(true);
    expect(second.verdict.status).toBe('clean');
    expect(await store.latestScan(first.document.documentId)).toMatchObject({ status: 'clean' });
  });
});

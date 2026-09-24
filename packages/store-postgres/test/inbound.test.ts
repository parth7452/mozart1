import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { ingestDocument, type PipelineDeps } from '@recouple/pipeline';
import type { ScanVerdict } from '@recouple/ingest';
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

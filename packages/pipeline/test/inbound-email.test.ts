import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INBOUND_READS_PER_DAY } from '@recouple/core-domain';
import {
  buildExtractionResult,
  CassetteClassifier,
  CassetteExtractor,
  type Cassette,
  type Classifier,
  type ClassificationResult,
  type DocType,
  type DocumentPayload,
  type Extractor,
  type ExtractionResult,
} from '@recouple/extraction';
import {
  allFixtureDocuments,
  everyDocument,
  expectedExtraction,
  type FixtureDocument,
} from '@recouple/fixtures';
import { parsePostmarkInbound, type ScanVerdict } from '@recouple/ingest';
import {
  InboundActingMemberRefusedError,
  InboundScanUnavailableError,
  readInboundEmailJob,
  receiveInboundEmail,
  type InboundDeps,
} from '../src/inbound';
import type { InboundAddressResolution } from '../src/inbound-ports';
import { InvalidJobPayloadError, readDocumentJob, type JobDeps } from '../src/jobs';
import { processUpload } from '../src/steps';
import type { StoredDocument } from '../src/ports';
import { AlwaysCleanScanner, InMemoryStore } from '../src/testing/memory-store';
import { InMemoryInboundStore } from '../src/testing/memory-inbound';

/**
 * Email-in's two halves (ADR 0047 §7, §8, §10).
 *
 * The request stores and scans and reads nothing; the job reads each stored
 * part, and the body only when no attachment was a notice; and no email opens
 * a case by itself — a notice or a remittance it carries is held for a person,
 * on every path that could read it.
 */
const ORG = '11111111-1111-1111-1111-111111111111';
const OWNER = '22222222-2222-2222-2222-222222222222';
const DOMAIN = 'in.mozart.example';
const TOKEN = '0123456789abcdef0123456789abcdef';
const ADDRESS: InboundAddressResolution = {
  addressId: '33333333-3333-3333-3333-333333333333',
  orgId: ORG,
  actingMember: OWNER,
  retired: false,
};

function fixtureFor(filename: string): FixtureDocument {
  const found = allFixtureDocuments().find((d) => d.filename === filename);
  if (found === undefined) throw new Error(`no fixture ${filename}`);
  return found;
}

const NOTICE = fixtureFor('walmart-apdp-notice.pdf');
const PO = fixtureFor('walmart-po.pdf');

/** A body that reads as the Walmart notice, as a retailer might paste it. */
const BODY_NOTICE = [
  'WALMART STORES, INC. — Accounts Payable Deduction',
  '',
  'Vendor Number: 481207',
  'Claim ID: APDP-99812',
  'Invoice Number: HF-20418',
  'Purchase Order: 7741-88203',
  'SKU 000-4471-08  Case Pack Olive Oil',
  'Qty Invoiced 30   Qty Received 25   Unit Cost $624.00',
  'Reason Code 24 — Shortage',
  'Total Deduction: $3,120.00',
  'Dispute Deadline: 11/12/2026',
].join('\n');

class FixtureReader implements Classifier, Extractor {
  readonly name = 'fixture';
  calls = 0;
  private fixture(document: DocumentPayload): FixtureDocument {
    return document.mimeType === 'text/plain' ? NOTICE : fixtureFor(document.filename);
  }
  async classify(document: DocumentPayload): Promise<ClassificationResult> {
    this.calls += 1;
    return {
      docType: this.fixture(document).docType as DocType,
      confidence: 0.99,
      call: { purpose: 'classify', provider: 'anthropic', modelVersion: 'fixture',
              documentId: document.documentId, costMicros: 1, latencyMs: 1, outcome: 'ok' },
    };
  }
  async extract(document: DocumentPayload, docType: DocType): Promise<ExtractionResult> {
    this.calls += 1;
    return buildExtractionResult({
      docType,
      extractor: this.name,
      document: expectedExtraction(this.fixture(document)),
      pageText: document.pageText,
      call: { purpose: 'extract', provider: 'anthropic', modelVersion: 'fixture',
              documentId: document.documentId, costMicros: 1, latencyMs: 1, outcome: 'ok' },
    });
  }
}

/** The in-memory store, plus a document by id, which a job owes itself. */
class JobTestStore extends InMemoryStore {
  async getDocument(documentId: string): Promise<StoredDocument | undefined> {
    return this.documents.get(documentId);
  }
}

function harness(scanner: InboundDeps['scanner'] = new AlwaysCleanScanner()) {
  const store = new JobTestStore();
  store.addMember(ORG, OWNER, 'owner');
  const inbound = new InMemoryInboundStore(ORG, store);
  const reader = new FixtureReader();
  const deps = { store, scanner, inbound, classifier: reader, extractor: reader };
  return { store, inbound, reader, deps: deps as typeof deps & JobDeps & InboundDeps };
}

const attach = (document: FixtureDocument) => ({
  Name: document.filename,
  Content: Buffer.from(document.bytes).toString('base64'),
  ContentType: document.mimeType,
});

function email(overrides: Record<string, unknown> = {}) {
  return parsePostmarkInbound(
    {
      MessageID: 'pm-0001',
      From: 'ap@walmart.example',
      FromFull: { Email: 'ap@walmart.example' },
      OriginalRecipient: `${TOKEN}@${DOMAIN}`,
      TextBody: 'Notice attached.',
      Headers: [
        { Name: 'X-Spam-Status', Value: 'No' },
        { Name: 'X-Spam-Score', Value: '0' },
        { Name: 'X-Spam-Tests', Value: 'DKIM_SIGNED,DKIM_VALID,DKIM_VALID_AU' },
      ],
      Attachments: [attach(NOTICE)],
      ...overrides,
    },
    DOMAIN,
  );
}

class ScannerOf {
  readonly name: string;
  constructor(private readonly status: ScanVerdict['status']) {
    this.name = `scanner-${status}`;
  }
  async scan(): Promise<ScanVerdict> {
    return { status: this.status, scanner: this.name };
  }
}

describe('the request half: store and scan, read nothing', () => {
  it('stores each part through its own door, with no member named, and records the email', async () => {
    const { store, inbound, reader, deps } = harness();
    const receipt = await receiveInboundEmail(email({ TextBody: BODY_NOTICE }), ADDRESS, deps);

    expect(receipt).toMatchObject({ kind: 'recorded', alreadyRecorded: false });
    expect(reader.calls).toBe(0);
    const [message] = inbound.messages;
    expect(message?.parts.map((p) => [p.kind, p.outcome])).toEqual([
      ['attachment', 'stored'],
      ['body', 'stored'],
    ]);
    expect(message?.verdict).toMatchObject({ authenticated: true, dkim: 'pass' });
    const sources = [...store.uploads.values()].map((u) => [u.source, u.createdBy]);
    expect(sources).toEqual([
      ['email_in', undefined],
      ['email_body', undefined],
    ]);
  });

  it('answers a second delivery of the same email from its record, storing nothing', async () => {
    const { store, inbound, deps } = harness();
    const first = await receiveInboundEmail(email(), ADDRESS, deps);
    const uploads = store.uploads.size;
    const second = await receiveInboundEmail(email(), ADDRESS, deps);
    expect(second).toMatchObject({ kind: 'recorded', alreadyRecorded: true });
    expect(second.kind === 'recorded' && first.kind === 'recorded' &&
      second.inboundMessageId === first.inboundMessageId).toBe(true);
    expect(store.uploads.size).toBe(uploads);
    expect(inbound.messages).toHaveLength(1);
  });

  it('records a part the front door refuses and keeps the rest', async () => {
    const { inbound, deps } = harness();
    const zip = { Name: 'signature.zip', Content: Buffer.from([0x50, 0x4b, 3, 4, 0, 0]).toString('base64'),
                  ContentType: 'application/zip' };
    await receiveInboundEmail(email({ Attachments: [attach(NOTICE), zip] }), ADDRESS, deps);
    // "Notice attached." is a cover note too short to be anything, and says so.
    expect(inbound.messages[0]?.parts.map((p) => p.outcome)).toEqual(['stored', 'type_not_allowed', 'body_too_short']);
  });

  it('records a body too short to be anything, rather than saying nothing', async () => {
    const { inbound, deps } = harness();
    await receiveInboundEmail(email({ Attachments: [], TextBody: 'thanks!' }), ADDRESS, deps);
    expect(inbound.messages[0]?.parts).toEqual([
      expect.objectContaining({ kind: 'body', outcome: 'body_too_short' }),
    ]);
  });

  it('records an infected part as not clean, and the job never reads it', async () => {
    const { inbound, reader, deps } = harness(new ScannerOf('infected'));
    const receipt = await receiveInboundEmail(email({ TextBody: '' }), ADDRESS, deps);
    expect(inbound.messages[0]?.parts.map((p) => p.outcome)).toEqual(['not_clean']);
    if (receipt.kind !== 'recorded') throw new Error('not recorded');
    const read = await readInboundEmailJob(deps, { orgId: ORG, userId: OWNER, inboundMessageId: receipt.inboundMessageId });
    expect(read.reads).toEqual([]);
    expect(reader.calls).toBe(0);
  });

  it('records nothing when the scanner gives no verdict, and the retry re-scans and reads it', async () => {
    const { store, inbound, reader, deps } = harness(new ScannerOf('error'));
    await expect(receiveInboundEmail(email({ TextBody: '' }), ADDRESS, deps)).rejects.toBeInstanceOf(
      InboundScanUnavailableError,
    );
    expect(inbound.messages).toHaveLength(0);

    const recovered = { ...deps, scanner: new AlwaysCleanScanner() };
    const receipt = await receiveInboundEmail(email({ TextBody: '' }), ADDRESS, recovered);
    // The first attempt stored the bytes; the retry finds them, scans them
    // again, and records them as already held — and the job still reads them.
    expect(inbound.messages[0]?.parts.map((p) => p.outcome)).toEqual(['already_held']);
    expect(store.uploads.size).toBe(1);
    if (receipt.kind !== 'recorded') throw new Error('not recorded');
    const read = await readInboundEmailJob(recovered, { orgId: ORG, userId: OWNER, inboundMessageId: receipt.inboundMessageId });
    expect(read.reads).toHaveLength(1);
    expect(reader.calls).toBeGreaterThan(0);
  });

  it('stores past the daily budget but records it, and the job does not read it', async () => {
    const { inbound, reader, deps } = harness();
    inbound.inboundReadsLastDay = async () => INBOUND_READS_PER_DAY - 1;
    const receipt = await receiveInboundEmail(email({ Attachments: [attach(NOTICE), attach(PO)], TextBody: '' }), ADDRESS, deps);
    expect(inbound.messages[0]?.parts.map((p) => p.outcome)).toEqual(['stored', 'over_daily_budget']);
    if (receipt.kind !== 'recorded') throw new Error('not recorded');
    const read = await readInboundEmailJob(deps, { orgId: ORG, userId: OWNER, inboundMessageId: receipt.inboundMessageId });
    expect(read.reads).toHaveLength(1);
    expect(reader.calls).toBe(2);
  });

  it('accepts nothing for an address whose member may no longer write', async () => {
    const { store, inbound, deps } = harness();
    const stranger = { ...ADDRESS, actingMember: '44444444-4444-4444-4444-444444444444' };
    await expect(receiveInboundEmail(email(), stranger, deps)).rejects.toBeInstanceOf(
      InboundActingMemberRefusedError,
    );
    expect(store.uploads.size).toBe(0);
    expect(inbound.messages).toHaveLength(0);
  });

  it('spends nothing when its claim pool is full', async () => {
    const { store, inbound, deps } = harness();
    inbound.poolFull = true;
    expect(await receiveInboundEmail(email(), ADDRESS, deps)).toEqual({ kind: 'busy', reason: 'no_connection' });
    expect(store.uploads.size).toBe(0);
  });
});

describe('the job half: read, and hold what an email says is a deduction', () => {
  async function received(deps: ReturnType<typeof harness>['deps'], overrides: Record<string, unknown> = {}) {
    const receipt = await receiveInboundEmail(email(overrides), ADDRESS, deps);
    if (receipt.kind !== 'recorded') throw new Error('not recorded');
    return receipt.inboundMessageId;
  }

  it('asks whether the member may write before it reads anything', async () => {
    const { reader, deps } = harness();
    const id = await received(deps);
    await expect(
      readInboundEmailJob(deps, { orgId: ORG, userId: '55555555-5555-5555-5555-555555555555', inboundMessageId: id }),
    ).rejects.toBeInstanceOf(InvalidJobPayloadError);
    expect(reader.calls).toBe(0);
  });

  it('holds an emailed notice for a person, opens no case, and does not read the cover note', async () => {
    const { store, deps } = harness();
    const id = await received(deps, { TextBody: BODY_NOTICE });
    const result = await readInboundEmailJob(deps, { orgId: ORG, userId: OWNER, inboundMessageId: id });

    expect(result.reads).toHaveLength(1);
    expect(result.reads[0]).toMatchObject({ docType: 'deduction_notice', held: 'by_email', deductionId: null });
    expect(result.bodyRead).toBe(false);
    expect(store.cases.size).toBe(0);
    expect(store.auditLog.map((row) => row.action)).toEqual(['document.held']);
  });

  it('holds a notice written in the body when nothing was attached', async () => {
    const { store, deps } = harness();
    const id = await received(deps, { Attachments: [], TextBody: BODY_NOTICE });
    const result = await readInboundEmailJob(deps, { orgId: ORG, userId: OWNER, inboundMessageId: id });
    expect(result.bodyRead).toBe(true);
    expect(result.reads[0]).toMatchObject({ docType: 'deduction_notice', held: 'by_email' });
    expect(store.cases.size).toBe(0);
  });

  it('reads an attachment that is not a deduction, and then the body', async () => {
    const { deps } = harness();
    const id = await received(deps, { Attachments: [attach(PO)], TextBody: BODY_NOTICE });
    const result = await readInboundEmailJob(deps, { orgId: ORG, userId: OWNER, inboundMessageId: id });
    expect(result.reads.map((r) => r.docType)).toEqual(['po', 'deduction_notice']);
    expect(result.bodyRead).toBe(true);
  });

  it('reads a file attached twice once, as one document', async () => {
    const { deps } = harness();
    const id = await received(deps, { Attachments: [attach(PO), attach(PO)], TextBody: '' });
    expect((await deps.inbound.inboundMessageParts(id)).map((p) => p.outcome)).toEqual([
      'stored',
      'already_held',
    ]);
    const asked: string[] = [];
    const result = await readInboundEmailJob(
      deps,
      { orgId: ORG, userId: OWNER, inboundMessageId: id },
      async (documentId) => {
        asked.push(documentId);
        return readDocumentJob(deps, { documentId, orgId: ORG, actor: { userId: OWNER } });
      },
    );
    expect(asked).toHaveLength(1);
    expect(result.reads.map((r) => r.docType)).toEqual(['po']);
  });

  it('does not read the body when the attached notice was answered from the record', async () => {
    const { deps, reader } = harness();
    const id = await received(deps, { TextBody: BODY_NOTICE });
    await readInboundEmailJob(deps, { orgId: ORG, userId: OWNER, inboundMessageId: id });
    const calls = reader.calls;
    const again = await readInboundEmailJob(deps, { orgId: ORG, userId: OWNER, inboundMessageId: id });
    expect(again.reads[0]).toMatchObject({ alreadyRead: true, docType: 'deduction_notice' });
    expect(again.bodyRead).toBe(false);
    expect(reader.calls).toBe(calls);
  });

  it('keeps the hold when the same bytes are uploaded, and when "Read again" asks to open a case', async () => {
    const { store, deps } = harness();
    const id = await received(deps, { TextBody: '' });
    await readInboundEmailJob(deps, { orgId: ORG, userId: OWNER, inboundMessageId: id });

    // A member uploads the same file: it dedupes to the emailed document and is
    // answered from its hold.
    const uploaded = await processUpload(
      { orgId: ORG, filename: NOTICE.filename, bytes: NOTICE.bytes, source: 'web_upload', uploadedBy: OWNER,
        pageText: NOTICE.pageText },
      deps,
    );
    expect(uploaded.case).toBeUndefined();
    expect(store.cases.size).toBe(0);

    // A never-read emailed document re-driven with allowCaseOpen true is held.
    const fresh = await received(deps, { MessageID: 'pm-0002', Attachments: [attach(fixtureFor('kehe-ksolve-notice.pdf'))], TextBody: '' });
    const part = (await deps.inbound.inboundMessageParts(fresh))[0];
    const reread = await readDocumentJob(deps, {
      documentId: part?.documentId as string, orgId: ORG, actor: { userId: OWNER }, allowCaseOpen: true,
    });
    expect(reread).toMatchObject({ held: 'by_email', deductionId: null });
    expect(store.cases.size).toBe(0);
  });

  it('holds an emailed remittance too, and opens no case for any of its lines', async () => {
    const key = 'hl-case-01-remittance';
    const fixture = everyDocument().find((d) => d.key === key) as FixtureDocument;
    const here = path.dirname(fileURLToPath(import.meta.url));
    const recording = JSON.parse(
      readFileSync(path.join(here, '../../fixtures/cassettes', `${key}.json`), 'utf8'),
    ) as Cassette;
    const byFilename = new Map([[fixture.filename, recording]]);
    const keyOf = (payload: { readonly filename: string }) => payload.filename;
    const { store, deps } = harness();
    const cassettes = {
      ...deps,
      classifier: new CassetteClassifier(byFilename, keyOf),
      extractor: new CassetteExtractor(byFilename, keyOf),
    };
    const receipt = await receiveInboundEmail(email({ Attachments: [attach(fixture)], TextBody: '' }), ADDRESS, cassettes);
    if (receipt.kind !== 'recorded') throw new Error('not recorded');
    const result = await readInboundEmailJob(cassettes, { orgId: ORG, userId: OWNER, inboundMessageId: receipt.inboundMessageId });
    expect(result.reads[0]).toMatchObject({ docType: 'remittance_advice', held: 'by_email', remittanceCases: [] });
    expect(store.cases.size).toBe(0);
  });
});

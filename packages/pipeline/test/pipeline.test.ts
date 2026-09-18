import { describe, expect, it } from 'vitest';
import {
  UnscannedDocumentError,
  type ScanVerdict,
} from '@recouple/ingest';
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
  WALMART_CODE_24,
  allFixtureDocuments,
  expectedExtraction,
  type FixtureDocument,
} from '@recouple/fixtures';
import {
  RejectedUploadError,
  classifyDocument,
  ingestDocument,
  ingestInboundEmail,
  processUpload,
  reconcileCase,
} from '../src/steps';
import type { PipelineDeps } from '../src/ports';
import {
  AlwaysCleanScanner,
  AlwaysInfectedScanner,
  InMemoryStore,
} from '../src/testing/memory-store';

function fixtureFor(filename: string): FixtureDocument {
  const found = allFixtureDocuments().find((d) => d.filename === filename);
  if (found === undefined) throw new Error(`no fixture ${filename}`);
  return found;
}

/**
 * The fixture readers key on the filename, which a document that arrived as an
 * email body does not have. It stands in for the Walmart notice, whose text it
 * carries: the point of those tests is the path a body takes, not the reading.
 */
function fixtureForPayload(document: DocumentPayload): FixtureDocument {
  if (document.mimeType === 'text/plain') return fixtureFor('walmart-apdp-notice.pdf');
  return fixtureFor(document.filename);
}

/**
 * Deterministic stand-ins for the reader models: they return exactly what a
 * perfect extraction would be. These test the pipeline's behaviour, not the
 * model's accuracy — that is what the eval suite and its cassettes are for.
 */
class FixtureClassifier implements Classifier {
  calls = 0;
  async classify(document: DocumentPayload): Promise<ClassificationResult> {
    this.calls += 1;
    const fixture = fixtureForPayload(document);
    return {
      docType: fixture.docType as DocType,
      confidence: 0.99,
      call: {
        purpose: 'classify',
        provider: 'anthropic',
        modelVersion: 'fixture',
        documentId: document.documentId,
        costMicros: 1_300,
        latencyMs: 12,
        outcome: 'ok',
      },
    };
  }
}

class FixtureExtractor implements Extractor {
  readonly name = 'fixture';
  calls = 0;
  async extract(document: DocumentPayload, docType: DocType): Promise<ExtractionResult> {
    this.calls += 1;
    const fixture = fixtureForPayload(document);
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

function harness(scanner: PipelineDeps['scanner'] = new AlwaysCleanScanner()) {
  const store = new InMemoryStore();
  const classifier = new FixtureClassifier();
  const extractor = new FixtureExtractor();
  const deps: PipelineDeps = { store, scanner, classifier, extractor, now: () => new Date(0) };
  return { store, classifier, extractor, deps };
}

const upload = (fixture: FixtureDocument) => ({
  orgId: 'org-1',
  filename: fixture.filename,
  bytes: fixture.bytes,
  source: 'web_upload' as const,
  pageText: fixture.pageText,
});

describe('a notice becomes a case', () => {
  it('ingests, classifies, extracts and opens the case', async () => {
    const { store, deps } = harness();
    const notice = fixtureFor('walmart-apdp-notice.pdf');

    const result = await processUpload(upload(notice), deps);

    expect(result.classification?.docType).toBe('deduction_notice');
    expect(result.case?.state).toBe('classified');
    expect(result.case?.claimId).toBe('APDP-99812');
    expect(result.case?.retailerName).toBe('Walmart');
    // The amount is the number the whole case is about: what the retailer took.
    // A case that does not carry it cannot be prioritised, costed or billed.
    expect(result.case?.deductionAmountCents).toBe(312_000);
    expect(result.extraction?.fields.length).toBeGreaterThan(10);

    // Every extracted field was checked against the page it cites.
    expect(result.extraction?.fields.every((f) => f.quoteVerified === true)).toBe(true);

    expect(store.events.map((e) => e.eventType)).toEqual(['case.discovered', 'case.classified']);
    expect(store.extractions).toHaveLength(1);
    expect(store.modelCalls.map((c) => c.purpose)).toEqual(['classify', 'extract']);
    expect(store.totalCostMicros()).toBe(14_000);
  });

  it('walks the case through the state machine rather than assigning a state', async () => {
    const { store, deps } = harness();
    await processUpload(upload(fixtureFor('walmart-apdp-notice.pdf')), deps);
    const [record] = [...store.cases.values()];
    expect(record?.state).toBe('classified');
    // discovered → classified is a legal edge; nothing jumped ahead.
    expect(store.events.at(-1)?.eventType).toBe('case.classified');
  });

  it('attaches evidence to the case it was uploaded against', async () => {
    const { store, deps } = harness();
    const opened = await processUpload(upload(fixtureFor('walmart-apdp-notice.pdf')), deps);
    const deductionId = opened.case?.deductionId as string;

    for (const filename of ['walmart-po.pdf', 'harborline-invoice.pdf', 'carrier-bol.pdf']) {
      const result = await processUpload(upload(fixtureFor(filename)), deps, {
        attachToCase: deductionId,
      });
      expect(result.case?.deductionId).toBe(deductionId);
    }

    expect(await store.documentsForCase(deductionId)).toHaveLength(4);
    expect(store.events.filter((e) => e.eventType === 'evidence.uploaded')).toHaveLength(3);
    // One case, not four: evidence does not open cases of its own.
    expect(store.cases.size).toBe(1);
  });

  it('reconciles the whole case once its evidence is in', async () => {
    const { deps } = harness();
    const opened = await processUpload(upload(fixtureFor('walmart-apdp-notice.pdf')), deps);
    const deductionId = opened.case?.deductionId as string;
    for (const filename of ['walmart-po.pdf', 'harborline-invoice.pdf', 'carrier-bol.pdf']) {
      await processUpload(upload(fixtureFor(filename)), deps, { attachToCase: deductionId });
    }

    const reconciliation = await reconcileCase(deductionId, deps);
    expect(reconciliation?.lines[0]?.verdict).toBe('matches');
    expect(reconciliation?.claimedTotalCents).toBe(312_000);
    expect(reconciliation?.findings.map((f) => f.code)).toContain('delivery_confirms_shortage');
    expect(reconciliation?.internallyConsistent).toBe(true);
    expect(WALMART_CODE_24.key).toBe('walmart-code-24-shortage');
  });

  it('has nothing to reconcile before a notice arrives', async () => {
    const { store, deps } = harness();
    const empty = await store.openCase({ orgId: 'org-1' });
    expect(await reconcileCase(empty.deductionId, deps)).toBeUndefined();
  });
});

describe('the same file twice', () => {
  it('dedupes on content hash instead of storing it again', async () => {
    const { store, deps } = harness();
    const notice = fixtureFor('walmart-apdp-notice.pdf');

    const first = await ingestDocument(upload(notice), deps);
    const second = await ingestDocument(upload(notice), deps);

    expect(second.deduplicated).toBe(true);
    expect(second.document.documentId).toBe(first.document.documentId);
    expect(store.documents.size).toBe(1);
  });
});

describe('nothing unclean reaches a model', () => {
  it('stops an infected file before classification', async () => {
    const { store, classifier, extractor, deps } = harness(new AlwaysInfectedScanner());

    const result = await processUpload(upload(fixtureFor('walmart-apdp-notice.pdf')), deps);

    expect(result.haltedBecause).toMatch(/not scanned clean: infected/);
    expect(result.classification).toBeUndefined();
    expect(result.extraction).toBeUndefined();
    // The gate is only real if the model was never called.
    expect(classifier.calls).toBe(0);
    expect(extractor.calls).toBe(0);
    expect(store.modelCalls).toHaveLength(0);
    expect(store.cases.size).toBe(0);
  });

  it('stops a file whose scan errored — an error is not a pass', async () => {
    const erroring = {
      name: 'broken',
      async scan(): Promise<ScanVerdict> {
        return { status: 'error', scanner: 'broken', detail: 'clamd unreachable' };
      },
    };
    const { classifier, deps } = harness(erroring);
    const result = await processUpload(upload(fixtureFor('kehe-ksolve-notice.pdf')), deps);
    expect(result.haltedBecause).toMatch(/not scanned clean: error/);
    expect(classifier.calls).toBe(0);
  });

  it('refuses to read a stored document that was never scanned at all', async () => {
    const { store, classifier, deps } = harness();
    const notice = fixtureFor('walmart-apdp-notice.pdf');
    // Straight into the store, bypassing ingest: the gate still holds.
    const stored = await store.putDocument({
      orgId: 'org-1',
      sha256: 'deadbeef',
      filename: notice.filename,
      mimeType: 'application/pdf',
      byteSize: notice.bytes.length,
      bytes: notice.bytes,
      requiresSplit: false,
    });

    await expect(classifyDocument(stored, deps)).rejects.toThrow(UnscannedDocumentError);
    expect(classifier.calls).toBe(0);
  });
});

describe('what the front door refuses', () => {
  it('rejects a file type we do not accept, and stores nothing', async () => {
    const { store, deps } = harness();
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    await expect(
      processUpload({ ...upload(fixtureFor('walmart-po.pdf')), bytes: zip, filename: 'a.zip' }, deps),
    ).rejects.toThrow(RejectedUploadError);
    expect(store.documents.size).toBe(0);
  });
});

describe('email-in', () => {
  const emailPayload = (overrides: Record<string, unknown> = {}) => {
    const notice = fixtureFor('walmart-apdp-notice.pdf');
    return {
      From: 'ap@walmart.example',
      To: 'u-harborline@in.recouple.app',
      Subject: 'Deduction notice APDP-99812',
      MessageID: 'msg-1',
      TextBody: 'Notice attached.',
      Headers: [{ Name: 'Authentication-Results', Value: 'mx; spf=pass; dkim=pass; dmarc=pass' }],
      Attachments: [
        {
          Name: notice.filename,
          Content: Buffer.from(notice.bytes).toString('base64'),
          ContentType: 'application/pdf',
          ContentLength: notice.bytes.length,
        },
      ],
      ...overrides,
    };
  };

  function emailHarness() {
    const h = harness();
    h.store.addOrg('harborline', 'org-1');
    return h;
  }

  it('ingests the attachments into the tenant the address names', async () => {
    const { store, deps } = emailHarness();
    const result = await ingestInboundEmail(emailPayload(), deps);

    expect(result.orgId).toBe('org-1');
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]?.classification?.docType).toBe('deduction_notice');
    expect(store.documents.size).toBe(1);
  });

  // A notice pasted into the message is a format some retailers actually send,
  // and until the body was read it produced nothing at all: an inbox with a real
  // deduction in it looked like an empty inbox.
  const BODY_NOTICE = [
    'WALMART STORES, INC. — Accounts Payable Deduction',
    '',
    'Vendor Number: 481207',
    'Claim ID: APDP-99812',
    'Invoice Number: HF-20418',
    'Purchase Order: 7741-88203',
    'Distribution Center: DC 6094 - Sanger, TX',
    '',
    'SKU 000-4471-08  Case Pack Olive Oil',
    'Qty Invoiced 30   Qty Received 25   Unit Cost $624.00',
    'Reason Code 24 — Shortage',
    'Total Deduction: $3,120.00',
    '',
    'Disputes must be filed in APDP within 90 days of the deduction date.',
    'Dispute Deadline: 11/12/2026',
  ].join('\n');

  it('reads a notice pasted into the message when nothing was attached', async () => {
    const { store, deps } = emailHarness();
    const result = await ingestInboundEmail(
      emailPayload({ Attachments: [], TextBody: BODY_NOTICE }),
      deps,
    );

    expect(result.skipped).toEqual([]);
    expect(result.documents).toHaveLength(1);
    const document = result.documents[0];
    expect(document?.ingest.document.mimeType).toBe('text/plain');
    expect(document?.classification?.docType).toBe('deduction_notice');
    // It is a document like any other: stored, scanned, read, and a case opened.
    expect(store.documents.size).toBe(1);
    expect(document?.case?.claimId).toBe('APDP-99812');
    // Named so a reviewer can tell where it came from without opening it.
    expect(document?.ingest.document.filename).toContain('email body');
  });

  it('does not read the body when an attachment was the notice', async () => {
    const { store, deps } = emailHarness();
    // The body here would classify as a notice on its own. Reading it anyway
    // would cost a model call and could open a second case for one deduction.
    const result = await ingestInboundEmail(emailPayload({ TextBody: BODY_NOTICE }), deps);

    expect(result.documents).toHaveLength(1);
    expect(store.documents.size).toBe(1);
    expect(result.documents[0]?.ingest.document.mimeType).toBe('application/pdf');
  });

  it('says why a body too short to be a notice was not read', async () => {
    const { store, deps } = emailHarness();
    const result = await ingestInboundEmail(
      emailPayload({ Attachments: [], TextBody: 'thanks!' }),
      deps,
    );

    expect(result.documents).toHaveLength(0);
    expect(store.documents.size).toBe(0);
    // Silence was the bug. An email that produced nothing now says what it was.
    expect(result.skipped).toEqual([
      { filename: 'the email body', reason: expect.stringContaining('body_too_short') },
    ]);
  });

  it('will not open a case from a body sent by an unauthenticated sender', async () => {
    const { deps } = emailHarness();
    const result = await ingestInboundEmail(
      emailPayload({
        Attachments: [],
        TextBody: BODY_NOTICE,
        Headers: [{ Name: 'Authentication-Results', Value: 'mx; spf=fail; dkim=fail' }],
      }),
      deps,
    );

    // The body is even easier to forge than an attachment: it is just text in a
    // message anyone can send. It is read and filed, and it opens nothing.
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]?.case).toBeUndefined();
    expect(result.documents[0]?.haltedBecause).toMatch(/unauthenticated sender/);
  });

  it('refuses an address that belongs to no tenant, rather than picking one', async () => {
    const { deps } = emailHarness();
    await expect(
      ingestInboundEmail(emailPayload({ To: 'u-nobody@in.recouple.app' }), deps),
    ).rejects.toThrow(/no tenant with inbound slug/);
  });

  it('will not open a case from an unauthenticated sender', async () => {
    const { store, deps } = emailHarness();
    const spoofed = await ingestInboundEmail(
      emailPayload({
        Headers: [{ Name: 'Authentication-Results', Value: 'mx; spf=pass; dkim=fail; dmarc=fail' }],
      }),
      deps,
    );

    // The flag, and — the part that matters — that nothing acted on it. An
    // earlier version computed this correctly and then opened the case anyway;
    // asserting only the flag is what let that through.
    expect(spoofed.mayOpenCase).toBe(false);
    expect(store.cases.size).toBe(0);
    expect(store.events).toHaveLength(0);
    expect(spoofed.documents[0]?.case).toBeUndefined();
    expect(spoofed.documents[0]?.haltedBecause).toMatch(/unauthenticated sender/);

    // The document itself is still read: it may be perfectly real, and a human
    // decides which case it belongs to.
    expect(spoofed.documents).toHaveLength(1);
    expect(spoofed.documents[0]?.extraction?.fields.length).toBeGreaterThan(10);
    expect(store.documents.size).toBe(1);

    const genuine = await ingestInboundEmail(emailPayload({ MessageID: 'msg-2' }), deps);
    expect(genuine.mayOpenCase).toBe(true);
    expect(store.cases.size).toBe(1);
  });

  it('keeps the good attachments when one is refused at the door', async () => {
    const { deps } = emailHarness();
    const notice = fixtureFor('walmart-apdp-notice.pdf');
    const result = await ingestInboundEmail(
      emailPayload({
        Attachments: [
          {
            Name: notice.filename,
            Content: Buffer.from(notice.bytes).toString('base64'),
            ContentType: 'application/pdf',
          },
          {
            Name: 'signature.zip',
            Content: Buffer.from(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0])).toString('base64'),
            ContentType: 'application/zip',
          },
        ],
      }),
      deps,
    );

    // A supplier who attaches something odd alongside a notice keeps the notice.
    expect(result.documents).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toMatch(/type_not_allowed/);
  });
});

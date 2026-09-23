/**
 * Filing a document that was already read against a case, without reading it
 * again.
 *
 * What this protects is what a reviewer met in production: a delivery receipt
 * and a rate confirmation, uploaded from the case list, were read and opened
 * nothing — they are evidence — and appeared nowhere. The list now shows them
 * and offers to attach each one. That offer is only worth making if attaching
 * spends nothing and loses nothing, so that is what is asserted: no model call,
 * no second extraction, a link and one event, and every refusal before the one
 * write.
 */

import { describe, expect, it } from 'vitest';
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
import { attachReadDocument, DocumentNotReadError } from '../src/attach';
import { CaseNotFoundError, processUpload, type IngestInput } from '../src/steps';
import { CaseMergedAwayError } from '../src/ports';
import { DocumentNotFoundError, ingestForJob } from '../src/jobs';
import {
  UnreadDocumentsQueryError,
  UNREAD_DOCUMENTS_MAX_LIMIT,
  type PipelineDeps,
} from '../src/ports';
import { AlwaysCleanScanner, InMemoryStore } from '../src/testing/memory-store';

const ORG = 'org-attach';
const ACTOR = { userId: 'user-attach' };

function fixtureFor(filename: string): FixtureDocument {
  const found = allFixtureDocuments().find((d) => d.filename === filename);
  if (found === undefined) throw new Error(`no fixture ${filename}`);
  return found;
}

/** Answers each fixture as the type it is, and counts how often it was asked. */
class CountingClassifier implements Classifier {
  calls = 0;
  async classify(document: DocumentPayload): Promise<ClassificationResult> {
    this.calls += 1;
    return {
      docType: fixtureFor(document.filename).docType as DocType,
      confidence: 0.99,
      call: {
        purpose: 'classify',
        provider: 'anthropic',
        modelVersion: 'fixture',
        documentId: document.documentId,
        costMicros: 1_300,
        latencyMs: 1,
        outcome: 'ok',
      },
    };
  }
}

class CountingExtractor implements Extractor {
  readonly name = 'fixture';
  calls = 0;
  async extract(document: DocumentPayload, docType: DocType): Promise<ExtractionResult> {
    this.calls += 1;
    return buildExtractionResult({
      docType,
      extractor: this.name,
      document: expectedExtraction(fixtureFor(document.filename)),
      pageText: document.pageText,
      call: {
        purpose: 'extract',
        provider: 'anthropic',
        modelVersion: 'fixture',
        documentId: document.documentId,
        costMicros: 12_700,
        latencyMs: 1,
        outcome: 'ok',
      },
    });
  }
}

function harness() {
  const store = new InMemoryStore();
  store.addMember(ORG, ACTOR.userId, 'analyst');
  const classifier = new CountingClassifier();
  const extractor = new CountingExtractor();
  const deps: PipelineDeps = {
    store,
    scanner: new AlwaysCleanScanner(),
    classifier,
    extractor,
    now: () => new Date(0),
  };
  return { store, deps, classifier, extractor };
}

function upload(fixture: FixtureDocument): IngestInput {
  return {
    orgId: ORG,
    filename: fixture.filename,
    bytes: fixture.bytes,
    source: 'web_upload' as const,
    pageText: fixture.pageText,
  };
}

/** A notice that opens a case, and a bill of lading uploaded from the list that opens nothing. */
async function caseAndLooseEvidence() {
  const h = harness();
  const opened = await processUpload(upload(fixtureFor('walmart-apdp-notice.pdf')), h.deps);
  const deductionId = opened.case?.deductionId as string;
  const bol = await processUpload(upload(fixtureFor('carrier-bol.pdf')), h.deps);
  expect(bol.case).toBeUndefined();
  return { ...h, deductionId, bolId: bol.ingest.document.documentId };
}

describe('attaching a document that was already read', () => {
  it('files it on the case as evidence without reading it again', async () => {
    const { store, deductionId, bolId, classifier, extractor } = await caseAndLooseEvidence();
    const modelCallsBefore = store.modelCalls.length;
    const extractionsBefore = store.extractions.length;
    const classifyCalls = classifier.calls;
    const extractCalls = extractor.calls;

    const result = await attachReadDocument(store, { deductionId, documentId: bolId });

    expect(result).toEqual({ deductionId, documentId: bolId, docType: 'bol', attached: true });
    expect(store.links).toContainEqual({ deductionId, documentId: bolId, role: 'evidence' });

    // Nothing was read: no model was asked anything and nothing was recorded
    // about a read.
    expect(classifier.calls).toBe(classifyCalls);
    expect(extractor.calls).toBe(extractCalls);
    expect(store.modelCalls).toHaveLength(modelCallsBefore);
    expect(store.extractions).toHaveLength(extractionsBefore);

    // And the case says how the document got there, in ids and a closed-set
    // type — nothing off the page.
    const attached = store.events.filter((e) => e.eventType === 'evidence.attached');
    expect(attached).toEqual([
      {
        orgId: ORG,
        deductionId,
        eventType: 'evidence.attached',
        payload: { document_id: bolId, doc_type: 'bol', read_again: false },
      },
    ]);
  });

  it('writes nothing the second time', async () => {
    const { store, deductionId, bolId } = await caseAndLooseEvidence();
    await attachReadDocument(store, { deductionId, documentId: bolId });

    const again = await attachReadDocument(store, { deductionId, documentId: bolId });

    expect(again.attached).toBe(false);
    expect(store.links.filter((l) => l.documentId === bolId)).toHaveLength(1);
    expect(store.events.filter((e) => e.eventType === 'evidence.attached')).toHaveLength(1);
  });

  it('does not file a case’s own notice against it a second time as evidence', async () => {
    const { store, deductionId } = await caseAndLooseEvidence();
    const noticeId = store.links.find((l) => l.role === 'notice')?.documentId as string;

    const result = await attachReadDocument(store, { deductionId, documentId: noticeId });

    expect(result.attached).toBe(false);
    expect(store.links.filter((l) => l.documentId === noticeId)).toEqual([
      { deductionId, documentId: noticeId, role: 'notice' },
    ]);
  });

  it('refuses a case it cannot resolve, and writes nothing', async () => {
    const { store, bolId } = await caseAndLooseEvidence();
    const linksBefore = store.links.length;

    await expect(
      attachReadDocument(store, { deductionId: 'no-such-case', documentId: bolId }),
    ).rejects.toBeInstanceOf(CaseNotFoundError);
    expect(store.links).toHaveLength(linksBefore);
  });

  it('refuses a case merged into another, and writes nothing (ADR 0042)', async () => {
    const { store, bolId, deductionId } = await caseAndLooseEvidence();
    await store.transitionCase(deductionId, 'merged');
    const linksBefore = store.links.length;

    await expect(
      attachReadDocument(store, { deductionId, documentId: bolId }),
    ).rejects.toBeInstanceOf(CaseMergedAwayError);
    expect(store.links).toHaveLength(linksBefore);
  });

  it('refuses a document it cannot see', async () => {
    const { store, deductionId } = await caseAndLooseEvidence();

    await expect(
      attachReadDocument(store, { deductionId, documentId: 'no-such-document' }),
    ).rejects.toBeInstanceOf(DocumentNotFoundError);
  });

  it('refuses a document that was never read, rather than reading it here', async () => {
    const { store, deps, deductionId, classifier } = await caseAndLooseEvidence();
    const stored = await ingestForJob(deps, upload(fixtureFor('walmart-po.pdf')));
    const classifyCalls = classifier.calls;

    await expect(
      attachReadDocument(store, { deductionId, documentId: stored.documentId }),
    ).rejects.toBeInstanceOf(DocumentNotReadError);
    expect(classifier.calls).toBe(classifyCalls);
    expect(store.links.some((l) => l.documentId === stored.documentId)).toBe(false);
  });
});

describe('the documents that were read and no case holds', () => {
  it('lists loose evidence with what it was read as, and stops once it is filed', async () => {
    const { store, deductionId, bolId } = await caseAndLooseEvidence();

    const before = await store.unattachedDocuments();
    expect(before.map((d) => [d.documentId, d.docType, d.filename])).toEqual([
      [bolId, 'bol', 'carrier-bol.pdf'],
    ]);

    await attachReadDocument(store, { deductionId, documentId: bolId });
    expect(await store.unattachedDocuments()).toEqual([]);
  });

  it('leaves out a notice that opened its case, and a document nobody has read', async () => {
    const { store, deps } = await caseAndLooseEvidence();
    const unread = await ingestForJob(deps, upload(fixtureFor('walmart-po.pdf')));

    const listed = (await store.unattachedDocuments()).map((d) => d.documentId);
    expect(listed).not.toContain(unread.documentId);
    expect(listed).not.toContain(store.links.find((l) => l.role === 'notice')?.documentId);
  });

  it('refuses a limit that is not one, the way the unread list does', async () => {
    const { store } = harness();
    for (const limit of [0, -1, 1.5, Number.NaN, UNREAD_DOCUMENTS_MAX_LIMIT + 1]) {
      await expect(store.unattachedDocuments(limit)).rejects.toBeInstanceOf(
        UnreadDocumentsQueryError,
      );
    }
  });
});

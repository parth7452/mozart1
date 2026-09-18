/**
 * An in-memory PipelineStore.
 *
 * For tests and local development only. It is exported from
 * `@recouple/pipeline/testing`, a separate entry point, so production code
 * cannot reach it by importing the package (CLAUDE.md: no mocks reachable from
 * production paths). The Supabase implementation lands with apps/web.
 *
 * It mirrors the database's behaviour where that behaviour is load-bearing:
 * documents dedupe on (org, sha256), and every *_events-shaped list is
 * append-only.
 */

import { randomUUID } from 'node:crypto';
import type { CaseState } from '@recouple/core-domain';
import type { DocType, ExtractedField, ModelCallRecord } from '@recouple/extraction';
import type { ScanVerdict } from '@recouple/ingest';
import type { CaseRecord, PipelineStore, StoredDocument } from '../ports';

export interface StoredExtraction {
  readonly documentId: string;
  readonly deductionId?: string;
  readonly docType: DocType;
  readonly extractor: string;
  readonly schemaVersion: string;
  readonly fields: readonly ExtractedField[];
  readonly document: unknown;
}

export interface StoredEvent {
  readonly orgId: string;
  readonly deductionId: string;
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
}

export class InMemoryStore implements PipelineStore {
  readonly documents = new Map<string, StoredDocument>();
  readonly scans: Array<{ documentId: string; verdict: ScanVerdict }> = [];
  readonly classifications: Array<{ documentId: string; docType: DocType; confidence: number }> = [];
  readonly extractions: StoredExtraction[] = [];
  readonly modelCalls: ModelCallRecord[] = [];
  readonly events: StoredEvent[] = [];
  readonly cases = new Map<string, CaseRecord>();
  readonly links: Array<{ deductionId: string; documentId: string; role: string }> = [];

  async findDocumentByHash(orgId: string, sha256: string): Promise<StoredDocument | undefined> {
    return [...this.documents.values()].find((d) => d.orgId === orgId && d.sha256 === sha256);
  }

  async putDocument(document: Omit<StoredDocument, 'documentId'>): Promise<StoredDocument> {
    const stored: StoredDocument = { ...document, documentId: randomUUID() };
    this.documents.set(stored.documentId, stored);
    return stored;
  }

  async recordScan(documentId: string, verdict: ScanVerdict): Promise<void> {
    this.scans.push({ documentId, verdict });
  }

  async latestScan(documentId: string): Promise<ScanVerdict | undefined> {
    return this.scans.filter((s) => s.documentId === documentId).at(-1)?.verdict;
  }

  async recordClassification(
    documentId: string,
    docType: DocType,
    confidence: number,
  ): Promise<void> {
    this.classifications.push({ documentId, docType, confidence });
  }

  async recordExtraction(input: StoredExtraction): Promise<void> {
    this.extractions.push(input);
  }

  async latestExtraction(
    documentId: string,
  ): Promise<{ docType: DocType; document: unknown } | undefined> {
    const found = this.extractions.filter((e) => e.documentId === documentId).at(-1);
    return found === undefined ? undefined : { docType: found.docType, document: found.document };
  }

  async recordModelCall(call: ModelCallRecord): Promise<void> {
    this.modelCalls.push(call);
  }

  async openCase(input: {
    orgId: string;
    claimId?: string;
    retailerName?: string;
    deductionAmountCents?: number;
  }): Promise<CaseRecord> {
    const record: CaseRecord = { deductionId: randomUUID(), state: 'discovered', ...input };
    this.cases.set(record.deductionId, record);
    return record;
  }

  async linkDocument(
    deductionId: string,
    documentId: string,
    role: 'notice' | 'evidence',
  ): Promise<void> {
    const already = this.links.some(
      (l) => l.deductionId === deductionId && l.documentId === documentId && l.role === role,
    );
    if (!already) this.links.push({ deductionId, documentId, role });
  }

  async transitionCase(deductionId: string, to: CaseState): Promise<CaseRecord> {
    const current = this.cases.get(deductionId);
    if (current === undefined) throw new Error(`no case ${deductionId}`);
    const next: CaseRecord = { ...current, state: to };
    this.cases.set(deductionId, next);
    return next;
  }

  async appendEvent(input: StoredEvent): Promise<void> {
    this.events.push(input);
  }

  async getCase(deductionId: string): Promise<CaseRecord | undefined> {
    return this.cases.get(deductionId);
  }

  async documentsForCase(deductionId: string): Promise<readonly StoredDocument[]> {
    return this.links
      .filter((l) => l.deductionId === deductionId)
      .map((l) => this.documents.get(l.documentId))
      .filter((d): d is StoredDocument => d !== undefined);
  }

  /** Total model spend on this book, in micro-USD. */
  totalCostMicros(): number {
    return this.modelCalls.reduce((sum, call) => sum + call.costMicros, 0);
  }
}

/** A scanner that always says clean. Tests only — never wire this to anything. */
export class AlwaysCleanScanner {
  readonly name = 'test-always-clean';
  async scan(): Promise<ScanVerdict> {
    return { status: 'clean', scanner: this.name };
  }
}

export class AlwaysInfectedScanner {
  readonly name = 'test-always-infected';
  async scan(): Promise<ScanVerdict> {
    return { status: 'infected', scanner: this.name, detail: 'Eicar-Test-Signature' };
  }
}

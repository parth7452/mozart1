/**
 * Recorded model responses, replayed.
 *
 * Every decision path needs a committed fixture (CLAUDE.md), for two reasons:
 * evals must score the same bytes on every run, and CI must not spend money or
 * depend on a vendor being up. A cassette is the raw validated document object
 * a live read returned; replay rebuilds the fields and re-checks the quotes
 * through exactly the same code as production.
 */

import { buildExtractionResult } from './claude';
import {
  ExtractionError,
  type Classifier,
  type ClassificationResult,
  type DocType,
  type DocumentPayload,
  type Extractor,
  type ExtractionResult,
  type ModelCallRecord,
} from './ports';

export interface Cassette {
  readonly key: string;
  /** The type the document actually is — what the extraction was run against. */
  readonly docType: DocType;
  /** What the classifier answered. Differs from docType when it got it wrong. */
  readonly classifiedAs: DocType;
  readonly classifierConfidence: number;
  readonly document: unknown;
  readonly recordedWith: string;
  readonly recordedAt: string;
  readonly call: {
    readonly modelVersion: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly costMicros: number;
    readonly latencyMs: number;
  };
}

/** How a payload maps to a cassette. Filename by default; sha256 in production. */
export type CassetteKey = (document: DocumentPayload) => string;

export const keyByFilename: CassetteKey = (document) => document.filename;

function replayCall(
  cassette: Cassette,
  purpose: ModelCallRecord['purpose'],
  documentId: string,
): ModelCallRecord {
  return {
    purpose,
    provider: 'anthropic',
    modelVersion: cassette.call.modelVersion,
    documentId,
    inputTokens: cassette.call.inputTokens,
    outputTokens: cassette.call.outputTokens,
    // A replay costs nothing and takes no time; recording what the original call
    // cost is the cassette's job, not the replay's.
    costMicros: 0,
    latencyMs: 0,
    outcome: 'ok',
    detail: `replayed cassette ${cassette.key} recorded ${cassette.recordedAt}`,
  };
}

export class CassetteExtractor implements Extractor {
  readonly name = 'cassette';

  constructor(
    private readonly cassettes: ReadonlyMap<string, Cassette>,
    private readonly key: CassetteKey = keyByFilename,
  ) {}

  async extract(document: DocumentPayload, docType: DocType): Promise<ExtractionResult> {
    const cassette = this.cassettes.get(this.key(document));
    if (cassette === undefined) {
      throw new ExtractionError(
        `no cassette recorded for ${this.key(document)}: record one before relying on it`,
        {
          purpose: 'extract',
          provider: 'anthropic',
          modelVersion: 'cassette',
          documentId: document.documentId,
          costMicros: 0,
          latencyMs: 0,
          outcome: 'error',
        },
      );
    }
    return buildExtractionResult({
      docType,
      extractor: `cassette:${cassette.recordedWith}`,
      document: cassette.document,
      pageText: document.pageText,
      call: replayCall(cassette, 'extract', document.documentId),
    });
  }
}

export class CassetteClassifier implements Classifier {
  constructor(
    private readonly cassettes: ReadonlyMap<string, Cassette>,
    private readonly key: CassetteKey = keyByFilename,
  ) {}

  async classify(document: DocumentPayload): Promise<ClassificationResult> {
    const cassette = this.cassettes.get(this.key(document));
    if (cassette === undefined) {
      throw new ExtractionError(`no cassette recorded for ${this.key(document)}`, {
        purpose: 'classify',
        provider: 'anthropic',
        modelVersion: 'cassette',
        documentId: document.documentId,
        costMicros: 0,
        latencyMs: 0,
        outcome: 'error',
      });
    }
    return {
      docType: cassette.classifiedAs,
      confidence: cassette.classifierConfidence,
      call: replayCall(cassette, 'classify', document.documentId),
    };
  }
}

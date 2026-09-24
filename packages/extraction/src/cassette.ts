/**
 * Recorded model responses, replayed.
 *
 * Every decision path needs a committed fixture (CLAUDE.md), for two reasons:
 * evals must score the same bytes on every run, and CI must not spend money or
 * depend on a vendor being up. A cassette is the raw validated document object
 * a live read returned; replay rebuilds the fields and re-checks the quotes
 * through exactly the same code as production.
 */

import { createHash } from 'node:crypto';
import { buildExtractionResult } from './claude';
import type { OcrBlock, OcrPage } from './ocr';
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
import { CLASSIFY_SYSTEM } from './prompt';
import { classifyTemperatureFor } from './models';

/**
 * What answered a cassette's `classifiedAs`: the classifier model and a hash
 * of the system prompt it was given.
 *
 * A cassette is keyed by filename, and replay hands back whatever the
 * classifier said when it was recorded. Without this, a prompt change moves no
 * number in `pnpm eval` — the old answers replay under the new prompt and read
 * as its score. The system prompt is what is hashed because it is where every
 * classification change has been made; the per-document instruction and the
 * text-layer preamble are not covered, and this does not claim they are.
 */
export interface ClassifierStamp {
  readonly model: string;
  /** sha256 of the classifier's system prompt, hex. */
  readonly promptSha256: string;
  /**
   * The temperature the classifier was asked at, or `null` when none was sent.
   * Absent on a stamp written before the classifier pinned one, which reads
   * as not current: an unpinned answer was one sample of several.
   */
  readonly temperature?: number | null;
  readonly classifiedAt: string;
}

export function classifierPromptSha256(system: string = CLASSIFY_SYSTEM): string {
  return createHash('sha256').update(system, 'utf8').digest('hex');
}

/**
 * Whether the classification a cassette replays was answered by this model
 * under this prompt, at the temperature this checkout asks it at. A cassette with no stamp is not current: it was recorded
 * before anything wrote down what answered it, so nothing says it was.
 */
export function classificationIsCurrent(
  cassette: Pick<Cassette, 'classifier'>,
  model: string,
  system: string = CLASSIFY_SYSTEM,
): boolean {
  return (
    cassette.classifier !== undefined &&
    cassette.classifier.model === model &&
    cassette.classifier.promptSha256 === classifierPromptSha256(system) &&
    cassette.classifier.temperature === classifyTemperatureFor(model)
  );
}

/**
 * The cassette with a new classification and everything else exactly as
 * recorded.
 *
 * Re-classifying is a question about the classifier alone, so the extraction,
 * its cost and the OCR pages are carried over untouched: re-reading them would
 * spend money on a question nobody asked, and let extraction noise move the
 * field scores of a change that did not touch extraction.
 */
export function withClassification(
  cassette: Cassette,
  classification: { readonly docType: DocType; readonly confidence: number },
  stamp: ClassifierStamp,
): Cassette {
  return {
    ...cassette,
    classifiedAs: classification.docType,
    classifierConfidence: classification.confidence,
    classifier: stamp,
  };
}

export interface Cassette {
  readonly key: string;
  /** The type the document actually is — what the extraction was run against. */
  readonly docType: DocType;
  /** What the classifier answered. Differs from docType when it got it wrong. */
  readonly classifiedAs: DocType;
  readonly classifierConfidence: number;
  /** Absent on every cassette recorded before classifications were stamped. */
  readonly classifier?: ClassifierStamp;
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
  /**
   * Present when the document had no text layer of its own and was OCR'd. The
   * eval replays these pages as the text layer, so what it scores is the whole
   * pipeline — OCR included — rather than extraction in isolation.
   */
  readonly ocr?: {
    readonly provider: string;
    readonly pages: readonly OcrPage[];
    readonly blocks: readonly OcrBlock[];
    readonly credits: number;
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

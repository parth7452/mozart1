/**
 * The reader models.
 *
 * Invariant 4 is enforced here by construction: no call in this file passes a
 * `tools` parameter, so there is no tool for an instruction injected into a PDF
 * to reach for. Nothing in this module writes to the database or makes an
 * outbound call of any kind — it takes bytes and returns validated fields.
 */

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { SCHEMA_VERSION } from './field';
import { costMicros, modelFor } from './models';
import {
  DOC_TYPES,
  ExtractionError,
  ModelRefusalError,
  type Classifier,
  type ClassificationResult,
  type DocType,
  type DocumentPayload,
  type Extractor,
  type ExtractionResult,
  type ModelCallRecord,
} from './ports';
import { CLASSIFY_SYSTEM, EXTRACTION_GUIDANCE, EXTRACTION_SYSTEM, buildReadContent } from './prompt';
import { flattenExtraction } from './flatten';
import { schemaFor } from './schemas';
import { verifyQuotes } from './verify';

export interface ReaderConfig {
  /** Pass a client to share connection pooling, or let each reader build one. */
  readonly client?: Anthropic;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  /** Required when the API key is org-scoped rather than workspace-scoped. */
  readonly workspaceId?: string;
  readonly maxTokens?: number;
  readonly effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  readonly model?: string;
}

/** A client for reading untrusted documents. Never given tools. */
export function createReaderClient(config: ReaderConfig = {}): Anthropic {
  if (config.client !== undefined) return config.client;
  // An org-scoped API key must name the workspace to bill and rate-limit
  // against; a workspace-scoped key carries it already.
  const workspaceId = config.workspaceId ?? process.env.ANTHROPIC_WORKSPACE_ID;
  return new Anthropic({
    ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
    ...(workspaceId !== undefined && workspaceId !== ''
      ? { defaultHeaders: { 'anthropic-workspace-id': workspaceId } }
      : {}),
    timeout: config.timeoutMs ?? 120_000,
  });
}

const ClassificationSchema = z.object({
  doc_type: z.enum(DOC_TYPES).describe('Exactly one type from the list.'),
  confidence: z.number().describe('0..1, calibrated.'),
  rationale: z.string().describe('One short sentence: what on the page told you.'),
});

interface UsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

function usageOf(usage: UsageLike | undefined): {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
} {
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cachedTokens: usage?.cache_read_input_tokens ?? 0,
  };
}

function describeError(error: unknown): { outcome: ModelCallRecord['outcome']; detail: string } {
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return { outcome: 'timeout', detail: error.message };
  }
  if (error instanceof Anthropic.APIError) {
    return { outcome: 'error', detail: `${error.status ?? 'api'}: ${error.message}` };
  }
  return { outcome: 'error', detail: error instanceof Error ? error.message : String(error) };
}

export class ClaudeClassifier implements Classifier {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(config: ReaderConfig = {}) {
    this.client = createReaderClient(config);
    this.model = config.model ?? modelFor('classify');
  }

  async classify(document: DocumentPayload): Promise<ClassificationResult> {
    const startedAt = Date.now();
    const base = {
      purpose: 'classify',
      provider: 'anthropic',
      modelVersion: this.model,
      documentId: document.documentId,
    } as const;

    try {
      const response = await this.client.messages.parse({
        model: this.model,
        max_tokens: 1024,
        system: CLASSIFY_SYSTEM,
        messages: [
          {
            role: 'user',
            content: buildReadContent(
              document,
              `Classify this document. Filename: ${document.filename}`,
            ) as never,
          },
        ],
        output_config: { format: zodOutputFormat(ClassificationSchema) },
      });

      const usage = usageOf(response.usage);
      const call: ModelCallRecord = {
        ...base,
        ...usage,
        costMicros: costMicros(this.model, usage),
        latencyMs: Date.now() - startedAt,
        outcome: 'ok',
      };

      if (response.stop_reason === 'refusal') {
        throw new ModelRefusalError('the classifier declined this document', {
          ...call,
          outcome: 'refusal',
          detail: response.stop_details?.explanation ?? 'no explanation given',
        });
      }

      const parsed = response.parsed_output;
      if (parsed === null || parsed === undefined) {
        throw new ExtractionError('the classifier returned no parseable output', {
          ...call,
          outcome: 'schema_mismatch',
        });
      }

      return {
        docType: parsed.doc_type,
        confidence: Math.min(1, Math.max(0, parsed.confidence)),
        call,
      };
    } catch (error) {
      if (error instanceof ExtractionError) throw error;
      const { outcome, detail } = describeError(error);
      throw new ExtractionError(`classification failed: ${detail}`, {
        ...base,
        costMicros: 0,
        latencyMs: Date.now() - startedAt,
        outcome,
        detail,
      });
    }
  }
}

export class ClaudeExtractor implements Extractor {
  readonly name = 'claude-vision';
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(private readonly config: ReaderConfig = {}) {
    this.client = createReaderClient(config);
    this.model = config.model ?? modelFor('extract');
  }

  async extract(document: DocumentPayload, docType: DocType): Promise<ExtractionResult> {
    const startedAt = Date.now();
    const base = {
      purpose: 'extract',
      provider: 'anthropic',
      modelVersion: this.model,
      documentId: document.documentId,
    } as const;
    const schema = schemaFor(docType);

    try {
      const response = await this.client.messages.parse({
        model: this.model,
        max_tokens: this.config.maxTokens ?? 16_000,
        system: EXTRACTION_SYSTEM,
        thinking: { type: 'adaptive' },
        messages: [
          {
            role: 'user',
            content: buildReadContent(
              document,
              `This document has been classified as: ${docType}.\n\n${EXTRACTION_GUIDANCE[docType]}\n\nExtract it now. Remember: quotes verbatim, amounts as printed, null for anything absent.`,
            ) as never,
          },
        ],
        output_config: {
          format: zodOutputFormat(schema),
          effort: this.config.effort ?? 'medium',
        },
      });

      const usage = usageOf(response.usage);
      const call: ModelCallRecord = {
        ...base,
        ...usage,
        costMicros: costMicros(this.model, usage),
        latencyMs: Date.now() - startedAt,
        outcome: 'ok',
      };

      if (response.stop_reason === 'refusal') {
        throw new ModelRefusalError('the extractor declined this document', {
          ...call,
          outcome: 'refusal',
          detail: response.stop_details?.explanation ?? 'no explanation given',
        });
      }
      if (response.stop_reason === 'max_tokens') {
        throw new ExtractionError(
          'the extraction was cut off by max_tokens: split the document and retry',
          { ...call, outcome: 'schema_mismatch', detail: 'stop_reason=max_tokens' },
        );
      }

      const parsed: unknown = response.parsed_output;
      if (parsed === null || parsed === undefined) {
        throw new ExtractionError('the extractor returned no parseable output', {
          ...call,
          outcome: 'schema_mismatch',
        });
      }

      return buildExtractionResult({
        docType,
        extractor: this.name,
        document: parsed,
        pageText: document.pageText,
        call,
      });
    } catch (error) {
      if (error instanceof ExtractionError) throw error;
      const { outcome, detail } = describeError(error);
      throw new ExtractionError(`extraction failed: ${detail}`, {
        ...base,
        costMicros: 0,
        latencyMs: Date.now() - startedAt,
        outcome,
        detail,
      });
    }
  }
}

/**
 * Turns a validated document object into a result: flatten to fields, then check
 * every quote against the page it cites. Shared by the live extractor and the
 * cassette replay so evals score exactly what production would produce.
 */
export function buildExtractionResult(input: {
  docType: DocType;
  extractor: string;
  document: unknown;
  pageText: readonly string[] | undefined;
  call: ModelCallRecord;
}): ExtractionResult {
  const fields = verifyQuotes(flattenExtraction(input.document), input.pageText);
  return {
    docType: input.docType,
    schemaVersion: SCHEMA_VERSION,
    extractor: input.extractor,
    fields,
    document: input.document,
    call: input.call,
  };
}

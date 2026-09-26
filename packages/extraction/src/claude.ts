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
import { classifyTemperatureFor, costMicros, modelFor } from './models';
import {
  DOC_TYPES,
  ExtractionError,
  ModelRefusalError,
  type Classifier,
  type ClassificationResult,
  type DocType,
  type DocumentPayload,
  type ExtractedField,
  type Extractor,
  type ExtractionResult,
  type ModelCallRecord,
} from './ports';
import { CLASSIFY_SYSTEM, EXTRACTION_GUIDANCE, EXTRACTION_SYSTEM, buildReadContent } from './prompt';
import { flattenExtraction } from './flatten';
import { describeFields, renderFieldList } from './paths';
import { schemaFor } from './schemas';
import { verifyQuotes } from './verify';
import { WireExtractionSchema, reassemble, type ReassemblyIssue } from './wire';
import {
  PAGING_POLICY,
  chunkInstruction,
  halveRange,
  mergeChunkFields,
  pageable,
  planPageChunks,
  rangeLabel,
  repeatingGroupsOf,
  type ChunkReading,
  type PageRange,
  type PagingPolicy,
} from './paging';

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
  /**
   * How a read that ran out of budget is re-asked in page ranges (ADR 0053),
   * or `false` to fail it as before. Defaults to `PAGING_POLICY`.
   */
  readonly paging?: Partial<PagingPolicy> | false;
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
  cache_creation_input_tokens?: number | null;
}

/**
 * Tokens as `model_calls` counts them. The API's `input_tokens` is only the
 * part of the prompt read at full price; cache reads and writes are reported
 * beside it. `inputTokens` is the whole prompt and `cachedTokens` the part read
 * from the cache, which is what `costMicros` expects. A call with no cache
 * marker reports zero for both, so its record is what it always was.
 */
function usageOf(usage: UsageLike | undefined): {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
} {
  const cacheRead = usage?.cache_read_input_tokens ?? 0;
  return {
    inputTokens: (usage?.input_tokens ?? 0) + cacheRead + cacheWritesOf(usage),
    outputTokens: usage?.output_tokens ?? 0,
    cachedTokens: cacheRead,
  };
}

/** Prompt tokens this call wrote to the cache, priced above plain input. */
function cacheWritesOf(usage: UsageLike | undefined): number {
  return usage?.cache_creation_input_tokens ?? 0;
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
      const temperature = classifyTemperatureFor(this.model);
      const response = await this.client.messages.parse({
        model: this.model,
        max_tokens: 1024,
        // Pinned where the model takes it (`classifyTemperatureFor`): a doc
        // type decides whether and how a case opens, so one page should get
        // one answer.
        ...(temperature !== null ? { temperature } : {}),
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

/**
 * What the extractor is told about a document type: its guidance and its field
 * list. With `EXTRACTION_SYSTEM` it is everything a schema or wording change
 * alters, which is why a cassette's extractor stamp hashes the two together.
 */
export function extractionInstruction(docType: DocType): string {
  return [
    `This document has been classified as: ${docType}.`,
    EXTRACTION_GUIDANCE[docType],
    '',
    'Return one entry in `fields` for each of these that the document carries, using the path exactly as written. Leave out anything the document does not carry.',
    '',
    renderFieldList(describeFields(schemaFor(docType))),
    '',
    'Quotes verbatim, amounts exactly as printed, nothing invented.',
  ].join('\n');
}

export class ClaudeExtractor implements Extractor {
  readonly name = 'claude-vision';
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly paging: PagingPolicy | false;

  constructor(private readonly config: ReaderConfig = {}) {
    this.client = createReaderClient(config);
    this.model = config.model ?? modelFor('extract');
    this.paging =
      config.paging === false ? false : { ...PAGING_POLICY, ...(config.paging ?? {}) };
  }

  /**
   * One streamed extraction call. Every call a read makes goes through here,
   * so none of them can be given `tools` (invariant 4): the parameter is not in
   * this request, and nothing a caller passes can put it there.
   */
  private async request(content: Array<Record<string, unknown>>) {
    // Streamed, and given real headroom. A dense remittance measured 10,794
    // output tokens for 42 rows — roughly 250 a row — so a 60-row advice would
    // have run into a 16,000-token ceiling, and a non-streaming request that
    // large risks the HTTP timeout before it risks the ceiling.
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: this.config.maxTokens ?? 32_000,
      system: EXTRACTION_SYSTEM,
      thinking: { type: 'adaptive' },
      messages: [{ role: 'user', content: content as never }],
      output_config: {
        format: zodOutputFormat(WireExtractionSchema),
        effort: this.config.effort ?? 'medium',
      },
    });
    // The SDK parses the structured output when the message stops, and a reply
    // cut off at `max_tokens` is unterminated JSON: `finalMessage` then throws
    // "Failed to parse structured output" before any `stop_reason` can be read,
    // and the read was recorded as an `error` costing nothing. The snapshot the
    // stream builds says why it stopped and what it used, so a reply that
    // stopped at the budget or was refused is answered from it, with no parsed
    // output, and every other failure is thrown as it was.
    let snapshot: Anthropic.Message | undefined;
    stream.on('streamEvent', (_event, message) => {
      snapshot = message;
    });
    try {
      return await stream.finalMessage();
    } catch (error) {
      const stopped = snapshot?.stop_reason;
      if (snapshot !== undefined && (stopped === 'max_tokens' || stopped === 'refusal')) {
        return { ...snapshot, parsed_output: null };
      }
      throw error;
    }
  }

  /** The blocks every call of a read shares: document, text layer, instruction. */
  private readContent(document: DocumentPayload, docType: DocType) {
    return buildReadContent(
      document,
      extractionInstruction(docType),
      // An OCR transcription is withheld here on purpose: the model
      // anchors on it and inherits its character errors. It still backs
      // the quote check and the boxes (ADR 0009).
      { includeTextLayer: document.pageTextSource !== 'ocr' },
    );
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
    const descriptors = describeFields(schema);

    try {
      const response = await this.request(this.readContent(document, docType));

      const usage = usageOf(response.usage);
      const call: ModelCallRecord = {
        ...base,
        ...usage,
        costMicros: costMicros(this.model, {
          ...usage,
          cacheWriteTokens: cacheWritesOf(response.usage),
        }),
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
        if (this.paging !== false && pageable(document, descriptors)) {
          // Too many rows for one reply: ask for them a page range at a time
          // over the same document (ADR 0053). Only a read that would
          // otherwise fail here takes this path.
          return await this.readInPages(document, docType, {
            startedAt,
            first: call,
            policy: this.paging,
          });
        }
        // The backstop, not the plan: a document dense enough to exhaust even a
        // 32,000-token budget, which cannot be read in page ranges, needs
        // splitting, and failing loudly here is what stops a truncated read
        // being stored as a complete one.
        throw new ExtractionError(
          `the extraction was cut off at ${usage.outputTokens} output tokens: split the document and retry`,
          { ...call, outcome: 'schema_mismatch', detail: 'stop_reason=max_tokens' },
        );
      }

      const parsed = response.parsed_output;
      if (parsed === null || parsed === undefined) {
        throw new ExtractionError('the extractor returned no parseable output', {
          ...call,
          outcome: 'schema_mismatch',
        });
      }

      const rebuilt = reassemble(parsed.fields, descriptors, schema);
      return buildExtractionResult({
        docType,
        extractor: this.name,
        document: rebuilt.document,
        validated: rebuilt.validated,
        issues: rebuilt.issues,
        pageText: document.pageText,
        // A document that did not satisfy its schema is recorded as such: the
        // fields are still evidence, but nothing downstream may treat it as typed.
        call: rebuilt.validated ? call : { ...call, outcome: 'schema_mismatch',
          detail: rebuilt.issues.map((i) => `${i.path}: ${i.problem}`).join('; ').slice(0, 500) },
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

  /**
   * The paged read (ADR 0053): the same document asked for page range by page
   * range, in waves of `policy.concurrency`, a part that runs out of budget
   * halved into the next wave, at most `policy.maxCalls` calls in all. The
   * replies are joined by `mergeChunkFields` and then take exactly the path a
   * single reply takes. What was spent is summed into one call record, on
   * success and on every failure alike.
   */
  private async readInPages(
    document: DocumentPayload,
    docType: DocType,
    input: { startedAt: number; first: ModelCallRecord; policy: PagingPolicy },
  ): Promise<ExtractionResult> {
    const { startedAt, first, policy } = input;
    const schema = schemaFor(docType);
    const descriptors = describeFields(schema);
    const groups = repeatingGroupsOf(descriptors);
    const pageCount = document.pageText?.length ?? 0;

    // Every part shares these blocks, so the last of them carries the cache
    // marker and only the part's own range block follows it.
    const shared = this.readContent(document, docType);
    const lastShared = shared.length - 1;
    const cached = shared.map((block, index) =>
      index === lastShared ? { ...block, cache_control: { type: 'ephemeral' } } : block,
    );

    const spent = {
      calls: 1,
      inputTokens: first.inputTokens ?? 0,
      outputTokens: first.outputTokens ?? 0,
      cachedTokens: first.cachedTokens ?? 0,
      costMicros: first.costMicros,
    };
    const asked: PageRange[] = [];
    const halved: string[] = [];
    const readings: ChunkReading[] = [];
    const record = (outcome: ModelCallRecord['outcome'], detail: string): ModelCallRecord => ({
      purpose: 'extract',
      provider: 'anthropic',
      modelVersion: this.model,
      documentId: document.documentId,
      inputTokens: spent.inputTokens,
      outputTokens: spent.outputTokens,
      cachedTokens: spent.cachedTokens,
      costMicros: spent.costMicros,
      latencyMs: Date.now() - startedAt,
      outcome,
      detail: detail.slice(0, PAGED_DETAIL_LIMIT),
    });
    const pagedHow = () =>
      `paged after stop_reason=max_tokens at ${first.outputTokens ?? 0} output tokens: ` +
      `${spent.calls} calls, pages ${asked.map(rangeLabel).join(',')}` +
      (halved.length > 0 ? `; halved ${halved.join(', ')}` : '');

    let wave = planPageChunks(pageCount, policy.pagesPerChunk);
    while (wave.length > 0) {
      if (spent.calls + wave.length > policy.maxCalls) {
        throw new ExtractionError(
          `a paged read of ${pageCount} pages would need more than ${policy.maxCalls} calls: ` +
            'split the document and retry',
          record(
            'schema_mismatch',
            `${pagedHow()}; refused ${wave.length} more parts past the ${policy.maxCalls}-call cap`,
          ),
        );
      }
      const next: PageRange[] = [];
      const failures: PartFailure[] = [];
      for (let at = 0; at < wave.length; at += policy.concurrency) {
        const batch = wave.slice(at, at + policy.concurrency);
        spent.calls += batch.length;
        asked.push(...batch);
        const settled = await Promise.allSettled(
          batch.map((range) =>
            this.request([
              ...cached,
              { type: 'text', text: chunkInstruction({ range, pageCount, groups }) },
            ]),
          ),
        );
        settled.forEach((outcome, index) => {
          const range = batch[index] as PageRange;
          if (outcome.status === 'rejected') {
            failures.push({ kind: 'error', range, error: outcome.reason });
            return;
          }
          const response = outcome.value;
          const usage = usageOf(response.usage);
          spent.inputTokens += usage.inputTokens;
          spent.outputTokens += usage.outputTokens;
          spent.cachedTokens += usage.cachedTokens;
          spent.costMicros += costMicros(this.model, {
            ...usage,
            cacheWriteTokens: cacheWritesOf(response.usage),
          });
          if (response.stop_reason === 'refusal') {
            failures.push({ kind: 'refused', range });
            return;
          }
          if (response.stop_reason === 'max_tokens') {
            const halves = halveRange(range);
            if (halves === undefined) {
              failures.push({ kind: 'cut_off', range, outputTokens: usage.outputTokens });
              return;
            }
            halved.push(`${rangeLabel(range)}→${halves.map(rangeLabel).join('+')}`);
            next.push(...halves);
            return;
          }
          const parsed = response.parsed_output;
          if (parsed === null || parsed === undefined) {
            failures.push({ kind: 'unparseable', range });
            return;
          }
          readings.push({ range, fields: parsed.fields });
        });
        // Stop spending at the first batch with a part that failed.
        const failure = failures[0];
        if (failure !== undefined) throw this.partFailed(failure, record, pagedHow());
      }
      wave = next;
    }

    const merge = mergeChunkFields(readings, descriptors);
    const rebuilt = reassemble(merge.fields, descriptors, schema);
    const detail = [
      pagedHow(),
      `rows kept ${merge.kept.join(', ')}`,
      ...(merge.issues.length > 0
        ? [`merge dropped ${merge.issues.map((i) => i.path).join(', ')}`]
        : []),
      ...(merge.identicalAtBoundary.length > 0
        ? [
            'identical rows either side of a part boundary, both kept: ' +
              merge.identicalAtBoundary.join(', '),
          ]
        : []),
      // As a single read records it: a document that did not satisfy its
      // schema says which paths did not.
      ...(rebuilt.validated
        ? []
        : [rebuilt.issues.map((i) => `${i.path}: ${i.problem}`).join('; ')]),
    ].join('; ');
    return buildExtractionResult({
      docType,
      extractor: this.name,
      document: rebuilt.document,
      validated: rebuilt.validated,
      issues: [...merge.issues, ...rebuilt.issues],
      pageText: document.pageText,
      call: record(rebuilt.validated ? 'ok' : 'schema_mismatch', detail),
    });
  }

  /** The error a failed part ends the read with, carrying everything spent. */
  private partFailed(
    failure: PartFailure,
    record: (outcome: ModelCallRecord['outcome'], detail: string) => ModelCallRecord,
    how: string,
  ): ExtractionError {
    const pages = rangeLabel(failure.range);
    switch (failure.kind) {
      case 'refused':
        return new ModelRefusalError(
          `the extractor declined pages ${pages} of this document`,
          record('refusal', `${how}; refused on pages ${pages}`),
        );
      case 'cut_off':
        return new ExtractionError(
          `page ${pages} alone was cut off at ${failure.outputTokens} output tokens: ` +
            'split the document and retry',
          record('schema_mismatch', `${how}; stop_reason=max_tokens on page ${pages} alone`),
        );
      case 'unparseable':
        return new ExtractionError(
          `the extractor returned no parseable output for pages ${pages}`,
          record('schema_mismatch', `${how}; no parseable output on pages ${pages}`),
        );
      case 'error': {
        const { outcome, detail } = describeError(failure.error);
        return new ExtractionError(
          `extraction failed on pages ${pages}: ${detail}`,
          record(outcome, `${how}; pages ${pages}: ${detail}`),
        );
      }
    }
  }
}

/** How long a paged read's `detail` may run: ranges and paths, never page text. */
const PAGED_DETAIL_LIMIT = 1_000;

/** Why a part of a paged read did not come back as rows. */
type PartFailure =
  | { readonly kind: 'refused'; readonly range: PageRange }
  | { readonly kind: 'cut_off'; readonly range: PageRange; readonly outputTokens: number }
  | { readonly kind: 'unparseable'; readonly range: PageRange }
  | { readonly kind: 'error'; readonly range: PageRange; readonly error: unknown };

/**
 * Turns a validated document object into a result: flatten to fields, then check
 * every quote against the page it cites. Shared by the live extractor and the
 * cassette replay so evals score exactly what production would produce.
 *
 * A field `verifyQuotes` moved off a page past the end of the text layer is named
 * on the call's `detail`, with the page the model cited and the page that
 * holds the quote. That call is the `model_calls` row for this read, so the
 * model's own citation outlives the read even though `extraction_results`
 * stores the page the quote is actually on.
 */
export function buildExtractionResult(input: {
  docType: DocType;
  extractor: string;
  document: unknown;
  pageText: readonly string[] | undefined;
  call: ModelCallRecord;
  validated?: boolean;
  issues?: readonly ReassemblyIssue[];
}): ExtractionResult {
  const fields = verifyQuotes(flattenExtraction(input.document), input.pageText);
  const moved = citedPagesMissing(fields, input.pageText?.length ?? 0);
  const detail = [input.call.detail, moved].filter((part) => part !== undefined).join('; ');
  return {
    docType: input.docType,
    schemaVersion: SCHEMA_VERSION,
    extractor: input.extractor,
    fields,
    document: input.document,
    validated: input.validated ?? true,
    issues: input.issues ?? [],
    call: detail === '' ? input.call : { ...input.call, detail },
  };
}

/** How many moved fields a call's `detail` names before it counts the rest. */
const MOVED_FIELDS_NAMED = 8;

/**
 * The fields cited to a page past the text layer's end and found on one in it, as
 * schema paths and page numbers — nothing off the page. Undefined when none.
 */
function citedPagesMissing(
  fields: readonly ExtractedField[],
  pages: number,
): string | undefined {
  const moved = fields.filter((field) => field.citedPage !== undefined);
  if (moved.length === 0) return undefined;
  const named = moved
    .slice(0, MOVED_FIELDS_NAMED)
    .map((field) => `${field.fieldPath} p${field.citedPage}→p${field.sourcePage}`);
  const rest = moved.length - named.length;
  return (
    `cited a page past the last page of the ${pages}-page text layer; each quote found on one page only: ` +
    named.join(', ') +
    (rest > 0 ? `, and ${rest} more` : '')
  );
}

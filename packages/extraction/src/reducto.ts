/**
 * Reducto, as the OCR and layout provider (ADR 0009).
 *
 * Two calls: upload the bytes, then parse. The parse returns markdown-ish
 * content per chunk and laid-out blocks carrying normalised boxes and a
 * per-block confidence, which is what lets a scan's extracted fields be both
 * verified and pointed at.
 */

import { costMicros } from './models';
import { OcrError, type OcrBlock, type OcrPage, type OcrProvider, type OcrResult } from './ocr';
import type { DocumentPayload, ModelCallRecord } from './ports';

export interface ReductoConfig {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** Injected in tests so no network is touched. */
  readonly fetchImpl?: typeof fetch;
}

interface ReductoBbox {
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  page?: number;
}

interface ReductoBlock {
  type?: string;
  content?: string;
  bbox?: ReductoBbox;
  confidence?: string;
  granular_confidence?: { parse_confidence?: number | null } | null;
}

interface ReductoParseResponse {
  job_id?: string;
  duration?: number;
  usage?: { num_pages?: number; credits?: number };
  result?: {
    chunks?: Array<{ content?: string; blocks?: ReductoBlock[] }>;
  };
}

/** Reducto reports a word, we keep a number; both are recorded. */
function confidenceOf(block: ReductoBlock): number | null {
  const granular = block.granular_confidence?.parse_confidence;
  if (typeof granular === 'number' && Number.isFinite(granular)) return granular;
  switch (block.confidence) {
    case 'high':
      return 0.9;
    case 'medium':
      return 0.6;
    case 'low':
      return 0.3;
    default:
      return null;
  }
}

function toBbox(bbox: ReductoBbox | undefined): readonly [number, number, number, number] | undefined {
  if (bbox === undefined) return undefined;
  const { left, top, width, height } = bbox;
  if ([left, top, width, height].some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
    return undefined;
  }
  const x0 = Math.min(1, Math.max(0, left as number));
  const y0 = Math.min(1, Math.max(0, top as number));
  const x1 = Math.min(1, Math.max(0, (left as number) + (width as number)));
  const y1 = Math.min(1, Math.max(0, (top as number) + (height as number)));
  if (x1 < x0 || y1 < y0) return undefined;
  return [x0, y0, x1, y1];
}

export class ReductoOcr implements OcrProvider {
  readonly name = 'reducto';
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: ReductoConfig = {}) {
    const key = config.apiKey ?? process.env.REDUCTO_API_KEY;
    if (key === undefined || key === '') {
      throw new Error('REDUCTO_API_KEY is not set: construct no OCR provider rather than a broken one');
    }
    this.apiKey = key;
    this.baseUrl = config.baseUrl ?? 'https://platform.reducto.ai';
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async ocr(document: DocumentPayload): Promise<OcrResult> {
    const startedAt = Date.now();
    const base = {
      purpose: 'extract',
      provider: 'reducto',
      modelVersion: 'reducto-parse',
      documentId: document.documentId,
    } as const;

    try {
      const fileId = await this.upload(document);
      const parsed = await this.parse(fileId);

      const blocks: OcrBlock[] = [];
      const pageText = new Map<number, string[]>();

      for (const chunk of parsed.result?.chunks ?? []) {
        for (const block of chunk.blocks ?? []) {
          const bbox = toBbox(block.bbox);
          const page = block.bbox?.page ?? 1;
          const text = (block.content ?? '').trim();
          if (text === '') continue;
          if (bbox !== undefined) {
            blocks.push({
              text,
              page,
              bbox,
              kind: block.type ?? 'unknown',
              confidence: confidenceOf(block),
            });
          }
          pageText.set(page, [...(pageText.get(page) ?? []), text]);
        }
      }

      const pages: OcrPage[] = [...pageText.entries()]
        .sort(([a], [b]) => a - b)
        .map(([page, parts]) => ({ page, text: parts.join('\n') }));

      // Reducto bills credits, not tokens. Recorded as cost so a scanned case's
      // true cost is visible next to the model spend; the unit is credits.
      const credits = parsed.usage?.credits ?? 0;
      const call: ModelCallRecord = {
        ...base,
        costMicros: Math.round(credits * 1_000),
        latencyMs: Date.now() - startedAt,
        outcome: 'ok',
        detail: `${credits} credits, ${parsed.usage?.num_pages ?? pages.length} page(s), job ${parsed.job_id ?? 'unknown'}`,
      };

      return { pages, blocks, provider: this.name, call };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new OcrError(`reducto ocr failed: ${detail}`, {
        ...base,
        costMicros: 0,
        latencyMs: Date.now() - startedAt,
        outcome: detail.includes('timed out') ? 'timeout' : 'error',
        detail,
      });
    }
  }

  private async upload(document: DocumentPayload): Promise<string> {
    const form = new FormData();
    const bytes = Buffer.from(document.base64, 'base64');
    form.append(
      'file',
      new Blob([new Uint8Array(bytes)], { type: document.mimeType }),
      document.filename,
    );

    const response = await this.call('/upload', { method: 'POST', body: form });
    const json = (await response.json()) as { file_id?: string };
    if (json.file_id === undefined) throw new Error('upload returned no file_id');
    return json.file_id;
  }

  private async parse(fileId: string): Promise<ReductoParseResponse> {
    const response = await this.call('/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ document_url: fileId }),
    });
    return (await response.json()) as ReductoParseResponse;
  }

  private async call(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 180_000);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: { Authorization: `Bearer ${this.apiKey}`, ...(init.headers ?? {}) },
      });
      if (!response.ok) {
        throw new Error(`${path} returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
      }
      return response;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`${path} timed out`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Constructs the provider only when one is configured. Never a broken one. */
export function ocrFromEnv(env: NodeJS.ProcessEnv = process.env): OcrProvider | undefined {
  const key = env.REDUCTO_API_KEY;
  if (key === undefined || key === '') return undefined;
  return new ReductoOcr({ apiKey: key });
}

export { costMicros };

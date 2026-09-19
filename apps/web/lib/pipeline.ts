import { ClaudeClassifier, ClaudeExtractor, ReductoOcr } from '@recouple/extraction';
import { scannerFromEnv } from '@recouple/ingest';
import type { PipelineDeps } from '@recouple/pipeline';

/**
 * The real pipeline, assembled from configuration.
 *
 * Two of these are deliberately fail-closed rather than fail-soft:
 *
 * - **No scanner configured means `NullScanner`**, which reports an error and
 *   not a clean bill of health. The gate then refuses to read the file. An
 *   environment with no ClamAV cannot ingest, which is the correct answer to
 *   "should we read an unscanned file from a stranger" (invariant 4).
 * - **No Reducto key means no OCR provider at all**, rather than one that
 *   throws on use. A document with a text layer is unaffected; a scan comes back
 *   with its quotes unverifiable and says so, which is a worse answer than
 *   OCR and a much better one than a silent guess (ADR 0009).
 *
 * Which scanner an environment gets is `scannerFromEnv`'s decision, not this
 * file's — a hosted `HttpScanner` when `CLAMAV_SCAN_URL` is set, clamd over TCP
 * when `CLAMAV_HOST` is, `NullScanner` otherwise. Deciding it twice is how the
 * two answers drift (ADR 0018).
 */
export function pipelineDepsFor(store: PipelineDeps['store']): PipelineDeps {
  const scanner = scannerFromEnv();

  const ocr =
    process.env.REDUCTO_API_KEY === undefined || process.env.REDUCTO_API_KEY === ''
      ? undefined
      : new ReductoOcr();

  return {
    store,
    scanner,
    classifier: new ClaudeClassifier(),
    extractor: new ClaudeExtractor(),
    ...(ocr !== undefined ? { ocr } : {}),
    now: () => new Date(),
  };
}

/** Roles that may add a document. `read_only` and `accountant_guest` may not. */
const WRITERS = new Set(['owner', 'approver', 'analyst']);

export function mayWrite(role: string): boolean {
  return WRITERS.has(role);
}

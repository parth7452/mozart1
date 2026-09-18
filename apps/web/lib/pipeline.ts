import { ClaudeClassifier, ClaudeExtractor, ReductoOcr } from '@recouple/extraction';
import { ClamAvScanner, NullScanner } from '@recouple/ingest';
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
 */
export function pipelineDepsFor(store: PipelineDeps['store']): PipelineDeps {
  const clamHost = process.env.CLAMAV_HOST;
  const scanner =
    clamHost === undefined || clamHost === ''
      ? new NullScanner()
      : new ClamAvScanner({ host: clamHost, port: Number(process.env.CLAMAV_PORT ?? 3310) });

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

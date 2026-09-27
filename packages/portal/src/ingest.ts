// Captures into the existing ingest (ADR 0057 §9): every capture is a
// `portal_fetch` arrival with no member behind it. A page snapshot goes through
// acceptPortalSnapshot as text/html; a download through the ordinary door by
// its magic bytes. A refused capture throws; nothing here swallows it.
import { ingestDocument, type IngestResult, type PipelineDeps } from '@recouple/pipeline';
import type { Capture } from './capture';

export async function ingestCaptures(
  captures: Capture[],
  orgId: string,
  deps: Pick<PipelineDeps, 'store' | 'scanner'>,
): Promise<IngestResult[]> {
  const results: IngestResult[] = [];
  for (const capture of captures) {
    results.push(
      await ingestDocument(
        {
          orgId,
          filename: capture.filename,
          bytes: capture.bytes,
          ...(capture.kind === 'page_snapshot' ? { declaredMimeType: 'text/html' } : {}),
          source: 'portal_fetch',
        },
        deps,
      ),
    );
  }
  return results;
}

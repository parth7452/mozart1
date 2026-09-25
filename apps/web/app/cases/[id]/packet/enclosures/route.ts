import { CaseNotVisibleError } from '@recouple/pipeline';
import { requireSession } from '../../../../../lib/session';
import { isUuid } from '../../../../../lib/request';
import { caseNotFound, workflowStoreFor } from '../../../../../lib/workflow';
import { zipEnclosures } from '../../../../../lib/enclosures-zip';

/**
 * Every document the packet encloses, as one zip, streamed.
 *
 * Exactly the packet's own `file_document_ids`, in its order — the packet the
 * case page shows, which is the approved one once there is an approval — and
 * nothing else the case holds. Each document is read through `getDocument`,
 * as `app_rw` with this session's claims, one at a time as the zip is written,
 * so a document another tenant owns is absent here as it is everywhere
 * (ADR 0014), and the response is never buffered whole (`lib/enclosures-zip`).
 *
 * Any member may download it, `read_only` included: it is a read, like the
 * documents it is made of.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  if (!isUuid(id)) return caseNotFound();

  const session = await requireSession();
  const store = workflowStoreFor(session);
  let streaming = false;
  try {
    const workflow = await store.getWorkflow(id);
    const packet = workflow?.packet;
    // No packet and no case look the same on purpose, as on the letter route.
    if (packet === undefined) return caseNotFound();

    const body = zipEnclosures(
      packet.fileDocumentIds,
      async (documentId) => {
        try {
          return await store.getDocument(documentId);
        } catch (cause) {
          // Ids and a class name only: never a filename or anything read off a
          // page. The download fails rather than arriving short.
          console.error('packet enclosures: read failed', {
            deductionId: id,
            documentId,
            error: cause instanceof Error ? cause.name : typeof cause,
          });
          throw cause;
        }
      },
      () => store.close(),
    );
    streaming = true;
    return new Response(body, {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="enclosures-${id.slice(0, 8)}.zip"`,
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (cause) {
    if (cause instanceof CaseNotVisibleError) return caseNotFound();
    throw cause;
  } finally {
    // Once the body is streaming, the stream closes the store when it ends.
    if (!streaming) await store.close();
  }
}

import { CaseNotVisibleError, type ServingRefusal } from '@recouple/pipeline';
import { requireSession } from '../../../../../lib/session';
import { isUuid } from '../../../../../lib/request';
import { caseNotFound, workflowStoreFor } from '../../../../../lib/workflow';
import { zipEnclosures } from '../../../../../lib/enclosures-zip';
import { refusedDocument } from '../../../../../lib/serve-document';

/**
 * Every document the packet encloses, as one zip, streamed.
 *
 * Exactly the packet's own `file_document_ids`, in its order — the packet the
 * case page shows, which is the approved one once there is an approval — and
 * nothing else the case holds. Each document is read through
 * `servableDocument`, as `app_rw` with this session's claims, one at a time as
 * the zip is written,
 * so a document another tenant owns is absent here as it is everywhere
 * (ADR 0014), and the response is never buffered whole (`lib/enclosures-zip`).
 *
 * Any member may download it, `read_only` included: it is a read, like the
 * documents it is made of.
 *
 * **Only documents that scanned clean**, as `/api/document` serves them
 * (`servingRefusal`). Every enclosure is asked before the first byte is
 * written — one query for the whole packet (`documentsServing`) — so a packet
 * holding one the scan refused is a 409 saying so rather than a zip with that
 * file inside it, or a download that fails half-way; and each is asked again
 * in the transaction that reads its bytes (`servableDocument`), so a verdict
 * recorded in between still stops it. The zip is the whole packet or nothing: leaving the file out would
 * send something other than what was approved.
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

    const verdicts = await store.documentsServing(packet.fileDocumentIds);
    for (const documentId of packet.fileDocumentIds) {
      const serving = verdicts.get(documentId);
      // A document the packet names and this tenant cannot see is left to the
      // stream, which fails the download rather than leaving it out.
      if (serving?.refusal !== undefined) {
        console.warn('packet enclosures: refused', {
          deductionId: id,
          documentId,
          refusal: serving.refusal,
        });
        return refusedDocument(serving.refusal);
      }
    }

    const body = zipEnclosures(
      packet.fileDocumentIds,
      async (documentId) => {
        try {
          const served = await store.servableDocument(documentId);
          if (served?.refusal !== undefined) {
            throw new EnclosureRefusedError(documentId, served.refusal);
          }
          return served?.document;
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

/** An enclosure whose verdict changed between the check and its read. Ids only. */
class EnclosureRefusedError extends Error {
  override readonly name = 'EnclosureRefusedError';
  constructor(documentId: string, refusal: ServingRefusal) {
    super(`packet encloses document ${documentId}, which is not served (${refusal})`);
  }
}

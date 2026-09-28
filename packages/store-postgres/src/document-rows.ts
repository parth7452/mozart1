/**
 * The statements that store a new document, each on a transaction the caller
 * already holds, as `app_rw` with the tenant's claims set.
 *
 * `PostgresStore` runs them one transaction per port call, as the pipeline's
 * `recordUpload` and `putDocument` ask. `PostgresPortalStore.recordNewCapture`
 * runs all of them and the capture row in one, so a portal capture's arrival,
 * its document and the row naming its run commit or fail together (ADR 0057
 * §15, ADR 0064). One copy of each statement, so the two cannot drift.
 *
 * Not exported from the package index: a caller outside this package stores a
 * document through a store.
 */

import type { PoolClient } from 'pg';
import type { IngestSource, StoredDocument } from '@recouple/pipeline';

/** One `uploads` row; returns its id. */
export async function insertUploadOn(
  client: PoolClient,
  input: { readonly orgId: string; readonly source: IngestSource; readonly createdBy?: string },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into uploads (org_id, source, created_by)
     values ($1, $2, $3)
     returning id`,
    [input.orgId, input.source, input.createdBy ?? null],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('insert into uploads returned no row');
  return id;
}

/** One `documents` row under a caller-chosen id, and its text pages. */
export async function insertDocumentOn(
  client: PoolClient,
  documentId: string,
  storageRef: string,
  document: Omit<StoredDocument, 'documentId'>,
): Promise<void> {
  const { rows } = await client.query<{ id: string }>(
    `insert into documents
       (id, org_id, sha256, byte_size, mime_type, storage_ref, filename, upload_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning id`,
    [
      documentId,
      document.orgId,
      Buffer.from(document.sha256, 'hex'),
      document.byteSize,
      document.mimeType,
      storageRef,
      document.filename,
      // Null only for a caller that stored bytes without recording an
      // arrival. `ingestDocument` always records one first; a test that
      // writes a document straight into the store is the other case, and a
      // case opened on such a document cannot be declined (see
      // `declineCase`), which is the loud version of not knowing.
      document.uploadId ?? null,
    ],
  );
  if (rows[0]?.id !== documentId) throw new Error('insert into documents returned no row');

  if (document.pageText !== undefined && document.pageText.length > 0) {
    for (const [index, text] of document.pageText.entries()) {
      await client.query(
        `insert into document_pages (org_id, document_id, page_number, text_layer)
         values ($1, $2, $3, $4)
         on conflict (document_id, page_number) do nothing`,
        [document.orgId, documentId, index + 1, text],
      );
    }
  }
}

/** A document's bytes, as its `document_blobs` row. A second put of the same document writes nothing. */
export async function insertBlobOn(
  client: PoolClient,
  orgId: string,
  documentId: string,
  bytes: Uint8Array,
): Promise<void> {
  await client.query(
    `insert into document_blobs (document_id, org_id, bytes, byte_size)
     values ($1, $2, $3, $4)
     on conflict (document_id) do nothing`,
    [documentId, orgId, Buffer.from(bytes), bytes.byteLength],
  );
}

/** What a run hands to ingest: a serialised page or a downloaded file. */
export type Capture = { kind: 'page_snapshot' | 'download'; stepName: string; filename: string; bytes: Uint8Array; mimeType: string };

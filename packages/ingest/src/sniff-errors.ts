/**
 * Why the door refused a file. A closed set: `inbound_message_parts.outcome`'s
 * check constraint (migration 0034) names every code, so a new one is a
 * migration.
 */
export type RejectionCode =
  | 'empty_file'
  | 'body_too_short'
  | 'too_large'
  | 'type_not_allowed'
  | 'content_does_not_match_type'
  | 'encrypted_pdf'
  | 'active_content_pdf'
  | 'decompression_bomb'
  | 'malformed_pdf';

export class RejectedUploadError extends Error {
  constructor(
    readonly code: RejectionCode,
    message: string,
  ) {
    super(message);
  }
}

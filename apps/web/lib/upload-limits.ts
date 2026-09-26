/**
 * How large one upload may be, in a module with no imports so the browser can
 * read the same numbers the server enforces.
 *
 * The limit is the platform's, not ours. Vercel answers any function request
 * body over 4.5 MB with 413 `FUNCTION_PAYLOAD_TOO_LARGE` before our code runs
 * (ADR 0047, context item 8), so the 25 MB this used to say was a promise a
 * 5–25 MB file met with Vercel's bare error page rather than our sentence. The
 * file limit is set so that the file plus its multipart framing stays under the
 * platform's body limit, and `test/multi-upload.test.tsx` holds that sum.
 *
 * A larger file needs somewhere to go that is not a function body —
 * direct-to-storage upload — and that is a new place unscanned bytes sit, so
 * it waits for its own ADR rather than being slipped in here.
 */

/**
 * The request body the platform delivers to a function, in bytes.
 *
 * Vercel says "4.5 MB". Read as decimal megabytes, the smaller of the two
 * readings, so the limit below is right under either.
 */
export const PLATFORM_BODY_LIMIT_BYTES = 4_500_000;

/** Multipart framing around the file itself: boundaries, headers, field names. */
export const FORM_OVERHEAD_BYTES = 64 * 1024;

/** The largest file one upload carries, as a person reads it. */
export const UPLOAD_MAX_MB = 4;
export const UPLOAD_MAX_BYTES = UPLOAD_MAX_MB * 1024 * 1024;

/**
 * What the upload forms offer in the file picker: the types the door accepts
 * (`ALLOWED_MIME_TYPES` in `@recouple/ingest`) and nothing else. The door
 * checks magic bytes whatever this says; this only stops the picker offering a
 * TIFF the door will refuse.
 */
export const UPLOAD_ACCEPT = '.pdf,.png,.jpg,.jpeg,.gif,.webp';

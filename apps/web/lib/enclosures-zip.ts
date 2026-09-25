import { Zip, ZipPassThrough } from 'fflate';

/**
 * A packet's enclosures as one zip, streamed.
 *
 * Streamed because a buffered function response is size-limited on Vercel and
 * a packet is up to 25 documents of up to 25 MB each: the zip is written a
 * document at a time as the client reads it, and no more than one document's
 * bytes are held at once. Stored rather than deflated — the enclosures are
 * PDFs and images, already compressed, and deflating them again spends the
 * function's CPU to save nothing.
 *
 * `fflate` is the zip writer: pure JavaScript, no native code and no
 * dependencies of its own, which is what a Vercel function can load.
 */

/** A document to put in the zip, as the store read it. */
export interface Enclosure {
  readonly filename: string;
  readonly bytes: Uint8Array;
}

/** The longest name, before its number, an entry is given. */
const NAME_MAX = 120;

/**
 * The name an enclosure gets inside the zip: its place in the packet, then its
 * filename with everything but letters, digits, `.`, `-`, `_` and space
 * replaced.
 *
 * The filename is untrusted — it came with somebody else's upload — so nothing
 * in it can be a path (`/`, `\`, `..` at the front), a control character or a
 * name another entry has: the number makes every entry unique and keeps the
 * packet's order when the zip is listed.
 */
export function enclosureName(index: number, filename: string): string {
  const safe = filename
    .replace(/[^\w.\- ]/g, '_')
    .replace(/^[.\s]+/, '')
    .trim()
    .slice(0, NAME_MAX)
    .trim();
  const number = String(index + 1).padStart(2, '0');
  return `${number}-${safe === '' ? 'document' : safe}`;
}

/**
 * The zip of `documentIds`, in that order, read one at a time through `read`.
 *
 * A document `read` cannot find is an error, not a gap: a packet that names a
 * document is a promise that it encloses it, and a zip that quietly left one
 * out would be sent as the whole packet. The stream errors, which the client
 * sees as a failed download rather than as a smaller file. `done` runs once,
 * however the stream ends — finished, failed or cancelled — so the caller can
 * close what it opened.
 */
export function zipEnclosures(
  documentIds: readonly string[],
  read: (documentId: string) => Promise<Enclosure | undefined>,
  done: () => Promise<void>,
): ReadableStream<Uint8Array> {
  let next = 0;
  let finished = false;
  const finish = async (): Promise<void> => {
    if (finished) return;
    finished = true;
    await done();
  };

  let zip: Zip;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      zip = new Zip((error, chunk, final) => {
        if (error !== null) {
          controller.error(error);
          return;
        }
        if (chunk.length > 0) controller.enqueue(chunk);
        if (final) controller.close();
      });
    },
    async pull(controller) {
      try {
        if (next >= documentIds.length) {
          zip.end();
          await finish();
          return;
        }
        const index = next;
        next += 1;
        const documentId = documentIds[index] as string;
        const enclosure = await read(documentId);
        if (enclosure === undefined) {
          throw new Error(`packet encloses document ${documentId}, which could not be read`);
        }
        const entry = new ZipPassThrough(enclosureName(index, enclosure.filename));
        zip.add(entry);
        entry.push(enclosure.bytes, true);
      } catch (error) {
        controller.error(error);
        await finish();
      }
    },
    async cancel() {
      zip.terminate();
      await finish();
    },
  });
}

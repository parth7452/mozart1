import type { BrowserUploadNotices, NoticeTone } from './notices';
import type { UploadAnswer } from './upload-answer';
import { UPLOAD_MAX_BYTES } from './upload-limits';

/**
 * Sending several files through `POST /upload`, one request per file, in turn.
 *
 * No React here, so the order and the refusals can be tested without a DOM.
 * Every file goes through the same route a single upload does — cross-site
 * check, session, role, magic bytes, the scan gate — so nothing the route
 * enforces is re-decided in the browser. The browser adds one refusal of its
 * own, the size, because the platform turns a larger body away before the
 * route runs and the person would otherwise see its error page.
 *
 * In turn, not in parallel: a backlog of a hundred files sent at once would be
 * a hundred concurrent reads against one tenant's budget, and a person reading
 * the results would see them land in no order at all.
 */

/** What one file came to, as shown beside its name. */
export type FileResult =
  | { readonly status: 'waiting' }
  | { readonly status: 'sending' }
  | {
      readonly status: 'answered';
      readonly tone: NoticeTone;
      readonly text: string;
      readonly caseId?: string;
    }
  /** No answer this app wrote: the batch stops here (`upload_unanswered`). */
  | { readonly status: 'unanswered'; readonly tone: 'bad'; readonly text: string }
  /** Never sent, because a file before it got no answer (`upload_not_sent`). */
  | { readonly status: 'not_sent'; readonly tone: 'bad'; readonly text: string };

/** The one network call, injected so a test can hold it and watch the order. */
export type Post = (body: FormData) => Promise<Response>;

/** The route's JSON mode, from a same-origin page. A redirect is not an answer. */
export const postUpload: Post = (body) =>
  fetch('/upload', {
    method: 'POST',
    body,
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
    // The JSON mode never redirects; a redirect is the session's, to the
    // sign-in page, and following it would read that page as an answer.
    redirect: 'manual',
  });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The route's answer, if the response is one: JSON of the `UploadAnswer`
 * shape. Anything else — an HTML error page, a login page, a body cut short —
 * is not, and is never shown as though it were.
 */
export async function answerOf(response: Response): Promise<UploadAnswer | undefined> {
  if (response.type === 'opaqueredirect' || !response.ok) return undefined;
  if (!(response.headers.get('content-type') ?? '').includes('application/json')) return undefined;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return undefined;
  }
  if (typeof body !== 'object' || body === null) return undefined;
  const { notice, about, tone, text, caseId } = body as Record<string, unknown>;
  if (typeof notice !== 'string' || typeof text !== 'string' || text === '') return undefined;
  if (tone !== 'good' && tone !== 'bad') return undefined;
  if (!Array.isArray(about) || !about.every((a) => typeof a === 'string')) return undefined;
  if (caseId !== undefined && !(typeof caseId === 'string' && UUID.test(caseId))) return undefined;
  return {
    notice: notice as UploadAnswer['notice'],
    about: about as string[],
    tone,
    text,
    ...(caseId === undefined ? {} : { caseId }),
  };
}

/** One file: refused here if it is too large to be delivered, else sent. */
export async function sendOne(
  file: File,
  attachToCase: string | undefined,
  notices: BrowserUploadNotices,
  post: Post,
): Promise<FileResult> {
  if (file.size > UPLOAD_MAX_BYTES) {
    return { status: 'answered', tone: notices.tooLarge.tone, text: notices.tooLarge.text };
  }
  const body = new FormData();
  body.set('file', file);
  if (attachToCase !== undefined) body.set('attachToCase', attachToCase);

  let response: Response;
  try {
    response = await post(body);
  } catch {
    return { status: 'unanswered', tone: 'bad', text: notices.unanswered.text };
  }
  // The platform's own refusal of a body, should one under our limit ever
  // meet it: nothing was stored, and the sentence for it is ours.
  if (response.status === 413) {
    return { status: 'answered', tone: notices.tooLarge.tone, text: notices.tooLarge.text };
  }
  const answer = await answerOf(response);
  if (answer === undefined) {
    return { status: 'unanswered', tone: 'bad', text: notices.unanswered.text };
  }
  return {
    status: 'answered',
    tone: answer.tone,
    text: answer.text,
    ...(answer.caseId === undefined ? {} : { caseId: answer.caseId }),
  };
}

/**
 * Every file, in the order chosen, each one sent only after the one before it
 * was answered. `report` is called with each file's index and result as it
 * changes. A file that gets no answer stops the batch — an expired session or
 * a platform fault will not answer the next one either, and a person should
 * look before anything more is sent — and the rest are marked not sent.
 *
 * Returns how many files got an answer, the browser's own size refusal included.
 */
export async function sendInTurn(
  files: readonly File[],
  attachToCase: string | undefined,
  notices: BrowserUploadNotices,
  post: Post,
  report: (index: number, result: FileResult) => void,
): Promise<number> {
  let answered = 0;
  for (const [index, file] of files.entries()) {
    report(index, { status: 'sending' });
    const result = await sendOne(file, attachToCase, notices, post);
    report(index, result);
    if (result.status === 'unanswered') {
      for (let rest = index + 1; rest < files.length; rest += 1) {
        report(rest, { status: 'not_sent', tone: 'bad', text: notices.notSent.text });
      }
      break;
    }
    answered += 1;
  }
  return answered;
}

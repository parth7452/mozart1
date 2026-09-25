import type { NoticeKey, NoticeTone } from './notices';

/**
 * What the route answers a caller that asked for JSON (`Accept:
 * application/json`) — the multi-file form, which sends one request per file
 * and shows each one's result beside its name.
 *
 * The same notice key and validated fragments the redirect would have carried,
 * plus the sentence they resolve to, resolved on the server so the browser needs
 * none of `lib/notices.ts` and never shows words a response did not get from it.
 * `caseId` is where the redirect would have gone, when that was a case.
 */
export interface UploadAnswer {
  readonly notice: NoticeKey;
  readonly about: readonly string[];
  readonly tone: NoticeTone;
  readonly text: string;
  readonly caseId?: string;
}

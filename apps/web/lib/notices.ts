import { CASE_STATES } from '@recouple/core-domain';
import { DOC_TYPES } from '@recouple/extraction';

/**
 * Every sentence this app is willing to say back to a reviewer, and nothing
 * else.
 *
 * A redirect is how a POST on a money path answers: the handler writes, then
 * sends the browser back to the case with what happened in the query string, so
 * a refresh does not repeat the write. The query string is a thing anybody can
 * type. Carrying the *sentence* there meant a link could make this app say
 * anything at all in its own voice — React escapes it, so it was never markup,
 * but "your session has expired, sign in at …" reads exactly like us.
 *
 * So a notice travels as a KEY, and the words live here. An unknown key renders
 * nothing: there is no fallback that shows what was in the URL.
 *
 * A handful of notices have to name something that is not known until it
 * happens — a packet's hash, the state a case turned out to be in, the claim id
 * a second notice printed. Those travel as the key plus `about`, one validated
 * fragment per `{0}`, `{1}` in the text. Validated, not escaped-and-trusted: a
 * fragment that is not the shape it claims to be renders no notice at all,
 * which is why every pattern below is a closed set or a narrow charset.
 */

/** Which tone a notice is shown in: `.notice.sent` or `.notice.bad`. */
export type NoticeTone = 'good' | 'bad';

export interface Notice {
  readonly text: string;
  readonly tone: NoticeTone;
}

/**
 * The query parameter the fragments travel in, repeated once per `{n}`.
 *
 * One name for all three notice parameters (`action`, `decline`, `upload`),
 * because one notice is shown at a time and a second set of fragments would be
 * a second notice.
 */
export const NOTICE_ABOUT_PARAM = 'about';

/**
 * Limits whose sentence is right here, so the number in the message and the
 * number the code enforces cannot drift apart. Each is a refusal, never a
 * silent truncation: a confirmation number cut to fit is a confirmation number
 * that chases nothing, and a note cut to fit is a record of something the
 * person did not write.
 */
export const NOTE_MAX_LENGTH = 2000;
export const CONFIRMATION_MAX_LENGTH = 120;
export const UPLOAD_MAX_MB = 25;
export const UPLOAD_MAX_BYTES = UPLOAD_MAX_MB * 1024 * 1024;

export const NOTICES = {
  // --- deciding to dispute -------------------------------------------------
  decide_role: { tone: 'bad', text: 'your role can review cases but not decide them' },
  decide_reason: { tone: 'bad', text: 'choose the reason this deduction is invalid' },
  decide_rationale: {
    tone: 'bad',
    text: 'say in one line why this deduction is worth disputing',
  },
  decided: {
    tone: 'good',
    text: 'recorded: this case is yours to assemble a packet for. Nothing has been sent.',
  },
  decide_declined: {
    tone: 'bad',
    text: 'this case was declined, and a declined case is not disputed — the decline stands',
  },
  decide_wrong_state: {
    tone: 'bad',
    text: 'this case is {0}, and a decision is made from a case that has been classified',
  },
  decide_rationale_too_long: {
    // Both numbers come off the store's own refusal rather than from a
    // constant read here: the store is the referee, and a message naming this
    // app's idea of the cap would be a lie the moment the two differed.
    tone: 'bad',
    text: 'that rationale is {0} characters and the cover sheet holds {1} — shorten it',
  },

  // --- assembling the packet -----------------------------------------------
  packet_role: { tone: 'bad', text: 'your role can review cases but not assemble a packet' },
  packet_no_decision: {
    tone: 'bad',
    text: 'this case has no decision to assemble a packet for',
  },
  packet_assembled: {
    tone: 'good',
    text: 'packet assembled: {0} documents under {1}. It has been sent nowhere; a second person approves it.',
  },
  packet_assembled_one: {
    tone: 'good',
    text: 'packet assembled: 1 document under {0}. It has been sent nowhere; a second person approves it.',
  },
  packet_nothing_to_send: {
    tone: 'bad',
    text: 'there is no notice on this case to send — attach the deduction notice first',
  },
  packet_after_approval: {
    tone: 'bad',
    text: 'this decision was already approved as packet {0}, so a new packet could never be approved',
  },
  packet_not_buildable: { tone: 'bad', text: 'the packet could not be built: {0}' },
  packet_not_buildable_unsaid: {
    tone: 'bad',
    text: 'the packet could not be built, and the reason given is not one this page can show — nothing was assembled',
  },
  packet_wrong_state: {
    tone: 'bad',
    text: 'this case is {0}, and a packet is assembled from a case an analyst has decided',
  },

  // --- approving ------------------------------------------------------------
  approve_role: {
    tone: 'bad',
    text: 'approving is an owner or approver’s act; your role can prepare a case but not authorise it',
  },
  approve_no_packet: { tone: 'bad', text: 'this case has no assembled packet to approve' },
  approve_note_too_long: {
    tone: 'bad',
    text: `that note is {0} characters and this field holds ${NOTE_MAX_LENGTH} — shorten it, because a note cut to fit is not the note you wrote`,
  },
  approved: {
    tone: 'good',
    text: 'approved: this packet may now be filed, and the submission you record must be this packet',
  },
  approve_is_preparer: {
    tone: 'bad',
    text: 'you prepared this decision, so you cannot approve it — a second person does that',
  },
  approve_wrong_state: {
    tone: 'bad',
    text: 'this case is {0}, and an approval is given on a case awaiting one',
  },
  approve_duplicate: {
    tone: 'bad',
    text: 'this packet was already approved; the first approval stands and is the one that counts',
  },
  approve_packet_missing: {
    tone: 'bad',
    text: 'no packet with that hash was assembled for this decision — reload the case and assemble it again',
  },
  approve_other_case: {
    tone: 'bad',
    text: 'that approval was recorded, but on a different case than the one you were looking at — the form you sent was out of date. The case it belongs to is in this list.',
  },

  // --- recording the filing -------------------------------------------------
  submit_role: { tone: 'bad', text: 'your role can review cases but not record a filing' },
  submit_no_approved_packet: { tone: 'bad', text: 'this case has no approved packet to file' },
  submit_confirmation: {
    tone: 'bad',
    text: 'record the confirmation number the portal gave back',
  },
  submit_confirmation_too_long: {
    tone: 'bad',
    text: `that confirmation number is {0} characters and a confirmation holds ${CONFIRMATION_MAX_LENGTH} — check it and paste it again, because a reference cut to fit chases nothing`,
  },
  submit_date: { tone: 'bad', text: 'give the date it was filed, as YYYY-MM-DD' },
  submitted: {
    tone: 'good',
    text: 'filed: this case is submitted, and what comes back is recorded here as an outcome',
  },
  submit_packet_mismatch: {
    tone: 'bad',
    text: 'this packet is not the one that was approved; it has to be approved again before it can be filed',
  },
  submit_duplicate: {
    tone: 'bad',
    text: 'this dispute was already filed on the retailer’s portal; the first filing stands',
  },
  submit_wrong_state: {
    tone: 'bad',
    text: 'this case is {0}, and a filing is recorded on a case that has been approved',
  },
  submit_no_approval: {
    tone: 'bad',
    text: 'this dispute has no approval, so there is nothing to file — a second person approves it first',
  },
  submit_approval_names_no_packet: {
    tone: 'bad',
    text: 'the approval on file names no packet, so it authorises nothing in particular — it has to be approved again',
  },
  submit_packet_not_for_decision: {
    tone: 'bad',
    text: 'that packet was not assembled for this decision',
  },
  submit_other_case: {
    tone: 'bad',
    text: 'that filing was recorded, but on a different case than the one you were looking at — the form you sent was out of date. The case it belongs to is in this list.',
  },

  // --- recording the outcome ------------------------------------------------
  outcome_role: { tone: 'bad', text: 'your role can review cases but not record an outcome' },
  outcome_required: { tone: 'bad', text: 'say what came back: won, partial or lost' },
  outcome_amount_unreadable: {
    tone: 'bad',
    text: 'write the recovered amount as dollars and cents, like 1,800.00 — it is stored as whole cents',
  },
  outcome_note_too_long: {
    tone: 'bad',
    text: `that note is {0} characters and this field holds ${NOTE_MAX_LENGTH} — shorten it, because a note cut to fit is not the note you wrote`,
  },
  outcome_recorded: { tone: 'good', text: 'recorded: this case is {0}' },
  outcome_amount_refused: { tone: 'bad', text: 'that amount cannot be right: {0}' },
  outcome_amount_refused_unsaid: {
    tone: 'bad',
    text: 'that amount cannot be right for what you said came back — check it against the deduction',
  },
  outcome_wrong_state: {
    tone: 'bad',
    text: 'this case is {0}, and an outcome is recorded on a case that was filed',
  },

  // --- declining ------------------------------------------------------------
  decline_role: { tone: 'bad', text: 'your role can review cases but not decide them' },
  decline_reason: { tone: 'bad', text: 'choose a reason for declining' },
  declined: { tone: 'good', text: 'recorded: this case is logged as declined, not discarded' },
  decline_already: {
    tone: 'bad',
    text: 'this case was already declined; the first decline stands',
  },

  // --- uploading ------------------------------------------------------------
  upload_role: { tone: 'bad', text: 'your role can review documents but not add them' },
  upload_too_large: { tone: 'bad', text: `that file is larger than ${UPLOAD_MAX_MB} MB` },
  upload_no_file: { tone: 'bad', text: 'choose a file first' },
  upload_queued_case: {
    tone: 'good',
    text: 'that document is being read; it will appear on this case when it is',
  },
  upload_queued_list: {
    tone: 'good',
    text: 'that document is being read; the case will appear here when it is',
  },
  upload_not_queued: {
    tone: 'bad',
    text: 'that document is stored but could not be queued for reading just now; it will be read when the queue is reachable — uploading the same file again re-queues it',
  },
  upload_not_scanned_clean: {
    tone: 'bad',
    text: 'that file did not come back clean from the scanner, so nothing in it was read. The gate fails closed: no verdict is not a pass.',
  },
  upload_already_read: {
    tone: 'bad',
    text: 'that document had already been read, so it was not read again and nothing was spent on it',
  },
  upload_read_as: {
    tone: 'good',
    text: 'read as a {0}; attach it to a case from that case’s page',
  },
  upload_read_no_case: {
    tone: 'good',
    text: 'that document was read and did not open a case; attach it to a case from that case’s page',
  },
  upload_case_gone: { tone: 'bad', text: 'that case is no longer available; nothing was uploaded' },
  upload_duplicate_case: {
    tone: 'bad',
    text: 'claim {0} is already this case; the document was read but no second case was opened',
  },
  upload_duplicate_case_unsaid: {
    tone: 'bad',
    text: 'that claim is already this case; the document was read but no second case was opened',
  },

  // One per `RejectionCode`, because the door's refusal is a closed set and its
  // message is a sentence built around a filename somebody else chose.
  upload_rejected: { tone: 'bad', text: 'that file was not accepted, and nothing was stored' },
  upload_rejected_empty_file: { tone: 'bad', text: 'that file is empty' },
  upload_rejected_body_too_short: {
    tone: 'bad',
    text: 'there is not enough in that message body to read as a notice',
  },
  upload_rejected_too_large: {
    tone: 'bad',
    text: `that file is larger than ${UPLOAD_MAX_MB} MB`,
  },
  upload_rejected_type_not_allowed: {
    tone: 'bad',
    text: 'that is not a kind of file this app accepts',
  },
  upload_rejected_content_does_not_match_type: {
    tone: 'bad',
    text: 'that file’s contents are not what its name and type say they are, so it was not stored',
  },
  upload_rejected_encrypted_pdf: {
    tone: 'bad',
    text: 'that PDF is encrypted, so nothing could be read from it',
  },
  upload_rejected_active_content_pdf: {
    tone: 'bad',
    text: 'that PDF carries active content, which this app does not open',
  },
  upload_rejected_decompression_bomb: {
    tone: 'bad',
    text: 'that file expands to far more than it claims to be, so it was not stored',
  },
  upload_rejected_malformed_pdf: {
    tone: 'bad',
    text: 'that PDF is malformed, so nothing could be read from it',
  },
  // `satisfies`, not a type annotation: the keys stay literal, so `NoticeKey`
  // is the set of them and a route that names a notice this table does not have
  // fails to compile rather than redirecting to a page that silently shows
  // nothing.
} as const satisfies Readonly<Record<string, Notice>>;

/** A key, and nothing else. Exported so a test can pin the set. */
export type NoticeKey = keyof typeof NOTICES;

const COUNT = /^[1-9][0-9]{0,6}$/;
/** The first twelve characters of a content hash, which is what a person compares. */
const SHORT_HASH = /^[0-9a-f]{12}$/;
/**
 * A claim id, as printed on somebody else's document.
 *
 * Untrusted text, so the shape is the check: it starts alphanumeric and holds
 * nothing but letters, digits, spaces and the punctuation claim ids actually
 * use. Anything else is not a claim id and the notice is not shown.
 */
const CLAIM_ID = /^[A-Za-z0-9][A-Za-z0-9 ._#/-]{0,63}$/;
/**
 * A short reason in our own words, from a named store refusal
 * (`InvalidRecoveryAmountError.reason`, `PacketNotBuildableError.detail`).
 *
 * The narrowest charset those sentences need: no angle brackets, no quotes, no
 * colon and no slash, so nothing that arrives here can read as markup, as a URL
 * or as a second sentence in somebody else's voice. A reason that does not fit
 * is not shown at all — each of these keys has a wordless twin for that.
 */
const SENTENCE = /^[A-Za-z0-9 ,.;()'’-]{1,200}$/;

function oneOf(values: readonly string[]): RegExp {
  return new RegExp(`^(${values.map((value) => value.replace(/_/g, ' ')).join('|')})$`);
}

/**
 * The fragments each key's text interpolates, in order.
 *
 * Keyed by `NoticeKey`, so a pattern for a notice that no longer exists is a
 * compile error rather than a rule nothing consults.
 */
const NOTICE_ABOUT: Readonly<Partial<Record<NoticeKey, readonly RegExp[]>>> = {
  decide_wrong_state: [oneOf(CASE_STATES)],
  decide_rationale_too_long: [COUNT, COUNT],
  packet_assembled: [COUNT, SHORT_HASH],
  packet_assembled_one: [SHORT_HASH],
  packet_after_approval: [SHORT_HASH],
  packet_not_buildable: [SENTENCE],
  packet_wrong_state: [oneOf(CASE_STATES)],
  approve_note_too_long: [COUNT],
  approve_wrong_state: [oneOf(CASE_STATES)],
  submit_confirmation_too_long: [COUNT],
  submit_wrong_state: [oneOf(CASE_STATES)],
  outcome_note_too_long: [COUNT],
  outcome_recorded: [oneOf(['won', 'partial', 'lost'])],
  outcome_amount_refused: [SENTENCE],
  outcome_wrong_state: [oneOf(CASE_STATES)],
  upload_read_as: [oneOf(DOC_TYPES)],
  upload_duplicate_case: [CLAIM_ID],
};

/**
 * The notice a key and its fragments mean, or nothing at all.
 *
 * Nothing at all for an unknown key, for the wrong number of fragments, and for
 * a fragment that is not the shape its key declares. There is deliberately no
 * halfway answer: a notice rendered with a fragment left out would be this app
 * saying a sentence it does not mean.
 */
export function resolveNotice(
  key: unknown,
  about: readonly string[] = [],
): Notice | undefined {
  if (typeof key !== 'string') return undefined;
  // `Object.hasOwn`, not `in`: `constructor` and `toString` are not notices.
  if (!Object.hasOwn(NOTICES, key)) return undefined;
  const copy: Notice = NOTICES[key as NoticeKey];

  const patterns = NOTICE_ABOUT[key as NoticeKey] ?? [];
  if (about.length !== patterns.length) return undefined;

  for (const [index, pattern] of patterns.entries()) {
    if (!pattern.test(about[index] as string)) return undefined;
  }
  // One pass, after every fragment has been checked: replacing them one at a
  // time would let an earlier fragment introduce a later placeholder.
  const text = copy.text.replace(/\{(\d)\}/g, (_, index: string) => about[Number(index)] as string);
  return { text, tone: copy.tone };
}

/**
 * The key for a rejection at the door, from `RejectedUploadError.code`.
 *
 * The code is a closed union and each member has its own sentence here. A code
 * this table does not know is a code somebody added upstream, and it gets the
 * wordless refusal rather than nothing at all — a file that was not accepted
 * must always say so.
 */
export function uploadRejectionNotice(code: unknown): NoticeKey {
  const key = `upload_rejected_${String(code)}`;
  return Object.hasOwn(NOTICES, key) ? (key as NoticeKey) : 'upload_rejected';
}

/**
 * A claim id as it was printed on somebody else's document, if it is the shape
 * of one. The caller shows the wordless notice when it is not.
 */
export function noticeClaimId(claimId: unknown): string | undefined {
  return typeof claimId === 'string' && CLAIM_ID.test(claimId) ? claimId : undefined;
}

/**
 * A sentence from a named store refusal, if it is one this app will repeat.
 *
 * The caller picks the wordless twin of its key when this says no, rather than
 * passing something through and hoping. Nothing is trimmed or rewritten to make
 * it fit: a reason that has been edited to be showable is not the reason.
 */
export function noticeSentence(reason: unknown): string | undefined {
  return typeof reason === 'string' && SENTENCE.test(reason) ? reason : undefined;
}

/** What `searchParams` hands back for a parameter that may repeat. */
export function aboutFrom(value: string | readonly string[] | undefined): readonly string[] {
  if (value === undefined) return [];
  return typeof value === 'string' ? [value] : [...value];
}

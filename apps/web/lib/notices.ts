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
 *
 * `CONFIRMATION_MAX_LENGTH` is enforced twice, deliberately. Here is where the
 * sentence a reviewer reads comes from; the database holds the same 120 as
 * `submissions_confirmation_number_length` (migration 0018, ADR 0023), because
 * a caller that is not this route can reach the column too — and since
 * migration 0017 froze it, a reference stored too long is one no update can
 * trim. Change one and change the other: the boundary is asserted at 120 and
 * 121 in `supabase/tests/13_a_filed_record_is_complete.sql`.
 */
export const NOTE_MAX_LENGTH = 2000;
export const CONFIRMATION_MAX_LENGTH = 120;
/**
 * What a decline's prose holds.
 *
 * The same number the decline form's `maxLength` carries, in one place now: the
 * route used to cut the text here instead of refusing it, so a reviewer
 * explaining a decline at length was logged as having said half of it — and the
 * counterfactual log is the one record of why a case was not fought
 * (docs/STRATEGY.md, ADD-1).
 */
export const DECLINE_DETAIL_MAX_LENGTH = 2000;
export const UPLOAD_MAX_MB = 25;
export const UPLOAD_MAX_BYTES = UPLOAD_MAX_MB * 1024 * 1024;
/**
 * How long a document may be stored and scanned and unread before the case list
 * says so.
 *
 * Long enough that a document being read right now is not called stuck — a
 * dense remittance is about a minute of model time, and a list that flagged
 * every upload for its first minute would teach a reviewer to ignore it. Short
 * enough that a read which never started is found the same session it was
 * uploaded in. It is one number because the page that asks the store and the
 * sentence that explains the answer must not be able to disagree.
 */
export const UNREAD_AFTER_MINUTES = 5;

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
    text: 'that approval was recorded, but on a different case than the one you were looking at — the form you sent was out of date. This is the case it was recorded on.',
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
    text: 'that filing was recorded, but on a different case than the one you were looking at — the form you sent was out of date. This is the case it was recorded on.',
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
  decline_detail_too_long: {
    tone: 'bad',
    text: `that note is {0} characters and this field holds ${DECLINE_DETAIL_MAX_LENGTH} — shorten it, because a decline is only ever explained once and half an explanation is not one`,
  },
  declined: { tone: 'good', text: 'recorded: this case is logged as declined, not discarded' },
  decline_already: {
    tone: 'bad',
    text: 'this case was already declined; the first decline stands',
  },
  decline_no_notice: {
    // Nothing was recorded. A decline is counted against the channel that found
    // the deduction, and a case with no notice document has nothing on it that
    // says which one that was — so the choice was between a row under a guessed
    // channel and no row at all, and a coverage number nobody can trust is
    // worse than one that is visibly incomplete (docs/STRATEGY.md, ADD-1).
    //
    // This one has something to do about it, which is why it is not the notice
    // below: attach the deduction notice and the decline goes through.
    tone: 'bad',
    text: 'this case was not declined: there is no notice document on it to say how the deduction reached us, and a decline is counted against the channel that found it. Attach the notice and decline it again. The case is untouched.',
  },
  decline_predates_provenance: {
    // The other half, and deliberately a different sentence: here the notice is
    // present and it is the *arrival* that was never recorded, because the
    // document was stored before ingest wrote one. This used to end "until a
    // migration adds a way to record its arrival", which was true when it was
    // written and stopped being true with migration 0019 (ADR 0024).
    //
    // It still does not tell the reviewer to go and do it. `documents` is
    // append-only, so nothing on this page or any other page can set
    // `upload_id`, and asserting which channel found a deduction is a decision
    // with somebody's name on it — an operator running `pnpm link:provenance`,
    // not a button. So the sentence says what is true, says that somebody can
    // unblock it, and does not pretend the reader is that somebody.
    tone: 'bad',
    text: 'this case predates provenance recording, so nothing on it says which channel found the deduction and a decline is counted against that channel. It can be recorded by an operator (ADR 0024) and the case declined afterwards. Nothing was written — the case was not declined and is untouched, and this is in the logs.',
  },

  // --- answering a possible duplicate ---------------------------------------
  //
  // Nothing here merges two cases, and every sentence says so. A verdict is a
  // record of what a person concluded about a pair the matcher refused to merge
  // (ADR 0032); a notice that implied the cases had been joined would be this
  // app claiming something it did not do on a money path.
  duplicate_role: {
    tone: 'bad',
    text: 'your role can review cases but not say whether two of them are one deduction',
  },
  duplicate_verdict: {
    tone: 'bad',
    text: 'say whether these are the same deduction or two different ones',
  },
  duplicate_confirmed: {
    tone: 'good',
    text: 'recorded: these two are one deduction. Both cases stay exactly as they are — nothing was merged, and nothing was sent anywhere.',
  },
  duplicate_dismissed: {
    tone: 'good',
    text: 'recorded: these are two different deductions, and both stay open',
  },
  duplicate_already: {
    tone: 'bad',
    text: 'this pair was already answered; the first answer stands',
  },
  duplicate_unknown_pair: {
    tone: 'bad',
    text: 'nothing names those two cases as a possible duplicate of each other — the page you answered from is out of date. Nothing was recorded.',
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
    // It used to say "the case will appear here when it is", whatever the
    // document turned out to be. The read happens in a job, after this
    // redirect, so nobody here knows yet whether it is a notice — and a
    // delivery receipt read that way opened nothing and appeared nowhere, while
    // the reviewer waited for a case that was never coming. So it says what
    // each kind of document will do, and where to find the ones that open
    // nothing.
    tone: 'good',
    text:
      'that document is being read. A deduction notice, or a remittance with a short payment, ' +
      'opens its case here within a couple of minutes; anything else — a delivery receipt, an ' +
      'invoice, a rate confirmation — is listed under “Read, not on a case”, to attach to its case',
  },
  upload_not_queued: {
    // It used to say that uploading the same file again re-queues it. That was
    // true of the bytes and false of the read: while the read function carried
    // an idempotency key on the document id, a second event for a document that
    // had stalled was swallowed for twenty-four hours, so the advice sent the
    // reviewer to do the one thing that could not work. The key is gone, and
    // the honest answer is the list below rather than a second upload.
    tone: 'bad',
    text: 'that document is stored and scanned but could not be queued for reading just now; it is listed under “Documents waiting to be read” on the case list, where it can be read again',
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
  upload_remittance_cases: {
    // A remittance that short-paid more than one line opens a case per line
    // (ADR 0028). Sending the reviewer to one of them would be a choice the
    // document did not make, so they go to the list, where all of them are.
    tone: 'good',
    text: 'read as a remittance advice; {0} short-paid lines opened or joined cases, listed below',
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

  // --- reading a document again --------------------------------------------
  //
  // The recovery path for a document that was stored, scanned clean and never
  // read. Nothing here re-uploads anything: the bytes are already in the
  // database, and what is being asked for is the read.
  reread_role: {
    tone: 'bad',
    text: 'your role can review documents but not ask for one to be read',
  },
  reread_queued: {
    tone: 'good',
    text: 'that document is queued to be read again; it leaves this list when it has been',
  },
  reread_done: {
    tone: 'good',
    text: 'that document has been read; a case it opened is in the list above',
  },
  reread_already_read: {
    tone: 'good',
    text: 'that document had already been read, so it was not read again and nothing was spent on it',
  },
  reread_being_read: {
    // Not the same thing as "already read", and saying so would be a small lie
    // in the one place a reviewer is watching for a case to appear: the read is
    // running right now, somewhere, and there is nothing recorded yet to show
    // them. The second press did not read it and did not wait for the first —
    // it holds this document's claim in the database, and a press that cannot
    // have it is answered rather than queued.
    tone: 'good',
    text: 'that document is already being read right now, so this did not start a second read; it leaves the list below when the first one finishes',
  },
  reread_not_scanned_clean: {
    tone: 'bad',
    text: 'that document has no clean scan verdict, so nothing in it was read. The gate fails closed: no verdict is not a pass.',
  },
  reread_duplicate_case: {
    // Deliberately wordless about which claim. The claim id is text off
    // somebody else's page, and the other notices that name one arrive at a
    // case page where there is somewhere to send the reviewer; this one arrives
    // at a list, where the id would be the only thing said and nothing to do
    // with it.
    tone: 'bad',
    text: 'that document was read, and the claim printed on it is already a case — no second case was opened',
  },
  reread_not_queued: {
    tone: 'bad',
    text: 'that document could not be queued just now — the queue would not take it. Nothing was lost; try again in a few minutes.',
  },
  reread_failed: {
    tone: 'bad',
    text: 'reading that document failed, and the reason is in this deployment’s logs — nothing was stored from the attempt',
  },

  // --- attaching a document that was already read -------------------------
  attach_role: {
    tone: 'bad',
    text: 'your role can review documents but not attach them to a case',
  },
  attach_choose_case: { tone: 'bad', text: 'choose the case to attach that document to' },
  attach_done: {
    tone: 'good',
    text: 'attached to this case as evidence. It was not read again, and nothing was charged.',
  },
  attach_already: {
    tone: 'good',
    text: 'this case already holds that document; nothing changed',
  },
  attach_not_read: {
    tone: 'bad',
    text: 'that document has not been read yet, so there is nothing to attach — read it first',
  },
  attach_case_gone: {
    tone: 'bad',
    text: 'that case is no longer available; nothing was attached',
  },
  attach_failed: {
    tone: 'bad',
    text: 'attaching that document failed, and nothing was attached. Try again.',
  },

  // --- QuickBooks (ADR 0039) ------------------------------------------------
  qbo_role: { tone: 'bad', text: 'only an owner can connect or disconnect QuickBooks' },
  qbo_not_configured: {
    tone: 'bad',
    text: 'QuickBooks is not set up on this deployment yet, so nothing was sent to Intuit',
  },
  qbo_wrong_host: {
    tone: 'bad',
    text: 'QuickBooks connects from this address only. Press Connect again here.',
  },
  qbo_state_invalid: {
    tone: 'bad',
    text:
      'that QuickBooks sign-in could not be matched to this session, so nothing was connected. ' +
      'It may have expired, or been started in another tab — press Connect again.',
  },
  qbo_denied: { tone: 'bad', text: 'the sign-in was cancelled at Intuit; nothing was connected' },
  qbo_exchange_failed: {
    tone: 'bad',
    text: 'Intuit did not complete the sign-in, so nothing was connected. Press Connect again.',
  },
  qbo_realm_unverified: {
    tone: 'bad',
    text: 'the sign-in could not read the QuickBooks company it named, so nothing was connected',
  },
  qbo_connected_elsewhere: {
    tone: 'bad',
    text:
      'that QuickBooks company is already connected in another workspace. It has to be ' +
      'disconnected there first; nothing was connected here.',
  },
  qbo_connect_failed: {
    tone: 'bad',
    text: 'connecting QuickBooks failed, and nothing was stored. Try again.',
  },
  qbo_connected: {
    tone: 'good',
    text:
      'QuickBooks is connected, and a first sync is on its way — short-paid invoices it finds ' +
      'will appear on the case list',
  },
  qbo_connected_no_scheduler: {
    tone: 'good',
    text:
      'QuickBooks is connected. This deployment has no scheduler, so nothing will read it until ' +
      'one is set up.',
  },
  qbo_connected_not_queued: {
    tone: 'good',
    text:
      'QuickBooks is connected, but the first sync could not be queued. The daily sync at ' +
      '07:00 UTC will pick it up.',
  },
  qbo_disconnected: {
    tone: 'good',
    text: 'QuickBooks is disconnected, and Intuit confirmed our access is revoked',
  },
  qbo_disconnected_not_revoked: {
    tone: 'bad',
    text:
      'QuickBooks is disconnected here, and nothing will read it — but Intuit did not confirm the ' +
      'revoke. To be sure, remove the app in QuickBooks under Settings → Apps.',
  },
  qbo_already_disconnected: { tone: 'good', text: 'that connection was already off; nothing changed' },
  qbo_disconnect_unknown: {
    tone: 'bad',
    text: 'that is not a connection this workspace has; nothing changed',
  },
  qbo_disconnect_failed: {
    tone: 'bad',
    text: 'disconnecting failed, and nothing changed. Try again.',
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
  decline_detail_too_long: [COUNT],
  submit_wrong_state: [oneOf(CASE_STATES)],
  outcome_note_too_long: [COUNT],
  outcome_recorded: [oneOf(['won', 'partial', 'lost'])],
  outcome_amount_refused: [SENTENCE],
  outcome_wrong_state: [oneOf(CASE_STATES)],
  upload_read_as: [oneOf(DOC_TYPES)],
  upload_remittance_cases: [COUNT],
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

import { describe, expect, it } from 'vitest';
import { CASE_STATES, MAX_RATIONALE_LENGTH } from '@recouple/core-domain';
import { DOC_TYPES } from '@recouple/extraction';
import {
  CONFIRMATION_MAX_LENGTH,
  NOTE_MAX_LENGTH,
  NOTICES,
  noticeClaimId,
  noticeSentence,
  resolveNotice,
  uploadRejectionNotice,
  type NoticeKey,
} from '../lib/notices';

/**
 * The words this app is willing to say, and the ones it will not repeat.
 *
 * A notice used to travel as its own sentence in the query string, which made
 * every page that shows one a place a link could put words into: `?action=your
 * session has expired, sign in at …` renders in this app's voice, on this app's
 * domain, under this app's header. React escaped it, so it was never markup —
 * but it was always ours to say and never theirs.
 *
 * What is tested here is the whole of that fix: a key that is not one of ours
 * says nothing at all, and the few notices that name something name a fragment
 * that had to be the shape it claims.
 */

/** A valid `about` list for each key that takes one. */
const ABOUT: Readonly<Partial<Record<NoticeKey, readonly string[]>>> = {
  decide_wrong_state: ['awaiting approval'],
  decide_rationale_too_long: ['501', '500'],
  packet_assembled: ['2', 'f00dcafe1234'],
  packet_assembled_one: ['f00dcafe1234'],
  packet_after_approval: ['f00dcafe1234'],
  packet_not_buildable: ['a packet with no documents is not a packet'],
  packet_wrong_state: ['classified'],
  approve_note_too_long: ['2001'],
  approve_wrong_state: ['submitted'],
  submit_confirmation_too_long: ['121'],
  decline_detail_too_long: ['2001'],
  submit_wrong_state: ['classified'],
  outcome_note_too_long: ['2001'],
  outcome_recorded: ['partial'],
  outcome_amount_refused: ['a partial recovery is more than nothing and less than the deduction'],
  outcome_wrong_state: ['classified'],
  upload_read_as: ['remittance advice'],
  upload_remittance_cases: ['3'],
  upload_duplicate_case: ['APDP-99812'],
  open_held_cases: ['3'],
};

/**
 * Every key, written out.
 *
 * Pinned rather than derived: a key is a thing routes redirect with and views
 * render, and one that appears or disappears without anybody noticing is either
 * a notice nothing can show or a redirect that shows nothing. Adding one here
 * is one line; forgetting to is a failing test.
 */
const EVERY_KEY: readonly string[] = [
  'approve_duplicate',
  'approve_is_preparer',
  'approve_no_packet',
  'approve_note_too_long',
  'approve_other_case',
  'approve_packet_missing',
  'approve_role',
  'approve_wrong_state',
  'approved',
  'attach_already',
  'attach_case_gone',
  'attach_case_merged',
  'attach_choose_case',
  'attach_done',
  'attach_failed',
  'attach_not_read',
  'attach_role',
  // Opening a case from a held document (ADR 0044).
  'open_held_already',
  'open_held_busy',
  'open_held_case_merged',
  'open_held_cases',
  'open_held_done',
  'open_held_duplicate',
  'open_held_failed',
  'open_held_none',
  'open_held_not_held',
  'open_held_not_read',
  'open_held_role',
  'open_held_unusable',
  'decide_declined',
  'decide_rationale',
  'decide_rationale_too_long',
  'decide_reason',
  'decide_role',
  'decide_wrong_state',
  'decided',
  'decline_already',
  'decline_detail_too_long',
  'decline_no_notice',
  'decline_predates_provenance',
  'decline_reason',
  'decline_role',
  'declined',
  'case_merged_away',
  'duplicate_already',
  'duplicate_confirmed_not_merged',
  'duplicate_dismissed',
  'duplicate_merged',
  'duplicate_role',
  'duplicate_unknown_pair',
  'duplicate_verdict',
  'merge_done',
  'merge_not_merged',
  'merge_refused',
  'merge_role',
  'merge_undone',
  'merge_unknown_pair',
  'outcome_amount_refused',
  'outcome_amount_refused_unsaid',
  'outcome_amount_unreadable',
  'outcome_note_too_long',
  'outcome_recorded',
  'outcome_required',
  'outcome_role',
  'outcome_wrong_state',
  'packet_after_approval',
  'packet_assembled',
  'packet_assembled_one',
  'packet_no_decision',
  'packet_not_buildable',
  'packet_not_buildable_unsaid',
  'packet_nothing_to_send',
  'packet_role',
  'packet_wrong_state',
  'reread_already_read',
  'reread_being_read',
  'reread_done',
  'reread_duplicate_case',
  'reread_failed',
  'reread_held',
  'qbo_already_connected',
  'qbo_already_disconnected',
  'qbo_connect_failed',
  'qbo_connected',
  'qbo_connected_elsewhere',
  'qbo_connected_no_scheduler',
  'qbo_connected_not_queued',
  'qbo_denied',
  'qbo_disconnect_failed',
  'qbo_disconnect_unknown',
  'qbo_disconnected',
  'qbo_disconnected_not_revoked',
  'qbo_exchange_failed',
  'qbo_not_configured',
  'qbo_realm_unverified',
  'qbo_role',
  'qbo_state_invalid',
  'qbo_wrong_host',
  'reread_not_queued',
  'reread_not_scanned_clean',
  'reread_queued',
  'reread_role',
  'submit_approval_names_no_packet',
  'submit_confirmation',
  'submit_confirmation_too_long',
  'submit_date',
  'submit_duplicate',
  'submit_no_approval',
  'submit_no_approved_packet',
  'submit_other_case',
  'submit_packet_mismatch',
  'submit_packet_not_for_decision',
  'submit_role',
  'submit_wrong_state',
  'submitted',
  'upload_already_read',
  'upload_case_gone',
  'upload_case_merged',
  'upload_duplicate_case',
  'upload_duplicate_case_unsaid',
  'upload_filed_from_record',
  'upload_held',
  'upload_no_file',
  'upload_not_queued',
  'upload_not_scanned_clean',
  'upload_queued_case',
  'upload_queued_list',
  'upload_read_as',
  'upload_read_no_case',
  'upload_rejected',
  'upload_rejected_active_content_pdf',
  'upload_rejected_body_too_short',
  'upload_rejected_content_does_not_match_type',
  'upload_rejected_decompression_bomb',
  'upload_rejected_empty_file',
  'upload_rejected_encrypted_pdf',
  'upload_rejected_malformed_pdf',
  'upload_rejected_too_large',
  'upload_rejected_type_not_allowed',
  'upload_remittance_cases',
  'upload_role',
  'upload_too_large',
];

describe('the notice table', () => {
  it('is exactly this set of keys', () => {
    expect(Object.keys(NOTICES).sort()).toEqual([...EVERY_KEY].sort());
  });

  it('resolves every key to its own words, in a tone that is one of the two', () => {
    for (const key of Object.keys(NOTICES) as NoticeKey[]) {
      const said = resolveNotice(key, ABOUT[key] ?? []);
      expect(said, key).toBeDefined();
      expect(said?.text, key).toBe(NOTICES[key].text.replace(/\{(\d)\}/g, (_, i: string) =>
        (ABOUT[key] as readonly string[])[Number(i)] as string,
      ));
      expect(['good', 'bad'], key).toContain(said?.tone);
      // One fragment per placeholder, both ways: a text with a hole nothing
      // fills renders "undefined", and a fragment with no hole to go in is a
      // validated value that silently never reaches the reader.
      expect(NOTICES[key].text.match(/\{\d\}/g)?.length ?? 0, key).toBe(
        (ABOUT[key] ?? []).length,
      );
      expect(said?.text, key).not.toMatch(/\{\d\}/);
      expect(said?.text.trim(), key).not.toBe('');
    }
  });

  it('names the limit it is enforcing, where there is one', () => {
    // The rationale's cap is the store's to name, and it arrives with the
     // refusal rather than being read off a constant here.
    expect(
      resolveNotice('decide_rationale_too_long', ['501', String(MAX_RATIONALE_LENGTH)])?.text,
    ).toBe(
      `that rationale is 501 characters and the cover sheet holds ${MAX_RATIONALE_LENGTH} — shorten it`,
    );
    expect(resolveNotice('approve_note_too_long', ['2001'])?.text).toContain(
      String(NOTE_MAX_LENGTH),
    );
    expect(resolveNotice('outcome_note_too_long', ['2001'])?.text).toContain(
      String(NOTE_MAX_LENGTH),
    );
    expect(resolveNotice('submit_confirmation_too_long', ['121'])?.text).toContain(
      String(CONFIRMATION_MAX_LENGTH),
    );
  });

  it('says nothing for a key that is not one of ours', () => {
    for (const forged of [
      'your session has expired, sign in at evil.test',
      'DECIDED',
      'decided ',
      '__proto__',
      'constructor',
      'toString',
      'hasOwnProperty',
      '',
      undefined,
      null,
      42,
    ]) {
      expect(resolveNotice(forged), String(forged)).toBeUndefined();
    }
  });

  it('says nothing when a fragment is missing, extra, or not the shape it claims', () => {
    // Missing and extra: the text would render with a hole in it, or with
    // something nobody put there.
    expect(resolveNotice('packet_assembled', ['2'])).toBeUndefined();
    expect(resolveNotice('packet_assembled', ['2', 'f00dcafe1234', 'x'])).toBeUndefined();
    expect(resolveNotice('decided', ['x'])).toBeUndefined();

    // A short hash is twelve hex characters and a state is one of the states.
    expect(resolveNotice('packet_after_approval', ['../../etc/passwd'])).toBeUndefined();
    expect(resolveNotice('packet_after_approval', ['F00DCAFE1234'])).toBeUndefined();
    expect(resolveNotice('decide_wrong_state', ['on fire'])).toBeUndefined();
    expect(resolveNotice('outcome_recorded', ['settled'])).toBeUndefined();
    expect(resolveNotice('upload_read_as', ['something else'])).toBeUndefined();
    expect(resolveNotice('decide_rationale_too_long', ['0', '500'])).toBeUndefined();
    expect(resolveNotice('decide_rationale_too_long', ['-1', '500'])).toBeUndefined();
    expect(
      resolveNotice('outcome_amount_refused', ['see <a href="evil.test">why</a>']),
    ).toBeUndefined();
  });

  it('accepts every state and every doc type, because the routes send them', () => {
    for (const state of CASE_STATES) {
      const said = resolveNotice('decide_wrong_state', [state.replace(/_/g, ' ')]);
      expect(said?.text, state).toContain(state.replace(/_/g, ' '));
    }
    for (const docType of DOC_TYPES) {
      const said = resolveNotice('upload_read_as', [docType.replace(/_/g, ' ')]);
      expect(said?.text, docType).toContain(docType.replace(/_/g, ' '));
    }
  });

  it('has a key for every way the door refuses a file', () => {
    // The codes are `RejectionCode`, a closed union. One this table has not
    // heard of still says the file was not accepted rather than nothing.
    for (const code of [
      'empty_file',
      'body_too_short',
      'too_large',
      'type_not_allowed',
      'content_does_not_match_type',
      'encrypted_pdf',
      'active_content_pdf',
      'decompression_bomb',
      'malformed_pdf',
    ]) {
      expect(uploadRejectionNotice(code), code).toBe(`upload_rejected_${code}`);
      expect(resolveNotice(uploadRejectionNotice(code)), code).toBeDefined();
    }
    expect(uploadRejectionNotice('something_new')).toBe('upload_rejected');
    expect(uploadRejectionNotice(undefined)).toBe('upload_rejected');
    // And a code cannot reach into the table for a notice that is not a
    // rejection.
    expect(uploadRejectionNotice('empty_file__proto__')).toBe('upload_rejected');
  });

  it('repeats a store’s reason only when it is a sentence, not a payload', () => {
    expect(noticeSentence('a lost case recovered nothing')).toBe('a lost case recovered nothing');
    expect(noticeSentence('cents are integers (invariant 3)')).toBe(
      'cents are integers (invariant 3)',
    );
    expect(
      noticeSentence('a won case recovered the whole deduction of 312000 cents; anything less is partial'),
    ).toBeDefined();
    for (const forged of [
      'go to https://evil.test',
      'sign in <a href="#">here</a>',
      'x'.repeat(201),
      '',
      undefined,
    ]) {
      expect(noticeSentence(forged), String(forged)).toBeUndefined();
    }
  });

  it('repeats a claim id only when it is the shape of one', () => {
    expect(noticeClaimId('APDP-99812')).toBe('APDP-99812');
    expect(noticeClaimId('CLM 123/45')).toBe('CLM 123/45');
    for (const forged of ['<script>alert(1)</script>', ' leading', 'x'.repeat(65), '', undefined]) {
      expect(noticeClaimId(forged), String(forged)).toBeUndefined();
    }
  });
});

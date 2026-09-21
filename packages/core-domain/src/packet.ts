/**
 * The dispute packet's cover narrative, built by our code.
 *
 * No model call (ADR 0020 §2). A dispute narrative is short and templated, and
 * building it deterministically is what makes the packet's content hash a pure
 * function of the case — which is the property the approval and the submission
 * both lean on: an approval names a hash, a submission repeats it, and a
 * document swapped in between changes the hash rather than passing unnoticed.
 *
 * It follows the same rule the rest of the money path follows: **models copy,
 * we compute**. Every value here has already been extracted and quote-verified
 * off the page, and the only arithmetic is `formatCents`, which renders integer
 * cents (invariant 3). No float ever touches this file.
 *
 * It lives in `core-domain` rather than in a store because both stores have to
 * produce the same bytes for the same case. A narrative that differed between
 * the in-memory store and Postgres would be two different packets with two
 * different hashes, and the tests that prove the two agree would be proving
 * nothing.
 */

import { createHash } from 'node:crypto';
import { cents, formatCents } from './money';
import { isCanonicalReasonCode, type CanonicalReasonCode } from './reason-codes';

export class PacketError extends Error {}

/** What the cover page says when the notice did not print a value. */
export const NOT_RECORDED = '(not recorded)';

/**
 * The longest narrative the database will hold
 * (`packets.narrative … check (length(narrative) between 1 and 20000)`).
 * Checked here as well so an over-long rationale is refused by name rather
 * than as a driver error, and refused before anything has been written.
 */
export const MAX_NARRATIVE_LENGTH = 20_000;

/**
 * What the narrative spends on everything that is not the rationale, so the
 * rationale can be refused at the point a person types it rather than three
 * steps later.
 *
 * The arithmetic, worst case, for the template `buildPacketNarrative` renders:
 *
 * | Part | Characters | Where the cap comes from |
 * | --- | --- | --- |
 * | fixed text | 196 | the labels, the two sentences, the heading and the newlines: 32 + 10 + 7 + 18 + 16 + 18 + 16 + 35 + 11 + 19 = 182, plus the 14 newlines that are not a document's |
 * | retailer | 500 | `deductions.retailer_name_as_printed … length <= 500` (migration 0015) |
 * | claim | 200 | `deductions.claim_id` is unbounded `text`; 200 is the budget |
 * | amount | 24 | `formatCents` of the largest exact cents is 22 characters |
 * | deduction date | 10 | `YYYY-MM-DD` |
 * | dispute deadline | 10 | `YYYY-MM-DD` |
 * | reason | 40 | the longest canonical code is 31 characters |
 * | enclosed documents | 7,500 | 25 documents x 300: `  NN. remittance: <255-character filename>` and its newline |
 *
 * 196 + 500 + 200 + 24 + 10 + 10 + 40 + 7,500 = 8,480, so a rationale of up to
 * 20,000 - 8,480 = 11,520 characters always fits.
 *
 * Two of those caps are budgets rather than proofs — `claim_id` and a matched
 * debtor's `display_name` are unbounded `text`, and nothing limits how many
 * documents a case may enclose. So this is the *first* check and not the only
 * one: `buildPacketNarrative` still measures what it actually built, and
 * `assemblePacket` surfaces that as a named refusal (`PacketNotBuildableError`)
 * rather than a raw `PacketError`.
 */
export const NARRATIVE_BUDGET_WITHOUT_RATIONALE = 196 + 500 + 200 + 24 + 10 + 10 + 40 + 7_500;

/**
 * The longest rationale a store will accept.
 *
 * It exists because `decisions` is append-only and the packet is assembled
 * *later*: a rationale that overflows `packets.narrative` would be accepted by
 * `recordHumanDecision`, move the case to `analyst_review`, and then wedge it
 * there — nothing can amend the decision, and nothing can assemble a packet.
 * Refused before the insert instead, where the analyst can still shorten it.
 */
export const MAX_RATIONALE_LENGTH = MAX_NARRATIVE_LENGTH - NARRATIVE_BUDGET_WITHOUT_RATIONALE;

/** A document the packet encloses, in the order it will be sent. */
export interface PacketDocument {
  /** `deduction_documents.role` — what this document is in the case. */
  readonly role: 'notice' | 'evidence' | 'remittance' | 'context';
  readonly filename: string;
}

/**
 * Everything the cover page says. Each optional field is a value the notice may
 * simply not have printed; it is rendered as {@link NOT_RECORDED} rather than
 * guessed at, the same way `openCase` leaves a column null rather than inventing
 * a dispute window (ADR 0019).
 */
export interface PacketNarrativeInput {
  readonly claimId?: string;
  /**
   * The retailer this dispute is addressed to: the matched debtor's display
   * name when exactly one debtor matched, and otherwise the name exactly as the
   * notice printed it. Which of the two it is, is the store's question to
   * answer — the cover page says who, not how we know.
   */
  readonly retailer?: string;
  /** Integer cents (invariant 3). Rendered by `formatCents`, never by hand. */
  readonly deductionAmountCents: number;
  /** `YYYY-MM-DD`, already parsed by `parsePrintedDate`. */
  readonly deductionDate?: string;
  readonly disputeDeadline?: string;
  /** The canonical reason the analyst says this deduction is invalid under. */
  readonly reason: CanonicalReasonCode;
  /** The analyst's one line, verbatim. */
  readonly rationale: string;
  /** At least one: the notice. `packets.file_document_ids` says so too. */
  readonly documents: readonly PacketDocument[];
}

function line(label: string, value: string | undefined): string {
  return `${label}: ${value === undefined || value === '' ? NOT_RECORDED : value}`;
}

/**
 * The cover narrative for a dispute packet.
 *
 * Deterministic: the same input produces the same string, byte for byte, with
 * no clock, no locale beyond `formatCents`' fixed `en-US` grouping, and no
 * iteration over anything unordered. That is what lets the content hash be
 * recomputed years later and still match the approval.
 *
 * Every value it is given appears in the output verbatim, which is the property
 * `packet.test.ts` checks: a narrative that dropped the claim id or rounded the
 * amount would be a packet that says something other than what the case says.
 */
export function buildPacketNarrative(input: PacketNarrativeInput): string {
  if (!isCanonicalReasonCode(input.reason)) {
    throw new PacketError(`${input.reason} is not a canonical reason code`);
  }
  const rationale = input.rationale.trim();
  if (rationale === '') {
    throw new PacketError('a dispute needs a rationale: the analyst says why, in their words');
  }
  if (input.documents.length === 0) {
    throw new PacketError('a packet with no documents is not a packet');
  }
  for (const document of input.documents) {
    if (document.filename.trim() === '') {
      throw new PacketError('every enclosed document has to be named');
    }
  }
  // `cents()` refuses a float and anything past the safe-integer range, so a
  // narrative can never print an amount that is not an exact number of cents.
  const amount = formatCents(cents(input.deductionAmountCents));

  const enclosed = input.documents.map(
    (document, index) => `  ${index + 1}. ${document.role}: ${document.filename}`,
  );

  const narrative = [
    'DISPUTE PACKET — COVER NARRATIVE',
    '',
    line('Retailer', input.retailer),
    line('Claim', input.claimId),
    `Deduction amount: ${amount}`,
    line('Deduction date', input.deductionDate),
    line('Dispute deadline', input.disputeDeadline),
    `Dispute reason: ${input.reason}`,
    '',
    'This deduction is disputed in full.',
    '',
    `Rationale: ${rationale}`,
    '',
    'Enclosed documents:',
    ...enclosed,
    '',
  ].join('\n');

  if (narrative.length > MAX_NARRATIVE_LENGTH) {
    throw new PacketError(
      `narrative is ${narrative.length} characters, over the ${MAX_NARRATIVE_LENGTH} the packet ` +
        'record holds — shorten the rationale rather than storing half a packet',
    );
  }
  return narrative;
}

/**
 * The sha256 of a packet's canonical contents, lower-case hex.
 *
 * The canonical form is a JSON object with exactly three keys written in a
 * fixed order — the decision the packet was assembled for, its document ids
 * sorted, and the narrative. Sorted, because the hash answers "are these the
 * same contents", and the order a reviewer attached two evidence files in is
 * not a difference in contents; the ordered list is kept separately in
 * `packets.file_document_ids`, which is what actually gets sent.
 *
 * Put the other way round: the hash covers the document *set*, and the
 * narrative covers the *order* — so two documents that differ only in the
 * order they were attached hash the same and hand back the packet that already
 * exists, while a document swapped for a different one changes the sorted set,
 * and a document renamed or re-roled changes the enclosed list the narrative
 * prints.
 *
 * `JSON.stringify` over a literal is canonical enough here for the same reason
 * `app.canonical(jsonb)` is: the keys are written in one place, in one order,
 * and the values are strings.
 */
export function packetContentHash(input: {
  readonly decisionId: string;
  readonly narrative: string;
  readonly fileDocumentIds: readonly string[];
}): string {
  const canonical = JSON.stringify({
    decisionId: input.decisionId,
    fileDocumentIds: [...input.fileDocumentIds].sort(),
    narrative: input.narrative,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * The dispute packet's narrative — the letter a supplier sends a payer —
 * built by our code.
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
import { REASON_WORDS_MAX_LENGTH, reasonInWords } from './reason-words';

export class PacketError extends Error {}

/** What the letter says when the case holds no value for a field. */
export const NOT_RECORDED = '(not recorded)';

/**
 * The longest narrative the database will hold
 * (`packets.narrative … check (length(narrative) between 1 and 20000)`).
 * Checked here as well so an over-long rationale is refused by name rather
 * than as a driver error, and refused before anything has been written.
 */
export const MAX_NARRATIVE_LENGTH = 20_000;

/**
 * How many invoice numbers the budget below leaves room for. A case usually
 * holds one; a survivor of a merge (ADR 0042) holds its own and the merged-away
 * case's. Past this the letter may still fit — `buildPacketNarrative` measures
 * what it built — but it is no longer promised to.
 */
export const INVOICE_NUMBERS_BUDGETED = 10;

/**
 * The letter's own words — every label, sentence and newline it writes around
 * the values — as budgeted in the table below.
 */
export const FIXED_TEXT_BUDGET = 340;

/**
 * What the narrative spends on everything that is not the rationale, so the
 * rationale can be refused at the point a person types it rather than three
 * steps later.
 *
 * The arithmetic, worst case, for the letter `buildPacketNarrative` renders:
 *
 * | Part | Characters | Where the cap comes from |
 * | --- | --- | --- |
 * | fixed text | 340 | every label, sentence and newline the template writes: 335 today, which `packet.test.ts` measures from the template itself and holds at or under this |
 * | supplier, twice | 400 | `organizations.name` is unbounded `text`; 200 is the budget, and the letter prints it in the From line and in the dispute sentence |
 * | payer | 500 | `deductions.retailer_name_as_printed … length <= 500` (migration 0015); a matched debtor's `display_name` is unbounded, and 500 is its budget too |
 * | claim | 200 | `deductions.claim_id` is unbounded `text`; 200 is the budget |
 * | invoice numbers | 2,020 | `deduction_identifiers.identifier … length between 1 and 200` (migration 0020), {@link INVOICE_NUMBERS_BUDGETED} of them, each with its `, ` |
 * | amount, twice | 48 | `formatCents` of the largest exact cents is 22 characters; 24 is the budget, and it is printed in the details and in the dispute sentence |
 * | deduction date | 10 | `YYYY-MM-DD` |
 * | dispute deadline | 10 | `YYYY-MM-DD` |
 * | reason | 100 | `REASON_WORDS_MAX_LENGTH`, which `reason-words.test.ts` holds every entry to |
 * | enclosures | 7,500 | 25 documents x 300: `  NN. Supporting document: <255-character filename>` and its newline is 283 |
 *
 * 340 + 400 + 500 + 200 + 2,020 + 48 + 10 + 10 + 100 + 7,500 = 11,128, so a
 * rationale of up to 20,000 - 11,128 = 8,872 characters always fits.
 *
 * Several of those caps are budgets rather than proofs — `claim_id`, the
 * supplier's name and a matched debtor's `display_name` are unbounded `text`,
 * and nothing limits how many documents or invoice numbers a case may hold. So
 * this is the *first* check and not the only one: `buildPacketNarrative` still
 * measures what it actually built, and `assemblePacket` surfaces that as a named
 * refusal (`PacketNotBuildableError`) rather than a raw `PacketError`.
 */
export const NARRATIVE_BUDGET_WITHOUT_RATIONALE =
  FIXED_TEXT_BUDGET + 2 * 200 + 500 + 200 + INVOICE_NUMBERS_BUDGETED * 202 + 2 * 24 + 10 + 10 +
  REASON_WORDS_MAX_LENGTH + 7_500;

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

/** How the letter names each role to a payer. */
export const ENCLOSURE_ROLE_WORDS = {
  notice: 'Deduction notice',
  evidence: 'Supporting document',
  remittance: 'Remittance advice',
  context: 'Reference document',
} as const satisfies Record<PacketDocument['role'], string>;

/**
 * Everything the letter says. Each optional field is a value the case may
 * simply not hold; it is rendered as {@link NOT_RECORDED} rather than guessed
 * at, the same way `openCase` leaves a column null rather than inventing a
 * dispute window (ADR 0019) — except the dispute deadline, which is left out
 * of a letter that has none rather than telling the payer we do not know it.
 */
export interface PacketNarrativeInput {
  /** Who is disputing: `organizations.name`, the tenant. Always present. */
  readonly supplier: string;
  readonly claimId?: string;
  /**
   * Who the dispute is addressed to: the matched debtor's display name when
   * exactly one debtor matched, and otherwise the name exactly as the notice
   * printed it. Which of the two it is, is the store's question to answer —
   * the letter says who, not how we know.
   */
  readonly payer?: string;
  /**
   * The case's `invoice_number` identifiers (a merged-away case's included),
   * in any order and with repeats: the builder de-duplicates them and sorts
   * them by code unit, so two stores that read them in different orders still
   * build the same bytes.
   */
  readonly invoiceNumbers: readonly string[];
  /** Integer cents (invariant 3). Rendered by `formatCents`, never by hand. */
  readonly deductionAmountCents: number;
  /** `YYYY-MM-DD`, already parsed by `parsePrintedDate`. */
  readonly deductionDate?: string;
  readonly disputeDeadline?: string;
  /** The canonical reason the analyst says this deduction is invalid under. */
  readonly reason: CanonicalReasonCode;
  /** The analyst's explanation, verbatim. */
  readonly rationale: string;
  /** At least one: the notice. `packets.file_document_ids` says so too. */
  readonly documents: readonly PacketDocument[];
}

function line(label: string, value: string | undefined): string {
  return `${label}: ${value === undefined || value === '' ? NOT_RECORDED : value}`;
}

/** Code-unit order, never `localeCompare`: the bytes may not depend on a locale. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The dispute letter a supplier sends a payer, and the packet's narrative.
 *
 * Deterministic: the same input produces the same string, byte for byte, with
 * no clock, no locale beyond `formatCents`' fixed `en-US` grouping, and no
 * iteration over anything unordered. That is what lets the content hash be
 * recomputed years later and still match the approval. It carries no date for
 * the same reason: the day it is sent is the sender's to write.
 *
 * Every value it is given appears in the output verbatim, which is the property
 * `packet.test.ts` checks: a letter that dropped the claim id or rounded the
 * amount would be a packet that says something other than what the case says.
 * The reason is the one value it translates — from the canonical code to
 * `REASON_WORDS`, because a payer reads words, not our taxonomy.
 */
export function buildPacketNarrative(input: PacketNarrativeInput): string {
  if (!isCanonicalReasonCode(input.reason)) {
    throw new PacketError(`${input.reason} is not a canonical reason code`);
  }
  const supplier = input.supplier.trim();
  if (supplier === '') {
    throw new PacketError('a dispute letter has to say who it is from');
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

  const invoices = [...new Set(input.invoiceNumbers.filter((n) => n.trim() !== ''))].sort(
    byCodeUnit,
  );
  const invoiceLine =
    invoices.length > 1
      ? `Invoice numbers: ${invoices.join(', ')}`
      : line('Invoice number', invoices[0]);

  const enclosed = input.documents.map(
    (document, index) =>
      `  ${index + 1}. ${ENCLOSURE_ROLE_WORDS[document.role]}: ${document.filename}`,
  );

  const narrative = [
    'DISPUTE OF DEDUCTION',
    '',
    `From: ${supplier}`,
    line('To', input.payer),
    '',
    line('Claim or deduction reference', input.claimId),
    invoiceLine,
    `Amount deducted: ${amount}`,
    line('Deduction date', input.deductionDate),
    ...(input.disputeDeadline !== undefined && input.disputeDeadline !== ''
      ? [`Dispute deadline: ${input.disputeDeadline}`]
      : []),
    '',
    `${supplier} disputes this deduction in full and asks that ${amount} be repaid.`,
    '',
    `Reason for dispute: ${reasonInWords(input.reason)}`,
    '',
    'Explanation:',
    rationale,
    '',
    'Enclosures:',
    ...enclosed,
    '',
    'Please quote the claim or deduction reference above in any reply about this dispute.',
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

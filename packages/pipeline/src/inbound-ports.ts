/**
 * The ports email-in reads and writes through (ADR 0047).
 *
 * Kept apart from `PipelineStore` for the reason `CaseWorkflowStore` is: a
 * different door, with different rules about who acts. An email acts as the
 * member its address acts as, and everything it records goes through one
 * definer function in the database (`app.record_inbound_message`), so these
 * are the only shapes that door accepts.
 */

/** Postmark is the only inbound provider; the column is a closed list. */
export type InboundProvider = 'postmark';

/** What a delivery was: received, lost on the way (§12), or refused (§11). */
export type InboundMessageOutcome = 'received' | 'not_received' | 'refused_retired';

export type InboundPartKind = 'attachment' | 'inline' | 'body';

/**
 * What became of one part of an email. The first four name a stored document;
 * the rest are refusals, recorded rather than dropped.
 */
export type InboundPartOutcome =
  | 'stored'
  | 'already_held'
  | 'over_daily_budget'
  | 'not_clean'
  | 'inline_image'
  | 'too_many_parts'
  | 'not_base64'
  | 'empty_file'
  | 'body_too_short'
  | 'too_large'
  | 'type_not_allowed'
  | 'content_does_not_match_type'
  | 'encrypted_pdf'
  | 'active_content_pdf'
  | 'decompression_bomb'
  | 'malformed_pdf';

export const INBOUND_PART_OUTCOMES_WITH_DOCUMENT: ReadonlySet<InboundPartOutcome> = new Set([
  'stored',
  'already_held',
  'over_daily_budget',
  'not_clean',
]);

export type DkimVerdict = 'pass' | 'fail' | 'none' | 'unknown';
export type SpfVerdict = 'pass' | 'fail' | 'softfail' | 'neutral' | 'none' | 'unknown';

/**
 * What Postmark reported about the sender (ADR 0047 §7). Recorded and shown;
 * it opens nothing. `authenticated` is aligned DKIM and nothing else, which the
 * database checks.
 */
export interface InboundVerdict {
  readonly authenticated: boolean;
  readonly dkim: DkimVerdict;
  /** Postmark reports no DMARC verdict, so this is always `unknown` today. */
  readonly dmarc: DkimVerdict;
  readonly spf: SpfVerdict;
  readonly verdictSource: 'postmark_spamassassin';
  /** The domain the email claims to be from. A claim, used for nothing. */
  readonly senderDomain?: string;
}

/** A token's tenant and the member a delivery to it acts as (§5). */
export interface InboundAddressResolution {
  readonly addressId: string;
  readonly orgId: string;
  /** The latest adopter, else the issuer; the retirer when `retired`. */
  readonly actingMember: string;
  readonly retired: boolean;
}

export interface InboundPartRecord {
  readonly ordinal: number;
  readonly kind: InboundPartKind;
  /** As the sender named it. Rendered escaped, never logged. */
  readonly filename?: string;
  readonly outcome: InboundPartOutcome;
  readonly documentId?: string;
}

export interface InboundMessageRecord {
  readonly addressId: string;
  readonly provider: InboundProvider;
  /** Postmark's MessageID, not the sender's Message-ID header. */
  readonly providerMessageId: string;
  readonly outcome: InboundMessageOutcome;
  /** Postmark's own date, on a `not_received` row only. */
  readonly providerReceivedAt?: Date;
  /** On a `received` row only. */
  readonly verdict?: InboundVerdict;
}

/** A part as recorded, with the message it belongs to. */
export interface RecordedInboundPart extends InboundPartRecord {
  readonly inboundMessageId: string;
}

/** The tenant-scoped half of email-in, acting as the address's member. */
export interface InboundMessageStore {
  /** The `received` row for this message, if one is recorded. */
  receivedMessage(
    provider: InboundProvider,
    providerMessageId: string,
  ): Promise<string | undefined>;
  /** Writes the message and all its parts in one call; returns its id. */
  recordInboundMessage(
    message: InboundMessageRecord,
    parts: readonly InboundPartRecord[],
  ): Promise<string>;
  /** The parts of one recorded message, in order. */
  inboundMessageParts(inboundMessageId: string): Promise<readonly RecordedInboundPart[]>;
  /**
   * Parts recorded `stored` or `already_held` on this tenant's messages over
   * the trailing 24 hours: what the daily read budget counts (§8).
   */
  inboundReadsLastDay(now: Date): Promise<number>;
}

/**
 * SubmissionChannel (plan §11).
 *
 * V1 ships ManualPortalSubmission: the packet is prepared and the human files
 * it. V1.5 adds email. V3 adds a browser agent. All three are implementations
 * of this one interface, so adding them is additive — and every one of them
 * still has to get past the approval trigger in the database.
 */

export type ChannelKind = 'manual_portal' | 'email' | 'portal_agent';

export interface PacketFile {
  readonly filename: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly storageRef: string;
  /** Where this file's content came from, for the reviewer's audit trail. */
  readonly sourceDocumentIds: readonly string[];
}

export interface Packet {
  readonly orgId: string;
  readonly deductionId: string;
  readonly decisionId: string;
  /** Grounded narrative with citations into evidence items. */
  readonly narrative: string;
  readonly files: readonly PacketFile[];
  /** sha256 over the packet's canonical contents; stored on the submission. */
  readonly contentHash: string;
}

export interface PreparedSubmission {
  readonly kind: ChannelKind;
  readonly packet: Packet;
  /** Step-by-step instructions for a human filer (manual_portal). */
  readonly instructions: readonly string[];
  /** Channel-specific payload: the email draft, portal field map, and so on. */
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface SubmitCtx {
  readonly actorId: string;
  /** The approvals row id. No channel may submit without one. */
  readonly approvalId: string;
  readonly idempotencyKey: string;
}

export interface SubmissionResult {
  readonly status: 'recorded' | 'sent' | 'accepted' | 'rejected';
  readonly confirmationNumber?: string;
  readonly submittedAt: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}

export interface SubmissionChannel {
  readonly kind: ChannelKind;
  prepare(packet: Packet, playbook: PlaybookChannelSpec): Promise<PreparedSubmission>;
  submit(prepared: PreparedSubmission, ctx: SubmitCtx): Promise<SubmissionResult>;
}

/** The slice of a retailer playbook that drives packet formatting. */
export interface PlaybookChannelSpec {
  readonly type: 'portal' | 'email' | 'edi';
  readonly name: string;
  readonly granularity: 'claim' | 'claim_line';
  readonly fileTypes: readonly string[];
  readonly maxFileMb?: number;
  readonly descriptionCharLimit?: number | null;
  readonly notes?: string;
}

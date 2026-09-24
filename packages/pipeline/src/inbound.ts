/**
 * Email-in's two halves (ADR 0047 §8).
 *
 * **The request stores and scans.** `receiveInboundEmail` runs inside the
 * webhook's request, under the message's claim, as the member the address
 * acts as. It walks the parts, puts each one through the same `ingestDocument`
 * an upload runs — one `uploads` row per document, `email_in` for a file and
 * `email_body` for the message, no `created_by` — and then records the email
 * and every part's outcome in one call. It reads nothing: a read runs into
 * Postmark's two-minute wait, and the queued read is the one that holds the
 * document's claim.
 *
 * **A job reads.** `readInboundEmailJob` reads each stored part through
 * `readDocumentJob`, the same path an upload's read takes, and the body only
 * when no attachment was a notice. An email's notice or remittance is held for
 * a person by `readDocument` itself, keyed on the document's arrival (§7), so
 * nothing here — and no caller — can let an email open a case.
 *
 * Every failure that is not a refusal of one part propagates. A part the front
 * door refuses is an outcome on the record, and the email carries on without it.
 */

import { INBOUND_READS_PER_DAY } from '@recouple/core-domain';
import {
  RejectedUploadError,
  isFilePart,
  type InboundEmail,
  type PostmarkVerdict,
} from '@recouple/ingest';
import type {
  InboundAddressResolution,
  InboundMessageStore,
  InboundPartOutcome,
  InboundPartRecord,
} from './inbound-ports';
import {
  InvalidJobPayloadError,
  readDocumentJob,
  type JobDeps,
  type ReadDocumentJobResult,
} from './jobs';
import type { PipelineDeps } from './ports';
import { ingestDocument } from './steps';

/** The scanner gave no verdict: answered 503, and the retry re-scans (§10, §11). */
export class InboundScanUnavailableError extends Error {
  override readonly name = 'InboundScanUnavailableError';
  constructor(readonly orgId: string, readonly documentId: string) {
    super(`the scanner gave no verdict for document ${documentId} in org ${orgId}`);
  }
}

/**
 * The member an address acts as may no longer write here: answered 503, so the
 * message stays in Postmark's retry schedule while an owner adopts the address
 * (§6, §11).
 */
export class InboundActingMemberRefusedError extends Error {
  override readonly name = 'InboundActingMemberRefusedError';
  constructor(readonly orgId: string, readonly addressId: string) {
    super(`the member address ${addressId} acts as may not write in org ${orgId}`);
  }
}

export interface InboundDeps {
  readonly store: JobDeps['store'];
  readonly scanner: PipelineDeps['scanner'];
  readonly inbound: InboundMessageStore;
  readonly now?: () => Date;
}

export type InboundReceipt =
  | {
      readonly kind: 'recorded';
      readonly inboundMessageId: string;
      /** True when an earlier delivery recorded it and this one wrote nothing. */
      readonly alreadyRecorded: boolean;
      readonly parts: readonly InboundPartRecord[];
    }
  | { readonly kind: 'busy'; readonly reason: 'held' | 'no_connection' };

function verdictRecord(verdict: PostmarkVerdict) {
  return {
    authenticated: verdict.authenticated,
    dkim: verdict.dkim,
    dmarc: verdict.dmarc,
    spf: verdict.spf,
    verdictSource: verdict.verdictSource,
    ...(verdict.senderDomain !== undefined ? { senderDomain: verdict.senderDomain } : {}),
  } as const;
}

/**
 * The request half. `address` is a live address the lookup resolved; the
 * store and the inbound store act as its `actingMember`.
 */
export async function receiveInboundEmail(
  email: InboundEmail,
  address: InboundAddressResolution,
  deps: InboundDeps,
): Promise<InboundReceipt> {
  if (address.retired) {
    throw new Error('receiveInboundEmail is for a live address; a retired one is refused before');
  }
  // Asked of the database before anything is stored: an address whose member
  // may no longer write accepts nothing until an owner adopts it (§6).
  if (!(await deps.store.memberMayWrite({ orgId: address.orgId, userId: address.actingMember }))) {
    throw new InboundActingMemberRefusedError(address.orgId, address.addressId);
  }

  const claim = await deps.inbound.withMessageClaim('postmark', email.providerMessageId, async () => {
    const existing = await deps.inbound.receivedMessage('postmark', email.providerMessageId);
    if (existing !== undefined) {
      return { inboundMessageId: existing, alreadyRecorded: true, parts: [] as InboundPartRecord[] };
    }

    let reads = await deps.inbound.inboundReadsLastDay((deps.now ?? (() => new Date()))());
    const parts: InboundPartRecord[] = [];

    for (const plan of email.parts) {
      if (!isFilePart(plan)) {
        parts.push({ ordinal: plan.ordinal, kind: plan.kind, filename: plan.filename, outcome: plan.outcome });
        continue;
      }
      const source = plan.kind === 'body' ? 'email_body' : 'email_in';
      let ingested;
      try {
        ingested = await ingestDocument(
          {
            orgId: address.orgId,
            filename: plan.filename,
            bytes: plan.bytes,
            ...(plan.declaredMimeType !== undefined ? { declaredMimeType: plan.declaredMimeType } : {}),
            // The door, recorded on the `uploads` row. No `uploadedBy`: the
            // sender is not one of our members and `From:` is forgeable.
            source,
            // A body has no image behind it: it is the text layer.
            ...(plan.kind === 'body' ? { pageText: [new TextDecoder().decode(plan.bytes)] } : {}),
          },
          deps,
        );
      } catch (error) {
        // The front door's refusal of this one part is permanent and recorded;
        // the email carries on. Anything else is a fault, and propagates.
        if (error instanceof RejectedUploadError) {
          parts.push({ ordinal: plan.ordinal, kind: plan.kind, filename: plan.filename, outcome: error.code });
          continue;
        }
        throw error;
      }

      const documentId = ingested.document.documentId;
      let outcome: InboundPartOutcome;
      if (ingested.verdict.status === 'error') {
        throw new InboundScanUnavailableError(address.orgId, documentId);
      } else if (ingested.verdict.status === 'infected') {
        outcome = 'not_clean';
      } else if (reads >= INBOUND_READS_PER_DAY) {
        outcome = 'over_daily_budget';
      } else {
        outcome = ingested.deduplicated ? 'already_held' : 'stored';
        reads += 1;
      }
      parts.push({ ordinal: plan.ordinal, kind: plan.kind, filename: plan.filename, outcome, documentId });
    }

    const inboundMessageId = await deps.inbound.recordInboundMessage(
      {
        addressId: address.addressId,
        provider: 'postmark',
        providerMessageId: email.providerMessageId,
        outcome: 'received',
        verdict: verdictRecord(email.verdict),
      },
      parts,
    );
    return { inboundMessageId, alreadyRecorded: false, parts };
  });

  if (!claim.claimed) return { kind: 'busy', reason: claim.reason };
  return { kind: 'recorded', ...claim.result };
}

export interface ReadInboundEmailJobInput {
  readonly orgId: string;
  /** The member the address acted as when the email was recorded. */
  readonly userId: string;
  readonly inboundMessageId: string;
}

export interface ReadInboundEmailJobResult {
  readonly inboundMessageId: string;
  readonly reads: readonly ReadDocumentJobResult[];
  /** Whether the body was read: only when no attachment was a notice. */
  readonly bodyRead: boolean;
}

/** Parts the job reads: stored or already held, and within the budget. */
const READABLE: ReadonlySet<InboundPartOutcome> = new Set(['stored', 'already_held']);

/**
 * The job half, one event per email. Each read is `readDocumentJob`'s: under
 * the document's claim, and answered from the record when the document was
 * already read — so a part recorded `already_held` that was this same email's
 * own document, stored by a delivery that died before its message row was
 * written, is read here rather than stranded.
 */
export async function readInboundEmailJob(
  deps: JobDeps & { readonly inbound: InboundMessageStore },
  input: ReadInboundEmailJobInput,
  readOne: (documentId: string) => Promise<ReadDocumentJobResult> = (documentId) =>
    readDocumentJob(deps, { documentId, orgId: input.orgId, actor: { userId: input.userId } }),
): Promise<ReadInboundEmailJobResult> {
  if (!(await deps.store.memberMayWrite({ orgId: input.orgId, userId: input.userId }))) {
    throw new InvalidJobPayloadError(
      `user ${input.userId} is not a member of org ${input.orgId} who may add documents`,
    );
  }

  const parts = await deps.inbound.inboundMessageParts(input.inboundMessageId);
  const reads: ReadDocumentJobResult[] = [];

  for (const part of parts) {
    if (part.kind === 'body' || part.documentId === undefined || !READABLE.has(part.outcome)) continue;
    reads.push(await readOne(part.documentId));
  }

  // The body is read only when no attachment was the notice — counting a read
  // answered from the record, which carries the type it was recorded as. If
  // one was, the body is a cover note, and reading it would pay to learn that.
  const noticeAttached = reads.some((read) => read.docType === 'deduction_notice');
  const body = parts.find(
    (part) => part.kind === 'body' && part.documentId !== undefined && READABLE.has(part.outcome),
  );
  let bodyRead = false;
  if (body?.documentId !== undefined && !noticeAttached) {
    reads.push(await readOne(body.documentId));
    bodyRead = true;
  }

  return { inboundMessageId: input.inboundMessageId, reads, bodyRead };
}

/**
 * Email-in (plan §7).
 *
 * A supplier forwards a deduction notice to their tenant's address and the
 * attachments become documents. Two things make that safe rather than merely
 * convenient.
 *
 * **The sender is a claim, not a fact.** `From:` is trivially forged, so an
 * email only counts as authenticated when DKIM passes — DMARC alignment counts
 * too, SPF alone does not, because SPF passes for anyone who can send from a
 * permitted envelope domain. An unauthenticated email is still ingested (the
 * documents may be perfectly real) but it is marked, and the pipeline refuses to
 * open a case from it without a human.
 *
 * **The address decides the tenant.** Each tenant has its own inbound address
 * and the org comes from that address, never from the sender or from anything in
 * the body — otherwise anyone who learned one tenant's address could file
 * documents into another's.
 */

export type AuthResult = 'pass' | 'fail' | 'none' | 'unknown';

export interface InboundAttachment {
  readonly filename: string;
  readonly contentType: string;
  readonly base64: string;
  readonly byteSize: number;
  /** Set for images embedded in the body rather than attached to it. */
  readonly contentId?: string;
  readonly inline: boolean;
}

export interface InboundEmail {
  /** The tenant, taken from the address it was sent to. */
  readonly orgSlug: string;
  readonly messageId: string;
  readonly from: string;
  readonly fromDomain: string;
  readonly to: string;
  readonly subject: string;
  readonly textBody: string;
  readonly receivedAt: string;
  readonly spf: AuthResult;
  readonly dkim: AuthResult;
  readonly dmarc: AuthResult;
  /**
   * DKIM or DMARC passed. Only an authenticated email may open a case on its
   * own; everything else waits for a human.
   */
  readonly authenticated: boolean;
  readonly attachments: readonly InboundAttachment[];
  /** True when the body looks like a forwarded chain rather than a fresh send. */
  readonly forwarded: boolean;
}

export class InboundEmailError extends Error {}

interface PostmarkHeader {
  Name?: string;
  Value?: string;
}

interface PostmarkAttachment {
  Name?: string;
  Content?: string;
  ContentType?: string;
  ContentLength?: number;
  ContentID?: string;
}

export interface PostmarkInboundPayload {
  From?: string;
  To?: string;
  OriginalRecipient?: string;
  Subject?: string;
  MessageID?: string;
  Date?: string;
  TextBody?: string;
  HtmlBody?: string;
  StrippedTextReply?: string;
  MailboxHash?: string;
  Headers?: PostmarkHeader[];
  Attachments?: PostmarkAttachment[];
}

function headerValue(headers: readonly PostmarkHeader[], name: string): string | undefined {
  const found = headers.find((h) => (h.Name ?? '').toLowerCase() === name.toLowerCase());
  return found?.Value;
}

/** Reads one method's verdict out of an Authentication-Results header. */
export function authResultFor(header: string | undefined, method: string): AuthResult {
  if (header === undefined || header === '') return 'unknown';
  const match = new RegExp(`\\b${method}\\s*=\\s*([a-z]+)`, 'i').exec(header);
  const verdict = match?.[1]?.toLowerCase();
  if (verdict === 'pass') return 'pass';
  if (verdict === 'fail' || verdict === 'softfail' || verdict === 'permerror') return 'fail';
  if (verdict === 'none') return 'none';
  return verdict === undefined ? 'unknown' : 'unknown';
}

/**
 * The tenant slug in an inbound address.
 *
 * Accepts `u-acme@in.recouple.app`, `u+acme@…` and Postmark's mailbox hash.
 * Anything else has no tenant, and an email with no tenant is refused rather
 * than guessed at.
 */
export function orgSlugFromAddress(address: string, mailboxHash?: string): string | undefined {
  if (mailboxHash !== undefined && mailboxHash.trim() !== '') return normaliseSlug(mailboxHash);

  const match = /<?([^<>@\s]+)@/.exec(address.trim());
  const local = match?.[1];
  if (local === undefined) return undefined;

  const prefixed = /^u[-+](.+)$/i.exec(local);
  if (prefixed?.[1] !== undefined) return normaliseSlug(prefixed[1]);
  return undefined;
}

function normaliseSlug(raw: string): string | undefined {
  const slug = raw.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
  return slug === '' ? undefined : slug;
}

function domainOf(address: string): string {
  const match = /@([^<>@\s]+)>?\s*$/.exec(address.trim());
  return (match?.[1] ?? '').toLowerCase().replace(/>$/, '');
}

const FORWARD_MARKERS = [
  '-----original message-----',
  'begin forwarded message',
  '---------- forwarded message',
  'from:',
];

/**
 * Turns a Postmark inbound webhook body into something the pipeline can act on.
 *
 * Throws only when the email cannot be attributed to a tenant. Everything else —
 * failed authentication, no attachments, an unreadable body — is reported on the
 * result so the caller can decide, because refusing to parse would lose a
 * document a supplier really did send.
 */
export function parseInboundEmail(payload: PostmarkInboundPayload): InboundEmail {
  const to = payload.OriginalRecipient ?? payload.To ?? '';
  const orgSlug = orgSlugFromAddress(to, payload.MailboxHash);
  if (orgSlug === undefined) {
    throw new InboundEmailError(
      `cannot tell which tenant ${JSON.stringify(to)} belongs to: expected u-<org>@…`,
    );
  }

  const headers = payload.Headers ?? [];
  const authHeader = headerValue(headers, 'Authentication-Results');
  const receivedSpf = headerValue(headers, 'Received-SPF');

  const dkim = authResultFor(authHeader, 'dkim');
  const dmarc = authResultFor(authHeader, 'dmarc');
  let spf = authResultFor(authHeader, 'spf');
  if (spf === 'unknown' && receivedSpf !== undefined) {
    spf = /^\s*pass/i.test(receivedSpf) ? 'pass' : /^\s*(fail|softfail)/i.test(receivedSpf) ? 'fail' : 'unknown';
  }

  const textBody = payload.TextBody ?? payload.StrippedTextReply ?? '';
  const lowerBody = textBody.toLowerCase();

  const attachments: InboundAttachment[] = (payload.Attachments ?? [])
    .filter((a) => (a.Content ?? '') !== '')
    .map((a) => {
      const contentId = (a.ContentID ?? '').replace(/^<|>$/g, '');
      return {
        filename: a.Name ?? 'attachment',
        contentType: a.ContentType ?? 'application/octet-stream',
        base64: (a.Content ?? '').replace(/\s+/g, ''),
        byteSize: a.ContentLength ?? Math.floor(((a.Content ?? '').length * 3) / 4),
        ...(contentId !== '' ? { contentId } : {}),
        inline: contentId !== '',
      };
    });

  return {
    orgSlug,
    messageId: payload.MessageID ?? '',
    from: payload.From ?? '',
    fromDomain: domainOf(payload.From ?? ''),
    to,
    subject: payload.Subject ?? '',
    textBody,
    receivedAt: payload.Date ?? new Date().toISOString(),
    spf,
    dkim,
    dmarc,
    // SPF alone is not enough: it passes for anyone who can send from a
    // permitted envelope domain, including a shared relay.
    authenticated: dkim === 'pass' || dmarc === 'pass',
    attachments,
    forwarded: FORWARD_MARKERS.some((marker) => lowerBody.includes(marker)),
  };
}

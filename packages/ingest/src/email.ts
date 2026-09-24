/**
 * Email-in: what a Postmark inbound webhook says, read strictly (ADR 0047).
 *
 * Three rules, and each replaces a looser one this file used to have.
 *
 * **The tenant comes from the envelope, and only from a token.** The address
 * Postmark was handed (`OriginalRecipient`, the SMTP `RCPT TO`) must be on our
 * inbound domain, and its local part must be a 32-hex token the database
 * issued. `To`, `Cc` and `MailboxHash` are what the sender wrote, and a slug is
 * a guessable name; neither decides anything any more (§3).
 *
 * **What Postmark says about the sender is recorded, and gates nothing.**
 * Postmark sends no `Authentication-Results`; it adds SpamAssassin's
 * `X-Spam-*` headers and `Received-SPF`, and passes the sender's own headers
 * through. So aligned DKIM is read from exactly one `X-Spam-Tests`
 * (`DKIM_VALID_AU`), with the other two `X-Spam-*` headers present exactly
 * once, for exactly one author address — and even then it is shown to a person
 * rather than trusted, because a sender can supply the only copy of those
 * headers on a message Postmark did not scan (§7). No email opens a case by
 * itself.
 *
 * **A part is planned, not guessed at.** Each attachment is decoded only from
 * strict base64, a small image the HTML body shows inline is recorded and not
 * stored, and at most ten parts are stored per email (§8). Every refusal is an
 * outcome on the record, not a silence.
 */

export type DkimResult = 'pass' | 'fail' | 'none' | 'unknown';
export type SpfResult = 'pass' | 'fail' | 'softfail' | 'neutral' | 'none' | 'unknown';

interface PostmarkHeader {
  Name?: unknown;
  Value?: unknown;
}

interface PostmarkAttachment {
  Name?: unknown;
  Content?: unknown;
  ContentType?: unknown;
  ContentLength?: unknown;
  ContentID?: unknown;
}

interface PostmarkAddress {
  Email?: unknown;
  Name?: unknown;
}

/** The Postmark inbound webhook body, as far as this reads it. */
export interface PostmarkInboundPayload {
  MessageID?: unknown;
  From?: unknown;
  FromFull?: PostmarkAddress | unknown;
  OriginalRecipient?: unknown;
  TextBody?: unknown;
  HtmlBody?: unknown;
  StrippedTextReply?: unknown;
  Headers?: unknown;
  Attachments?: unknown;
}

/** The payload is not a shape we can read: a schema fault, answered 503 (§11). */
export class InboundPayloadError extends Error {
  override readonly name = 'InboundPayloadError';
}

// ---------------------------------------------------------------------------
// The recipient (§3)
// ---------------------------------------------------------------------------

export type RecipientParse =
  | { readonly kind: 'token'; readonly token: string }
  | { readonly kind: 'not_our_domain' }
  | { readonly kind: 'not_a_token' };

const TOKEN = /^[0-9a-f]{32}$/;

/**
 * The token in the envelope recipient, or why there is none.
 *
 * Lowercased, split at the last `@`; a domain other than ours is
 * `not_our_domain` (a misconfiguration, since only our Postmark server holds
 * the credential); a `+suffix` is dropped and never read; what remains must be
 * exactly a token. An empty recipient never falls through to `To`.
 */
export function tokenFromRecipient(
  originalRecipient: unknown,
  inboundDomain: string,
): RecipientParse {
  if (typeof originalRecipient !== 'string') return { kind: 'not_our_domain' };
  const address = originalRecipient.trim().toLowerCase();
  const at = address.lastIndexOf('@');
  if (at <= 0) return { kind: 'not_our_domain' };
  const domain = address.slice(at + 1);
  if (domain === '' || domain !== inboundDomain.trim().toLowerCase()) {
    return { kind: 'not_our_domain' };
  }
  const local = address.slice(0, at);
  const plus = local.indexOf('+');
  const token = plus === -1 ? local : local.slice(0, plus);
  return TOKEN.test(token) ? { kind: 'token', token } : { kind: 'not_a_token' };
}

// ---------------------------------------------------------------------------
// The verdict (§7)
// ---------------------------------------------------------------------------

export interface PostmarkVerdict {
  /** Aligned DKIM, as Postmark's SpamAssassin reported it. Nothing else. */
  readonly authenticated: boolean;
  readonly dkim: DkimResult;
  /** Postmark reports no DMARC verdict, and none is inferred. */
  readonly dmarc: 'unknown';
  readonly spf: SpfResult;
  readonly verdictSource: 'postmark_spamassassin';
  /** The author's domain, as the email claims it. Absent unless one address. */
  readonly senderDomain?: string;
}

function headersOf(payload: PostmarkInboundPayload): readonly { name: string; value: string }[] {
  if (!Array.isArray(payload.Headers)) return [];
  return (payload.Headers as PostmarkHeader[]).flatMap((h) =>
    typeof h?.Name === 'string' && typeof h.Value === 'string'
      ? [{ name: h.Name.trim().toLowerCase(), value: h.Value }]
      : [],
  );
}

function valuesOf(
  headers: readonly { name: string; value: string }[],
  name: string,
): readonly string[] {
  return headers.filter((h) => h.name === name).map((h) => h.value);
}

/** One RFC 5322 addr-spec, strictly: local@domain, no spaces, no second `@`. */
const ADDR_SPEC = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)$/;
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * The one author address, or undefined when there is not exactly one.
 *
 * SpamAssassin judges "author's domain" against the From header as it parses
 * it. With two authors it could validate one domain while we display the
 * other, so two is none: `FromFull.Email` must be one addr-spec, the legacy
 * `From` string must hold no second address, and `Headers` must not carry a
 * `From` of its own.
 */
function singleAuthor(
  payload: PostmarkInboundPayload,
  headers: readonly { name: string; value: string }[],
): string | undefined {
  const full = payload.FromFull as PostmarkAddress | undefined;
  const email = typeof full?.Email === 'string' ? full.Email.trim() : '';
  if (!ADDR_SPEC.test(email)) return undefined;
  const legacy = typeof payload.From === 'string' ? payload.From : '';
  if ((legacy.match(/@/g) ?? []).length > 1) return undefined;
  if (valuesOf(headers, 'from').length > 0) return undefined;
  return email;
}

function spfOf(values: readonly string[]): SpfResult {
  if (values.length !== 1) return values.length === 0 ? 'none' : 'unknown';
  const word = /^\s*([a-z]+)/i.exec(values[0] as string)?.[1]?.toLowerCase();
  switch (word) {
    case 'pass':
    case 'fail':
    case 'softfail':
    case 'neutral':
    case 'none':
      return word;
    default:
      return 'unknown';
  }
}

/** The DKIM tokens in one `X-Spam-Tests` value, unfolded and split exactly. */
function dkimFromTests(value: string): DkimResult {
  const tokens = new Set(
    value
      .replace(/\r?\n[ \t]+/g, ' ')
      .split(/[\s,]+/)
      .filter((t) => t !== ''),
  );
  if (tokens.has('DKIM_VALID_AU')) return 'pass';
  // Valid, but not for the author's domain: the case of a forger signing
  // with their own.
  if (tokens.has('DKIM_VALID')) return 'fail';
  if (tokens.has('DKIM_SIGNED')) return 'fail';
  return 'none';
}

export function postmarkVerdict(payload: PostmarkInboundPayload): PostmarkVerdict {
  const headers = headersOf(payload);
  const author = singleAuthor(payload, headers);
  const tests = valuesOf(headers, 'x-spam-tests');
  const scanWhole =
    tests.length === 1 &&
    valuesOf(headers, 'x-spam-status').length === 1 &&
    valuesOf(headers, 'x-spam-score').length === 1;

  // Unknown unless the scan headers are whole (one of each: a missing one is a
  // skipped scan, a second copy is somebody else's) and the author is one
  // address.
  const dkim: DkimResult =
    scanWhole && author !== undefined ? dkimFromTests(tests[0] as string) : 'unknown';

  const domain = author?.slice(author.lastIndexOf('@') + 1).toLowerCase();
  return {
    authenticated: dkim === 'pass',
    dkim,
    dmarc: 'unknown',
    spf: spfOf(valuesOf(headers, 'received-spf')),
    verdictSource: 'postmark_spamassassin',
    ...(domain !== undefined && HOSTNAME.test(domain) ? { senderDomain: domain } : {}),
  };
}

// ---------------------------------------------------------------------------
// The parts (§8)
// ---------------------------------------------------------------------------

/** At most this many parts of one email are stored; the rest are recorded. */
export const MAX_STORED_PARTS_PER_EMAIL = 10;

/** An image smaller than this that the HTML shows inline is a signature logo. */
export const INLINE_IMAGE_MAX_BYTES = 50 * 1024;

/** A part to ingest: bytes, as the sender named them. */
export interface InboundFilePart {
  readonly ordinal: number;
  readonly kind: 'attachment' | 'body';
  readonly filename: string;
  readonly declaredMimeType?: string;
  readonly bytes: Uint8Array;
}

/** A part recorded without being stored. */
export interface InboundRefusedPart {
  readonly ordinal: number;
  readonly kind: 'attachment' | 'inline';
  readonly filename: string;
  readonly outcome: 'inline_image' | 'too_many_parts' | 'not_base64';
}

export type InboundPartPlan = InboundFilePart | InboundRefusedPart;

export function isFilePart(part: InboundPartPlan): part is InboundFilePart {
  return !('outcome' in part);
}

const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Decoded only when every character is base64: `Buffer.from` drops the rest. */
function strictBase64(content: string): Uint8Array | undefined {
  const unwrapped = content.replace(/\r?\n/g, '');
  if (!STRICT_BASE64.test(unwrapped)) return undefined;
  return new Uint8Array(Buffer.from(unwrapped, 'base64'));
}

function referencedInline(html: string, contentId: string): boolean {
  const id = contentId.replace(/^<|>$/g, '').trim().toLowerCase();
  if (id === '') return false;
  return html.toLowerCase().includes(`cid:${id}`);
}

/**
 * Every part of an email, in the order Postmark lists them, then the body.
 *
 * An image under 50 KB whose `ContentID` the HTML references as `cid:` is a
 * signature logo: recorded as `inline_image`, not stored. Any other image —
 * including a phone photo Apple Mail or Outlook gave a Content-ID — is stored
 * like an attachment. Beyond ten stored parts the rest are `too_many_parts`.
 * The body is `TextBody`, else `StrippedTextReply`, and it is a part too.
 */
export function planParts(payload: PostmarkInboundPayload): readonly InboundPartPlan[] {
  if (payload.Attachments !== undefined && !Array.isArray(payload.Attachments)) {
    throw new InboundPayloadError('Attachments is not a list');
  }
  const html = typeof payload.HtmlBody === 'string' ? payload.HtmlBody : '';
  const plans: InboundPartPlan[] = [];
  let stored = 0;
  let ordinal = 0;

  for (const raw of (payload.Attachments ?? []) as PostmarkAttachment[]) {
    const filename = typeof raw?.Name === 'string' && raw.Name.trim() !== '' ? raw.Name : 'attachment';
    const contentType = typeof raw?.ContentType === 'string' ? raw.ContentType : undefined;
    const content = typeof raw?.Content === 'string' ? raw.Content : '';
    const contentId = typeof raw?.ContentID === 'string' ? raw.ContentID : '';
    const at = ordinal++;

    const bytes = strictBase64(content);
    if (bytes === undefined) {
      plans.push({ ordinal: at, kind: 'attachment', filename, outcome: 'not_base64' });
      continue;
    }
    if (
      contentType?.toLowerCase().startsWith('image/') === true &&
      bytes.byteLength < INLINE_IMAGE_MAX_BYTES &&
      referencedInline(html, contentId)
    ) {
      plans.push({ ordinal: at, kind: 'inline', filename, outcome: 'inline_image' });
      continue;
    }
    if (stored >= MAX_STORED_PARTS_PER_EMAIL) {
      plans.push({ ordinal: at, kind: 'attachment', filename, outcome: 'too_many_parts' });
      continue;
    }
    stored += 1;
    plans.push({
      ordinal: at,
      kind: 'attachment',
      filename,
      ...(contentType !== undefined ? { declaredMimeType: contentType } : {}),
      bytes,
    });
  }

  const text =
    typeof payload.TextBody === 'string' && payload.TextBody.trim() !== ''
      ? payload.TextBody
      : typeof payload.StrippedTextReply === 'string'
        ? payload.StrippedTextReply
        : '';
  if (text.trim() !== '') {
    plans.push({
      ordinal: ordinal++,
      kind: 'body',
      filename: 'email-body.txt',
      bytes: new TextEncoder().encode(text),
    });
  }
  return plans;
}

// ---------------------------------------------------------------------------
// The whole email
// ---------------------------------------------------------------------------

export interface InboundEmail {
  /** Postmark's MessageID: its own UUID, not the sender's Message-ID header. */
  readonly providerMessageId: string;
  readonly recipient: RecipientParse;
  readonly verdict: PostmarkVerdict;
  readonly parts: readonly InboundPartPlan[];
}

/**
 * Reads a Postmark inbound payload. Throws `InboundPayloadError` only for a
 * shape we cannot read at all (not an object, no MessageID, Attachments not a
 * list). Everything else — no token, no verdict, a refused part — is on the
 * result, because refusing to parse would lose a document a supplier sent.
 */
export function parsePostmarkInbound(payload: unknown, inboundDomain: string): InboundEmail {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new InboundPayloadError('the payload is not a JSON object');
  }
  const body = payload as PostmarkInboundPayload;
  if (typeof body.MessageID !== 'string' || body.MessageID.trim() === '') {
    throw new InboundPayloadError('the payload carries no MessageID');
  }
  return {
    providerMessageId: body.MessageID.trim(),
    recipient: tokenFromRecipient(body.OriginalRecipient, inboundDomain),
    verdict: postmarkVerdict(body),
    parts: planParts(body),
  };
}

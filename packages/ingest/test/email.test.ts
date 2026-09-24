import { describe, expect, it } from 'vitest';
import { renderTextPdf } from '@recouple/fixtures';
import {
  INLINE_IMAGE_MAX_BYTES,
  InboundPayloadError,
  MAX_STORED_PARTS_PER_EMAIL,
  isFilePart,
  parsePostmarkInbound,
  planParts,
  postmarkVerdict,
  tokenFromRecipient,
  type PostmarkInboundPayload,
} from '../src/email';

/**
 * The Postmark inbound payload, read strictly (ADR 0047 §3, §7, §8).
 *
 * These payloads are hand-written to Postmark's documented shape. The founder's
 * test sends (ADR 0047, "What the founder does", steps 6–9) are to be committed
 * as recorded fixtures and asserted here too: hand-written payloads are how the
 * previous parser shipped reading a header Postmark never sends.
 */
const DOMAIN = 'in.mozart.example';
const TOKEN = '0123456789abcdef0123456789abcdef';

const pdfBase64 = () =>
  Buffer.from(renderTextPdf([['Deduction Notice', 'Claim: DN-1']])).toString('base64');

const SCANNED = [
  { Name: 'X-Spam-Status', Value: 'No' },
  { Name: 'X-Spam-Score', Value: '-0.1' },
  { Name: 'X-Spam-Tests', Value: 'DKIM_SIGNED,DKIM_VALID,DKIM_VALID_AU,SPF_PASS' },
  { Name: 'Received-SPF', Value: 'Pass (sender SPF authorized) identity=mailfrom; client-ip=192.0.2.1' },
];

const payload = (overrides: Partial<PostmarkInboundPayload> = {}): PostmarkInboundPayload => ({
  MessageID: '0a1b2c3d-0000-4000-8000-000000000001',
  From: 'ap@harborlane.example',
  FromFull: { Email: 'ap@harborlane.example', Name: 'Harbor Lane AP' },
  OriginalRecipient: `${TOKEN}@${DOMAIN}`,
  TextBody: 'Please see the attached notice.',
  HtmlBody: '<p>Please see the attached notice.</p>',
  Headers: SCANNED,
  Attachments: [{ Name: 'notice.pdf', Content: pdfBase64(), ContentType: 'application/pdf' }],
  ...overrides,
});

describe('which tenant an email is for', () => {
  it('reads a token from the envelope recipient on our domain', () => {
    expect(tokenFromRecipient(`${TOKEN}@${DOMAIN}`, DOMAIN)).toEqual({ kind: 'token', token: TOKEN });
    expect(tokenFromRecipient(`${TOKEN.toUpperCase()}@IN.MOZART.EXAMPLE`, DOMAIN)).toEqual({
      kind: 'token',
      token: TOKEN,
    });
  });

  it('ignores a +suffix, and never reads it', () => {
    expect(tokenFromRecipient(`${TOKEN}+invoices@${DOMAIN}`, DOMAIN)).toEqual({ kind: 'token', token: TOKEN });
  });

  it('refuses another domain, and an empty recipient, as not ours', () => {
    expect(tokenFromRecipient(`${TOKEN}@attacker.example`, DOMAIN)).toEqual({ kind: 'not_our_domain' });
    expect(tokenFromRecipient(`${TOKEN}@sub.${DOMAIN}`, DOMAIN)).toEqual({ kind: 'not_our_domain' });
    expect(tokenFromRecipient('', DOMAIN)).toEqual({ kind: 'not_our_domain' });
    expect(tokenFromRecipient(undefined, DOMAIN)).toEqual({ kind: 'not_our_domain' });
  });

  it('refuses a slug or anything else that is not a token', () => {
    expect(tokenFromRecipient(`u-northstar@${DOMAIN}`, DOMAIN)).toEqual({ kind: 'not_a_token' });
    expect(tokenFromRecipient(`${TOKEN.slice(1)}@${DOMAIN}`, DOMAIN)).toEqual({ kind: 'not_a_token' });
  });

  it('takes the tenant from OriginalRecipient alone, never To or MailboxHash', () => {
    const email = parsePostmarkInbound(
      { ...payload({ OriginalRecipient: '' }), To: `${TOKEN}@${DOMAIN}`, MailboxHash: TOKEN } as PostmarkInboundPayload,
      DOMAIN,
    );
    expect(email.recipient).toEqual({ kind: 'not_our_domain' });
  });
});

describe('what Postmark says about the sender', () => {
  it('reads aligned DKIM as a pass, and records the author domain as a claim', () => {
    expect(postmarkVerdict(payload())).toEqual({
      authenticated: true,
      dkim: 'pass',
      dmarc: 'unknown',
      spf: 'pass',
      verdictSource: 'postmark_spamassassin',
      senderDomain: 'harborlane.example',
    });
  });

  it('calls a valid signature for somebody else’s domain a fail', () => {
    const tests = { Name: 'X-Spam-Tests', Value: 'DKIM_SIGNED,DKIM_VALID,SPF_PASS' };
    const verdict = postmarkVerdict(payload({ Headers: [...SCANNED.filter((h) => h.Name !== 'X-Spam-Tests'), tests] }));
    expect(verdict).toMatchObject({ dkim: 'fail', authenticated: false });
  });

  it('calls a signature that did not verify a fail, and no signature none', () => {
    const signed = { Name: 'X-Spam-Tests', Value: 'DKIM_SIGNED,SPF_PASS' };
    const none = { Name: 'X-Spam-Tests', Value: 'SPF_PASS,HTML_MESSAGE' };
    const base = SCANNED.filter((h) => h.Name !== 'X-Spam-Tests');
    expect(postmarkVerdict(payload({ Headers: [...base, signed] })).dkim).toBe('fail');
    expect(postmarkVerdict(payload({ Headers: [...base, none] })).dkim).toBe('none');
  });

  it('reads a folded, mixed-case X-Spam-Tests header by exact token', () => {
    const folded = [
      { Name: 'x-spam-status', Value: 'No' },
      { Name: 'X-SPAM-SCORE', Value: '0' },
      { Name: 'x-Spam-Tests', Value: 'DKIM_SIGNED,DKIM_VALID,\r\n\tDKIM_VALID_AU,SPF_PASS' },
    ];
    expect(postmarkVerdict(payload({ Headers: folded })).dkim).toBe('pass');
  });

  it('does not match a lookalike token', () => {
    const lookalike = { Name: 'X-Spam-Tests', Value: 'XDKIM_VALID_AU,DKIM_VALID_AUX,SPF_PASS' };
    const base = SCANNED.filter((h) => h.Name !== 'X-Spam-Tests');
    expect(postmarkVerdict(payload({ Headers: [...base, lookalike] })).dkim).toBe('none');
  });

  it('knows nothing when a scan header is missing: the scan was skipped or incomplete', () => {
    const noScore = SCANNED.filter((h) => h.Name !== 'X-Spam-Score');
    expect(postmarkVerdict(payload({ Headers: noScore }))).toMatchObject({
      dkim: 'unknown',
      authenticated: false,
    });
  });

  it('knows nothing when a scan header is doubled: somebody else wrote one', () => {
    const forged = { Name: 'X-Spam-Tests', Value: 'DKIM_VALID_AU' };
    expect(postmarkVerdict(payload({ Headers: [...SCANNED, forged] }))).toMatchObject({
      dkim: 'unknown',
      authenticated: false,
    });
  });

  it('authenticates nothing from a forged Authentication-Results, which it no longer reads', () => {
    // The header the previous parser trusted with no verifier pinned: a sender
    // could write it, and Postmark never did.
    const forged = [{ Name: 'Authentication-Results', Value: 'x; dkim=pass header.d=harborlane.example; dmarc=pass' }];
    expect(postmarkVerdict(payload({ Headers: forged }))).toMatchObject({
      dkim: 'unknown',
      dmarc: 'unknown',
      authenticated: false,
    });
  });

  it('knows nothing when there are two authors, or a From header of the sender’s own', () => {
    expect(
      postmarkVerdict(payload({ From: 'ap@harborlane.example, ceo@elsewhere.example' })),
    ).toMatchObject({ dkim: 'unknown', authenticated: false });
    expect(
      postmarkVerdict(payload({ Headers: [...SCANNED, { Name: 'From', Value: 'x@y.example' }] })),
    ).toMatchObject({ dkim: 'unknown' });
    expect(postmarkVerdict(payload({ FromFull: { Email: 'not an address' } }))).toMatchObject({
      dkim: 'unknown',
    });
    expect(postmarkVerdict(payload({ FromFull: { Email: 'not an address' } })).senderDomain).toBeUndefined();
  });

  it('never takes the domain from a display name', () => {
    const verdict = postmarkVerdict(
      payload({ FromFull: { Email: 'ap@harborlane.example', Name: 'billing@bank.example' } }),
    );
    expect(verdict.senderDomain).toBe('harborlane.example');
  });

  it('reads SPF from exactly one Received-SPF, and it never authenticates on its own', () => {
    const noDkim = [
      ...SCANNED.filter((h) => h.Name !== 'X-Spam-Tests'),
      { Name: 'X-Spam-Tests', Value: 'SPF_PASS' },
    ];
    expect(postmarkVerdict(payload({ Headers: noDkim }))).toMatchObject({
      spf: 'pass',
      authenticated: false,
    });
    expect(
      postmarkVerdict(payload({ Headers: [...SCANNED, { Name: 'Received-SPF', Value: 'Pass' }] })).spf,
    ).toBe('unknown');
  });
});

describe('the parts of an email', () => {
  it('stores an attachment and the body, in order', () => {
    const parts = planParts(payload());
    expect(parts.map((p) => [p.ordinal, p.kind, isFilePart(p)])).toEqual([
      [0, 'attachment', true],
      [1, 'body', true],
    ]);
  });

  it('records a small image the HTML shows inline, and stores it only if it is not', () => {
    const logo = Buffer.alloc(2_000, 1).toString('base64');
    const parts = planParts(
      payload({
        HtmlBody: '<img src="cid:logo@x">',
        Attachments: [
          { Name: 'logo.png', Content: logo, ContentType: 'image/png', ContentID: '<logo@x>' },
          { Name: 'photo.jpg', Content: logo, ContentType: 'image/jpeg', ContentID: 'photo@x' },
        ],
      }),
    );
    expect(parts[0]).toMatchObject({ kind: 'inline', outcome: 'inline_image' });
    // Given a Content-ID but not shown inline: an attached photo, stored.
    expect(isFilePart(parts[1]!)).toBe(true);
  });

  it('stores an iPhone photo with a Content-ID and no cid: reference, however large', () => {
    const photo = Buffer.alloc(2 * 1024 * 1024, 7).toString('base64');
    const parts = planParts(
      payload({
        HtmlBody: '<p>see photo</p>',
        Attachments: [{ Name: 'IMG_0001.jpeg', Content: photo, ContentType: 'image/jpeg', ContentID: 'ABC-123' }],
      }),
    );
    expect(isFilePart(parts[0]!)).toBe(true);
  });

  it('stores a referenced image at or over the inline limit', () => {
    const big = Buffer.alloc(INLINE_IMAGE_MAX_BYTES, 1).toString('base64');
    const parts = planParts(
      payload({
        HtmlBody: '<img src="cid:big">',
        Attachments: [{ Name: 'scan.png', Content: big, ContentType: 'image/png', ContentID: 'big' }],
      }),
    );
    expect(isFilePart(parts[0]!)).toBe(true);
  });

  it('records content that is not strict base64 instead of decoding what it can', () => {
    const parts = planParts(
      payload({ Attachments: [{ Name: 'x.pdf', Content: 'JVBERi0x!!not base64', ContentType: 'application/pdf' }] }),
    );
    expect(parts[0]).toMatchObject({ outcome: 'not_base64' });
  });

  it('stores ten parts and records the rest', () => {
    const attachments = Array.from({ length: MAX_STORED_PARTS_PER_EMAIL + 2 }, (_, i) => ({
      Name: `n${i}.pdf`,
      Content: pdfBase64(),
      ContentType: 'application/pdf',
    }));
    const parts = planParts(payload({ Attachments: attachments }));
    const stored = parts.filter((p) => isFilePart(p) && p.kind === 'attachment');
    expect(stored).toHaveLength(MAX_STORED_PARTS_PER_EMAIL);
    expect(parts.filter((p) => 'outcome' in p && p.outcome === 'too_many_parts')).toHaveLength(2);
  });

  it('falls back to the stripped reply for the body, and has no body when both are empty', () => {
    const reply = planParts(payload({ TextBody: '', StrippedTextReply: 'Deduction DN-1 of $40.00' }));
    expect(reply.at(-1)).toMatchObject({ kind: 'body' });
    const none = planParts(payload({ TextBody: '', StrippedTextReply: '' }));
    expect(none.some((p) => p.kind === 'body')).toBe(false);
  });
});

describe('a payload we cannot read', () => {
  it('is refused by name when it is not an object, has no MessageID, or Attachments is not a list', () => {
    expect(() => parsePostmarkInbound(null, DOMAIN)).toThrow(InboundPayloadError);
    expect(() => parsePostmarkInbound([], DOMAIN)).toThrow(InboundPayloadError);
    expect(() => parsePostmarkInbound(payload({ MessageID: '' }), DOMAIN)).toThrow(InboundPayloadError);
    expect(() => parsePostmarkInbound(payload({ Attachments: 'x' }), DOMAIN)).toThrow(InboundPayloadError);
  });
});

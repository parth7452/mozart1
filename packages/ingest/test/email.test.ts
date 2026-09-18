import { describe, expect, it } from 'vitest';
import { renderTextPdf } from '@recouple/fixtures';
import {
  InboundEmailError,
  authResultFor,
  orgSlugFromAddress,
  parseInboundEmail,
  type PostmarkInboundPayload,
} from '../src/email';

const pdfBase64 = () =>
  Buffer.from(renderTextPdf([['Deduction Notice', 'Claim: DN-1']])).toString('base64');

const payload = (overrides: Partial<PostmarkInboundPayload> = {}): PostmarkInboundPayload => ({
  From: 'ap@harborlane.example',
  To: 'u-northstar@in.recouple.app',
  Subject: 'Deduction notice DN-2609-001',
  MessageID: 'msg-1',
  Date: '2026-09-18T09:00:00Z',
  TextBody: 'Please see the attached notice.',
  Headers: [
    {
      Name: 'Authentication-Results',
      Value: 'mx.recouple.app; spf=pass smtp.mailfrom=harborlane.example; dkim=pass header.d=harborlane.example; dmarc=pass',
    },
  ],
  Attachments: [
    { Name: 'notice.pdf', Content: pdfBase64(), ContentType: 'application/pdf', ContentLength: 900 },
  ],
  ...overrides,
});

describe('which tenant an email belongs to', () => {
  it('reads the slug out of the address it was sent to', () => {
    expect(orgSlugFromAddress('u-northstar@in.recouple.app')).toBe('northstar');
    expect(orgSlugFromAddress('U+Northstar@in.recouple.app')).toBe('northstar');
    expect(orgSlugFromAddress('"AP" <u-northstar@in.recouple.app>')).toBe('northstar');
  });

  it('prefers the mailbox hash when the provider supplies one', () => {
    expect(orgSlugFromAddress('inbound@in.recouple.app', 'northstar')).toBe('northstar');
  });

  it('refuses an address with no tenant in it rather than guessing', () => {
    expect(orgSlugFromAddress('support@in.recouple.app')).toBeUndefined();
    expect(() => parseInboundEmail(payload({ To: 'support@in.recouple.app' }))).toThrow(
      InboundEmailError,
    );
  });

  it('takes the tenant from the recipient, never from the sender', () => {
    // A sender claiming to be another tenant changes nothing.
    const email = parseInboundEmail(
      payload({ From: 'u-someone-else@in.recouple.app', To: 'u-northstar@in.recouple.app' }),
    );
    expect(email.orgSlug).toBe('northstar');
  });

  it('uses the original recipient when the mail was forwarded by a rule', () => {
    const email = parseInboundEmail(
      payload({ To: 'relay@postmarkapp.com', OriginalRecipient: 'u-acme@in.recouple.app' }),
    );
    expect(email.orgSlug).toBe('acme');
  });
});

describe('whether the sender is who they say', () => {
  it('reads each method out of the Authentication-Results header', () => {
    const header = 'mx; spf=pass; dkim=fail header.d=x; dmarc=none';
    expect(authResultFor(header, 'spf')).toBe('pass');
    expect(authResultFor(header, 'dkim')).toBe('fail');
    expect(authResultFor(header, 'dmarc')).toBe('none');
    expect(authResultFor(undefined, 'dkim')).toBe('unknown');
  });

  it('counts an email as authenticated when DKIM passes', () => {
    expect(parseInboundEmail(payload()).authenticated).toBe(true);
  });

  it('does not count SPF alone as authentication', () => {
    // SPF passes for anyone who can send from a permitted envelope domain,
    // including a shared relay, so it cannot stand in for DKIM.
    const email = parseInboundEmail(
      payload({
        Headers: [
          { Name: 'Authentication-Results', Value: 'mx; spf=pass smtp.mailfrom=relay.example' },
        ],
      }),
    );
    expect(email.spf).toBe('pass');
    expect(email.dkim).toBe('unknown');
    expect(email.authenticated).toBe(false);
  });

  it('treats a failed DKIM as unauthenticated, not as a reason to drop the mail', () => {
    const email = parseInboundEmail(
      payload({
        Headers: [{ Name: 'Authentication-Results', Value: 'mx; spf=fail; dkim=fail; dmarc=fail' }],
      }),
    );
    expect(email.authenticated).toBe(false);
    // The documents may still be real; they are parsed and left for a human.
    expect(email.attachments).toHaveLength(1);
  });

  it('falls back to Received-SPF when there is no Authentication-Results', () => {
    const email = parseInboundEmail(
      payload({
        Headers: [{ Name: 'Received-SPF', Value: 'Pass (mailfrom) identity=mailfrom' }],
      }),
    );
    expect(email.spf).toBe('pass');
    expect(email.authenticated).toBe(false);
  });
});

describe('what the email carries', () => {
  it('collects attachments with their bytes and type', () => {
    const email = parseInboundEmail(payload());
    expect(email.attachments[0]).toMatchObject({
      filename: 'notice.pdf',
      contentType: 'application/pdf',
      inline: false,
    });
    expect(Buffer.from(email.attachments[0]!.base64, 'base64').subarray(0, 5).toString()).toBe(
      '%PDF-',
    );
  });

  it('marks an embedded image as inline rather than as an attachment', () => {
    const email = parseInboundEmail(
      payload({
        Attachments: [
          { Name: 'sig.png', Content: 'iVBORw0KGgo=', ContentType: 'image/png', ContentID: '<sig@mail>' },
        ],
      }),
    );
    expect(email.attachments[0]?.inline).toBe(true);
    expect(email.attachments[0]?.contentId).toBe('sig@mail');
  });

  it('skips an attachment with no content at all', () => {
    const email = parseInboundEmail(
      payload({ Attachments: [{ Name: 'empty.pdf', Content: '', ContentType: 'application/pdf' }] }),
    );
    expect(email.attachments).toHaveLength(0);
  });

  it('notices a forwarded chain', () => {
    expect(parseInboundEmail(payload()).forwarded).toBe(false);
    expect(
      parseInboundEmail(
        payload({ TextBody: 'FYI\n\n---------- Forwarded message ---------\nFrom: ap@x' }),
      ).forwarded,
    ).toBe(true);
  });

  it('survives a payload missing almost everything', () => {
    const email = parseInboundEmail({ To: 'u-acme@in.recouple.app' });
    expect(email.orgSlug).toBe('acme');
    expect(email.attachments).toEqual([]);
    expect(email.authenticated).toBe(false);
  });
});

describe('a forged Authentication-Results header', () => {
  const withHeader = (value: string) =>
    parseInboundEmail(payload({ Headers: [{ Name: 'Authentication-Results', Value: value }] }));

  it('cannot smuggle a verdict through the envelope sender', () => {
    // `=` is legal in a local part, so an attacker sends from
    // bounce+dkim=pass@evil.example and the genuine header reads
    // "spf=pass smtp.mailfrom=bounce+dkim=pass@evil.example; dkim=fail".
    // Scanning the whole header for "dkim=..." reads the envelope, not the verdict.
    const header =
      'spf.postmarkapp.com; spf=pass smtp.mailfrom=bounce+dkim=pass@evil.example; ' +
      'dkim=fail (bad signature); dmarc=fail';
    expect(authResultFor(header, 'dkim')).toBe('fail');
    expect(authResultFor(header, 'dmarc')).toBe('fail');
    expect(withHeader(header).authenticated).toBe(false);
  });

  it('reads only the leading token of each clause', () => {
    const header = 'mx; dkim=fail header.d=evil.example reason="dkim=pass"; dmarc=fail';
    expect(authResultFor(header, 'dkim')).toBe('fail');
  });

  it('ignores a header from a verifier we do not trust, when one is named', () => {
    // A sender may add their own Authentication-Results; only ours counts.
    const forged = 'anything-i-want; dkim=pass; dmarc=pass';
    expect(authResultFor(forged, 'dkim')).toBe('pass'); // with no verifier pinned
    expect(authResultFor(forged, 'dkim', 'mx.recouple.app')).toBe('unknown');
    expect(
      parseInboundEmail(
        payload({ Headers: [{ Name: 'Authentication-Results', Value: forged }] }),
        { trustedAuthservId: 'mx.recouple.app' },
      ).authenticated,
    ).toBe(false);
  });

  it('still reads a genuine header from the verifier we do trust', () => {
    const genuine = 'mx.recouple.app; spf=pass smtp.mailfrom=harborlane.example; dkim=pass; dmarc=pass';
    expect(authResultFor(genuine, 'dkim', 'mx.recouple.app')).toBe('pass');
    expect(
      parseInboundEmail(
        payload({ Headers: [{ Name: 'Authentication-Results', Value: genuine }] }),
        { trustedAuthservId: 'mx.recouple.app' },
      ).authenticated,
    ).toBe(true);
  });

  it('treats a clause with no verdict as unknown, not as a pass', () => {
    expect(authResultFor('mx; dkim', 'dkim')).toBe('unknown');
    expect(authResultFor('mx;', 'dkim')).toBe('unknown');
    expect(authResultFor('', 'dkim')).toBe('unknown');
  });
});

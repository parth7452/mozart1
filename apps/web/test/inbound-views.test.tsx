import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { UnattachedDocument } from '@recouple/pipeline';
import type { FiledNothingByAddress, InboundAddressRow } from '@recouple/store-postgres';
import {
  EmailThatFiledNothing,
  emailLine,
  filedNothingSentence,
  InboundEmailPage,
  type InboundDeployment,
} from '../components/inbound-email';
import { UnattachedDocuments } from '../components/unattached-documents';

/**
 * Email-in as a person sees it (ADR 0047 §4, §7, §11): pure views over what
 * the store returned. What matters is who sees an address, that every row is
 * worded as a fact, and that the two pieces of a stranger's text — a filename
 * and a claimed sender domain — are text and not markup.
 */

const TODAY = new Date('2026-09-24T12:00:00Z');
const VIEWER_ID = '22222222-2222-2222-2222-222222222222';
const DOMAIN = 'in.mozart.example';
const TOKEN = '0123456789abcdef0123456789abcdef';

function address(overrides: Partial<InboundAddressRow> = {}): InboundAddressRow {
  return {
    addressId: '44444444-4444-4444-4444-444444444444',
    token: TOKEN,
    createdBy: VIEWER_ID,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    actingMember: VIEWER_ID,
    actingMemberEmail: 'owner@example.test',
    actingMemberMayWrite: true,
    lastReceivedAt: new Date('2026-09-23T15:00:00Z'),
    refusedSinceRetired: 0,
    ...overrides,
  };
}

function page(
  overrides: Partial<Parameters<typeof InboundEmailPage>[0]> & { role?: string } = {},
): string {
  const { role = 'owner', ...rest } = overrides;
  return renderToStaticMarkup(
    <InboundEmailPage
      viewer={{ email: 'owner@example.test', orgName: 'Acme', role }}
      viewerUserId={VIEWER_ID}
      deployment={{ kind: 'bound', domain: DOMAIN }}
      addresses={[address()]}
      mayWriteHere
      mayManage
      filedNothing={[]}
      today={TODAY}
      {...rest}
    />,
  );
}

describe('Settings → Email', () => {
  it('shows an owner each live address, who it acts as, when it last had mail, and the size limit', () => {
    const html = page();
    expect(html).toContain(`${TOKEN}@${DOMAIN}`);
    expect(html).toContain('Acts as owner@example.test');
    expect(html).toContain('Last received mail: 2026-09-23');
    expect(html).toContain('Attachments up to about 3 MB in total; larger files by upload.');
    expect(html).toContain('/settings/email/issue');
    expect(html).toContain('/settings/email/retire');
    // Already acts as the viewer: nothing to adopt.
    expect(html).not.toContain('/settings/email/adopt');
    // Mail yesterday: retiring asks first.
    expect(html).toContain('Retire…');
  });

  it('offers adoption of an address that acts as someone else', () => {
    const html = page({ addresses: [address({ actingMember: '33333333-3333-3333-3333-333333333333' })] });
    expect(html).toContain('/settings/email/adopt');
    expect(html).toContain('Adopt: act as me');
  });

  it('warns that an address whose member may no longer write accepts nothing', () => {
    const html = page({ addresses: [address({ actingMemberMayWrite: false, actingMemberEmail: 'left@example.test' })] });
    expect(html).toContain('Not accepting mail:');
    expect(html).toContain('left@example.test can no longer add documents here');
    expect(html).toContain('An owner should adopt this address.');
  });

  it('shows a writer the addresses and no buttons', () => {
    const html = page({ role: 'analyst', mayManage: false });
    expect(html).toContain(`${TOKEN}@${DOMAIN}`);
    expect(html).not.toContain('/settings/email/issue');
    expect(html).not.toContain('/settings/email/retire');
  });

  it('tells a read_only member how many addresses there are, and not what they are', () => {
    const html = page({ role: 'read_only', mayManage: false, mayWriteHere: false });
    expect(html).toContain('This workspace has 1 live address.');
    expect(html).not.toContain(TOKEN);
    expect(html).not.toContain('Retired');
  });

  it('lists retired addresses with the mail refused since', () => {
    const html = page({
      addresses: [
        address(),
        address({
          addressId: '55555555-5555-5555-5555-555555555555',
          token: 'fedcba9876543210fedcba9876543210',
          retiredAt: new Date('2026-09-10T00:00:00Z'),
          retiredBy: VIEWER_ID,
          refusedSinceRetired: 3,
          lastRefusedAt: new Date('2026-09-22T00:00:00Z'),
        }),
      ],
    });
    expect(html).toContain('fedcba9876543210fedcba9876543210@in.mozart.example</span> · retired 2026-09-10');
    expect(html).toContain('3 emails reached it after it was retired and were refused; the last on 2026-09-22.');
  });

  it('asks an owner to confirm retiring an address still in use', () => {
    const html = page({ confirmRetire: '44444444-4444-4444-4444-444444444444' });
    expect(html).toContain('Retire an address still in use?');
    expect(html).toContain('name="confirmed" value="yes"');
    // Not for an id that is no live address of this workspace.
    expect(page({ confirmRetire: '99999999-9999-9999-9999-999999999999' })).not.toContain(
      'Retire an address still in use?',
    );
  });

  it('says where a deployment receives no email, and shows the token alone', () => {
    const none: InboundDeployment = { kind: 'none' };
    const html = page({ deployment: none });
    expect(html).toContain('This deployment does not receive email');
    expect(html).toContain(`<strong class="mono">${TOKEN}</strong>`);
  });

  it('names a misconfiguration’s setting to an owner only', () => {
    const wrong: InboundDeployment = { kind: 'misconfigured', reason: 'INBOUND_DOMAIN is not set, and the other is' };
    expect(page({ deployment: wrong })).toContain('For your administrator: INBOUND_DOMAIN is not set');
    expect(page({ deployment: wrong, role: 'analyst', mayManage: false })).not.toContain('INBOUND_DOMAIN');
  });

  it('says what a notice key means, and nothing for a key it does not know', () => {
    expect(page({ notice: 'email_issued' })).toContain('a new address is issued.');
    expect(page({ notice: 'you have been hacked' })).not.toContain('hacked');
  });
});

const filed = (overrides: Partial<FiledNothingByAddress> = {}): FiledNothingByAddress => ({
  addressId: '44444444-4444-4444-4444-444444444444',
  token: TOKEN,
  retired: false,
  beyond: 0,
  emails: [
    {
      inboundMessageId: '66666666-6666-6666-6666-666666666666',
      outcome: 'received',
      at: '2026-09-23T15:00:00.000Z',
      senderDomain: 'payer.example',
      parts: [
        { ordinal: 0, kind: 'attachment', outcome: 'not_clean', filename: '<img src=x onerror=alert(1)>.pdf' },
        { ordinal: 1, kind: 'body', outcome: 'body_too_short', filename: 'email-body.txt' },
      ],
    },
  ],
  ...overrides,
});

describe('Email that filed nothing', () => {
  it('says what arrived and why it filed nothing, as facts, with a stranger’s filename as text', () => {
    const html = renderToStaticMarkup(<EmailThatFiledNothing groups={[filed()]} domain={DOMAIN} />);
    expect(html).toContain('Email that filed nothing');
    expect(html).toContain(`${TOKEN}@${DOMAIN}`);
    expect(html).toContain('An email to this address on 2026-09-23 filed nothing.');
    expect(html).toContain('From payer.example — as the email claims, unverified.');
    expect(html).toContain('refused by the virus scan');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;.pdf');
    expect(html).not.toContain('<img');
    // A body part is named as the message, not by the file name we gave it.
    expect(html).toContain('the message itself: too short to be a notice');
    expect(html).not.toContain('email-body.txt');
  });

  it('words a lost email and a refused one as what happened, never as an errand', () => {
    expect(
      filedNothingSentence({ inboundMessageId: 'm', outcome: 'not_received', at: '2026-09-20T04:00:00.000Z', parts: [] }),
    ).toBe(
      'An email to this address on 2026-09-20 did not reach us. Postmark could not deliver it here; ' +
        'the usual cause is attachments over about 3 MB in total.',
    );
    expect(
      filedNothingSentence({ inboundMessageId: 'm', outcome: 'refused_retired', at: '2026-09-21T10:00:00.000Z', parts: [] }),
    ).toBe('An email to this address on 2026-09-21 was refused: the address is retired.');
  });

  it('counts what it does not list, and draws nothing when there is nothing', () => {
    const html = renderToStaticMarkup(<EmailThatFiledNothing groups={[filed({ beyond: 4 })]} domain={DOMAIN} />);
    expect(html).toContain('And 4 more to this address in the last 30 days.');
    expect(renderToStaticMarkup(<EmailThatFiledNothing groups={[]} domain={DOMAIN} />)).toBe('');
  });
});

describe('a held document that came by email (§7)', () => {
  it('says the claimed sender and Postmark’s DKIM report, in three words', () => {
    expect(emailLine({ dkim: 'pass', senderDomain: 'harborlane.example' })).toBe(
      'By email · from harborlane.example (as the email claims) · aligned DKIM per Postmark: yes',
    );
    expect(emailLine({ dkim: 'fail', senderDomain: 'harborlane.example' })).toMatch(/: no$/);
    expect(emailLine({ dkim: 'none', senderDomain: 'harborlane.example' })).toMatch(/: no$/);
    expect(emailLine({ dkim: 'unknown' })).toBe(
      'By email · the sender is not one address · aligned DKIM per Postmark: unknown',
    );
  });

  it('shows it under the hold on the list', () => {
    const document: UnattachedDocument = {
      documentId: '77777777-7777-7777-7777-777777777777',
      filename: 'notice.pdf',
      createdAt: '2026-09-24T10:00:00.000Z',
      docType: 'deduction_notice',
      confidence: 0.99,
      hold: {
        documentId: '77777777-7777-7777-7777-777777777777',
        orgId: '11111111-1111-1111-1111-111111111111',
        docType: 'deduction_notice',
        confidence: 0.99,
        floor: 0.95,
        reason: 'by_email',
      },
      email: { dkim: 'pass', senderDomain: 'harborlane.example' },
    };
    const html = renderToStaticMarkup(
      <UnattachedDocuments documents={[document]} targets={{ rows: [], total: 0, limit: 250 }} />,
    );
    expect(html).toContain('it arrived by email');
    expect(html).toContain('By email · from harborlane.example (as the email claims) · aligned DKIM per Postmark: yes');
    expect(html).toContain('/documents/77777777-7777-7777-7777-777777777777/open-case');
  });
});

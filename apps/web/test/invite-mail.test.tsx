import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RESEND_API_URL } from '../lib/alerts';
import { inviteMailFromEnv, sendInvitation, type InviteMailBinding } from '../lib/invite-mail';
import { welcomeMessage } from '../lib/team-words';

/**
 * The invitation email (ADR 0065): the welcome message, sent through the
 * alerts' Resend account once the person has been added. It never throws —
 * the person is added whatever the mail does — and it answers which notice
 * the page shows. Logs carry ids, never the address, the name or the key.
 */

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const MEMBER_ID = '33333333-3333-3333-3333-333333333333';
const ADDRESS = 'new.person@example.test';
const KEY = 're_secret_key_value';
const CONFIGURED: InviteMailBinding = { kind: 'configured', from: 'alerts@mozart.example', apiKey: KEY };
const WELCOME = { workspace: 'Acme Foods', fullName: 'New Person', email: ADDRESS, role: 'analyst' } as const;
const IDS = { orgId: ORG_ID, invitedUserId: MEMBER_ID };

const logged: string[] = [];

beforeEach(() => {
  logged.length = 0;
  vi.spyOn(console, 'info').mockImplementation((line: string) => void logged.push(line));
  vi.spyOn(console, 'warn').mockImplementation((line: string) => void logged.push(line));
  vi.spyOn(console, 'error').mockImplementation((line: string) => void logged.push(line));
});

function expectNothingPersonalLogged() {
  const lines = logged.join('\n');
  expect(lines).not.toContain(ADDRESS);
  expect(lines).not.toContain('New Person');
  expect(lines).not.toContain(KEY);
}

describe('inviteMailFromEnv', () => {
  it("reads the alerts' sender and key, both or neither", () => {
    expect(inviteMailFromEnv({})).toEqual({ kind: 'none' });
    expect(inviteMailFromEnv({ ALERT_EMAIL_FROM: ' alerts@mozart.example ', RESEND_API_KEY: KEY })).toEqual(
      CONFIGURED,
    );
    expect(inviteMailFromEnv({ RESEND_API_KEY: KEY })).toMatchObject({
      kind: 'misconfigured',
      reason: expect.stringContaining('ALERT_EMAIL_FROM not set'),
    });
    expect(inviteMailFromEnv({ ALERT_EMAIL_FROM: 'alerts@mozart.example' })).toMatchObject({
      kind: 'misconfigured',
      reason: expect.stringContaining('RESEND_API_KEY not set'),
    });
    expect(inviteMailFromEnv({ ALERT_EMAIL_FROM: 'Mozart <a@b.example>', RESEND_API_KEY: KEY })).toMatchObject({
      kind: 'misconfigured',
    });
  });

  it('does not need ALERT_EMAIL_TO, which is the alerts’ own', () => {
    expect(
      inviteMailFromEnv({ ALERT_EMAIL_FROM: 'alerts@mozart.example', RESEND_API_KEY: KEY, ALERT_EMAIL_TO: '' }),
    ).toEqual(CONFIGURED);
  });
});

describe('sendInvitation', () => {
  it('sends the welcome message to the person, from Mozart, and answers team_invited', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"id":"x"}', { status: 200 }));
    const notice = await sendInvitation(WELCOME, IDS, { binding: CONFIGURED, fetch: fetchImpl });

    expect(notice).toBe('team_invited');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(RESEND_API_URL);
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    expect(headers['idempotency-key']).toMatch(/^team-invite:[0-9a-f-]{36}$/);
    expect(headers['user-agent']).toMatch(/\S/);

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      from: 'Mozart <alerts@mozart.example>',
      to: [ADDRESS],
      subject: 'Your Acme Foods workspace on Mozart',
      text: expect.any(String),
    });
    // The same words the page offers to copy, less the subject line.
    expect(welcomeMessage(WELCOME)).toBe(`Subject: ${body.subject as string}\n\n${body.text as string}`);
    expect(body.text).toContain('https://app.mozart.financial/login');
    expectNothingPersonalLogged();
  });

  it('says when this deployment sends no mail, and sends nothing', async () => {
    const fetchImpl = vi.fn();
    expect(await sendInvitation(WELCOME, IDS, { binding: { kind: 'none' }, fetch: fetchImpl })).toBe(
      'team_invited_not_emailed',
    );
    expect(
      await sendInvitation(WELCOME, IDS, {
        binding: { kind: 'misconfigured', reason: 'RESEND_API_KEY not set, and ALERT_EMAIL_FROM is' },
        fetch: fetchImpl,
      }),
    ).toBe('team_invited_not_emailed');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logged.join('\n')).toContain('RESEND_API_KEY not set');
    expectNothingPersonalLogged();
  });

  it('answers a refusal, a timeout or a network failure as not sent, logged by status, never thrown', async () => {
    const refused = vi.fn(async () => new Response(`{"message":"${ADDRESS} refused"}`, { status: 422 }));
    expect(await sendInvitation(WELCOME, IDS, { binding: CONFIGURED, fetch: refused })).toBe(
      'team_invited_mail_failed',
    );
    expect(logged.join('\n')).toContain('http 422');

    const unreachable = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await sendInvitation(WELCOME, IDS, { binding: CONFIGURED, fetch: unreachable })).toBe(
      'team_invited_mail_failed',
    );
    expect(logged.join('\n')).toContain('network');
    expectNothingPersonalLogged();
  });

  it('sends nothing to what is not one bare address', async () => {
    const fetchImpl = vi.fn();
    for (const email of ['a@b.example, c@d.example', 'Name <a@b.example>', 'not-an-address']) {
      expect(await sendInvitation({ ...WELCOME, email }, IDS, { binding: CONFIGURED, fetch: fetchImpl })).toBe(
        'team_invited_mail_failed',
      );
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

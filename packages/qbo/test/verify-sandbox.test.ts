/**
 * The checkable parts of `pnpm qbo:verify` (`packages/qbo/scripts/`).
 *
 * Nothing here talks to Intuit — there is no sandbox in CI and a test that
 * reaches the network is a test that fails at 3am for reasons that are not ours
 * (ADR 0026). What is covered is what can go wrong without leaving the machine:
 * the message a missing setting produces, the rewrite of the rotated refresh
 * token back into `.env`, and the redaction that makes a recorded response safe
 * to commit.
 *
 * The `.env` rewrite gets the most attention on purpose. It edits a file a
 * person maintains by hand, and it holds the only copy of a refresh token Intuit
 * has already replaced by the time we write it.
 */

import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EnvSaveFailed,
  readSandboxSettings,
  redactJson,
  redactText,
  REDACTED,
  rewriteEnvLines,
  SandboxSettingsProblem,
  saveEnvFileAtomically,
} from '../scripts/verify-sandbox-core';

const COMPLETE = {
  QBO_ENVIRONMENT: 'sandbox',
  QBO_CLIENT_ID: 'ABclientidABclientidABclientidABclientid',
  QBO_CLIENT_SECRET: 'XYclientsecretXYclientsecretXYclientsecr',
  QBO_REALM_ID: '4620816365213608204',
  QBO_REFRESH_TOKEN: 'AB11605090630refreshZmv1G4oX9Rtf2AoQ0hx',
} as const;

describe('readSandboxSettings', () => {
  it('reads the five settings, with no access token unless .env has one', () => {
    const settings = readSandboxSettings(COMPLETE);
    expect(settings.realmId).toBe(COMPLETE.QBO_REALM_ID);
    expect(settings.refreshToken).toBe(COMPLETE.QBO_REFRESH_TOKEN);
    // `exactOptionalPropertyTypes`: an absent access token is an absent key.
    expect('accessToken' in settings).toBe(false);

    const withAccess = readSandboxSettings({ ...COMPLETE, QBO_ACCESS_TOKEN: 'access-token' });
    expect(withAccess.accessToken).toBe('access-token');
  });

  it('names every missing setting at once, and says where each one comes from', () => {
    let thrown: unknown;
    try {
      readSandboxSettings({ QBO_ENVIRONMENT: 'sandbox', QBO_CLIENT_ID: COMPLETE.QBO_CLIENT_ID });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SandboxSettingsProblem);
    const message = (thrown as SandboxSettingsProblem).message;

    // All three at once: sending someone back to the Intuit portal one setting
    // at a time is not a kindness.
    expect(message).toContain('QBO_CLIENT_SECRET');
    expect(message).toContain('QBO_REALM_ID');
    expect(message).toContain('QBO_REFRESH_TOKEN');
    expect(message).not.toContain('QBO_CLIENT_ID\n');
    expect(message).toContain('3 settings are');

    // And where to get them, because the person running this is not expected to
    // know Intuit's console.
    expect(message).toContain('Keys & credentials');
    expect(message).toContain('Development tab');
    expect(message).toContain('OAuth 2.0 Playground');
    expect(message).toContain('What to do:');
  });

  it('treats a blank value as missing', () => {
    expect(() => readSandboxSettings({ ...COMPLETE, QBO_REFRESH_TOKEN: '   ' })).toThrow(
      SandboxSettingsProblem,
    );
  });

  it('refuses production, and says how to point at a sandbox instead', () => {
    let message = '';
    try {
      readSandboxSettings({ ...COMPLETE, QBO_ENVIRONMENT: 'production' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('refuses to run against production');
    expect(message).toContain('QBO_ENVIRONMENT=sandbox');
  });

  it('refuses an environment it does not recognise rather than assuming sandbox', () => {
    expect(() => readSandboxSettings({ ...COMPLETE, QBO_ENVIRONMENT: 'Sandbox ' })).not.toThrow();
    expect(() => readSandboxSettings({ ...COMPLETE, QBO_ENVIRONMENT: 'staging' })).toThrow(
      /not a value this script understands/,
    );
  });
});

describe('rewriteEnvLines', () => {
  const file = [
    '# QuickBooks sandbox, from the Intuit developer portal',
    'QBO_ENVIRONMENT=sandbox',
    '',
    'QBO_CLIENT_ID=abc123',
    'QBO_REFRESH_TOKEN=old-refresh-token',
    'QBO_ACCESS_TOKEN=old-access-token',
    '',
    '# Everything else',
    'DATABASE_URL=postgres://localhost/recouple',
    'ANTHROPIC_API_KEY=sk-ant-not-a-real-key',
    '',
  ].join('\n');

  it('changes only the lines it was given and leaves the rest byte for byte', () => {
    const { text, changed, absent } = rewriteEnvLines(
      file,
      new Map([
        ['QBO_REFRESH_TOKEN', 'new-refresh-token'],
        ['QBO_ACCESS_TOKEN', 'new-access-token'],
      ]),
    );

    expect(changed).toEqual(['QBO_REFRESH_TOKEN', 'QBO_ACCESS_TOKEN']);
    expect(absent).toEqual([]);

    // The difference, line by line, is exactly the two values.
    const before = file.split('\n');
    const after = text.split('\n');
    expect(after).toHaveLength(before.length);
    const differing = after
      .map((line, at) => (line === before[at] ? undefined : at))
      .filter((at): at is number => at !== undefined);
    expect(differing).toEqual([4, 5]);
    expect(after[4]).toBe('QBO_REFRESH_TOKEN=new-refresh-token');
    expect(after[5]).toBe('QBO_ACCESS_TOKEN=new-access-token');

    // Nothing of the old values survives anywhere in the file.
    expect(text).not.toContain('old-refresh-token');
    expect(text).not.toContain('old-access-token');
  });

  it('leaves a key it was not given alone even where the value matches', () => {
    const { text } = rewriteEnvLines(file, new Map([['QBO_REFRESH_TOKEN', 'new']]));
    expect(text).toContain('QBO_ACCESS_TOKEN=old-access-token');
    expect(text).toContain('DATABASE_URL=postgres://localhost/recouple');
  });

  it('keeps CRLF endings, a missing final newline, an export prefix and quotes', () => {
    const crlf = 'A=1\r\nQBO_REFRESH_TOKEN=old\r\nB=2';
    const rewritten = rewriteEnvLines(crlf, new Map([['QBO_REFRESH_TOKEN', 'new']])).text;
    expect(rewritten).toBe('A=1\r\nQBO_REFRESH_TOKEN=new\r\nB=2');

    expect(
      rewriteEnvLines('export QBO_REFRESH_TOKEN=old\n', new Map([['QBO_REFRESH_TOKEN', 'new']]))
        .text,
    ).toBe('export QBO_REFRESH_TOKEN=new\n');

    // A person who quoted their line keeps their quotes: a rewrite that drops
    // them changed something it was not asked to change.
    expect(
      rewriteEnvLines('QBO_REFRESH_TOKEN="old"\n', new Map([['QBO_REFRESH_TOKEN', 'new']])).text,
    ).toBe('QBO_REFRESH_TOKEN="new"\n');
    expect(
      rewriteEnvLines("QBO_REFRESH_TOKEN='old'\n", new Map([['QBO_REFRESH_TOKEN', 'new']])).text,
    ).toBe("QBO_REFRESH_TOKEN='new'\n");
  });

  it('reports a key with no line instead of appending one', () => {
    const { text, changed, absent } = rewriteEnvLines(
      'QBO_REFRESH_TOKEN=old\n',
      new Map([
        ['QBO_REFRESH_TOKEN', 'new'],
        ['QBO_ACCESS_TOKEN', 'also-new'],
      ]),
    );
    expect(changed).toEqual(['QBO_REFRESH_TOKEN']);
    expect(absent).toEqual(['QBO_ACCESS_TOKEN']);
    // Appending would write a line dotenv ignores while the shell variable that
    // supplied the value still exists.
    expect(text).toBe('QBO_REFRESH_TOKEN=new\n');
  });

  it('reports nothing changed when the value is already the new one', () => {
    const { text, changed } = rewriteEnvLines(
      'QBO_REFRESH_TOKEN=same\n',
      new Map([['QBO_REFRESH_TOKEN', 'same']]),
    );
    expect(changed).toEqual([]);
    expect(text).toBe('QBO_REFRESH_TOKEN=same\n');
  });
});

describe('saveEnvFileAtomically', () => {
  const scratch = (): string => mkdtempSync(path.join(tmpdir(), 'recouple-qbo-verify-'));

  it('replaces the file, keeps its permissions, and leaves no temporary behind', () => {
    const dir = scratch();
    const envPath = path.join(dir, '.env');
    writeFileSync(envPath, 'QBO_REFRESH_TOKEN=old\n', { encoding: 'utf8', mode: 0o600 });

    saveEnvFileAtomically(envPath, 'QBO_REFRESH_TOKEN=new\n');

    expect(readFileSync(envPath, 'utf8')).toBe('QBO_REFRESH_TOKEN=new\n');
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
    // Temp file then rename: the rename is what makes the swap atomic, and
    // nothing is left in the directory afterwards.
    expect(readdirSync(dir)).toEqual(['.env']);
  });

  it('says where the complete new file is when it cannot be moved into place', () => {
    const dir = scratch();
    // A directory cannot be renamed over, so the write succeeds and the rename
    // is the step that fails — the case where the new file is complete and the
    // person can put it in place themselves.
    const asDirectory = mkdtempSync(path.join(dir, '.env'));

    let thrown: unknown;
    try {
      saveEnvFileAtomically(asDirectory, 'QBO_REFRESH_TOKEN=new\n');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(EnvSaveFailed);
    const failure = thrown as EnvSaveFailed;
    expect(failure.completeFileAt).toBeDefined();
    expect(readFileSync(failure.completeFileAt as string, 'utf8')).toBe('QBO_REFRESH_TOKEN=new\n');
    expect(failure.reason).toBeInstanceOf(Error);
  });

  it('reports no salvageable file when it cannot write at all', () => {
    const dir = scratch();
    let thrown: unknown;
    try {
      // No `.env` to take the permissions from, so the write side fails.
      saveEnvFileAtomically(path.join(dir, 'missing', '.env'), 'QBO_REFRESH_TOKEN=new\n');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(EnvSaveFailed);
    expect((thrown as EnvSaveFailed).completeFileAt).toBeUndefined();
  });
});

describe('redaction', () => {
  const secrets = [COMPLETE.QBO_REALM_ID, COMPLETE.QBO_CLIENT_ID, COMPLETE.QBO_REFRESH_TOKEN];

  it('cuts every occurrence of a secret out of a string', () => {
    const text = `realm ${COMPLETE.QBO_REALM_ID} and again ${COMPLETE.QBO_REALM_ID}`;
    const out = redactText(text, secrets);
    expect(out).not.toContain(COMPLETE.QBO_REALM_ID);
    expect(out).toBe(`realm ${REDACTED} and again ${REDACTED}`);
  });

  it('leaves a value too short to be a credential alone rather than shredding the text', () => {
    expect(redactText('a-b-c', ['-'])).toBe('a-b-c');
  });

  it('redacts a token by its key even when the value was never seen before', () => {
    // The rotated tokens in a refresh response are exactly this case: they did
    // not exist when the secrets list was built.
    const out = redactJson(
      {
        token_type: 'bearer',
        expires_in: 3600,
        access_token: 'a-token-nobody-listed',
        refresh_token: 'another-one',
      },
      secrets,
    ) as Record<string, unknown>;

    expect(out['access_token']).toBe(REDACTED);
    expect(out['refresh_token']).toBe(REDACTED);
    // Neither of these is a credential, and the fixture is worth less without
    // them.
    expect(out['token_type']).toBe('bearer');
    expect(out['expires_in']).toBe(3600);
  });

  it('walks a ledger response, keeps the shape, and keeps SyncToken', () => {
    const out = redactJson(
      {
        QueryResponse: {
          Invoice: [
            {
              Id: '145',
              SyncToken: '1',
              TotalAmt: 3120.0,
              Balance: 0,
              PrivateNote: `for realm ${COMPLETE.QBO_REALM_ID}`,
              CustomerRef: { value: '58', name: 'Sysco Baltimore, LLC' },
              Line: [{ Amount: 890.25, Description: null }],
            },
          ],
        },
      },
      secrets,
    ) as { QueryResponse: { Invoice: Record<string, unknown>[] } };

    const invoice = out.QueryResponse.Invoice[0] as Record<string, unknown>;
    expect(invoice['Id']).toBe('145');
    // `SyncToken` is a version number, not a credential: redacting it would cost
    // the fixture a field it exists to record.
    expect(invoice['SyncToken']).toBe('1');
    expect(invoice['TotalAmt']).toBe(3120.0);
    expect(invoice['PrivateNote']).toBe(`for realm ${REDACTED}`);
    expect(invoice['CustomerRef']).toEqual({ value: '58', name: 'Sysco Baltimore, LLC' });
    expect(invoice['Line']).toEqual([{ Amount: 890.25, Description: null }]);
    expect(JSON.stringify(out)).not.toContain(COMPLETE.QBO_REALM_ID);
  });
});

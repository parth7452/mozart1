import { afterEach, describe, expect, it, vi } from 'vitest';
import { Inngest, NonRetriableError } from 'inngest';
import {
  ALERTED_FUNCTIONS,
  ALERT_FILTER,
  ALERT_FUNCTION_CONFIG,
  ALERT_TEST_REQUESTED,
  AlertMailError,
  FUNCTION_FAILED,
  RESEND_API_URL,
  ResendAlertMailer,
  alertOnFailureFunction,
  alertSteps,
  alertsFromEnv,
  parseFailure,
  type AlertBinding,
  type AlertContext,
  type AlertMessage,
  type AlertSettings,
} from '../lib/alerts';
import { INNGEST_APP_ID, READ_DOCUMENT_CONFIG } from '../lib/inngest';
import { READ_INBOUND_EMAIL_CONFIG } from '../lib/inbound';
import { LEDGER_SYNC_CONFIG, LEDGER_SYNC_FAN_OUT_CONFIG } from '../lib/inngest-ledger';

/**
 * The failed-run alert (ADR 0052).
 *
 * The questions that matter if it is wrong. Does it email about the four jobs
 * and nothing else? Does anything but a function id, a run id, a class name
 * and a link reach the email — in particular the error's message or the
 * triggering event, which can quote a document? Does a burst become one email?
 * And does an unconfigured deployment send nothing and say so?
 */

const RUN = '01H0TPSJ576QY54R6JJ8MEX6JH';
const ALERT_RUN = '01H0TPW7KB4KCR739TG2J3FTHT';
const READ = `${INNGEST_APP_ID}-${READ_DOCUMENT_CONFIG.id}`;

/** Put in every field the email must not read; it must never come back out. */
const CANARY = 'WALMART-DN-2609-001-$4,800.00';

const SETTINGS: AlertSettings = {
  to: 'founder@example.com',
  from: 'alerts@mozart.example',
  apiKey: 're_test_key_never_printed',
};

function failedEvent(overrides: Record<string, unknown> = {}) {
  return {
    name: FUNCTION_FAILED,
    data: {
      function_id: READ,
      run_id: RUN,
      error: {
        __serialized: true,
        name: 'NonRetriableError',
        message: `DuplicateCaseError reading document: claim ${CANARY}`,
        stack: `Error: ${CANARY}\n    at read`,
        error: CANARY,
        cause: { name: 'DuplicateCaseError', message: CANARY },
      },
      event: {
        name: 'document/read.requested',
        id: '01H0TPSHZTVFF6SFVTR6E25MTC',
        data: { documentId: CANARY, orgId: CANARY, note: CANARY },
      },
      events: [{ name: 'document/read.requested', data: { note: CANARY } }],
      result: CANARY,
      ...overrides,
    },
  };
}

function harness(binding: AlertBinding = { kind: 'configured', settings: SETTINGS }) {
  const sent: AlertMessage[] = [];
  const mailer = { send: vi.fn(async (message: AlertMessage) => void sent.push(message)) };
  const context: AlertContext = { binding: () => binding, mailerFor: () => mailer };
  const step = { run: vi.fn(async (_id: string, work: () => Promise<void>) => work()) };
  const handler = alertSteps(context);
  const invoke = (event: { name: string; data: unknown }) =>
    handler({ event, runId: ALERT_RUN, step });
  return { sent, mailer, step, invoke };
}

afterEach(() => vi.restoreAllMocks());

describe('which failures are emailed', () => {
  it('watches exactly the four jobs, by the id Inngest reports', () => {
    expect([...ALERTED_FUNCTIONS.keys()].sort()).toEqual(
      [
        READ_DOCUMENT_CONFIG.id,
        READ_INBOUND_EMAIL_CONFIG.id,
        LEDGER_SYNC_CONFIG.id,
        LEDGER_SYNC_FAN_OUT_CONFIG.id,
      ]
        .map((id) => `recouple-${id}`)
        .sort(),
    );
    expect(READ).toBe('recouple-read-document');
  });

  it('filters the trigger to those four, with ids safe inside a CEL string', () => {
    for (const id of ALERTED_FUNCTIONS.keys()) {
      expect(id).toMatch(/^[a-z0-9-]+$/);
      expect(ALERT_FILTER).toContain(`event.data.function_id == '${id}'`);
    }
    expect(ALERT_FILTER.split(' || ')).toHaveLength(ALERTED_FUNCTIONS.size);
    expect(ALERT_FUNCTION_CONFIG.triggers).toEqual([
      { event: 'inngest/function.failed', if: ALERT_FILTER },
      { event: ALERT_TEST_REQUESTED },
    ]);
  });

  it('never watches itself', () => {
    expect(ALERTED_FUNCTIONS.has(`${INNGEST_APP_ID}-${ALERT_FUNCTION_CONFIG.id}`)).toBe(false);
    expect(ALERT_FILTER).not.toContain(ALERT_FUNCTION_CONFIG.id);
  });

  it.each([...ALERTED_FUNCTIONS.keys()])('emails a failure of %s once', async (functionId) => {
    const { sent, invoke } = harness();
    await expect(invoke(failedEvent({ function_id: functionId }))).resolves.toEqual({
      outcome: 'sent',
      test: false,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain(`Function: ${functionId}`);
  });

  it.each([
    'recouple-alert-on-failure',
    'recouple-read-document-failure',
    'another-app-read-document',
    'read-document',
    undefined,
  ])('sends nothing for %s', async (functionId) => {
    const { mailer, invoke } = harness();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(invoke(failedEvent({ function_id: functionId }))).resolves.toEqual({
      outcome: 'not_watched',
    });
    expect(mailer.send).not.toHaveBeenCalled();
  });
});

describe('what the email says', () => {
  it('names the function, the run, the class and a link, and nothing from the event', async () => {
    const { sent, invoke } = harness();
    await invoke(failedEvent());
    const [message] = sent;
    expect(message!.subject).toBe('Mozart: a background job failed (Read an uploaded document)');
    expect(message!.text).toContain(`Function: ${READ} (Read an uploaded document)`);
    expect(message!.text).toContain(`Run: ${RUN}`);
    expect(message!.text).toContain('Error class: NonRetriableError');
    expect(message!.text).toContain(`https://app.inngest.com/env/production/runs/${RUN}`);
    expect(message!.text).toContain('Documents waiting to be read');
    expect(message!.idempotencyKey).toBe(`alert:${RUN}`);

    const everything = JSON.stringify(message);
    expect(everything).not.toContain(CANARY);
    expect(everything).not.toContain('DuplicateCaseError');
    expect(everything).not.toContain('document/read.requested');
  });

  it('logs nothing from the event either', async () => {
    const lines: string[] = [];
    for (const level of ['log', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, level).mockImplementation((...args) => void lines.push(args.join(' ')));
    }
    const { invoke } = harness();
    await invoke(failedEvent());
    expect(lines.join('\n')).not.toContain(CANARY);
    expect(lines.join('\n')).toContain(`${READ} run ${RUN}`);
  });

  it('reads only function_id, run_id and error.name', () => {
    expect(parseFailure(failedEvent().data)).toEqual({
      functionId: READ,
      runId: RUN,
      errorName: 'NonRetriableError',
    });
  });

  it.each([
    ['text off a page', `Walmart ${CANARY}`],
    ['markup', '<b>Error</b>'],
    ['a sentence', 'Error: claim DN-1 already open'],
    ['something too long', `E${'x'.repeat(64)}`],
    ['not a string', 42],
  ])('drops a class name that is %s', async (_, name) => {
    const { sent, invoke } = harness();
    await invoke(failedEvent({ error: { name, message: CANARY } }));
    expect(sent[0]!.text).toContain('Error class: not given');
    expect(JSON.stringify(sent[0])).not.toContain(CANARY);
  });

  it.each([
    ['text', CANARY],
    ['a lower-case id', RUN.toLowerCase()],
    ['a uuid', '11111111-1111-1111-1111-111111111111'],
    ['absent', undefined],
  ])('drops a run id that is %s, and links to the function instead', async (_, runId) => {
    const { sent, invoke } = harness();
    await invoke(failedEvent({ run_id: runId }));
    expect(sent[0]!.text).toContain('Run: not given');
    expect(sent[0]!.idempotencyKey).toBe(`alert:${ALERT_RUN}`);
    expect(sent[0]!.text).toContain(
      'https://app.inngest.com/env/production/functions/recouple-read-document/runs',
    );
    expect(JSON.stringify(sent[0])).not.toContain(CANARY);
  });
});

describe('a burst is one email', () => {
  it('rate-limits to one run per function per hour', () => {
    expect(ALERT_FUNCTION_CONFIG.rateLimit).toEqual({
      limit: 1,
      period: '1h',
      key: 'event.data.function_id',
    });
  });

  it('retries a send twice at most', () => {
    expect(ALERT_FUNCTION_CONFIG.retries).toBe(2);
  });

  it('is what the function registers with Inngest', () => {
    const client = new Inngest({ id: INNGEST_APP_ID, isDev: true });
    const fn = alertOnFailureFunction(client, {
      binding: () => ({ kind: 'none' }),
      mailerFor: () => ({ send: async () => undefined }),
    });
    const [config] = fn['getConfig']({
      baseUrl: new URL('https://app.example/api/inngest'),
      appPrefix: INNGEST_APP_ID,
    }) as Array<Record<string, unknown>>;
    expect(config!.id).toBe('recouple-alert-on-failure');
    expect(config!.rateLimit).toEqual(ALERT_FUNCTION_CONFIG.rateLimit);
    expect(config!.triggers).toEqual([
      { event: 'inngest/function.failed', expression: ALERT_FILTER },
      { event: ALERT_TEST_REQUESTED },
    ]);
  });
});

describe('the test event', () => {
  it('sends a clearly labelled test, keyed on its own run', async () => {
    const { sent, invoke } = harness();
    await expect(invoke({ name: ALERT_TEST_REQUESTED, data: {} })).resolves.toEqual({
      outcome: 'sent',
      test: true,
    });
    expect(sent[0]!.subject).toMatch(/^\[TEST\] /);
    expect(sent[0]!.text).toContain('This is a test. Nothing failed.');
    expect(sent[0]!.idempotencyKey).toBe(`alert-test:${ALERT_RUN}`);
  });

  it('ignores whatever the sender put in it', async () => {
    const { sent, invoke } = harness();
    await invoke({ name: ALERT_TEST_REQUESTED, data: { function_id: READ, note: CANARY } });
    expect(JSON.stringify(sent[0])).not.toContain(CANARY);
    expect(sent[0]!.subject).toMatch(/^\[TEST\] /);
  });
});

describe('not configured', () => {
  it('reads no variables as off', () => {
    expect(alertsFromEnv({})).toEqual({ kind: 'none' });
    expect(alertsFromEnv({ ALERT_EMAIL_TO: ' ', RESEND_API_KEY: '' })).toEqual({ kind: 'none' });
  });

  it('reads some of them as misconfigured, naming what is missing', () => {
    expect(alertsFromEnv({ ALERT_EMAIL_TO: 'a@b.co' })).toEqual({
      kind: 'misconfigured',
      reason: 'ALERT_EMAIL_FROM and RESEND_API_KEY not set, and the rest are',
    });
    expect(alertsFromEnv({ ALERT_EMAIL_TO: 'a@b.co', ALERT_EMAIL_FROM: 'c@d.co' })).toEqual({
      kind: 'misconfigured',
      reason: 'RESEND_API_KEY not set, and the rest are',
    });
  });

  it.each(['a@b.co, c@d.co', 'Founder <a@b.co>', 'not an address', 'a@b'])(
    'refuses ALERT_EMAIL_TO %j',
    (to) => {
      expect(
        alertsFromEnv({ ALERT_EMAIL_TO: to, ALERT_EMAIL_FROM: 'c@d.co', RESEND_API_KEY: 'k' }),
      ).toEqual({ kind: 'misconfigured', reason: 'ALERT_EMAIL_TO is not one email address' });
    },
  );

  it('reads all three as configured', () => {
    expect(
      alertsFromEnv({
        ALERT_EMAIL_TO: ' founder@example.com ',
        ALERT_EMAIL_FROM: 'alerts@mozart.example',
        RESEND_API_KEY: 're_x',
      }),
    ).toEqual({
      kind: 'configured',
      settings: { to: 'founder@example.com', from: 'alerts@mozart.example', apiKey: 're_x' },
    });
  });

  it('sends nothing and says alerts are not configured', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { mailer, step, invoke } = harness({ kind: 'none' });
    await expect(invoke(failedEvent())).resolves.toEqual({ outcome: 'not_configured' });
    expect(mailer.send).not.toHaveBeenCalled();
    expect(step.run).not.toHaveBeenCalled();
    expect(info.mock.calls.flat().join(' ')).toContain('alerts are not configured');
  });

  it('sends nothing when misconfigured, and logs why as an error', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { mailer, invoke } = harness({ kind: 'misconfigured', reason: 'RESEND_API_KEY not set' });
    await expect(invoke({ name: ALERT_TEST_REQUESTED, data: {} })).resolves.toEqual({
      outcome: 'misconfigured',
    });
    expect(mailer.send).not.toHaveBeenCalled();
    expect(error.mock.calls.flat().join(' ')).toContain('RESEND_API_KEY not set');
  });
});

describe('a send that fails', () => {
  function failingWith(error: unknown) {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const context: AlertContext = {
      binding: () => ({ kind: 'configured', settings: SETTINGS }),
      mailerFor: () => ({
        send: async () => {
          throw error;
        },
      }),
    };
    const step = { run: async (_id: string, work: () => Promise<void>) => work() };
    return alertSteps(context)({ event: failedEvent(), runId: ALERT_RUN, step });
  }

  it.each([400, 401, 403, 404, 422])('does not retry a %i', async (status) => {
    await expect(failingWith(new AlertMailError('http', status))).rejects.toBeInstanceOf(
      NonRetriableError,
    );
  });

  it.each([
    new AlertMailError('http', 409),
    new AlertMailError('http', 429),
    new AlertMailError('http', 503),
    new AlertMailError('timeout'),
    new AlertMailError('network'),
    new TypeError('boom'),
  ])('retries %s', async (error) => {
    const rejection = failingWith(error);
    await expect(rejection).rejects.toThrow(/alert not sent/);
    await expect(rejection).rejects.not.toBeInstanceOf(NonRetriableError);
  });

  it('never puts the key in what it throws or logs', async () => {
    const lines: string[] = [];
    const rejection = failingWith(new AlertMailError('http', 401));
    vi.mocked(console.error).mockImplementation((...args) => void lines.push(args.join(' ')));
    const error = await rejection.catch((e: Error) => e);
    expect(String(error)).not.toContain(SETTINGS.apiKey);
    expect(lines.join(' ')).not.toContain(SETTINGS.apiKey);
  });
});

describe('ResendAlertMailer', () => {
  const MESSAGE: AlertMessage = { subject: 'S', text: 'T', idempotencyKey: `alert:${RUN}` };

  it('posts plain text with the key, an idempotency key and a user agent', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"id":"x"}', { status: 200 }));
    await new ResendAlertMailer({ settings: SETTINGS, fetch: fetchImpl }).send(MESSAGE);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(RESEND_API_URL);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${SETTINGS.apiKey}`);
    expect(headers['idempotency-key']).toBe(`alert:${RUN}`);
    expect(headers['user-agent']).toMatch(/\S/);
    expect(JSON.parse(init.body as string)).toEqual({
      from: `Mozart alerts <${SETTINGS.from}>`,
      to: [SETTINGS.to],
      subject: 'S',
      text: 'T',
    });
  });

  it('reports a refusal by status, without the body', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(`{"message":"${SETTINGS.apiKey} is invalid"}`, { status: 403 }),
    );
    const error = await new ResendAlertMailer({ settings: SETTINGS, fetch: fetchImpl })
      .send(MESSAGE)
      .catch((e: AlertMailError) => e);
    expect(error).toBeInstanceOf(AlertMailError);
    expect((error as AlertMailError).httpStatus).toBe(403);
    expect((error as AlertMailError).settled).toBe(true);
    expect(String(error)).not.toContain(SETTINGS.apiKey);
  });

  it('gives up after its timeout', async () => {
    const fetchImpl = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    );
    const error = await new ResendAlertMailer({
      settings: SETTINGS,
      fetch: fetchImpl as unknown as typeof fetch,
      timeoutMs: 5,
    })
      .send(MESSAGE)
      .catch((e: AlertMailError) => e);
    expect(error).toMatchObject({ reason: 'timeout', settled: false });
  });
});

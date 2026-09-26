import { NonRetriableError, internalEvents, type Inngest } from 'inngest';
import { INNGEST_APP_ID, READ_DOCUMENT_CONFIG } from './inngest';
import { READ_INBOUND_EMAIL_CONFIG } from './inbound';
import { LEDGER_SYNC_CONFIG, LEDGER_SYNC_FAN_OUT_CONFIG } from './inngest-ledger';

/**
 * An email to the operator when a background job fails after its retries
 * (ADR 0052).
 *
 * One function, triggered by Inngest's own `inngest/function.failed`, filtered
 * to the four jobs that do work a customer cannot watch. What the email may
 * say is the whole design: the function, the run id, the error's class name and
 * a link — each a constant or checked against a closed format. The failure
 * event also carries the error's message and the event that started the run,
 * and neither is read here, because a message can quote the page
 * (`DuplicateCaseError` interpolates a claim id) and the email is a copy of it
 * in a third party's inbox (invariant 4, ADR 0021's rule for a failed run).
 */

/** The system event Inngest emits once a run ends Failed. */
export const FUNCTION_FAILED = internalEvents.FunctionFailed;

/** Sent by hand from the Inngest dashboard to prove the path works (ADR 0052 §6). */
export const ALERT_TEST_REQUESTED = 'recouple/alert.test';

/**
 * The jobs whose failure is emailed, by the id Inngest reports: the app id and
 * the function's own id, joined by a hyphen. Built from each job's exported
 * config so a renamed job cannot quietly fall out of the filter.
 */
export const ALERTED_FUNCTIONS: ReadonlyMap<string, { readonly name: string; readonly next: string }> =
  new Map([
    [
      fullId(READ_DOCUMENT_CONFIG.id),
      {
        name: READ_DOCUMENT_CONFIG.name,
        next:
          'The document is stored and was not read. It is listed under "Documents waiting to be ' +
          'read" on the case list: press Read again once. If it is still there tomorrow, open the ' +
          'run below.',
      },
    ],
    [
      fullId(READ_INBOUND_EMAIL_CONFIG.id),
      {
        name: READ_INBOUND_EMAIL_CONFIG.name,
        next:
          'The email and its parts are stored and scanned; some were not read. They are listed ' +
          'under "Documents waiting to be read" on the case list: press Read again once on each.',
      },
    ],
    [
      fullId(LEDGER_SYNC_CONFIG.id),
      {
        name: LEDGER_SYNC_CONFIG.name,
        next:
          'One workspace’s QuickBooks sync did not finish. Its run is on that workspace’s Coverage ' +
          'page with guidance; tomorrow’s 07:00 UTC run reads the same window again.',
      },
    ],
    [
      fullId(LEDGER_SYNC_FAN_OUT_CONFIG.id),
      {
        name: LEDGER_SYNC_FAN_OUT_CONFIG.name,
        next:
          'Today’s ledger syncs were not started for any workspace. Invoke "Fan out the daily ' +
          'ledger syncs" from the Inngest dashboard once the run below says why.',
      },
    ],
  ]);

function fullId(functionId: string): string {
  return `${INNGEST_APP_ID}-${functionId}`;
}

/**
 * The trigger's filter, one `==` per watched function.
 *
 * Every id is `[a-z0-9-]`, which `alerts.test.tsx` asserts, so quoting it in a
 * CEL string literal needs no escaping.
 */
export const ALERT_FILTER = [...ALERTED_FUNCTIONS.keys()]
  .map((id) => `event.data.function_id == '${id}'`)
  .join(' || ');

/**
 * How the runtime runs the alert.
 *
 * `rateLimit` makes a burst one email: the first failure of a function sends,
 * and every further failure of that function within the hour is dropped by
 * Inngest before a run starts. The test event carries no `function_id`, and a
 * key over a missing field does not rate-limit, so every test press sends.
 *
 * `retries: 2`: a send is attempted at most three times. A failure of this
 * function emits no failure event of its own (the server's guard), so a send
 * that never succeeds is a log line, not a loop.
 */
export const ALERT_FUNCTION_CONFIG = {
  id: 'alert-on-failure',
  name: 'Email a failed run',
  triggers: [{ event: FUNCTION_FAILED, if: ALERT_FILTER }, { event: ALERT_TEST_REQUESTED }],
  retries: 2 as const,
  rateLimit: { limit: 1, period: '1h' as const, key: 'event.data.function_id' },
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface AlertSettings {
  readonly to: string;
  readonly from: string;
  readonly apiKey: string;
}

export type AlertBinding =
  | { readonly kind: 'none' }
  | { readonly kind: 'misconfigured'; readonly reason: string }
  | { readonly kind: 'configured'; readonly settings: AlertSettings };

const ALERT_VARIABLES = ['ALERT_EMAIL_TO', 'ALERT_EMAIL_FROM', 'RESEND_API_KEY'] as const;

/** One bare address: no name, no list, no angle brackets. */
const ONE_ADDRESS = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

/**
 * Whether this deployment emails failures, decided in one place
 * (`scannerFromEnv`'s shape). All three variables, or none. Some of them is a
 * half-finished setup and says which one is missing; an address that is not
 * one bare address says so too. Neither answer sends anything.
 */
export function alertsFromEnv(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AlertBinding {
  const values = ALERT_VARIABLES.map((name) => (environment[name] ?? '').trim());
  const [to, from, apiKey] = values as [string, string, string];
  const missing = ALERT_VARIABLES.filter((_, index) => values[index] === '');

  if (missing.length === ALERT_VARIABLES.length) return { kind: 'none' };
  if (missing.length > 0) {
    return { kind: 'misconfigured', reason: `${missing.join(' and ')} not set, and the rest are` };
  }
  if (!ONE_ADDRESS.test(to)) {
    return { kind: 'misconfigured', reason: 'ALERT_EMAIL_TO is not one email address' };
  }
  if (!ONE_ADDRESS.test(from)) {
    return { kind: 'misconfigured', reason: 'ALERT_EMAIL_FROM is not one email address' };
  }
  return { kind: 'configured', settings: { to, from, apiKey } };
}

// ---------------------------------------------------------------------------
// What the email says
// ---------------------------------------------------------------------------

/** The three things read off a failure event, each checked. Nothing else is read. */
export interface RunFailure {
  readonly functionId: string;
  readonly runId: string | undefined;
  readonly errorName: string | undefined;
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const CLASS_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;

/**
 * The failure, or `undefined` when it is not one of the watched functions'.
 *
 * Reads `function_id`, `run_id` and `error.name` by name and touches nothing
 * else: not `error.message`, not `error.stack`, not `event`. A run id that is
 * not a ULID, or a class name that is not an identifier, is dropped rather
 * than printed.
 */
export function parseFailure(data: unknown): RunFailure | undefined {
  const raw = asRecord(data);
  const functionId = raw.function_id;
  if (typeof functionId !== 'string' || !ALERTED_FUNCTIONS.has(functionId)) return undefined;
  const runId = typeof raw.run_id === 'string' && ULID.test(raw.run_id) ? raw.run_id : undefined;
  const name = asRecord(raw.error).name;
  const errorName = typeof name === 'string' && CLASS_NAME.test(name) ? name : undefined;
  return { functionId, runId, errorName };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

export interface AlertMessage {
  readonly subject: string;
  readonly text: string;
  /** What makes two sends the same email, for Resend's 24-hour window. */
  readonly idempotencyKey: string;
}

const DASHBOARD = 'https://app.inngest.com/env/production';

const WHY_SO_LITTLE =
  'This email names the function, the run and the error’s class only. The error’s ' +
  'message and the event that started the run are on the run’s page in the Inngest ' +
  'dashboard, and are not copied here because they can quote a document (ADR 0052).';

/**
 * The alert for one failed run. A pure function of the checked failure and of
 * this alert's own run id, which keys the send when the failure named no run —
 * keying on the function instead would let Resend's 24-hour window swallow the
 * next hour's alert.
 */
export function failureMessage(failure: RunFailure, alertRunId: string): AlertMessage {
  const watched = ALERTED_FUNCTIONS.get(failure.functionId);
  if (watched === undefined) throw new Error(`not a watched function: ${failure.functionId}`);
  const link =
    failure.runId !== undefined
      ? `${DASHBOARD}/runs/${failure.runId}`
      : `${DASHBOARD}/functions/${encodeURIComponent(failure.functionId)}/runs`;

  return {
    subject: `Mozart: a background job failed (${watched.name})`,
    text: [
      'A background job failed after its retries.',
      '',
      `Function: ${failure.functionId} (${watched.name})`,
      `Run: ${failure.runId ?? 'not given'}`,
      `Error class: ${failure.errorName ?? 'not given'}`,
      `Open the run: ${link}`,
      '',
      `What to do: ${watched.next}`,
      '',
      'Further failures of this function in the next hour are not emailed. The Runs page ' +
        'in the Inngest dashboard lists every one.',
      '',
      WHY_SO_LITTLE,
    ].join('\n'),
    idempotencyKey: `alert:${failure.runId ?? alertRunId}`,
  };
}

/** The test email (ADR 0052 §6). Keyed on this run, so every press sends one. */
export function testMessage(alertRunId: string): AlertMessage {
  return {
    subject: '[TEST] Mozart: failure alerts are working',
    text: [
      'This is a test. Nothing failed.',
      '',
      'It was sent because someone sent the event recouple/alert.test from the Inngest ' +
        'dashboard. A real alert names a failed function, its run, the error’s class and a ' +
        'link to the run, and at most one is sent per function per hour.',
      '',
      WHY_SO_LITTLE,
    ].join('\n'),
    idempotencyKey: `alert-test:${alertRunId}`,
  };
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export interface AlertMailer {
  send(message: AlertMessage): Promise<void>;
}

export const RESEND_API_URL = 'https://api.resend.com/emails';

/**
 * A send Resend refused or never answered. Carries a closed reason and the
 * HTTP status, never the key and never a body.
 */
export class AlertMailError extends Error {
  override readonly name = 'AlertMailError';
  constructor(
    readonly reason: 'http' | 'timeout' | 'network',
    readonly httpStatus?: number,
  ) {
    super(
      reason === 'http'
        ? `Resend answered ${httpStatus ?? 'an error'}`
        : `the send to Resend failed (${reason})`,
    );
  }

  /**
   * Whether asking again could answer differently. A bad key, an unverified
   * domain or a malformed address is refused the same way every time; a
   * timeout, a 409 (the same key still in flight), a 429 or a 5xx may not be.
   */
  get settled(): boolean {
    return (
      this.reason === 'http' &&
      this.httpStatus !== undefined &&
      [400, 401, 403, 404, 422].includes(this.httpStatus)
    );
  }
}

export interface ResendConfig {
  readonly settings: AlertSettings;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/** Plain text through Resend's send endpoint, with a key that can only send (ADR 0052 §2). */
export class ResendAlertMailer implements AlertMailer {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly config: ResendConfig) {
    this.fetchImpl = config.fetch ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  async send(message: AlertMessage): Promise<void> {
    const { settings } = this.config;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(RESEND_API_URL, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${settings.apiKey}`,
            'content-type': 'application/json',
            // Resend refuses a request with no User-Agent.
            'user-agent': 'recouple-alerts/1',
            'idempotency-key': message.idempotencyKey,
          },
          body: JSON.stringify({
            from: `Mozart alerts <${settings.from}>`,
            to: [settings.to],
            subject: message.subject,
            text: message.text,
          }),
          signal: abort.signal,
        });
      } catch (error) {
        throw new AlertMailError(
          error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'network',
        );
      }
      // The body is Resend's and says nothing we would print; the status does.
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok) throw new AlertMailError('http', response.status);
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// The function
// ---------------------------------------------------------------------------

export interface AlertContext {
  binding(): AlertBinding;
  mailerFor(settings: AlertSettings): AlertMailer;
}

export type AlertResult =
  | { readonly outcome: 'sent'; readonly test: boolean }
  | { readonly outcome: 'not_configured' | 'misconfigured' | 'not_watched' };

export interface AlertInvocation {
  readonly event: { readonly name: string; readonly data: unknown };
  readonly runId: string;
  readonly step: { run(id: string, work: () => Promise<void>): Promise<unknown> };
}

/**
 * The handler, as a function of the context so a test can invoke it with a
 * stubbed `step` and a stubbed mailer.
 *
 * Nothing it logs is more than a function id, a run id, a variable's name or a
 * status: the same rule as the email.
 */
export function alertSteps(
  context: AlertContext,
): (invocation: AlertInvocation) => Promise<AlertResult> {
  return async ({ event, runId, step }) => {
    const test = event.name === ALERT_TEST_REQUESTED;
    const failure = test ? undefined : parseFailure(event.data);
    if (!test && failure === undefined) {
      // The trigger's filter should have kept this out; the list is checked
      // again because the email is only ever about one of the four.
      console.warn('[recouple] alert: a failure of a function this does not watch; nothing sent');
      return { outcome: 'not_watched' };
    }
    const about = test ? 'test' : `${failure!.functionId} run ${failure!.runId ?? 'unknown'}`;

    const binding = context.binding();
    if (binding.kind === 'none') {
      console.info(
        `[recouple] alert: alerts are not configured (${ALERT_VARIABLES.join(', ')} unset); ` +
          `nothing sent for ${about}`,
      );
      return { outcome: 'not_configured' };
    }
    if (binding.kind === 'misconfigured') {
      console.error(
        `[recouple] alert: alerts are misconfigured — ${binding.reason}; nothing sent for ${about}`,
      );
      return { outcome: 'misconfigured' };
    }

    const message = test ? testMessage(runId) : failureMessage(failure!, runId);
    const mailer = context.mailerFor(binding.settings);
    await step.run('send-alert', async () => {
      try {
        await mailer.send(message);
      } catch (error) {
        const status = error instanceof AlertMailError ? error.message : 'an unexpected error';
        // A failure of this function is reported by nobody (ADR 0052 §5), so
        // this line is the record.
        console.error(`[recouple] alert: not sent for ${about}: ${status}`);
        if (error instanceof AlertMailError && error.settled) {
          throw new NonRetriableError(`alert not sent: ${error.message}`);
        }
        throw new Error(`alert not sent: ${status}`);
      }
    });
    console.info(`[recouple] alert: sent for ${about}`);
    return { outcome: 'sent', test };
  };
}

/** The production context: the environment's answer, and Resend. */
export const ALERT_CONTEXT: AlertContext = {
  binding: () => alertsFromEnv(),
  mailerFor: (settings) => new ResendAlertMailer({ settings }),
};

export function alertOnFailureFunction(client: Inngest, context: AlertContext = ALERT_CONTEXT) {
  return client.createFunction(ALERT_FUNCTION_CONFIG, alertSteps(context));
}

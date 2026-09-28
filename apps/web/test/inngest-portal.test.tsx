import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { Inngest, NonRetriableError, RetryAfterError } from 'inngest';
import { PORTAL_TERMS_ALLOWED, portalTermsAllowances } from '@recouple/core-domain';
import { LocalTokenCipher } from '@recouple/crypto/testing';
import { AlwaysCleanScanner } from '@recouple/pipeline/testing';
import {
  PortalRunAlertError,
  PortalRunLostError,
  PortalWorkerBusyError,
  PortalWorkerContractError,
  PortalWorkerRefusedError,
  PortalWorkerUnavailableError,
  type PortalReadJobDeps,
} from '@recouple/pipeline';
import {
  RunRequestSchema,
  bindingOf,
  parseRecipe,
  type RecipeVersion,
  type RunRequest,
  type WorkerRunEnd,
} from '@recouple/portal';
import {
  PortalOwnerRequiredError,
  PostgresPortalStore,
  PostgresStore,
  closeAllPools,
} from '@recouple/store-postgres';
import { INNGEST_APP_ID, INNGEST_PLAN_CONCURRENCY_LIMIT, READ_REQUESTED } from '../lib/inngest';
import { PORTAL_READ_REQUESTED, portalReadRequestedEvent } from '../lib/portals';
import {
  HttpPortalWorkerClient,
  PORTAL_READ_CONFIG,
  PORTAL_READ_FAN_OUT_CONFIG,
  PORTAL_READ_FAN_OUT_REQUESTED,
  PORTAL_READS_IN_FLIGHT,
  asPortalReadFailure,
  parsePortalReadRequested,
  portalFanOutSteps,
  portalReadDepsFor,
  portalReadEvent,
  portalReadFromEnv,
  portalReadFunctions,
  portalReadSteps,
  portalSteps,
  portalWorkerFor,
  type PortalReadContext,
  type PortalReadEnv,
} from '../lib/inngest-portal';

/**
 * The portal read's Inngest binding (ADR 0057 §6, §13; ADR 0062).
 *
 * What would matter if it were wrong. Does a deployment without the worker's
 * two variables, a queue or production get a run recorded `not_configured`
 * rather than a request somewhere? Does the worker's client send the token to
 * the worker's origin alone, and turn every refusal into a named error that
 * carries no body, token or address? Is the event Settings sends the event
 * this function reads? Does a refused sign-in end the function failed, so the
 * alert sends, and does every failure leave the runtime with ids and a class
 * name only? And, on a real database, does a run write its rows as the
 * connection's member, a capture become a `portal_fetch` document, and a
 * refused sign-in turn the connection off?
 */

vi.mock('../lib/env', () => ({
  env: {
    get databaseUrl(): string {
      // Never dialled by the tests that have no database; the rest use the throwaway.
      return process.env.TEST_DATABASE_URL ?? 'postgres://unused@127.0.0.1:1/unused';
    },
  },
}));

const WORKER = 'https://portal-read.example';
const TOKEN = randomBytes(32).toString('hex');
const INNGEST = { INNGEST_EVENT_KEY: 'evt-key', INNGEST_SIGNING_KEY: 'signkey-prod-0123456789' };
const PAGE_TEXT = 'PAGE-TEXT-CANARY-9142';
const BODY_CANARY = 'WORKER-BODY-CANARY-3317';

const ORIGIN = 'https://accounts.sap.example';

function recipeJson(portalKey: string): Record<string, unknown> {
  return {
    portalKey,
    version: 1,
    effectiveFrom: '2026-01-01',
    hostAllowlist: ['service.ariba.example', 'accounts.sap.example'],
    signIn: { origin: ORIGIN, formPaths: ['/sign-in'], mfaPaths: ['/mfa'], acsPaths: [] },
    neverClick: ['create invoice'],
    postAsRead: [],
    caps: { maxPages: 5, maxDownloads: 0, maxRunMs: 120_000 },
    provenance: { draftedBy: { kind: 'person', id: 'founder' }, source: 'test walk-through', portalAdr: '0062' },
    steps: [
      { kind: 'open', name: 'start', url: `${ORIGIN}/sign-in` },
      { kind: 'sign_in' },
      { kind: 'answer_mfa' },
      { kind: 'expect', name: 'expect_anid', text: 'AN' },
      { kind: 'capture_page', name: 'landing' },
      { kind: 'sign_out' },
    ],
  };
}

const STEP_LOG = ['start', 'sign_in', 'answer_mfa', 'expect_anid', 'landing', 'sign_out'].map((step) => ({
  step,
  passed: true,
}));

const SNAPSHOT = new TextEncoder().encode(
  `<!doctype html>\n<html><body><h1>Home</h1><p>${PAGE_TEXT}</p></body></html>\n`,
);
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function runRequest(over: Partial<RunRequest> = {}): RunRequest {
  const recipe = parseRecipe(recipeJson('sap_business_network'));
  return {
    runId: randomUUID(),
    orgId: randomUUID(),
    connectionId: randomUUID(),
    recipe,
    binding: bindingOf(recipe),
    sealed: { cipher: 'local-envelope', keyId: 'local-portal-key', wrappedKey: 'd3JhcHBlZA==', ciphertext: 'c2VhbGVk' },
    params: {},
    expectAccountId: 'AN01000000001-T',
    dryRun: true,
    ...over,
  };
}

const json = (status: number, body: unknown): Response =>
  new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

let lines: string[];

beforeEach(() => {
  lines = [];
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg))).join(' '));
    });
  }
});

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------

describe('whether this deployment reads portals (portalReadFromEnv)', () => {
  const both = { PORTAL_READ_URL: WORKER, PORTAL_READ_TOKEN: TOKEN, ...INNGEST };

  it('is none with neither of the worker’s variables', () => {
    expect(portalReadFromEnv({ ...INNGEST })).toEqual({ kind: 'none' });
    expect(portalReadFromEnv({ PORTAL_READ_URL: '  ' })).toEqual({ kind: 'none' });
  });

  it('is bound with both, a queue and https, to the worker’s origin', () => {
    expect(portalReadFromEnv(both)).toEqual({ kind: 'bound', url: WORKER, token: TOKEN });
    expect(portalReadFromEnv({ ...both, PORTAL_READ_URL: `${WORKER}/` })).toEqual({ kind: 'bound', url: WORKER, token: TOKEN });
    expect(portalReadFromEnv({ ...both, VERCEL_ENV: 'production' }).kind).toBe('bound');
  });

  it('allows plain http only where the token crosses no network', () => {
    expect(portalReadFromEnv({ ...both, PORTAL_READ_URL: 'http://127.0.0.1:8080' })).toEqual({
      kind: 'bound',
      url: 'http://127.0.0.1:8080',
      token: TOKEN,
    });
  });

  it.each<[string, PortalReadEnv, string]>([
    ['the token without the address', { PORTAL_READ_TOKEN: TOKEN, ...INNGEST }, 'PORTAL_READ_URL is not set'],
    ['the address without the token', { PORTAL_READ_URL: WORKER, ...INNGEST }, 'PORTAL_READ_TOKEN is not set'],
    ['a preview', { ...both, VERCEL_ENV: 'preview' }, 'Production only'],
    ['a short token', { ...both, PORTAL_READ_TOKEN: TOKEN.slice(0, 63) }, 'PORTAL_READ_TOKEN is not 64'],
    ['a token with a space in it', { ...both, PORTAL_READ_TOKEN: `${TOKEN} x` }, 'PORTAL_READ_TOKEN is not 64'],
    ['plain http to another machine', { ...both, PORTAL_READ_URL: 'http://portal-read.example' }, 'is not https'],
    ['an address with a path', { ...both, PORTAL_READ_URL: `${WORKER}/runs` }, 'the worker’s origin'],
    ['an address with a query', { ...both, PORTAL_READ_URL: `${WORKER}/?a=1` }, 'the worker’s origin'],
    ['an address with credentials', { ...both, PORTAL_READ_URL: 'https://u:p@portal-read.example' }, 'the worker’s origin'],
    ['something that is not a URL', { ...both, PORTAL_READ_URL: 'portal-read' }, 'is not a URL'],
    ['no queue', { PORTAL_READ_URL: WORKER, PORTAL_READ_TOKEN: TOKEN }, 'no Inngest keys'],
    ['half a queue', { PORTAL_READ_URL: WORKER, PORTAL_READ_TOKEN: TOKEN, INNGEST_EVENT_KEY: 'e' }, 'half-configured'],
  ])('is misconfigured with %s, naming the variable and never its value', (_, environment, said) => {
    const binding = portalReadFromEnv(environment);
    expect(binding.kind).toBe('misconfigured');
    const reason = binding.kind === 'misconfigured' ? binding.reason : '';
    expect(reason).toContain(said);
    expect(reason).not.toContain(TOKEN.slice(0, 16));
    expect(reason).not.toContain('portal-read.example');
  });

  it('turns every answer but a binding into a run recorded not configured, with why', () => {
    expect(portalWorkerFor({ kind: 'none' })).toEqual({
      kind: 'not_configured',
      reason: 'PORTAL_READ_URL and PORTAL_READ_TOKEN are not set',
    });
    expect(portalWorkerFor({ kind: 'misconfigured', reason: 'why' })).toEqual({ kind: 'not_configured', reason: 'why' });
    const bound = portalWorkerFor({ kind: 'bound', url: WORKER, token: TOKEN });
    expect(bound.kind).toBe('ready');
    expect(bound.kind === 'ready' && bound.client instanceof HttpPortalWorkerClient).toBe(true);
  });
});

describe('the worker, over HTTP', () => {
  function worker(respond: (url: URL, init: RequestInit) => Response | Promise<Response>) {
    const calls: { url: URL; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ url, init: init ?? {} });
      return respond(url, init ?? {});
    });
    const client = new HttpPortalWorkerClient({
      url: WORKER,
      token: TOKEN,
      fetch: fetchImpl as unknown as typeof fetch,
      timeoutMs: 50,
      captureTimeoutMs: 50,
    });
    return { client, calls, fetchImpl };
  }

  /** Nothing a refusal says may carry the token, the worker's address or its body. */
  function expectQuiet(error: unknown): void {
    const said = `${(error as Error).name}: ${(error as Error).message}`;
    for (const withheld of [TOKEN, 'portal-read.example', BODY_CANARY]) expect(said).not.toContain(withheld);
  }

  it('posts a run to /runs with the bearer token, refusing redirects, and reads its handle', async () => {
    const request = runRequest();
    const { client, calls } = worker(() => json(202, { runId: request.runId, state: 'running' }));
    await expect(client.startRun(request)).resolves.toEqual({ runId: request.runId, state: 'running' });
    expect(calls).toHaveLength(1);
    const [{ url, init }] = calls as [{ url: URL; init: RequestInit }];
    expect(url.href).toBe(`${WORKER}/runs`);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(RunRequestSchema.parse(JSON.parse(init.body as string))).toEqual(request);
  });

  it('reads 200 for a run it already holds', async () => {
    const request = runRequest();
    const { client } = worker(() => json(200, { runId: request.runId, state: 'done' }));
    await expect(client.startRun(request)).resolves.toEqual({ runId: request.runId, state: 'done' });
  });

  it('answers a busy worker as busy, to be asked again later', async () => {
    const request = runRequest();
    const { client } = worker(() => json(503, { error: 'busy' }));
    const error = await client.startRun(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PortalWorkerBusyError);
    expect((error as PortalWorkerBusyError).retryAfterMs).toBeGreaterThan(0);
  });

  it.each([
    [401, 'unauthorized'],
    [400, 'bad_request'],
    [413, 'too_large'],
  ] as const)('names a %i refusal by route, status and code, and nothing it was sent', async (status, code) => {
    const { client } = worker(() => json(status, { error: code, note: BODY_CANARY }));
    const error = await client.startRun(runRequest()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PortalWorkerRefusedError);
    expect(error).toMatchObject({ httpStatus: status, code: undefined });
    expectQuiet(error);
    // A body that is exactly the contract's names its code.
    const { client: exact } = worker(() => json(status, { error: code }));
    await expect(exact.startRun(runRequest())).rejects.toMatchObject({ httpStatus: status, code });
  });

  it('answers a run the worker no longer holds as lost, on every route of a run', async () => {
    const runId = randomUUID();
    const { client } = worker(() => json(404, { error: 'not_found' }));
    await expect(client.runState(runId)).rejects.toBeInstanceOf(PortalRunLostError);
    await expect(client.runResult(runId)).rejects.toBeInstanceOf(PortalRunLostError);
    await expect(client.capture(runId, 0)).rejects.toBeInstanceOf(PortalRunLostError);
  });

  it('asks again after a 409, a 5xx, the network or a timeout', async () => {
    const runId = randomUUID();
    await expect(worker(() => json(409, { error: 'not_done' })).client.runResult(runId)).rejects.toBeInstanceOf(
      PortalWorkerUnavailableError,
    );
    await expect(worker(() => json(502, BODY_CANARY)).client.runState(runId)).rejects.toMatchObject({
      name: 'PortalWorkerUnavailableError',
      httpStatus: 502,
    });
    const network = await worker(() => {
      throw new TypeError(`fetch failed for ${WORKER}`);
    })
      .client.runState(runId)
      .catch((e: unknown) => e);
    expect(network).toMatchObject({ name: 'PortalWorkerUnavailableError', detail: 'network' });
    expectQuiet(network);
    const timeout = await worker(
      (_url, init) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    )
      .client.runState(runId)
      .catch((e: unknown) => e);
    expect(timeout).toMatchObject({ name: 'PortalWorkerUnavailableError', detail: 'timeout' });
  });

  it('refuses an answer the contract does not allow', async () => {
    const runId = randomUUID();
    await expect(worker(() => json(200, { runId, state: 'maybe' })).client.runState(runId)).rejects.toBeInstanceOf(
      PortalWorkerContractError,
    );
    await expect(worker(() => json(200, { runId, outcome: 'completed' })).client.runResult(runId)).rejects.toBeInstanceOf(
      PortalWorkerContractError,
    );
  });

  it('never sends a request the contract would refuse', async () => {
    const { client, fetchImpl } = worker(() => json(202, {}));
    const error = await client
      .startRun({ ...runRequest(), expectAccountId: ' padded ' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PortalWorkerContractError);
    expect((error as Error).message).toContain('expectAccountId');
    expect((error as Error).message).not.toContain('padded');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fetches one capture at a time, by its index', async () => {
    const runId = randomUUID();
    const capture = {
      runId,
      index: 1,
      kind: 'page_snapshot',
      stepName: 'landing',
      filename: 'landing.html',
      contentType: 'text/html',
      pagePath: '/landing',
      snapshotRuleVersion: 1,
      capturedAt: '2026-09-28T10:00:00.000Z',
      sha256: sha(SNAPSHOT),
      bodyBase64: Buffer.from(SNAPSHOT).toString('base64'),
    };
    const { client, calls } = worker(() => json(200, capture));
    await expect(client.capture(runId, 1)).resolves.toEqual(capture);
    expect(calls[0]?.url.pathname).toBe(`/runs/${runId}/captures/1`);
    expect(calls[0]?.init.method).toBe('GET');
  });
});

describe('the event', () => {
  const ids = {
    connectionId: randomUUID(),
    orgId: randomUUID(),
    userId: randomUUID(),
    recipeVersionId: randomUUID(),
    runKey: randomUUID(),
  };

  it('reads the dry run Settings → Portals sends', () => {
    const sent = portalReadRequestedEvent({ ...ids, dryRun: true });
    expect(sent.name).toBe(PORTAL_READ_REQUESTED);
    expect(parsePortalReadRequested(sent.data)).toEqual({ ...ids, dryRun: true });
  });

  it('reads the fan-out’s read, which captures and names no version', () => {
    const read = {
      connectionId: ids.connectionId,
      orgId: ids.orgId,
      userId: ids.userId,
      runKey: ids.runKey,
      dryRun: false,
    };
    const sent = portalReadEvent(read);
    expect(sent.name).toBe(PORTAL_READ_REQUESTED);
    expect(parsePortalReadRequested(sent.data)).toEqual(read);
  });

  it('spells every id as the contract and the database do', () => {
    const upper = { ...ids, dryRun: true, connectionId: ids.connectionId.toUpperCase(), orgId: ids.orgId.toUpperCase() };
    expect(parsePortalReadRequested(upper)).toMatchObject({ connectionId: ids.connectionId, orgId: ids.orgId });
  });

  it.each([
    ['no payload', null],
    ['an org that is not an id', { ...ids, dryRun: true, orgId: 'acme' }],
    ['no key', { ...ids, dryRun: true, runKey: undefined }],
    ['no word on whether it captures', { ...ids }],
    ['a word that is not true or false', { ...ids, dryRun: 'yes' }],
    ['a version for a read that captures', { ...ids, dryRun: false }],
  ])('refuses %s, without a retry', (_, data) => {
    expect(() => parsePortalReadRequested(data)).toThrow(NonRetriableError);
  });
});

describe('how the runtime runs it', () => {
  it('is triggered by the event Settings sends, and keyed on the request, not the connection', () => {
    expect(PORTAL_READ_CONFIG.triggers).toEqual([{ event: 'portal/read.requested' }]);
    expect(PORTAL_READ_REQUESTED).toBe('portal/read.requested');
    expect(PORTAL_READ_CONFIG.idempotency).toBe('event.data.runKey');
    expect(Object.keys(portalReadRequestedEvent({
      connectionId: randomUUID(),
      orgId: randomUUID(),
      userId: randomUUID(),
      dryRun: true,
      recipeVersionId: randomUUID(),
      runKey: randomUUID(),
    }).data)).toContain('runKey');
  });

  it('runs one read per connection and one across the fleet, within the plan', () => {
    expect(PORTAL_READ_CONFIG.concurrency).toEqual([
      { key: 'event.data.connectionId', limit: 1 },
      { limit: PORTAL_READS_IN_FLIGHT },
    ]);
    expect(PORTAL_READS_IN_FLIGHT).toBeLessThanOrEqual(INNGEST_PLAN_CONCURRENCY_LIMIT);
  });

  it('has a fan-out nothing schedules', () => {
    expect(PORTAL_READ_FAN_OUT_CONFIG.triggers).toEqual([{ event: PORTAL_READ_FAN_OUT_REQUESTED }]);
    expect(JSON.stringify(PORTAL_READ_FAN_OUT_CONFIG)).not.toContain('cron');
  });

  it('is what the functions register with Inngest', () => {
    const client = new Inngest({ id: INNGEST_APP_ID, isDev: true });
    const context: PortalReadContext = {
      connectionsToRead: async () => [],
      send: async () => undefined,
      depsFor: () => {
        throw new Error('not built at registration');
      },
    };
    const configs = portalReadFunctions(client, context).flatMap(
      (fn) =>
        fn['getConfig']({
          baseUrl: new URL('https://app.example/api/inngest'),
          appPrefix: INNGEST_APP_ID,
        }) as Array<Record<string, unknown>>,
    );
    expect(configs.map((c) => c.id)).toEqual(['recouple-portal-read-fan-out', 'recouple-read-portal']);
    expect(configs.map((c) => c.triggers)).toEqual([
      [{ event: PORTAL_READ_FAN_OUT_REQUESTED }],
      [{ event: PORTAL_READ_REQUESTED }],
    ]);
  });
});

describe('the fan-out', () => {
  function steps() {
    const memo = new Map<string, unknown>();
    return {
      memo,
      async run<T>(id: string, work: () => Promise<T>): Promise<T> {
        if (memo.has(id)) return memo.get(id) as T;
        const kept = JSON.parse(JSON.stringify(await work())) as T;
        memo.set(id, kept);
        return kept;
      },
    };
  }

  it('asks for a read that captures of every enabled connection, as its member, each with a key of its own', async () => {
    const connections = [
      { connectionId: randomUUID(), orgId: randomUUID(), createdBy: randomUUID() },
      { connectionId: randomUUID(), orgId: randomUUID(), createdBy: randomUUID() },
    ];
    const sent: { name: string; data: object }[][] = [];
    const context: PortalReadContext = {
      connectionsToRead: async () => connections,
      send: async (events) => void sent.push([...events]),
      depsFor: () => {
        throw new Error('the fan-out builds no deps');
      },
    };
    const step = steps();
    await expect(portalFanOutSteps(context)({ step })).resolves.toEqual({ connections: 2 });
    expect(sent).toHaveLength(1);
    const events = sent[0]!.map((event) => ({ name: event.name, data: parsePortalReadRequested(event.data) }));
    expect(events.map((e) => e.name)).toEqual([PORTAL_READ_REQUESTED, PORTAL_READ_REQUESTED]);
    expect(events.map((e) => e.data)).toEqual(
      connections.map((c, i) => ({
        connectionId: c.connectionId,
        orgId: c.orgId,
        userId: c.createdBy,
        dryRun: false,
        runKey: events[i]!.data.runKey,
      })),
    );
    expect(new Set(events.map((e) => e.data.runKey)).size).toBe(2);

    // A retry of the send re-sends the keys the list step minted.
    step.memo.delete('send-read-requests');
    await portalFanOutSteps(context)({ step });
    expect(sent[1]).toEqual(sent[0]);
  });

  it('sends nothing when no connection is enabled', async () => {
    const send = vi.fn(async () => undefined);
    await expect(
      portalFanOutSteps({ connectionsToRead: async () => [], send, depsFor: () => ({}) as never })({ step: steps() }),
    ).resolves.toEqual({ connections: 0 });
    expect(send).not.toHaveBeenCalled();
  });
});

describe('what leaves a step, and whether it is asked again', () => {
  const where = `connection ${randomUUID()} org ${randomUUID()}`;
  const inline = {
    run: async <T,>(_id: string, work: () => Promise<T>): Promise<T> => work(),
    sleep: vi.fn(async () => undefined),
  };

  async function failed(error: unknown): Promise<Error> {
    const thrown = await portalSteps(inline, where)
      .run('start', async () => {
        throw error;
      })
      .catch((e: unknown) => e);
    return thrown as Error;
  }

  it('asks a busy worker again after its wait, named as it was', async () => {
    const error = await failed(new PortalWorkerBusyError(randomUUID()));
    expect(error).toBeInstanceOf(RetryAfterError);
    expect(error.name).toBe('PortalWorkerBusyError');
  });

  it.each([
    ['a run the worker lost', new PortalRunLostError(randomUUID())],
    ['a refusal of the worker’s', new PortalWorkerRefusedError('startRun', 401, 'unauthorized')],
    ['a store’s named refusal', new PortalOwnerRequiredError(randomUUID(), randomUUID())],
    ['a check constraint', Object.assign(new Error('violates check'), { code: '23514' })],
  ])('never asks again after %s', async (_, original) => {
    const error = await failed(original);
    expect(error).toBeInstanceOf(NonRetriableError);
    expect(error.name).toBe((original as Error).name);
  });

  it('asks again after anything else, and says only its class and the ids', async () => {
    const error = await failed(new TypeError(`cannot read ${PAGE_TEXT}`));
    expect(error).not.toBeInstanceOf(NonRetriableError);
    expect(error.name).toBe('TypeError');
    expect(error.message).toBe(`TypeError in step start, ${where}`);
    expect(lines.join('\n')).not.toContain(PAGE_TEXT);
  });

  it('ends the function failed, and never again, with the name a recorded end alerts by', () => {
    const alert = new PortalRunAlertError({
      runId: randomUUID(),
      orgId: randomUUID(),
      connectionId: randomUUID(),
      dryRun: true,
      recipeVersionId: randomUUID(),
      outcome: 'needs_attention',
      reason: 'credential_rejected',
      atStep: 'sign_in',
      counts: { pages: 1, captures: 0, newDocuments: 0, deduplicated: 0, refusals: 0 },
      documentIds: [],
      disabled: 'disabled',
    });
    const ended = asPortalReadFailure(alert, { connectionId: randomUUID(), orgId: randomUUID() });
    expect(ended).toBeInstanceOf(NonRetriableError);
    expect(ended.name).toBe('PortalCredentialRejectedError');
    expect(ended.message).toBe(alert.message);

    const other = asPortalReadFailure(new TypeError(PAGE_TEXT), { connectionId: 'c', orgId: 'o' });
    expect(other).toBeInstanceOf(NonRetriableError);
    expect(other.name).toBe('TypeError');
    expect(other.message).toBe('TypeError reading portal connection c for org o');
    expect(lines.join('\n')).not.toContain(PAGE_TEXT);
  });
});

describe('the deps a read runs through (portalReadDepsFor)', () => {
  const identity = { orgId: randomUUID(), userId: randomUUID() };

  it('reads the deployed terms, the portal package’s binding, and a store that cannot seal', () => {
    const { deps } = portalReadDepsFor(identity, async () => undefined, { kind: 'none' });
    expect(deps.terms).toBe(PORTAL_TERMS_ALLOWED);
    expect(deps.bindingOf).toBe(bindingOf);
    expect(deps.store).toBeInstanceOf(PostgresPortalStore);
    expect(deps.ingest.store).toBeInstanceOf(PostgresStore);
    expect(deps.worker).toEqual({ kind: 'not_configured', reason: 'PORTAL_READ_URL and PORTAL_READ_TOKEN are not set' });
  });

  it('says a misconfigured worker aloud, by reason, and still records the run', () => {
    const { deps } = portalReadDepsFor(identity, async () => undefined, { kind: 'misconfigured', reason: 'PORTAL_READ_TOKEN is short' });
    expect(deps.worker.kind).toBe('not_configured');
    expect(lines.join('\n')).toContain('PORTAL_READ_TOKEN is short');
  });

  it('asks for each capture to be read like an upload, as the run’s member, keyed on the document', async () => {
    const sent: { name: string; data: object }[] = [];
    const { deps } = portalReadDepsFor(identity, async (events) => void sent.push(...events), {
      kind: 'bound',
      url: WORKER,
      token: TOKEN,
    });
    const documentId = randomUUID();
    await deps.requestReads([documentId]);
    expect(sent).toEqual([
      { name: READ_REQUESTED, data: { documentId, orgId: identity.orgId, userId: identity.userId, readKey: documentId } },
    ]);
  });
});

// ---------------------------------------------------------------------------
// On a real database: the handler, the job, the store and migration 0038
// ---------------------------------------------------------------------------

const connectionString = process.env.TEST_DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

describeDb('a portal read on Postgres (the handler, the job and migration 0038)', () => {
  const admin = new Pool({ connectionString });
  const config = { connectionString: connectionString as string };
  const orgId = randomUUID();
  const owner = randomUUID();
  const suffix = orgId.slice(0, 8);
  const USERNAME = `svc-${suffix}-DO-NOT-LOG`;
  const PASSWORD = `pw-${suffix}-DO-NOT-LOG`;
  const TOTP = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXQ';
  const appCipher = new LocalTokenCipher({ rootKey: randomBytes(32), keyId: 'local-portal-key', mode: 'seal_only' });
  let made = 0;

  beforeAll(async () => {
    await admin.query(`insert into organizations (id, slug, name) values ($1, $2, 'Portal job')`, [orgId, `portal-job-${suffix}`]);
    await admin.query(`insert into org_settings (org_id) values ($1)`, [orgId]);
    await admin.query(`insert into users (id, email) values ($1, $2)`, [owner, `portal-job-${suffix}@example.test`]);
    await admin.query(`insert into memberships (org_id, user_id, role) values ($1, $2, 'owner')`, [orgId, owner]);
  });

  afterAll(async () => {
    // Nothing is deleted: the portal tables are append-only. The database is a throwaway.
    await closeAllPools();
    await admin.end();
  });

  /** A connection of its own portal, with a promoted version and a sealed credential. */
  async function ready(): Promise<{ key: string; connectionId: string; versionId: string; recipe: RecipeVersion }> {
    made += 1;
    const key = `portal_job_${suffix}_${made}`;
    const store = new PostgresPortalStore(config, { orgId, userId: owner }, { cipher: appCipher });
    const connectionId = await store.createConnection({
      portalKey: key,
      label: 'SAP Business Network plumbing test',
      accountId: `AN${Date.now()}${made}-T`,
      params: {},
    });
    const recipe = parseRecipe(recipeJson(key));
    const versionId = await store.addRecipeVersion({ recipe });
    await store.reviewRecipeVersion({ recipeVersionId: versionId, verdict: 'promoted' });
    await store.sealAndStoreCredential({
      connectionId,
      recipeVersionId: versionId,
      payload: { username: USERNAME, password: PASSWORD, totpSecret: TOTP },
    });
    return { key, connectionId, versionId, recipe };
  }

  /** The worker's contract, in process: one run, done on the first poll. */
  function fakeWorker(end: WorkerRunEnd, captures: readonly { stepName: string; bytes: Uint8Array }[] = []) {
    const requests: RunRequest[] = [];
    const bodies: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      if ((init?.headers as Record<string, string>).authorization !== `Bearer ${TOKEN}`) {
        return json(401, { error: 'unauthorized' });
      }
      if (init?.method === 'POST' && url.pathname === '/runs') {
        bodies.push(init.body as string);
        const request = RunRequestSchema.parse(JSON.parse(init.body as string));
        requests.push(request);
        return json(202, { runId: request.runId, state: 'running' });
      }
      const [, , runId, part, index] = url.pathname.split('/');
      const request = requests.find((r) => r.runId === runId);
      if (request === undefined) return json(404, { error: 'not_found' });
      const listed = request.dryRun ? [] : captures;
      if (part === undefined) return json(200, { runId, state: 'done' });
      if (part === 'result') {
        return json(200, {
          runId,
          counts: { pages: 3, captures: listed.length, refusals: 1 },
          steps: STEP_LOG,
          captures: listed.map((c, i) => ({
            index: i,
            kind: 'page_snapshot',
            stepName: c.stepName,
            sha256: sha(c.bytes),
            byteLength: c.bytes.byteLength,
          })),
          ...end,
        });
      }
      const c = listed[Number(index)];
      if (c === undefined) return json(404, { error: 'not_found' });
      return json(200, {
        runId,
        index: Number(index),
        kind: 'page_snapshot',
        stepName: c.stepName,
        filename: `${c.stepName}.html`,
        contentType: 'text/html',
        pagePath: '/dashboard',
        snapshotRuleVersion: 1,
        capturedAt: '2026-09-28T10:00:00.000Z',
        sha256: sha(c.bytes),
        bodyBase64: Buffer.from(c.bytes).toString('base64'),
      });
    };
    return { requests, bodies, fetch: fetchImpl as typeof fetch };
  }

  function memoSteps() {
    const memo = new Map<string, unknown>();
    return {
      async run<T>(id: string, work: () => Promise<T>): Promise<T> {
        if (memo.has(id)) return memo.get(id) as T;
        const value = await work();
        const kept = value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as T);
        memo.set(id, kept);
        return kept as T;
      },
      async sleep(): Promise<void> {},
    };
  }

  function contextFor(
    worker: ReturnType<typeof fakeWorker>,
    terms: PortalReadJobDeps<RecipeVersion>['terms'],
    sent: { name: string; data: object }[],
  ): PortalReadContext {
    return {
      connectionsToRead: async () => [],
      send: async (events) => void sent.push(...events),
      depsFor: (identity) => ({
        deps: {
          store: new PostgresPortalStore(config, identity),
          worker: {
            kind: 'ready',
            client: new HttpPortalWorkerClient({ url: WORKER, token: TOKEN, fetch: worker.fetch }),
          },
          terms,
          bindingOf,
          ingest: { store: new PostgresStore(config, identity), scanner: new AlwaysCleanScanner() },
          requestReads: async (documentIds) => {
            sent.push(...documentIds.map((documentId) => ({ name: READ_REQUESTED, data: { documentId } })));
          },
        },
        close: async () => undefined,
      }),
    };
  }

  const allow = (key: string) =>
    portalTermsAllowances([{ adr: '0062', portalKey: key, answer: 'allowed', recordedOn: '2026-10-01' }]);

  async function runRow(runId: string) {
    const { rows } = await admin.query<Record<string, unknown>>(
      `select s.dry_run, s.requested_by, s.recipe_version_id, r.outcome, r.reason, r.error_class, r.at_step,
              r.page_count, r.capture_count, r.new_document_count, r.deduplicated_count, r.refusal_count, r.step_log
         from portal_read_starts s left join portal_read_runs r on r.run_id = s.id
        where s.id = $1`,
      [runId],
    );
    return rows[0];
  }

  function expectNothingLeaked(...also: unknown[]): void {
    const text = [...lines, ...also.map((thing) => JSON.stringify(thing) ?? String(thing))].join('\n');
    for (const secret of [USERNAME, PASSWORD, TOTP, TOKEN, PAGE_TEXT]) expect(text).not.toContain(secret);
  }

  it('records a dry run as the connection’s member, and hands the worker the sealed row and nothing else', async () => {
    const { key, connectionId, versionId } = await ready();
    const worker = fakeWorker({ outcome: 'completed' });
    const sent: { name: string; data: object }[] = [];
    const result = await portalReadSteps(contextFor(worker, allow(key), sent))({
      event: portalReadRequestedEvent({
        connectionId,
        orgId,
        userId: owner,
        dryRun: true,
        recipeVersionId: versionId,
        runKey: randomUUID(),
      }),
      step: memoSteps(),
    });

    expect(result).toMatchObject({ outcome: 'completed', dryRun: true, recipeVersionId: versionId });
    expect(await runRow(result.runId)).toEqual({
      dry_run: true,
      requested_by: owner,
      recipe_version_id: versionId,
      outcome: 'completed',
      reason: null,
      error_class: null,
      at_step: null,
      page_count: 3,
      capture_count: 0,
      new_document_count: 0,
      deduplicated_count: 0,
      refusal_count: 1,
      step_log: STEP_LOG,
    });

    const { rows } = await admin.query<{ cipher: string; key_id: string; wrapped_key: string; ciphertext: string }>(
      `select cipher, key_id, wrapped_key, ciphertext from portal_credentials where connection_id = $1`,
      [connectionId],
    );
    expect(worker.requests).toHaveLength(1);
    expect(worker.requests[0]!.sealed).toEqual({
      cipher: rows[0]!.cipher,
      keyId: rows[0]!.key_id,
      wrappedKey: rows[0]!.wrapped_key,
      ciphertext: rows[0]!.ciphertext,
    });
    expect(worker.requests[0]!.dryRun).toBe(true);
    expect(sent).toEqual([]);
    expectNothingLeaked(result, worker.bodies);
  });

  it('stores a capture as a portal_fetch document with no member, a capture row naming it, and asks for its read', async () => {
    const { key, connectionId, versionId } = await ready();
    const worker = fakeWorker({ outcome: 'completed' }, [{ stepName: 'landing', bytes: SNAPSHOT }]);
    const sent: { name: string; data: object }[] = [];
    const result = await portalReadSteps(contextFor(worker, allow(key), sent))({
      event: portalReadEvent({ connectionId, orgId, userId: owner, dryRun: false, runKey: randomUUID() }),
      step: memoSteps(),
    });

    expect(result).toMatchObject({ outcome: 'completed', dryRun: false, recipeVersionId: versionId });
    expect(result.documentIds).toHaveLength(1);
    const documentId = result.documentIds[0]!;
    const { rows: captures } = await admin.query<Record<string, unknown>>(
      `select document_id, refusal, kind, step_name, page_path, snapshot_rule_version, sha256, recipe_version_id
         from portal_captures where run_id = $1`,
      [result.runId],
    );
    expect(captures).toEqual([
      {
        document_id: documentId,
        refusal: null,
        kind: 'page_snapshot',
        step_name: 'landing',
        page_path: '/dashboard',
        snapshot_rule_version: 1,
        sha256: sha(SNAPSHOT),
        recipe_version_id: versionId,
      },
    ]);
    const { rows: arrival } = await admin.query<Record<string, unknown>>(
      `select u.source, u.created_by, d.mime_type, encode(d.sha256, 'hex') as sha
         from documents d join uploads u on u.id = d.upload_id where d.id = $1`,
      [documentId],
    );
    expect(arrival).toEqual([{ source: 'portal_fetch', created_by: null, mime_type: 'text/html', sha: sha(SNAPSHOT) }]);
    expect(await runRow(result.runId)).toMatchObject({ outcome: 'completed', capture_count: 1, new_document_count: 1 });
    expect(sent).toEqual([{ name: READ_REQUESTED, data: { documentId } }]);
    expectNothingLeaked(result);
  });

  it('turns the connection off on a refused sign-in, audits why, and ends the function failed so a person hears', async () => {
    const { key, connectionId, versionId } = await ready();
    const worker = fakeWorker({ outcome: 'needs_attention', reason: 'credential_rejected', atStep: 'sign_in' });
    const error = await portalReadSteps(contextFor(worker, allow(key), []))({
      event: portalReadRequestedEvent({
        connectionId,
        orgId,
        userId: owner,
        dryRun: true,
        recipeVersionId: versionId,
        runKey: randomUUID(),
      }),
      step: memoSteps(),
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NonRetriableError);
    expect((error as Error).name).toBe('PortalCredentialRejectedError');
    const { rows } = await admin.query<{ enabled: boolean }>(`select enabled from portal_connections where id = $1`, [connectionId]);
    expect(rows[0]?.enabled).toBe(false);
    const { rows: audits } = await admin.query<{ action: string; payload: Record<string, unknown> }>(
      `select action, payload from audit_log where subject_id = $1 and action = 'portal_connection.disabled'`,
      [connectionId],
    );
    expect(audits).toEqual([{ action: 'portal_connection.disabled', payload: expect.objectContaining({ reason: 'credential_rejected' }) }]);
    const { rows: runs } = await admin.query<Record<string, unknown>>(
      `select r.outcome, r.reason, r.at_step from portal_read_runs r join portal_read_starts s on s.id = r.run_id
        where s.connection_id = $1`,
      [connectionId],
    );
    expect(runs).toEqual([{ outcome: 'needs_attention', reason: 'credential_rejected', at_step: 'sign_in' }]);
    expectNothingLeaked(error, audits);
  });

  it('refuses every run under ADR 0062 while its terms are pending, and sends the worker nothing', async () => {
    const { connectionId, versionId } = await ready();
    const worker = fakeWorker({ outcome: 'completed' });
    const result = await portalReadSteps(contextFor(worker, PORTAL_TERMS_ALLOWED, []))({
      event: portalReadRequestedEvent({
        connectionId,
        orgId,
        userId: owner,
        dryRun: true,
        recipeVersionId: versionId,
        runKey: randomUUID(),
      }),
      step: memoSteps(),
    });
    expect(result).toMatchObject({ outcome: 'refused', errorClass: 'PortalTermsNotRecordedError' });
    expect(await runRow(result.runId)).toMatchObject({ outcome: 'refused', error_class: 'PortalTermsNotRecordedError' });
    expect(worker.requests).toEqual([]);
  });
});

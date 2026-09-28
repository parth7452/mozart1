import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PORTAL_TERMS_ALLOWED, portalTermsAllowances } from '@recouple/core-domain';
import { allFixtureDocuments } from '@recouple/fixtures';
import type { ScanVerdict } from '@recouple/ingest';
import {
  PORTAL_READ_ERROR_CLASSES,
  PORTAL_READ_MAX_CAPTURES,
  PORTAL_READ_POLL,
  PORTAL_WORKER_BUSY_RETRY_MS,
  PortalCaptureIntegrityError,
  PortalReadConnectionNotFoundError,
  PortalReadJobError,
  PortalReadVersionNotFoundError,
  PortalRunAlertError,
  PortalRunLostError,
  PortalWorkerBusyError,
  PortalWorkerRefusedError,
  PortalWorkerUnavailableError,
  isSettledPortalReadError,
  portalReadPollLimit,
  portalReadRetryAfterMs,
  portalRunNeedsAlert,
  readPortalJob,
  type PortalJobBinding,
  type PortalJobCaptureInput,
  type PortalJobCaptureRow,
  type PortalJobConnection,
  type PortalJobCredential,
  type PortalJobRecipe,
  type PortalJobRecipeVersion,
  type PortalJobRunCapture,
  type PortalJobRunEnd,
  type PortalJobRunEndInput,
  type PortalJobRunRequest,
  type PortalJobRunResult,
  type PortalJobRunStart,
  type PortalJobSteps,
  type PortalReadJobDeps,
  type PortalReadJobInput,
  type PortalReadJobStore,
  type PortalWorkerClient,
  type PortalWorkerRunEnd,
} from '../src/portal-job';
import type { StoredDocument } from '../src/ports';
import { ingestDocument } from '../src/steps';
import { AlwaysCleanScanner, AlwaysInfectedScanner, InMemoryStore } from '../src/testing/memory-store';

/**
 * One portal read, without a queue, a worker or a database (ADR 0057 §6, §13;
 * ADR 0062).
 *
 * What would matter if this were wrong. Is anything read, or the ciphertext
 * sent, before the connection, the member and the portal's terms have all said
 * yes? Does every run that got a start row get an outcome row, and does a
 * refused sign-in turn the connection off before anything else can type the
 * same password? Does every capture go through the ordinary door as
 * `portal_fetch`, counted once however often its step is asked? And does
 * anything a step returns, a line logs or an error says carry the ciphertext
 * or a page?
 */

const ORG = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const SOMEONE = '33333333-3333-4333-8333-333333333333';
const CONNECTION = '44444444-4444-4444-8444-444444444444';
const VERSION = '55555555-5555-4555-8555-555555555555';
const DRAFT = '66666666-6666-4666-8666-666666666666';
const CREDENTIAL = '77777777-7777-4777-8777-777777777777';
const NEWER_CREDENTIAL = '88888888-8888-4888-8888-888888888888';
const ANID = 'AN01000000001-T';

const sha = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

interface TestRecipe extends PortalJobRecipe {
  readonly version: number;
  readonly hostAllowlist: readonly string[];
  readonly signIn: { readonly origin: string; readonly formPaths: readonly string[] };
}

const RECIPE: TestRecipe = {
  portalKey: 'sap_business_network',
  version: 1,
  hostAllowlist: ['portal.example'],
  signIn: { origin: 'https://portal.example', formPaths: ['/login'] },
  caps: { maxRunMs: 120_000 },
  provenance: { portalAdr: '0062' },
};

/** A binding as a function of the recipe alone, as `bindingOf` in @recouple/portal is. */
function bindingOf(recipe: TestRecipe): PortalJobBinding {
  return {
    signInOrigin: recipe.signIn.origin,
    signInPaths: [...recipe.signIn.formPaths].sort(),
    hostsHash: sha([...recipe.hostAllowlist].sort().join('\n')),
  };
}

/** What would be a disaster anywhere but the request body and the row. */
const WRAPPED_KEY = Buffer.from('WRAPPED-DATA-KEY-CANARY').toString('base64');
const CIPHERTEXT = Buffer.from('SEALED-PASSWORD-CANARY').toString('base64');
const SEALED = {
  cipher: 'kms-envelope-aes-256-gcm',
  keyId: 'arn:aws:kms:us-east-1:111122223333:key/portal',
  wrappedKey: WRAPPED_KEY,
  ciphertext: CIPHERTEXT,
};
const PAGE_TEXT = 'PAGE-TEXT-CANARY-5521';
const SNAPSHOT = utf8(
  `<!doctype html>\n<html><body><h1>Home</h1><p>${PAGE_TEXT}</p>` +
    `<table><tr><td>${ANID}</td></tr></table></body></html>\n`,
);
const PDF = (() => {
  const found = allFixtureDocuments().find((d) => d.filename === 'walmart-apdp-notice.pdf');
  if (found === undefined) throw new Error('no walmart-apdp-notice.pdf fixture');
  return found.bytes;
})();
const SECRETS = [WRAPPED_KEY, CIPHERTEXT, 'WRAPPED-DATA-KEY-CANARY', 'SEALED-PASSWORD-CANARY', PAGE_TEXT];

/** The terms gate allowing ADR 0062 for its own portal, as a test's data. */
const ALLOW_0062 = portalTermsAllowances([
  { adr: '0062', portalKey: 'sap_business_network', answer: 'allowed', recordedOn: '2026-10-01' },
]);

// ---------------------------------------------------------------------------
// The store, as migration 0038's functions and triggers answer
// ---------------------------------------------------------------------------

class FakePortalStore implements PortalReadJobStore<TestRecipe> {
  readonly calls: string[] = [];
  connectionRecord: PortalJobConnection | undefined = {
    connectionId: CONNECTION,
    orgId: ORG,
    portalKey: 'sap_business_network',
    accountId: ANID,
    params: {},
    enabled: true,
    createdBy: OWNER,
  };
  readonly versions = new Map<string, PortalJobRecipeVersion<TestRecipe>>([
    [VERSION, { recipeVersionId: VERSION, portalKey: 'sap_business_network', recipe: RECIPE, review: { verdict: 'promoted' } }],
  ]);
  promoted: string | undefined = VERSION;
  readonly credentials: PortalJobCredential[] = [
    { credentialId: CREDENTIAL, connectionId: CONNECTION, sealed: SEALED, binding: bindingOf(RECIPE) },
  ];
  mayWrite = true;
  owner = true;
  readonly starts: PortalJobRunStart[] = [];
  readonly ends: PortalJobRunEndInput[] = [];
  readonly captures: PortalJobCaptureInput[] = [];
  readonly disables: unknown[] = [];
  /** Runs after a start row is first written: a person acting in between. */
  afterStart: (() => void) | undefined;
  disableError: Error | undefined;
  /** The capture row refused, after its checks: nothing of the capture is written. */
  newCaptureError: Error | undefined;

  constructor(readonly documents: InMemoryStore) {}

  async memberMayWrite(actor: { orgId: string; userId: string }): Promise<boolean> {
    this.calls.push('memberMayWrite');
    expect(actor).toEqual({ orgId: ORG, userId: OWNER });
    return this.mayWrite;
  }
  async memberIsOwner(actor: { orgId: string; userId: string }): Promise<boolean> {
    this.calls.push('memberIsOwner');
    expect(actor).toEqual({ orgId: ORG, userId: OWNER });
    return this.owner;
  }
  async connection(connectionId: string): Promise<PortalJobConnection | undefined> {
    this.calls.push('connection');
    return this.connectionRecord?.connectionId === connectionId ? this.connectionRecord : undefined;
  }
  async promotedRecipe(connectionId: string): Promise<PortalJobRecipeVersion<TestRecipe> | undefined> {
    this.calls.push('promotedRecipe');
    expect(connectionId).toBe(CONNECTION);
    return this.promoted === undefined ? undefined : this.versions.get(this.promoted);
  }
  async recipeVersion(recipeVersionId: string): Promise<PortalJobRecipeVersion<TestRecipe> | undefined> {
    this.calls.push('recipeVersion');
    return this.versions.get(recipeVersionId);
  }
  async latestCredential(connectionId: string): Promise<PortalJobCredential | undefined> {
    this.calls.push('latestCredential');
    return this.credentials.filter((c) => c.connectionId === connectionId).at(-1);
  }
  async recordRunStart(input: PortalJobRunStart): Promise<string> {
    this.calls.push('recordRunStart');
    // app.record_portal_read_start(): as the connection's member, a version
    // not promoted only in a dry run, and a replay writes nothing.
    if (input.requestedBy !== this.connectionRecord?.createdBy) {
      throw new Error('a start names the member the connection acts as');
    }
    if (
      !input.dryRun &&
      input.recipeVersionId !== null &&
      this.versions.get(input.recipeVersionId)?.review?.verdict !== 'promoted'
    ) {
      throw new Error('only a dry run runs a version nobody promoted');
    }
    const existing = this.starts.find((s) => s.runId === input.runId);
    if (existing !== undefined) {
      if (!isDeepStrictEqual(existing, input)) throw new Error('a run id names one start');
      return input.runId;
    }
    this.starts.push(input);
    this.afterStart?.();
    return input.runId;
  }
  async recordRunEnd(input: PortalJobRunEndInput): Promise<string> {
    this.calls.push('recordRunEnd');
    const start = this.starts.find((s) => s.runId === input.runId);
    if (start === undefined) throw new Error('an outcome needs its start row');
    if (start.dryRun && (input.counts.captures !== 0 || input.counts.newDocuments !== 0 || input.counts.deduplicated !== 0)) {
      throw new Error('a dry run captures nothing');
    }
    const existing = this.ends.find((e) => e.runId === input.runId);
    if (existing !== undefined) {
      if (!isDeepStrictEqual(existing, input)) throw new Error('a run ends once');
      return `end:${input.runId}`;
    }
    this.ends.push(input);
    return `end:${input.runId}`;
  }
  async recordCapture(input: PortalJobCaptureInput): Promise<string> {
    this.calls.push('recordCapture');
    const start = this.starts.find((s) => s.runId === input.runId);
    if (start === undefined) throw new Error('a capture needs its start row');
    if (start.dryRun) throw new Error('a dry run captures nothing');
    if (start.recipeVersionId !== input.recipeVersionId) throw new Error('a capture names its run’s version');
    const index = this.captures.findIndex((c) => isDeepStrictEqual(c, input));
    if (index >= 0) return `capture:${index}`;
    this.captures.push(input);
    return `capture:${this.captures.length - 1}`;
  }
  /**
   * One transaction, as the Postgres store writes it: every check first, then
   * the arrival, the document and the row, so a refusal writes none of them.
   */
  async recordNewCapture(input: {
    capture: PortalJobCaptureRow;
    document: Omit<StoredDocument, 'documentId' | 'uploadId'>;
  }): Promise<{ document: StoredDocument; captureId: string }> {
    this.calls.push('recordNewCapture');
    const start = this.starts.find((s) => s.runId === input.capture.runId);
    if (start === undefined) throw new Error('a capture needs its start row');
    if (start.dryRun) throw new Error('a dry run captures nothing');
    if (start.recipeVersionId !== input.capture.recipeVersionId) throw new Error('a capture names its run’s version');
    if (input.document.sha256 !== input.capture.sha256) throw new Error('the bytes captured are the bytes kept');
    if (this.newCaptureError !== undefined) throw this.newCaptureError;
    const upload = await this.documents.recordUpload({ orgId: input.document.orgId, source: 'portal_fetch' });
    const document = await this.documents.putDocument({ ...input.document, uploadId: upload.uploadId });
    this.captures.push({ ...input.capture, documentId: document.documentId });
    return { document, captureId: `capture:${this.captures.length - 1}` };
  }
  async disableConnection(input: {
    connectionId: string;
    reason: 'credential_rejected';
    credentialId: string;
  }): Promise<'disabled' | 'newer_credential' | 'already_off' | undefined> {
    this.calls.push('disableConnection');
    this.disables.push(input);
    if (this.disableError !== undefined) throw this.disableError;
    if (this.connectionRecord === undefined) return undefined;
    if (this.credentials.at(-1)?.credentialId !== input.credentialId) return 'newer_credential';
    if (!this.connectionRecord.enabled) return 'already_off';
    this.connectionRecord = { ...this.connectionRecord, enabled: false };
    return 'disabled';
  }
}

// ---------------------------------------------------------------------------
// The worker, as its HTTP contract answers
// ---------------------------------------------------------------------------

interface PlannedCapture {
  readonly kind: 'page_snapshot' | 'download';
  readonly stepName: string;
  readonly bytes: Uint8Array;
  readonly filename: string;
  /** Serve other bytes than the result lists. */
  readonly tampered?: boolean;
}

const STEP_LOG = [
  { step: 'open_sign_in', passed: true },
  { step: 'sign_in', passed: true },
  { step: 'answer_mfa', passed: true },
  { step: 'expect_anid', passed: true },
  { step: 'landing', passed: true },
  { step: 'sign_out', passed: true },
];

class FakeWorker implements PortalWorkerClient<TestRecipe> {
  readonly requests: PortalJobRunRequest<TestRecipe>[] = [];
  readonly calls: string[] = [];
  startState: 'running' | 'done' = 'running';
  /** Successive answers to a poll; the last one repeats. */
  states: ('running' | 'done')[] = ['running', 'done'];
  end: PortalWorkerRunEnd = { outcome: 'completed' };
  planned: PlannedCapture[] = [];
  /** Listed in the result whatever the run: a worker breaking its contract. */
  listAnyway = false;
  startErrors: Error[] = [];
  stateError: Error | undefined;
  resultError: Error | undefined;
  /** Runs after a start: a person acting while the browser is out. */
  afterStartRun: (() => void) | undefined;
  /** The next start is made, and its answer never reaches the job: a timeout, the network. */
  loseStartAnswer = false;
  /** The runs this worker holds: a run it never started is one it answers as lost, as the worker does. */
  readonly started = new Set<string>();

  async startRun(request: PortalJobRunRequest<TestRecipe>) {
    this.calls.push('startRun');
    this.requests.push(request);
    const error = this.startErrors.shift();
    if (error !== undefined) throw error;
    this.started.add(request.runId);
    this.afterStartRun?.();
    if (this.loseStartAnswer) {
      this.loseStartAnswer = false;
      throw new PortalWorkerUnavailableError('startRun', 'timeout');
    }
    return { runId: request.runId, state: this.startState };
  }
  async runState(runId: string) {
    this.calls.push('runState');
    if (this.stateError !== undefined) throw this.stateError;
    if (!this.started.has(runId)) throw new PortalRunLostError(runId);
    const state = this.states.length > 1 ? this.states.shift()! : this.states[0]!;
    return { runId, state };
  }
  async runResult(runId: string): Promise<PortalJobRunResult> {
    this.calls.push('runResult');
    if (this.resultError !== undefined) throw this.resultError;
    const dryRun = this.requests.at(-1)?.dryRun ?? true;
    const listed = dryRun && !this.listAnyway ? [] : this.planned;
    return {
      runId,
      counts: { pages: 4, captures: listed.length, refusals: 2 },
      steps: STEP_LOG,
      captures: listed.map((p, index) => ({
        index,
        kind: p.kind,
        stepName: p.stepName,
        sha256: sha(p.bytes),
        byteLength: p.bytes.byteLength,
      })),
      ...this.end,
    };
  }
  async capture(runId: string, index: number): Promise<PortalJobRunCapture> {
    this.calls.push(`capture:${index}`);
    const p = this.planned[index];
    if (p === undefined) throw new PortalRunLostError(runId);
    const body = p.tampered === true ? utf8('<html><body>other bytes</body></html>') : p.bytes;
    return {
      runId,
      index,
      kind: p.kind,
      stepName: p.stepName,
      filename: p.filename,
      contentType: p.kind === 'page_snapshot' ? 'text/html' : 'application/pdf',
      pagePath: '/landing',
      snapshotRuleVersion: p.kind === 'page_snapshot' ? 1 : null,
      capturedAt: '2026-09-28T10:00:00.000Z',
      sha256: sha(p.bytes),
      bodyBase64: Buffer.from(body).toString('base64'),
    };
  }
}

// ---------------------------------------------------------------------------
// The runtime's steps, as Inngest runs them
// ---------------------------------------------------------------------------

/**
 * Memoizes each step by id and hands back what the queue would keep (its
 * JSON), so a replayed invocation gets what the first one returned. A step
 * that throws is tried again `retries` times unless its error is settled,
 * then its failure is memoized and rethrown, as a step that ran out of
 * retries is.
 */
class FakeSteps implements PortalJobSteps {
  readonly memo = new Map<string, { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: unknown }>();
  readonly ran: string[] = [];
  readonly slept: [string, number][] = [];
  readonly returned: unknown[] = [];

  constructor(private readonly retries = 0) {}

  async run<T>(id: string, work: () => Promise<T>): Promise<T> {
    const memo = this.memo.get(id);
    if (memo !== undefined) {
      if (memo.ok) return memo.value as T;
      throw memo.error;
    }
    for (let attempt = 0; ; attempt += 1) {
      this.ran.push(id);
      try {
        const value = await work();
        const kept: unknown = value === undefined ? undefined : JSON.parse(JSON.stringify(value));
        this.memo.set(id, { ok: true, value: kept });
        this.returned.push(kept);
        return kept as T;
      } catch (error) {
        if (!isSettledPortalReadError(error) && attempt < this.retries) continue;
        this.memo.set(id, { ok: false, error });
        throw error;
      }
    }
  }

  async sleep(id: string, ms: number): Promise<void> {
    if (this.memo.has(id)) return;
    this.memo.set(id, { ok: true, value: undefined });
    this.slept.push([id, ms]);
  }
}

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

function world() {
  const documents = new InMemoryStore();
  const store = new FakePortalStore(documents);
  const worker = new FakeWorker();
  const reads: (readonly string[])[] = [];
  const deps: PortalReadJobDeps<TestRecipe> = {
    store,
    worker: { kind: 'ready', client: worker },
    terms: ALLOW_0062,
    bindingOf,
    ingest: { store: documents, scanner: new AlwaysCleanScanner() },
    requestReads: async (ids) => {
      reads.push([...ids]);
    },
  };
  return { store, worker, documents, reads, deps };
}

function input(over: Partial<PortalReadJobInput> = {}): PortalReadJobInput {
  return { connectionId: CONNECTION, orgId: ORG, actor: { userId: OWNER }, dryRun: true, ...over };
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  const outcome = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(outcome instanceof Error)) throw new Error('expected the job to throw');
  return outcome;
}

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

/** Nothing that leaves the job carries the ciphertext or a page: no step's return, no log line, no error, no row. */
function expectNothingLeaked(...also: unknown[]): void {
  const text = [
    ...lines,
    ...also.map((thing) =>
      thing instanceof Error ? `${thing.name}: ${thing.message}` : JSON.stringify(thing) ?? String(thing),
    ),
  ].join('\n');
  for (const secret of SECRETS) expect(text).not.toContain(secret);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ---------------------------------------------------------------------------

describe('a dry run', () => {
  it('asks its questions, writes its start row, hands the worker the ciphertext, polls, and records the step log', async () => {
    const w = world();
    const steps = new FakeSteps();
    const result = await readPortalJob(w.deps, input(), steps);

    expect(result.runId).toMatch(UUID);
    expect(result).toEqual({
      runId: result.runId,
      orgId: ORG,
      connectionId: CONNECTION,
      dryRun: true,
      recipeVersionId: VERSION,
      outcome: 'completed',
      atStep: null,
      counts: { pages: 4, captures: 0, newDocuments: 0, deduplicated: 0, refusals: 2 },
      documentIds: [],
    });
    expect(w.store.calls).toEqual([
      // prepare
      'connection',
      'memberMayWrite',
      'memberIsOwner',
      'promotedRecipe',
      'latestCredential',
      'recordRunStart',
      // start: asked again, the version by the id the start row names
      'connection',
      'memberMayWrite',
      'memberIsOwner',
      'recipeVersion',
      'latestCredential',
      // finish
      'recordRunEnd',
    ]);
    expect(w.store.starts).toEqual([
      { runId: result.runId, orgId: ORG, connectionId: CONNECTION, recipeVersionId: VERSION, dryRun: true, requestedBy: OWNER },
    ]);
    expect(w.worker.requests).toEqual([
      {
        runId: result.runId,
        orgId: ORG,
        connectionId: CONNECTION,
        recipe: RECIPE,
        binding: bindingOf(RECIPE),
        sealed: SEALED,
        params: {},
        expectAccountId: ANID,
        dryRun: true,
      },
    ]);
    expect(w.store.ends).toEqual([
      {
        runId: result.runId,
        orgId: ORG,
        outcome: 'completed',
        atStep: null,
        counts: { pages: 4, captures: 0, newDocuments: 0, deduplicated: 0, refusals: 2 },
        stepLog: STEP_LOG,
      },
    ]);
    expect(steps.ran).toEqual(['mint-run-id', 'prepare', 'start', 'poll-1', 'poll-2', 'result', 'finish']);
    expect(steps.slept).toEqual([
      ['wait-1', PORTAL_READ_POLL.firstWaitMs],
      ['wait-2', PORTAL_READ_POLL.waitMs],
    ]);
    expect(w.worker.calls).toEqual(['startRun', 'runState', 'runState', 'runResult']);
    expect(w.reads).toEqual([]);
    expect(w.documents.uploads.size).toBe(0);
    expectNothingLeaked(steps.returned, result);
  });

  it('is refused while ADR 0062 records its terms as pending: the deployed data', async () => {
    const w = world();
    const result = await readPortalJob({ ...w.deps, terms: PORTAL_TERMS_ALLOWED }, input(), new FakeSteps());

    expect(result).toMatchObject({
      outcome: 'refused',
      errorClass: PORTAL_READ_ERROR_CLASSES.termsNotAllowing,
      recipeVersionId: VERSION,
      counts: { pages: 0, captures: 0, newDocuments: 0, deduplicated: 0, refusals: 0 },
    });
    expect(result.why).toContain('not_recorded');
    // Nothing past the gate was read, and the ciphertext went nowhere.
    expect(w.store.calls).not.toContain('latestCredential');
    expect(w.worker.calls).toEqual([]);
    expect(w.store.starts).toEqual([expect.objectContaining({ recipeVersionId: VERSION, dryRun: true })]);
    expect(w.store.ends).toEqual([
      expect.objectContaining({ outcome: 'refused', errorClass: 'PortalTermsNotRecordedError', atStep: null, stepLog: [] }),
    ]);
  });

  it('runs a version an owner named, reviewed or not, and only as a dry run', async () => {
    const w = world();
    w.store.versions.set(DRAFT, { recipeVersionId: DRAFT, portalKey: 'sap_business_network', recipe: { ...RECIPE, version: 2 }, review: null });

    const result = await readPortalJob(w.deps, input({ recipeVersionId: DRAFT }), new FakeSteps());
    expect(result).toMatchObject({ outcome: 'completed', recipeVersionId: DRAFT });
    expect(w.store.calls).not.toContain('promotedRecipe');
    expect(w.worker.requests[0]?.recipe).toEqual({ ...RECIPE, version: 2 });

    const other = world();
    await expect(readPortalJob(other.deps, input({ dryRun: false, recipeVersionId: DRAFT }), new FakeSteps())).rejects.toBeInstanceOf(
      PortalReadJobError,
    );
    expect(other.store.calls).toEqual([]);
  });

  it('refuses to dry-run a version an owner rejected', async () => {
    const w = world();
    w.store.versions.set(DRAFT, {
      recipeVersionId: DRAFT,
      portalKey: 'sap_business_network',
      recipe: { ...RECIPE, version: 2 },
      review: { verdict: 'rejected' },
    });
    const result = await readPortalJob(w.deps, input({ recipeVersionId: DRAFT }), new FakeSteps());
    expect(result).toMatchObject({ outcome: 'refused', errorClass: PORTAL_READ_ERROR_CLASSES.recipeRejected, recipeVersionId: DRAFT });
    expect(w.worker.calls).toEqual([]);
  });
});

describe('the questions, in the ledger sync’s order', () => {
  it('refuses a connection that is off before asking anything else', async () => {
    const w = world();
    w.store.connectionRecord = { ...w.store.connectionRecord!, enabled: false };
    const result = await readPortalJob(w.deps, input(), new FakeSteps());
    expect(result).toMatchObject({ outcome: 'refused', errorClass: 'PortalConnectionDisabledError', recipeVersionId: null });
    expect(w.store.calls).toEqual(['connection', 'recordRunStart', 'recordRunEnd']);
    expect(w.worker.calls).toEqual([]);
  });

  it('refuses a member who may no longer write, before any recipe or credential is read', async () => {
    const w = world();
    w.store.mayWrite = false;
    const result = await readPortalJob(w.deps, input(), new FakeSteps());
    expect(result).toMatchObject({ outcome: 'refused', errorClass: 'PortalReadRefusedError' });
    expect(w.store.calls).toEqual(['connection', 'memberMayWrite', 'recordRunStart', 'recordRunEnd']);
  });

  it('refuses a member who is no longer an owner, who could not turn the connection off on a refused sign-in', async () => {
    const w = world();
    w.store.owner = false;
    const result = await readPortalJob(w.deps, input(), new FakeSteps());
    expect(result).toMatchObject({ outcome: 'refused', errorClass: 'PortalReadOwnerRequiredError' });
    expect(w.store.calls).toEqual(['connection', 'memberMayWrite', 'memberIsOwner', 'recordRunStart', 'recordRunEnd']);
  });

  it('refuses a recipe that borrows another portal’s terms', async () => {
    const w = world();
    const unfiOnly = portalTermsAllowances([{ adr: '0062', portalKey: 'unfi', answer: 'allowed', recordedOn: '2026-10-01' }]);
    const result = await readPortalJob({ ...w.deps, terms: unfiOnly }, input(), new FakeSteps());
    expect(result).toMatchObject({ outcome: 'refused', errorClass: 'PortalTermsNotRecordedError' });
    expect(result.why).toContain('other_portal');
    expect(w.worker.calls).toEqual([]);
  });

  it('records a deployment with no worker as not configured, naming what is missing only in its why', async () => {
    const w = world();
    const result = await readPortalJob(
      { ...w.deps, worker: { kind: 'not_configured', reason: 'PORTAL_READ_URL and PORTAL_READ_TOKEN are not set' } },
      input(),
      new FakeSteps(),
    );
    expect(result).toMatchObject({ outcome: 'not_configured', errorClass: 'PortalWorkerNotConfiguredError' });
    expect(result.why).toContain('PORTAL_READ_URL');
    expect(w.store.ends[0]).not.toHaveProperty('why');
    expect(JSON.stringify(w.store.ends)).not.toContain('PORTAL_READ_URL');
    expect(w.store.calls).not.toContain('latestCredential');
  });

  it('records a connection with no promoted version in effect as not configured, naming no version', async () => {
    const w = world();
    w.store.promoted = undefined;
    const result = await readPortalJob(w.deps, input(), new FakeSteps());
    expect(result).toMatchObject({ outcome: 'not_configured', errorClass: 'PortalRecipeNotConfiguredError', recipeVersionId: null });
    expect(w.store.starts[0]?.recipeVersionId).toBeNull();
  });

  it('records a connection with no credential as not configured', async () => {
    const w = world();
    w.store.credentials.length = 0;
    const result = await readPortalJob(w.deps, input(), new FakeSteps());
    expect(result).toMatchObject({ outcome: 'not_configured', errorClass: 'PortalCredentialNotConfiguredError' });
    expect(w.worker.calls).toEqual([]);
  });

  it('finds a credential sealed to another binding itself, and never sends the ciphertext', async () => {
    const w = world();
    w.store.credentials[0] = {
      ...w.store.credentials[0]!,
      binding: bindingOf({ ...RECIPE, hostAllowlist: ['portal.example', 'elsewhere.example'] }),
    };
    const result = await readPortalJob(w.deps, input(), new FakeSteps());
    expect(result).toMatchObject({ outcome: 'needs_attention', reason: 'binding_mismatch', atStep: null });
    expect(w.worker.calls).toEqual([]);
    expect(w.store.ends).toEqual([expect.objectContaining({ outcome: 'needs_attention', reason: 'binding_mismatch' })]);
  });
});

describe('what it throws rather than records', () => {
  it.each([
    ['a connection this tenant cannot see', () => ({ connectionId: SOMEONE }), PortalReadConnectionNotFoundError],
    ['a member who is not the one the connection acts as', () => ({ actor: { userId: SOMEONE } }), PortalReadJobError],
    ['a named version this tenant cannot see', () => ({ recipeVersionId: DRAFT }), PortalReadVersionNotFoundError],
    ['a read that captures naming a version', () => ({ dryRun: false, recipeVersionId: VERSION }), PortalReadJobError],
    ['no org', () => ({ orgId: '' }), PortalReadJobError],
  ] as const)('refuses %s, and writes nothing', async (_, over, type) => {
    const w = world();
    const error = await failure(readPortalJob(w.deps, input(over()), new FakeSteps()));
    expect(error).toBeInstanceOf(type);
    expect(isSettledPortalReadError(error)).toBe(true);
    expect(w.store.starts).toEqual([]);
    expect(w.worker.calls).toEqual([]);
  });

  it('refuses a named version of another portal', async () => {
    const w = world();
    w.store.versions.set(DRAFT, {
      recipeVersionId: DRAFT,
      portalKey: 'unfi',
      recipe: { ...RECIPE, portalKey: 'unfi' },
      review: null,
    });
    await expect(readPortalJob(w.deps, input({ recipeVersionId: DRAFT }), new FakeSteps())).rejects.toBeInstanceOf(PortalReadJobError);
    expect(w.store.starts).toEqual([]);
  });
});

describe('a read that captures', () => {
  function capturing() {
    const w = world();
    w.worker.planned = [
      { kind: 'page_snapshot', stepName: 'landing', bytes: SNAPSHOT, filename: 'landing.html' },
      { kind: 'download', stepName: 'export', bytes: PDF, filename: 'export.pdf' },
    ];
    return w;
  }

  it('takes each capture through the door as portal_fetch, records it, and asks for it to be read', async () => {
    const w = capturing();
    const steps = new FakeSteps();
    const result = await readPortalJob(w.deps, input({ dryRun: false }), steps);

    const documents = [...w.documents.documents.values()];
    expect(documents.map((d) => d.mimeType)).toEqual(['text/html', 'application/pdf']);
    expect([...w.documents.uploads.values()].map((u) => [u.source, u.createdBy])).toEqual([
      ['portal_fetch', undefined],
      ['portal_fetch', undefined],
    ]);
    expect(result).toMatchObject({
      outcome: 'completed',
      dryRun: false,
      counts: { pages: 4, captures: 2, newDocuments: 2, deduplicated: 0, refusals: 2 },
      documentIds: documents.map((d) => d.documentId),
    });
    expect(w.reads).toEqual([documents.map((d) => d.documentId)]);
    expect(w.store.captures).toEqual([
      {
        runId: result.runId,
        orgId: ORG,
        recipeVersionId: VERSION,
        kind: 'page_snapshot',
        stepName: 'landing',
        pagePath: '/landing',
        snapshotRuleVersion: 1,
        sha256: sha(SNAPSHOT),
        capturedAt: new Date('2026-09-28T10:00:00.000Z'),
        documentId: documents[0]!.documentId,
      },
      {
        runId: result.runId,
        orgId: ORG,
        recipeVersionId: VERSION,
        kind: 'download',
        stepName: 'export',
        pagePath: '/landing',
        snapshotRuleVersion: null,
        sha256: sha(PDF),
        capturedAt: new Date('2026-09-28T10:00:00.000Z'),
        documentId: documents[1]!.documentId,
      },
    ]);
    expect(steps.ran).toEqual([
      'mint-run-id',
      'prepare',
      'start',
      'poll-1',
      'poll-2',
      'result',
      'known-0',
      'capture-0',
      'known-1',
      'capture-1',
      'finish',
      'request-reads',
    ]);
    // The rows come before the outcome, and the outcome before any read.
    expect(w.store.calls.slice(-3)).toEqual(['recordNewCapture', 'recordNewCapture', 'recordRunEnd']);

    // A step returns ids and codes: no bytes, no filename, no path.
    const returned = JSON.stringify(steps.returned);
    for (const withheld of ['landing.html', 'export.pdf', Buffer.from(SNAPSHOT).toString('base64'), 'bodyBase64', 'filename', 'pagePath']) {
      expect(returned).not.toContain(withheld);
    }
    expectNothingLeaked(steps.returned, result);
  });

  it('writes a new capture with its arrival, so a refused row leaves no upload and no document', async () => {
    const w = capturing();
    w.store.newCaptureError = new Error('portal capture blocked');
    const error = await failure(readPortalJob(w.deps, input({ dryRun: false }), new FakeSteps()));

    expect(error).toBeInstanceOf(PortalRunAlertError);
    expect(w.store.calls).toContain('recordNewCapture');
    expect(w.store.calls).not.toContain('recordCapture');
    expect(w.documents.uploads.size).toBe(0);
    expect(w.documents.documents.size).toBe(0);
    expect(w.store.captures).toEqual([]);
    expect(w.reads).toEqual([]);
  });

  it('keeps the first arrival of bytes the tenant already held, and counts them as such', async () => {
    const w = capturing();
    const uploaded = await ingestDocument(
      { orgId: ORG, filename: 'backup.pdf', bytes: PDF, source: 'web_upload', uploadedBy: OWNER },
      { store: w.documents, scanner: new AlwaysCleanScanner() },
    );
    const result = await readPortalJob(w.deps, input({ dryRun: false }), new FakeSteps());

    expect(result.counts).toEqual({ pages: 4, captures: 2, newDocuments: 1, deduplicated: 1, refusals: 2 });
    expect(w.documents.uploads.size).toBe(2);
    expect(await w.documents.uploadSourceFor(uploaded.document.documentId)).toBe('web_upload');
    expect(w.store.captures[1]).toMatchObject({ documentId: uploaded.document.documentId });
    expect(result.documentIds).toContain(uploaded.document.documentId);
  });

  it('records a capture the door refuses, keeps no bytes, and ends needing a person at its step', async () => {
    const w = world();
    w.worker.planned = [
      { kind: 'page_snapshot', stepName: 'landing', bytes: SNAPSHOT, filename: 'landing.html' },
      // An "export" that is a web page: a download is decided by its bytes, never let through as a snapshot.
      {
        kind: 'download',
        stepName: 'export',
        bytes: utf8('<!doctype html>\n<html><body><p>an export that is a page</p></body></html>\n'),
        filename: 'export.html',
      },
    ];
    const result = await readPortalJob(w.deps, input({ dryRun: false }), new FakeSteps());

    expect(result).toMatchObject({
      outcome: 'needs_attention',
      reason: 'capture_refused',
      atStep: 'export',
      counts: { captures: 2, newDocuments: 1, deduplicated: 0 },
    });
    expect(w.store.captures[1]).toMatchObject({ stepName: 'export', refusal: 'type_not_allowed' });
    expect(w.store.captures[1]).not.toHaveProperty('documentId');
    expect(w.documents.documents.size).toBe(1);
    expect(result.documentIds).toHaveLength(1);
    expect(portalRunNeedsAlert(result)).toBe(false);
  });

  it('stores a capture that scanned infected and never asks for it to be read', async () => {
    const w = capturing();
    const result = await readPortalJob(
      { ...w.deps, ingest: { store: w.documents, scanner: new AlwaysInfectedScanner() } },
      input({ dryRun: false }),
      new FakeSteps(),
    );
    expect(result).toMatchObject({ outcome: 'completed', documentIds: [] });
    expect(w.store.captures).toHaveLength(2);
    expect(w.reads).toEqual([]);
    expect(lines.join('\n')).toContain('scanned infected');
  });

  it('scans a capture again when the scanner gave no verdict, and counts it once', async () => {
    const w = capturing();
    let scans = 0;
    const flaky = {
      name: 'test-flaky',
      async scan(): Promise<ScanVerdict> {
        scans += 1;
        return scans === 1 ? { status: 'error', scanner: 'test-flaky', detail: 'no verdict' } : { status: 'clean', scanner: 'test-flaky' };
      },
    };
    const steps = new FakeSteps(1);
    const result = await readPortalJob({ ...w.deps, ingest: { store: w.documents, scanner: flaky } }, input({ dryRun: false }), steps);

    expect(result).toMatchObject({ outcome: 'completed', counts: { newDocuments: 2, deduplicated: 0 } });
    expect(steps.ran.filter((id) => id === 'capture-0')).toHaveLength(2);
    expect(w.store.captures).toHaveLength(2);
    expect(w.documents.documents.size).toBe(2);
    expect(w.documents.scans.map((s) => s.verdict.status)).toEqual(['error', 'clean', 'clean']);
    expect(result.documentIds).toHaveLength(2);
  });

  it('refuses a capture whose bytes are not what the worker listed, and records the run failed', async () => {
    const w = world();
    w.worker.planned = [{ kind: 'page_snapshot', stepName: 'landing', bytes: SNAPSHOT, filename: 'landing.html', tampered: true }];
    const error = await failure(readPortalJob(w.deps, input({ dryRun: false }), new FakeSteps()));

    expect(error).toBeInstanceOf(PortalRunAlertError);
    expect(error.name).toBe('PortalRunFailedError');
    expect(w.store.ends).toEqual([
      expect.objectContaining({ outcome: 'failed', reason: 'error', errorClass: 'PortalCaptureIntegrityError', atStep: null }),
    ]);
    expect(w.documents.documents.size).toBe(0);
    expect(w.store.captures).toEqual([]);
    // Fetched again, on a runtime that retries: a transfer that went wrong once may not twice.
    expect(isSettledPortalReadError(new PortalCaptureIntegrityError('run', 0))).toBe(false);
  });

  it('records a run with more captures than one run takes in as failed, before fetching any', async () => {
    const w = world();
    w.worker.planned = Array.from({ length: PORTAL_READ_MAX_CAPTURES + 1 }, (_, i) => ({
      kind: 'page_snapshot' as const,
      stepName: `page_${i}`,
      bytes: utf8(`<html><body><p>page ${i}</p></body></html>`),
      filename: `page_${i}.html`,
    }));
    const error = await failure(readPortalJob(w.deps, input({ dryRun: false }), new FakeSteps()));

    expect(error.name).toBe('PortalRunFailedError');
    expect(w.store.ends).toEqual([
      expect.objectContaining({
        outcome: 'failed',
        errorClass: 'PortalWorkerContractError',
        counts: { pages: 4, captures: PORTAL_READ_MAX_CAPTURES + 1, newDocuments: 0, deduplicated: 0, refusals: 2 },
        stepLog: STEP_LOG,
      }),
    ]);
    expect(w.worker.calls.filter((call) => call.startsWith('capture:'))).toEqual([]);
  });

  it('never lets a dry run capture, whatever the worker lists', async () => {
    const w = capturing();
    w.worker.listAnyway = true;
    const error = await failure(readPortalJob(w.deps, input(), new FakeSteps()));

    expect(error.name).toBe('PortalRunFailedError');
    expect(w.store.ends).toEqual([
      expect.objectContaining({
        outcome: 'failed',
        errorClass: 'PortalWorkerContractError',
        counts: { pages: 0, captures: 0, newDocuments: 0, deduplicated: 0, refusals: 0 },
      }),
    ]);
    expect(w.worker.calls).not.toContain('capture:0');
    expect(w.documents.documents.size).toBe(0);
  });
});

describe('a refused sign-in', () => {
  it('turns the connection off before its outcome is written, and reaches a person', async () => {
    const w = world();
    w.worker.end = { outcome: 'needs_attention', reason: 'credential_rejected', atStep: 'sign_in' };
    const error = await failure(readPortalJob(w.deps, input(), new FakeSteps()));

    expect(error).toBeInstanceOf(PortalRunAlertError);
    expect(error.name).toBe('PortalCredentialRejectedError');
    expect((error as PortalRunAlertError).result).toMatchObject({
      outcome: 'needs_attention',
      reason: 'credential_rejected',
      atStep: 'sign_in',
      disabled: 'disabled',
    });
    expect(w.store.disables).toEqual([{ connectionId: CONNECTION, reason: 'credential_rejected', credentialId: CREDENTIAL }]);
    expect(w.store.calls.slice(-2)).toEqual(['disableConnection', 'recordRunEnd']);
    expect(w.store.connectionRecord?.enabled).toBe(false);
    expect(w.store.ends).toEqual([
      expect.objectContaining({ outcome: 'needs_attention', reason: 'credential_rejected', atStep: 'sign_in' }),
    ]);
    expect(isSettledPortalReadError(error)).toBe(true);
    expect(error.message).toContain(CONNECTION);
    expectNothingLeaked(error);
  });

  it('leaves the connection on when an owner has entered a newer credential since', async () => {
    const w = world();
    w.worker.end = { outcome: 'needs_attention', reason: 'credential_rejected', atStep: 'sign_in' };
    w.worker.afterStartRun = () => {
      w.store.credentials.push({ credentialId: NEWER_CREDENTIAL, connectionId: CONNECTION, sealed: SEALED, binding: bindingOf(RECIPE) });
    };
    const error = await failure(readPortalJob(w.deps, input(), new FakeSteps()));
    expect((error as PortalRunAlertError).result).toMatchObject({ disabled: 'newer_credential' });
    expect(w.store.connectionRecord?.enabled).toBe(true);
  });

  it('asks again when turning it off fails, and writes no outcome until it is off', async () => {
    const w = world();
    w.worker.end = { outcome: 'needs_attention', reason: 'credential_rejected', atStep: 'sign_in' };
    w.store.disableError = new Error('the database blinked');
    const disable = w.store.disableConnection.bind(w.store);
    w.store.disableConnection = async (request) => {
      try {
        return await disable(request);
      } finally {
        // Once: the next attempt finds the database back.
        w.store.disableError = undefined;
      }
    };
    const error = await failure(readPortalJob(w.deps, input(), new FakeSteps(1)));
    expect(error.name).toBe('PortalCredentialRejectedError');
    expect(w.store.calls.filter((call) => call === 'disableConnection')).toHaveLength(2);
    expect(w.store.connectionRecord?.enabled).toBe(false);
    expect(w.store.ends).toEqual([expect.objectContaining({ reason: 'credential_rejected' })]);
  });

  it('records the run failed when the connection cannot be turned off at all, and alerts', async () => {
    const w = world();
    w.worker.end = { outcome: 'needs_attention', reason: 'credential_rejected', atStep: 'sign_in' };
    w.store.disableError = Object.assign(new Error('owner required'), { name: 'PortalOwnerRequiredError' });
    const error = await failure(readPortalJob(w.deps, input(), new FakeSteps()));
    expect(error.name).toBe('PortalRunFailedError');
    expect(w.store.ends).toEqual([
      expect.objectContaining({ outcome: 'failed', reason: 'error', errorClass: 'PortalOwnerRequiredError' }),
    ]);
  });

  it('is never typed again: a start that finds the connection turned off since is refused, and sends nothing', async () => {
    const w = world();
    w.store.afterStart = () => {
      w.store.connectionRecord = { ...w.store.connectionRecord!, enabled: false };
    };
    const result = await readPortalJob(w.deps, input(), new FakeSteps());
    expect(result).toMatchObject({ outcome: 'refused', errorClass: 'PortalConnectionDisabledError', recipeVersionId: VERSION });
    // Asked only whether it already holds the run, which it does not; nothing is sent.
    expect(w.worker.calls).toEqual(['runState']);
    expect(w.worker.requests).toEqual([]);
    expect(w.store.starts).toHaveLength(1);
    expect(w.store.ends).toHaveLength(1);
  });

  it('follows a run whose start reached the worker though its answer was lost, whatever a retry of the start finds', async () => {
    // The first start reached the worker, which is signing in, and its answer
    // never came back; before the step is asked again an owner turns the
    // connection off. Recorded as refused, the run would say nothing was
    // signed in to and drop the portal's refusal, so the connection turned on
    // again would type the refused password (ADR 0057 §8).
    const w = world();
    w.worker.end = { outcome: 'needs_attention', reason: 'credential_rejected', atStep: 'sign_in' };
    w.worker.loseStartAnswer = true;
    w.worker.afterStartRun = () => {
      w.store.connectionRecord = { ...w.store.connectionRecord!, enabled: false };
    };
    const error = await failure(readPortalJob(w.deps, input(), new FakeSteps(1)));

    expect(error.name).toBe('PortalCredentialRejectedError');
    expect((error as PortalRunAlertError).result).toMatchObject({
      outcome: 'needs_attention',
      reason: 'credential_rejected',
      disabled: 'already_off',
    });
    expect(w.worker.calls.filter((call) => call === 'startRun')).toHaveLength(1);
    expect(w.store.ends).toEqual([
      expect.objectContaining({ outcome: 'needs_attention', reason: 'credential_rejected', atStep: 'sign_in' }),
    ]);
    // The refused credential is held on the connection, which was already off.
    expect(w.store.disables).toEqual([{ connectionId: CONNECTION, reason: 'credential_rejected', credentialId: CREDENTIAL }]);
    expectNothingLeaked(error);
  });

  it('records no refusal while the worker cannot say whether it holds the run, and records the run failed', async () => {
    const w = world();
    w.store.afterStart = () => {
      w.store.connectionRecord = { ...w.store.connectionRecord!, enabled: false };
    };
    w.worker.stateError = new PortalWorkerUnavailableError('runState', 'network');
    const error = await failure(readPortalJob(w.deps, input(), new FakeSteps()));

    expect(error.name).toBe('PortalRunFailedError');
    expect(w.store.ends).toEqual([
      expect.objectContaining({ outcome: 'failed', reason: 'error', errorClass: 'PortalWorkerUnavailableError' }),
    ]);
    expect(w.worker.requests).toEqual([]);
    expectNothingLeaked(error);
  });
});

describe('which ends reach a person', () => {
  it.each([
    [{ outcome: 'needs_attention', reason: 'session_expired', atStep: 'landing' }, 'PortalSessionExpiredError'],
    [{ outcome: 'failed', reason: 'guard_refused', atStep: 'open_sign_in' }, 'PortalRunFailedError'],
    [{ outcome: 'failed', reason: 'error', errorClass: 'TokenDecryptionError', atStep: null }, 'PortalRunFailedError'],
  ] as const)('%o is recorded and then alerts as %s', async (end, name) => {
    const w = world();
    w.worker.end = end;
    const error = await failure(readPortalJob(w.deps, input(), new FakeSteps()));
    expect(error.name).toBe(name);
    expect(w.store.ends).toEqual([expect.objectContaining({ outcome: end.outcome, reason: end.reason, atStep: end.atStep })]);
    expect(w.store.disables).toEqual([]);
    expect(w.store.connectionRecord?.enabled).toBe(true);
  });

  it.each(['mfa_unanswerable', 'challenge', 'page_changed', 'terms_prompt', 'account_mismatch', 'binding_mismatch'] as const)(
    'records %s for a person on Settings, and emails no one',
    async (reason) => {
      const w = world();
      w.worker.end = { outcome: 'needs_attention', reason, atStep: reason === 'binding_mismatch' ? null : 'expect_anid' };
      const result = await readPortalJob(w.deps, input(), new FakeSteps());
      expect(result).toMatchObject({ outcome: 'needs_attention', reason });
      expect(w.store.disables).toEqual([]);
    },
  );

  it('alerts on exactly a refused sign-in, an expired session and a failure', () => {
    const ends: [PortalJobRunEnd, boolean][] = [
      [{ outcome: 'completed' }, false],
      [{ outcome: 'refused', errorClass: 'PortalConnectionDisabledError' }, false],
      [{ outcome: 'not_configured', errorClass: 'PortalWorkerNotConfiguredError' }, false],
      [{ outcome: 'needs_attention', reason: 'capture_refused' }, false],
      [{ outcome: 'needs_attention', reason: 'credential_rejected' }, true],
      [{ outcome: 'needs_attention', reason: 'session_expired' }, true],
      [{ outcome: 'failed', reason: 'cap_exceeded' }, true],
      [{ outcome: 'failed', reason: 'error', errorClass: 'Error' }, true],
    ];
    for (const [end, alerts] of ends) expect(portalRunNeedsAlert(end)).toBe(alerts);
  });
});

describe('a worker that cannot answer', () => {
  it('records a run the worker no longer holds as failed, and never starts it again', async () => {
    const w = world();
    w.worker.stateError = new PortalRunLostError('lost');
    const error = await failure(readPortalJob(w.deps, input(), new FakeSteps(3)));
    expect(error.name).toBe('PortalRunFailedError');
    expect(w.store.ends).toEqual([expect.objectContaining({ outcome: 'failed', reason: 'error', errorClass: 'PortalRunLostError' })]);
    expect(w.worker.calls.filter((call) => call === 'startRun')).toHaveLength(1);
    // Settled: asking again would meet the same answer.
    expect(w.worker.calls.filter((call) => call === 'runState')).toHaveLength(1);
  });

  it('records a result that is gone as failed', async () => {
    const w = world();
    w.worker.resultError = new PortalRunLostError('gone');
    const error = await failure(readPortalJob(w.deps, input(), new FakeSteps()));
    expect(error.name).toBe('PortalRunFailedError');
    expect(w.store.ends).toEqual([expect.objectContaining({ errorClass: 'PortalRunLostError' })]);
  });

  it('asks a busy worker again later, with the same run id, and writes one start row', async () => {
    const w = world();
    w.worker.startErrors = [new PortalWorkerBusyError('busy')];
    const result = await readPortalJob(w.deps, input(), new FakeSteps(1));
    expect(result.outcome).toBe('completed');
    expect(w.worker.requests).toHaveLength(2);
    expect(w.worker.requests[0]?.runId).toBe(w.worker.requests[1]?.runId);
    expect(w.store.starts).toHaveLength(1);
    expect(portalReadRetryAfterMs(new PortalWorkerBusyError('x'))).toBe(PORTAL_WORKER_BUSY_RETRY_MS);
    expect(isSettledPortalReadError(new PortalWorkerBusyError('x'))).toBe(false);
  });

  it('records a worker busy through every retry as failed', async () => {
    const w = world();
    w.worker.startErrors = [new PortalWorkerBusyError('busy'), new PortalWorkerBusyError('busy')];
    const error = await failure(readPortalJob(w.deps, input(), new FakeSteps(1)));
    expect(error.name).toBe('PortalRunFailedError');
    expect(w.store.ends).toEqual([expect.objectContaining({ errorClass: 'PortalWorkerBusyError' })]);
  });

  it('records a worker that refuses the request as failed, without asking again', async () => {
    const w = world();
    w.worker.startErrors = [new PortalWorkerRefusedError('startRun', 401, 'unauthorized')];
    const error = await failure(readPortalJob(w.deps, input(), new FakeSteps(3)));
    expect(error.name).toBe('PortalRunFailedError');
    expect(w.worker.requests).toHaveLength(1);
    expect(w.store.ends).toEqual([expect.objectContaining({ errorClass: 'PortalWorkerRefusedError' })]);
  });

  it('stops waiting for a run that never ends, after every cap the worker keeps', async () => {
    const w = world();
    w.worker.states = ['running'];
    const steps = new FakeSteps();
    const error = await failure(readPortalJob(w.deps, input(), steps));
    const limit = portalReadPollLimit(RECIPE.caps.maxRunMs);
    expect(error.name).toBe('PortalRunFailedError');
    expect(steps.ran.filter((id) => id.startsWith('poll-'))).toHaveLength(limit);
    expect(w.store.ends).toEqual([expect.objectContaining({ errorClass: 'PortalRunTimedOutError' })]);
  });

  it('waits as long as the worker can take, and no longer', () => {
    // Two minutes' cap, three of the worker's grace, two of slack: seven minutes of twenty-second polls.
    expect(portalReadPollLimit(120_000)).toBe(22);
    expect(portalReadPollLimit(90 * 60_000)).toBe(portalReadPollLimit(30 * 60_000));
    expect(portalReadPollLimit(Number.NaN)).toBe(portalReadPollLimit(30 * 60_000));
  });
});

describe('a replay', () => {
  it('writes, sends and stores nothing a second time, and answers the same', async () => {
    const w = world();
    w.worker.planned = [{ kind: 'page_snapshot', stepName: 'landing', bytes: SNAPSHOT, filename: 'landing.html' }];
    const steps = new FakeSteps();
    const first = await readPortalJob(w.deps, input({ dryRun: false }), steps);
    const writes = [...w.store.calls];
    const workerCalls = [...w.worker.calls];

    const again = await readPortalJob(w.deps, input({ dryRun: false }), steps);
    expect(again).toEqual(first);
    expect(w.store.calls).toEqual(writes);
    expect(w.worker.calls).toEqual(workerCalls);
    expect(w.documents.uploads.size).toBe(1);
    expect(w.reads).toHaveLength(1);
  });
});

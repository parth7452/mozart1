import { beforeEach, describe, expect, it } from 'vitest';
import {
  openHeldDocument,
  readInboundEmailJob,
  receiveInboundEmail,
  type InboundAddressResolution,
  type InboundDeps,
  type JobDeps,
  type StoredDocument,
} from '@recouple/pipeline';
import { AlwaysCleanScanner, InMemoryInboundStore, InMemoryStore } from '@recouple/pipeline/testing';
import {
  buildExtractionResult,
  type ClassificationResult,
  type DocType,
  type DocumentPayload,
  type ExtractionResult,
} from '@recouple/extraction';
import { allFixtureDocuments, expectedExtraction, type FixtureDocument } from '@recouple/fixtures';
import type { ScanVerdict } from '@recouple/ingest';
import {
  handleInboundPostmark,
  inboundMethodNotAllowed,
  type InboundRouteDeps,
} from '../lib/inbound-route';
import {
  INBOUND_EMAILS_IN_FLIGHT,
  INBOUND_READ_REQUESTED,
  POSTMARK_WEBHOOK_USER,
  READ_INBOUND_EMAIL_CONFIG,
  presentsInboundCredential,
  readInboundEmailSteps,
  type InboundReadRequestedData,
} from '../lib/inbound';
import { INNGEST_PLAN_CONCURRENCY_LIMIT } from '../lib/inngest';
import { config as proxyConfig } from '../proxy';

/**
 * `POST /api/inbound/postmark`, row by row through ADR 0047 §11's table.
 *
 * The door runs against the real request half (`receiveInboundEmail`) over the
 * in-memory stores, so a 200 here means an email was really stored, scanned
 * and recorded, and the event names a message that exists. Postmark, Inngest
 * and the database are the only things not here.
 *
 * Every test also feeds `said`: each response body, log line and event, and
 * the recorded rows. The last test asserts nothing §13 forbids is in any of
 * them — the secret, the token, the recipient, the sender, the subject, a
 * header value, the Authorization header.
 */

const SECRET = 'c0ffee'.repeat(11);
const DOMAIN = 'in.mozart.example';
const TOKEN = '0123456789abcdef0123456789abcdef';
const RETIRED_TOKEN = 'fedcba9876543210fedcba9876543210';
const ORG = '11111111-1111-1111-1111-111111111111';
const OWNER = '22222222-2222-2222-2222-222222222222';
const FORMER = '66666666-6666-6666-6666-666666666666';
const SUBJECT = 'Deduction notice APDP-99812 — urgent';
const SENDER = 'ap-department@walmart.example';
const SPAM_TESTS = 'DKIM_SIGNED,DKIM_VALID,DKIM_VALID_AU,SPF_PASS';

const LIVE: InboundAddressResolution = {
  addressId: '33333333-3333-3333-3333-333333333333',
  orgId: ORG,
  actingMember: OWNER,
  retired: false,
};
const RETIRED: InboundAddressResolution = {
  addressId: '44444444-4444-4444-4444-444444444444',
  orgId: ORG,
  actingMember: OWNER,
  retired: true,
};

function fixture(filename: string): FixtureDocument {
  const found = allFixtureDocuments().find((d) => d.filename === filename);
  if (found === undefined) throw new Error(`no fixture ${filename}`);
  return found;
}
const NOTICE = fixture('walmart-apdp-notice.pdf');

/** Everything the door said or wrote, for the last test's search. */
const said: string[] = [];

const basic = (user: string, password: string) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
const GOOD = basic(POSTMARK_WEBHOOK_USER, SECRET);

function payload(overrides: Record<string, unknown> = {}) {
  return {
    MessageID: 'b7bc2f4a-e38e-4336-af7d-e6c392c2f817',
    From: `Walmart AP <${SENDER}>`,
    FromFull: { Email: SENDER, Name: 'Walmart AP' },
    To: `${TOKEN}@${DOMAIN}`,
    OriginalRecipient: `${TOKEN}@${DOMAIN}`,
    Subject: SUBJECT,
    TextBody: 'Notice attached.',
    Headers: [
      { Name: 'X-Spam-Status', Value: 'No' },
      { Name: 'X-Spam-Score', Value: '-0.1' },
      { Name: 'X-Spam-Tests', Value: SPAM_TESTS },
    ],
    Attachments: [
      {
        Name: NOTICE.filename,
        Content: Buffer.from(NOTICE.bytes).toString('base64'),
        ContentType: 'application/pdf',
      },
    ],
    ...overrides,
  };
}

function post(body: unknown, authorization: string | null = GOOD): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (authorization !== null) headers.set('authorization', authorization);
  return new Request('https://app.mozart.financial/api/inbound/postmark', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

class FixtureReader {
  readonly name = 'fixture';
  calls = 0;
  async classify(document: DocumentPayload): Promise<ClassificationResult> {
    this.calls += 1;
    return {
      docType: 'deduction_notice',
      confidence: 0.99,
      call: { purpose: 'classify', provider: 'anthropic', modelVersion: 'fixture',
              documentId: document.documentId, costMicros: 1, latencyMs: 1, outcome: 'ok' },
    };
  }
  async extract(document: DocumentPayload, docType: DocType): Promise<ExtractionResult> {
    this.calls += 1;
    return buildExtractionResult({
      docType,
      extractor: this.name,
      document: expectedExtraction(NOTICE),
      pageText: document.pageText,
      call: { purpose: 'extract', provider: 'anthropic', modelVersion: 'fixture',
              documentId: document.documentId, costMicros: 1, latencyMs: 1, outcome: 'ok' },
    });
  }
}

/** The in-memory store, plus a document by id, which a job owes itself. */
class JobTestStore extends InMemoryStore {
  async getDocument(documentId: string): Promise<StoredDocument | undefined> {
    return this.documents.get(documentId);
  }
}

/** A scanner that answers what it is told, one answer per call. */
class ScriptedScanner {
  readonly name = 'scripted';
  calls = 0;
  constructor(private readonly answers: (ScanVerdict['status'] | 'crash')[]) {}
  async scan(): Promise<ScanVerdict> {
    const answer = this.answers[Math.min(this.calls, this.answers.length - 1)] ?? 'clean';
    this.calls += 1;
    if (answer === 'crash') throw new Error('the function was killed mid-scan');
    return { status: answer, scanner: this.name };
  }
}

function world(scanner: InboundDeps['scanner'] = new AlwaysCleanScanner()) {
  const store = new JobTestStore();
  store.addMember(ORG, OWNER, 'owner');
  const inbound = new InMemoryInboundStore(ORG, store);
  const reader = new FixtureReader();
  const sent: InboundReadRequestedData[] = [];
  const lines: string[] = [];
  let sendFails = false;
  let formerMayWrite = false;
  const inboundDeps: InboundDeps = { store, scanner, inbound, now: () => new Date() };

  const deps: InboundRouteDeps = {
    binding: () => ({ kind: 'bound', secret: SECRET, domain: DOMAIN }),
    lookup: async (token) => (token === TOKEN ? LIVE : token === RETIRED_TOKEN ? RETIRED : undefined),
    receive: (email, address) => receiveInboundEmail(email, address, inboundDeps),
    recordRefusal: async (address, providerMessageId) => {
      await inbound.recordInboundMessage(
        { addressId: address.addressId, provider: 'postmark', providerMessageId, outcome: 'refused_retired' },
        [],
      );
    },
    memberMayWrite: async (actor) => (actor.userId === FORMER ? formerMayWrite : store.memberMayWrite(actor)),
    send: async (data) => {
      if (sendFails) throw Object.assign(new Error('fetch failed'), { name: 'TypeError' });
      sent.push(data);
      said.push(JSON.stringify(data));
    },
    log: {
      info: (line: string) => {
        lines.push(line);
        said.push(line);
      },
      error: (line: string) => {
        lines.push(line);
        said.push(line);
      },
    },
  };

  const jobDeps = { store, scanner, inbound, classifier: reader, extractor: reader } as unknown as JobDeps & {
    inbound: InMemoryInboundStore;
  };
  return {
    store,
    inbound,
    reader,
    sent,
    lines,
    deps,
    jobDeps,
    failSends: (fails: boolean) => {
      sendFails = fails;
    },
    letFormerWrite: (may: boolean) => {
      formerMayWrite = may;
    },
  };
}

async function answer(request: Request, deps: InboundRouteDeps) {
  const response = await handleInboundPostmark(request, deps);
  const body = await response.text();
  said.push(body);
  return { status: response.status, body, headers: response.headers };
}

beforeEach(() => {
  said.length = 0;
});

describe('the credential (§2)', () => {
  it('matches only postmark:<secret>, compared as hashes', () => {
    expect(presentsInboundCredential(GOOD, SECRET)).toBe(true);
    expect(presentsInboundCredential(GOOD.replace('Basic', 'basic'), SECRET)).toBe(true);
    expect(presentsInboundCredential(basic('postmark', `${SECRET}x`), SECRET)).toBe(false);
    expect(presentsInboundCredential(basic('mark', SECRET), SECRET)).toBe(false);
    expect(presentsInboundCredential(basic('postmark', SECRET.slice(0, 10)), SECRET)).toBe(false);
    expect(presentsInboundCredential(`Bearer ${SECRET}`, SECRET)).toBe(false);
    expect(presentsInboundCredential(null, SECRET)).toBe(false);
    expect(presentsInboundCredential('Basic', SECRET)).toBe(false);
  });
});

describe('what the route answers (§11)', () => {
  it('answers 503 and logs nothing where this deployment receives no email', async () => {
    const { deps, lines } = world();
    const result = await answer(post(payload()), { ...deps, binding: () => ({ kind: 'none' }) });
    expect(result).toMatchObject({ status: 503, body: 'unavailable' });
    expect(lines).toEqual([]);
  });

  it('answers 503 and logs why where the binding is half-made', async () => {
    const { deps, lines } = world();
    const result = await answer(post(payload()), {
      ...deps,
      binding: () => ({ kind: 'misconfigured', reason: 'no virus scanner is configured, so nothing could be read' }),
    });
    expect(result.status).toBe(503);
    expect(lines).toEqual([
      '[recouple] inbound email refuses to serve: no virus scanner is configured, so nothing could be read',
    ]);
  });

  it('challenges a missing or wrong credential with 401, before it reads the body', async () => {
    for (const authorization of [null, basic('postmark', 'wrong'), `Bearer ${SECRET}`]) {
      const { deps, store, inbound } = world();
      const result = await answer(post(payload(), authorization), deps);
      expect(result.status).toBe(401);
      expect(result.headers.get('www-authenticate')).toBe('Basic realm="inbound"');
      expect(store.uploads.size).toBe(0);
      expect(inbound.messages).toHaveLength(0);
    }
    // Not even a body that is not JSON is looked at.
    const { deps } = world();
    expect((await answer(post('not json', null), deps)).status).toBe(401);
  });

  it('answers 503 to a payload our schema cannot read, since only our Postmark holds the credential', async () => {
    for (const body of ['not json', { To: `${TOKEN}@${DOMAIN}` }, payload({ Attachments: 'none' })]) {
      const { deps, lines } = world();
      expect((await answer(post(body), deps)).status).toBe(503);
      expect(lines[0]).toMatch(/^\[recouple\] inbound email: payload refused \(\w+\)$/);
    }
  });

  it('answers 503 to a recipient on another domain — Postmark’s Check button lands here', async () => {
    const { deps, lines, inbound } = world();
    const check = payload({ OriginalRecipient: 'ad8a4d0842c486355a33a7f019caab51@inbound.postmarkapp.com' });
    expect((await answer(post(check), deps)).status).toBe(503);
    expect(lines).toEqual([`[recouple] inbound email ${check.MessageID}: not_our_domain`]);
    expect(inbound.messages).toHaveLength(0);
  });

  it('answers 403 on our domain to what is not a token, and to a token nobody was given', async () => {
    const { deps, lines, store } = world();
    expect((await answer(post(payload({ OriginalRecipient: `support@${DOMAIN}` })), deps)).status).toBe(403);
    expect(
      (await answer(post(payload({ OriginalRecipient: `${'9'.repeat(32)}@${DOMAIN}` })), deps)).status,
    ).toBe(403);
    expect(lines.map((line) => line.split(': ').at(-1))).toEqual(['not_a_token', 'unknown_token']);
    expect(store.uploads.size).toBe(0);
  });

  it('refuses a retired address with 403, and records it as the retirer who may still write', async () => {
    const { deps, inbound, store } = world();
    const retired = payload({ OriginalRecipient: `${RETIRED_TOKEN}@${DOMAIN}` });
    expect((await answer(post(retired), deps)).status).toBe(403);
    expect(inbound.messages).toEqual([
      expect.objectContaining({ addressId: RETIRED.addressId, outcome: 'refused_retired', parts: [] }),
    ]);
    expect(store.uploads.size).toBe(0);
  });

  it('refuses a retired address whose retirer may no longer write, with only a log line', async () => {
    const { deps, inbound, lines } = world();
    const byFormer = { ...deps, lookup: async () => ({ ...RETIRED, actingMember: FORMER }) };
    expect((await answer(post(payload()), byFormer)).status).toBe(403);
    expect(inbound.messages).toHaveLength(0);
    expect(lines[0]).toContain(`refused_retired, address ${RETIRED.addressId} org ${ORG}`);
  });

  it('answers 503 and stores nothing while the member an address acts as may not write', async () => {
    const { deps, store, inbound, lines } = world();
    const stale = { ...deps, lookup: async () => ({ ...LIVE, actingMember: FORMER }) };
    expect((await answer(post(payload()), stale)).status).toBe(503);
    expect(store.uploads.size).toBe(0);
    expect(inbound.messages).toHaveLength(0);
    expect(lines[0]).toContain(`acting member may not write, address ${LIVE.addressId} org ${ORG}`);
  });

  it('answers 503 when the database cannot be asked whose token it is, by class name', async () => {
    const { deps, lines } = world();
    const down = {
      ...deps,
      lookup: async () => {
        throw Object.assign(new Error(`connection refused for ${TOKEN}`), { name: 'DatabaseError' });
      },
    };
    expect((await answer(post(payload()), down)).status).toBe(503);
    expect(lines).toEqual([
      '[recouple] inbound email b7bc2f4a-e38e-4336-af7d-e6c392c2f817: address lookup failed (DatabaseError)',
    ]);
  });

  it('answers 503 when a refusal at a retired address cannot be recorded, so the retry records it', async () => {
    const { deps, lines } = world();
    const failing = {
      ...deps,
      recordRefusal: async () => {
        throw Object.assign(new Error('timeout'), { name: 'DatabaseError' });
      },
    };
    const retired = payload({ OriginalRecipient: `${RETIRED_TOKEN}@${DOMAIN}` });
    expect((await answer(post(retired), failing)).status).toBe(503);
    expect(lines[0]).toContain(`refusal at retired address ${RETIRED.addressId} org ${ORG} not recorded (DatabaseError)`);
  });

  it('answers 503 at once when the claim pool is full, spending nothing', async () => {
    const { deps, store, inbound } = world();
    inbound.poolFull = true;
    expect((await answer(post(payload()), deps)).status).toBe(503);
    expect(store.uploads.size).toBe(0);
  });

  it('answers 200 only after the message, its parts and the event', async () => {
    const { deps, inbound, sent } = world();
    const recordedWhenSent: number[] = [];
    const watching = {
      ...deps,
      send: async (data: InboundReadRequestedData) => {
        recordedWhenSent.push(inbound.messages.length);
        await deps.send(data);
      },
    };
    const result = await answer(post(payload()), watching);

    expect(result).toMatchObject({ status: 200, body: 'ok' });
    expect(recordedWhenSent).toEqual([1]);
    const [message] = inbound.messages;
    expect(message?.parts.map((p) => [p.kind, p.outcome])).toEqual([
      ['attachment', 'stored'],
      ['body', 'body_too_short'],
    ]);
    expect(sent).toEqual([
      { orgId: ORG, userId: OWNER, inboundMessageId: message?.id, readKey: message?.id },
    ]);
  });

  it('answers 200 to an email whose every part was refused: it is on the record, with why', async () => {
    const { deps, inbound, sent } = world();
    const zip = { Name: 'deductions.zip', Content: Buffer.from([0x50, 0x4b, 3, 4, 0, 0]).toString('base64'),
                  ContentType: 'application/zip' };
    expect((await answer(post(payload({ Attachments: [zip], TextBody: 'thanks' })), deps)).status).toBe(200);
    expect(inbound.messages[0]?.parts.map((p) => p.outcome)).toEqual(['type_not_allowed', 'body_too_short']);
    expect(sent).toHaveLength(1);
  });

  it('answers an email already recorded with 200, and sends its event again', async () => {
    const { deps, inbound, sent, store } = world();
    expect((await answer(post(payload()), deps)).status).toBe(200);
    const uploads = store.uploads.size;
    const again = await answer(post(payload()), deps);

    expect(again.status).toBe(200);
    expect(inbound.messages).toHaveLength(1);
    expect(store.uploads.size).toBe(uploads);
    // The same readKey: the runtime's window on it swallows the second send.
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
  });

  it('answers 503 when the event cannot be sent, and the retry sends it', async () => {
    const { deps, inbound, sent, failSends, lines } = world();
    failSends(true);
    expect((await answer(post(payload()), deps)).status).toBe(503);
    expect(inbound.messages).toHaveLength(1);
    expect(lines.at(-1)).toMatch(/read not queued \(TypeError\)$/);

    failSends(false);
    expect((await answer(post(payload()), deps)).status).toBe(200);
    expect(inbound.messages).toHaveLength(1);
    expect(sent).toEqual([expect.objectContaining({ inboundMessageId: inbound.messages[0]?.id })]);
  });

  it('answers 503 when the scanner gives no verdict, and the retry scans again', async () => {
    const scanner = new ScriptedScanner(['error', 'clean']);
    const { deps, inbound, store } = world(scanner);
    expect((await answer(post(payload()), deps)).status).toBe(503);
    expect(inbound.messages).toHaveLength(0);

    expect((await answer(post(payload()), deps)).status).toBe(200);
    expect(scanner.calls).toBe(2);
    expect(store.uploads.size).toBe(1);
    expect(inbound.messages[0]?.parts[0]?.outcome).toBe('already_held');
  });

  it('recovers an attempt killed between the bytes and the scan: one record, one arrival, every document read', async () => {
    const scanner = new ScriptedScanner(['crash', 'clean']);
    const { deps, inbound, store, jobDeps, sent } = world(scanner);
    expect((await answer(post(payload()), deps)).status).toBe(503);
    expect(store.documents.size).toBe(1);
    expect(inbound.messages).toHaveLength(0);

    expect((await answer(post(payload()), deps)).status).toBe(200);
    expect(inbound.messages).toHaveLength(1);
    expect(store.uploads.size).toBe(1);

    const event = sent[0] as InboundReadRequestedData;
    const read = await readInboundEmailJob(jobDeps, event);
    expect(read.reads).toHaveLength(1);
    expect(read.reads[0]).toMatchObject({ docType: 'deduction_notice', held: 'by_email' });
  });

  it('holds an emailed notice for a person, who opens the case from it', async () => {
    const { deps, store, jobDeps, sent } = world();
    expect((await answer(post(payload()), deps)).status).toBe(200);
    const read = await readInboundEmailJob(jobDeps, sent[0] as InboundReadRequestedData);
    const documentId = read.reads[0]?.documentId as string;
    expect(read.reads[0]).toMatchObject({ held: 'by_email', deductionId: null });
    expect(store.cases.size).toBe(0);

    const opened = await openHeldDocument(store, { orgId: ORG, documentId, confirmedBy: OWNER });
    expect(opened.opened).toHaveLength(1);
    expect(store.cases.size).toBe(1);
  });

  it('is not behind the session proxy, which has no session to refresh here (§1)', () => {
    const [matcher] = proxyConfig.matcher;
    const proxied = (path: string) => new RegExp(`^${matcher}$`).test(path);
    expect(proxied('/api/inbound/postmark')).toBe(false);
    expect(proxied('/settings/email')).toBe(true);
    expect(proxied('/')).toBe(true);
  });

  it('answers anything but POST with 405', async () => {
    const response = inboundMethodNotAllowed();
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
    expect(await response.text()).toBe('method not allowed');
  });
});

describe('the job (§8)', () => {
  it('reads each document as its own step, as the member the event names, and closes its store', async () => {
    const { deps, sent, jobDeps } = world();
    expect((await answer(post(payload()), deps)).status).toBe(200);

    const steps: string[] = [];
    let closed = 0;
    const run = readInboundEmailSteps({
      storeFor: (identity) => {
        expect(identity).toEqual({ orgId: ORG, userId: OWNER });
        return Object.assign(Object.create(jobDeps.store) as object, {
          close: async () => {
            closed += 1;
          },
        }) as never;
      },
      depsFor: () => jobDeps,
      inboundFor: () => jobDeps.inbound as never,
    });
    const result = await run({
      event: { data: sent[0] },
      step: {
        run: async <T,>(id: string, work: () => Promise<T>) => {
          steps.push(id);
          return work();
        },
      },
    });
    expect(steps).toEqual([`read-${result.reads[0]?.documentId}`]);
    expect(closed).toBe(1);
  });

  it('refuses an event that does not carry ids, without retrying it', async () => {
    const run = readInboundEmailSteps({
      storeFor: () => {
        throw new Error('no store should be built');
      },
      depsFor: () => {
        throw new Error('no deps');
      },
      inboundFor: () => {
        throw new Error('no inbound');
      },
    });
    await expect(
      run({ event: { data: { orgId: ORG, userId: 'x', inboundMessageId: 'y', readKey: 'z' } }, step: { run: async (_id, work) => work() } }),
    ).rejects.toMatchObject({ name: 'NonRetriableError' });
  });

  it('does not retry a member who may no longer write', async () => {
    const { deps, sent, jobDeps } = world();
    expect((await answer(post(payload()), deps)).status).toBe(200);
    const run = readInboundEmailSteps({
      storeFor: () => Object.assign(Object.create(jobDeps.store) as object, { close: async () => undefined }) as never,
      depsFor: () => jobDeps,
      inboundFor: () => jobDeps.inbound as never,
    });
    const stranger = { ...(sent[0] as InboundReadRequestedData), userId: '77777777-7777-7777-7777-777777777777' };
    await expect(
      run({ event: { data: stranger }, step: { run: async (_id, work) => work() } }),
    ).rejects.toMatchObject({ name: 'NonRetriableError' });
  });

  it('is keyed on the message and fits inside the plan’s concurrency', () => {
    expect(READ_INBOUND_EMAIL_CONFIG.triggers).toEqual([{ event: INBOUND_READ_REQUESTED }]);
    expect(READ_INBOUND_EMAIL_CONFIG.idempotency).toBe('event.data.readKey');
    expect(INBOUND_EMAILS_IN_FLIGHT).toBeLessThanOrEqual(INNGEST_PLAN_CONCURRENCY_LIMIT);
    const keyless = READ_INBOUND_EMAIL_CONFIG.concurrency.filter((option) => option.key === undefined);
    expect(keyless).toEqual([{ limit: INBOUND_EMAILS_IN_FLIGHT }]);
  });
});

describe('what the door says (§13)', () => {
  it('puts no secret, token, recipient, sender, subject or header value in any answer, log or event', async () => {
    const { deps, inbound, failSends } = world();
    // Drive the door through the answers that log: refusals, a failure, a success.
    await answer(post(payload(), basic('postmark', 'wrong')), deps);
    await answer(post(payload({ OriginalRecipient: `support@${DOMAIN}` })), deps);
    await answer(post(payload({ OriginalRecipient: `${'9'.repeat(32)}@${DOMAIN}` })), deps);
    await answer(post(payload({ OriginalRecipient: `${RETIRED_TOKEN}@${DOMAIN}` })), deps);
    await answer(post(payload({ OriginalRecipient: `${TOKEN}@elsewhere.example` })), deps);
    failSends(true);
    await answer(post(payload()), deps);
    failSends(false);
    await answer(post(payload()), deps);
    await answer(post('not json'), deps);
    said.push(JSON.stringify(inbound.messages.map(({ parts, ...message }) => ({ ...message, parts }))));

    const forbidden = [
      SECRET,
      TOKEN,
      RETIRED_TOKEN,
      `${TOKEN}@${DOMAIN}`,
      'support@',
      SENDER,
      'Walmart AP',
      SUBJECT,
      SPAM_TESTS,
      GOOD,
      Buffer.from(`${POSTMARK_WEBHOOK_USER}:${SECRET}`).toString('base64'),
    ];
    expect(said.length).toBeGreaterThan(10);
    for (const line of said) {
      for (const secret of forbidden) expect(line).not.toContain(secret);
    }
  });
});

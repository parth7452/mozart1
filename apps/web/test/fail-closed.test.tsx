import { afterEach, describe, expect, it } from 'vitest';
import { processUpload } from '@recouple/pipeline';
import { AlwaysCleanScanner, InMemoryStore } from '@recouple/pipeline/testing';
import {
  ClaudeExtractor,
  buildExtractionResult,
  type ClassificationResult,
  type DocType,
  type DocumentPayload,
  type ExtractionResult,
} from '@recouple/extraction';
import { allFixtureDocuments, expectedExtraction } from '@recouple/fixtures';
import { InlineRunner, InngestRunner, pipelineDepsFor, runnerFromEnv } from '../lib/pipeline';
import { INBOUND_SECRET_MIN_LENGTH, inboundEmailFromEnv } from '../lib/inbound';

/**
 * What the app does when it is not fully configured.
 *
 * The answer that matters is that it refuses rather than guesses. An environment
 * with no malware scanner must not be able to read a stranger's file, and the
 * way to be sure is to run the real assembly with the variable unset.
 */
const notice = allFixtureDocuments().find((d) => d.filename === 'walmart-apdp-notice.pdf');

if (notice === undefined) throw new Error('the walmart notice fixture is missing');

const upload = {
  orgId: '11111111-1111-1111-1111-111111111111',
  filename: notice.filename,
  bytes: notice.bytes,
  source: 'web_upload' as const,
  pageText: notice.pageText,
};

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe('an unconfigured environment', () => {
  it('refuses to read a file when no malware scanner is configured', async () => {
    delete process.env.CLAMAV_HOST;
    delete process.env.CLAMAV_SCAN_URL;
    delete process.env.CLAMAV_SCAN_TOKEN;
    const store = new InMemoryStore();
    const deps = pipelineDepsFor(store);
    expect(deps.scanner.name).toBe('none');

    const result = await processUpload(upload, deps);

    // Invariant 4: no verdict is not a pass. The file is stored and scanned —
    // the scan is what reports the error — and nothing reads it after that.
    expect(result.haltedBecause).toMatch(/not scanned clean/);
    // And it says which of the two it is. `error (none)` on its own sends
    // someone looking for a corrupt file when the answer is an unset variable.
    expect(result.haltedBecause).toMatch(/no malware scanner is configured/);
    expect(result.classification).toBeUndefined();
    expect(result.extraction).toBeUndefined();
    expect(result.case).toBeUndefined();
    // And it cost nothing: no model was called on an unscanned file.
    expect(store.modelCalls).toEqual([]);
  });

  it('reads with no paged extraction, which could not finish inside a job (ADR 0053 §6)', () => {
    const deps = pipelineDepsFor(new InMemoryStore());
    expect(deps.extractor).toBeInstanceOf(ClaudeExtractor);
    expect((deps.extractor as ClaudeExtractor).pagesWhenCutOff).toBe(false);
  });

  it('constructs no OCR provider without a key, rather than one that throws', () => {
    delete process.env.REDUCTO_API_KEY;
    const deps = pipelineDepsFor(new InMemoryStore());
    expect(deps.ocr).toBeUndefined();
  });

  it('uses clamd when it is configured', () => {
    delete process.env.CLAMAV_SCAN_URL;
    process.env.CLAMAV_HOST = 'clamd.internal';
    expect(pipelineDepsFor(new InMemoryStore()).scanner.name).toBe('clamav');
  });

  it('uses the hosted scanner when the deployment has one', () => {
    process.env.CLAMAV_SCAN_URL = 'https://scan.example/scan';
    process.env.CLAMAV_SCAN_TOKEN = 'token';
    expect(pipelineDepsFor(new InMemoryStore()).scanner.name).toBe('clamav-http');
  });

  it('refuses to read a file when the hosted scanner has a URL but no token', async () => {
    // Half-configured is not configured. The alternative — calling an
    // authenticated service without authenticating — is a slower way of not
    // scanning, and one that looks like a scanner in the logs (ADR 0018).
    process.env.CLAMAV_SCAN_URL = 'https://scan.example/scan';
    delete process.env.CLAMAV_SCAN_TOKEN;
    delete process.env.CLAMAV_HOST;

    const store = new InMemoryStore();
    const deps = pipelineDepsFor(store);
    expect(deps.scanner.name).toBe('none');

    const result = await processUpload(upload, deps);
    expect(result.haltedBecause).toMatch(/not scanned clean/);
    expect(result.extraction).toBeUndefined();
    expect(store.modelCalls).toEqual([]);
  });

  it('still reads a file once something declares it clean', async () => {
    // The gate is the scan verdict, not the scanner's identity. The readers are
    // stubbed here on purpose: `pipelineDepsFor` builds the real Claude ones, and
    // a test that calls a model is a test that costs money and needs a network.
    const store = new InMemoryStore();
    const deps = {
      ...pipelineDepsFor(store),
      scanner: new AlwaysCleanScanner(),
      classifier: {
        async classify(document: DocumentPayload): Promise<ClassificationResult> {
          return {
            docType: 'deduction_notice',
            confidence: 0.99,
            call: {
              purpose: 'classify', provider: 'anthropic', modelVersion: 'stub',
              documentId: document.documentId, costMicros: 0, latencyMs: 0, outcome: 'ok',
            },
          };
        },
      },
      extractor: {
        name: 'stub',
        async extract(document: DocumentPayload, docType: DocType): Promise<ExtractionResult> {
          return buildExtractionResult({
            docType, extractor: 'stub', document: expectedExtraction(notice),
            pageText: document.pageText,
            call: {
              purpose: 'extract', provider: 'anthropic', modelVersion: 'stub',
              documentId: document.documentId, costMicros: 0, latencyMs: 0, outcome: 'ok',
            },
          });
        },
      },
    };
    const result = await processUpload(upload, deps);
    expect(result.haltedBecause).toBeUndefined();
    expect(result.case?.claimId).toBe('APDP-99812');
  });
});

/**
 * Where the read runs, which is the other decision this app makes from the
 * environment alone (ADR 0021).
 *
 * The same shape as the scanner's, and for the same reason: one place decides,
 * the absent case is the safe one rather than the convenient one, and a
 * half-configured environment is an error instead of a guess.
 */
describe('which runner an environment gets', () => {
  it('reads inside the request when there is no Inngest binding', () => {
    delete process.env.INNGEST_EVENT_KEY;
    delete process.env.INNGEST_SIGNING_KEY;

    const runner = runnerFromEnv();
    expect(runner).toBeInstanceOf(InlineRunner);
    expect(runner.name).toBe('inline');
  });

  it('hands the read to a job when both keys are set', () => {
    process.env.INNGEST_EVENT_KEY = 'test-event-key';
    process.env.INNGEST_SIGNING_KEY = 'signkey-test-abc';

    const runner = runnerFromEnv();
    expect(runner).toBeInstanceOf(InngestRunner);
    expect(runner.name).toBe('inngest');
  });

  it('refuses a half-configured binding, both ways round', () => {
    // An event key with no signing key serves an endpoint that cannot tell
    // Inngest from anybody else; a signing key with no event key serves a
    // function nothing can trigger. Neither is a mode to fall back to.
    process.env.INNGEST_EVENT_KEY = 'test-event-key';
    delete process.env.INNGEST_SIGNING_KEY;
    expect(() => runnerFromEnv()).toThrow(/only the event key/);

    delete process.env.INNGEST_EVENT_KEY;
    process.env.INNGEST_SIGNING_KEY = 'signkey-test-abc';
    expect(() => runnerFromEnv()).toThrow(/only the signing key/);
  });

  it('is decided nowhere else: an empty value is not a key', () => {
    process.env.INNGEST_EVENT_KEY = '';
    process.env.INNGEST_SIGNING_KEY = '';
    expect(runnerFromEnv().name).toBe('inline');
  });
});

describe('whether an environment receives email (ADR 0047 §14)', () => {
  const SECRET = 'f'.repeat(INBOUND_SECRET_MIN_LENGTH);
  /** An environment of exactly these variables. */
  const only = (values: Record<string, string>): NodeJS.ProcessEnv =>
    ({ NODE_ENV: 'test', ...values }) as NodeJS.ProcessEnv;
  const ready = {
    POSTMARK_INBOUND_SECRET: SECRET,
    INBOUND_DOMAIN: 'In.Mozart.Example',
    INNGEST_EVENT_KEY: 'event-key',
    INNGEST_SIGNING_KEY: 'signing-key',
    CLAMAV_SCAN_URL: 'https://scan.example/scan',
    CLAMAV_SCAN_TOKEN: 'token',
  };
  const without = (...names: (keyof typeof ready)[]) =>
    only(Object.fromEntries(Object.entries(ready).filter(([name]) => !names.includes(name as keyof typeof ready))));

  it('has no binding with neither variable, which is what a preview is', () => {
    expect(inboundEmailFromEnv(without('POSTMARK_INBOUND_SECRET', 'INBOUND_DOMAIN'))).toEqual({ kind: 'none' });
    expect(inboundEmailFromEnv(only({}))).toEqual({ kind: 'none' });
  });

  it('is bound with both, a queue and a scanner, and lowercases the domain', () => {
    expect(inboundEmailFromEnv(only(ready))).toEqual({ kind: 'bound', secret: SECRET, domain: 'in.mozart.example' });
  });

  it('calls half a configuration an error, both ways round', () => {
    expect(inboundEmailFromEnv(without('INBOUND_DOMAIN'))).toMatchObject({
      kind: 'misconfigured',
      reason: expect.stringContaining('INBOUND_DOMAIN'),
    });
    expect(inboundEmailFromEnv(without('POSTMARK_INBOUND_SECRET'))).toMatchObject({
      kind: 'misconfigured',
      reason: expect.stringContaining('POSTMARK_INBOUND_SECRET'),
    });
  });

  it('refuses a secret shorter than 64 characters', () => {
    expect(
      inboundEmailFromEnv(only({ ...ready, POSTMARK_INBOUND_SECRET: 'f'.repeat(INBOUND_SECRET_MIN_LENGTH - 1) })),
    ).toMatchObject({ kind: 'misconfigured', reason: expect.stringContaining('shorter than 64') });
  });

  it('refuses to receive where reads are not queued', () => {
    expect(inboundEmailFromEnv(without('INNGEST_EVENT_KEY', 'INNGEST_SIGNING_KEY'))).toMatchObject({
      kind: 'misconfigured',
      reason: expect.stringContaining('no Inngest keys'),
    });
    expect(inboundEmailFromEnv(without('INNGEST_SIGNING_KEY'))).toMatchObject({
      kind: 'misconfigured',
      reason: expect.stringContaining('half-configured'),
    });
  });

  it('refuses to receive where nothing could scan what arrives', () => {
    expect(inboundEmailFromEnv(without('CLAMAV_SCAN_URL', 'CLAMAV_SCAN_TOKEN'))).toMatchObject({
      kind: 'misconfigured',
      reason: expect.stringContaining('no virus scanner'),
    });
    // A URL with no token is NullScanner too (ADR 0018).
    expect(inboundEmailFromEnv(without('CLAMAV_SCAN_TOKEN'))).toMatchObject({ kind: 'misconfigured' });
  });

  it('never puts the secret in a reason', () => {
    for (const environment of [without('INBOUND_DOMAIN'), without('CLAMAV_SCAN_URL'), without('INNGEST_EVENT_KEY')]) {
      const binding = inboundEmailFromEnv(environment);
      expect(JSON.stringify(binding.kind === 'misconfigured' ? binding.reason : '')).not.toContain(SECRET);
    }
  });
});

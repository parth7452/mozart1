import { createHash, timingSafeEqual } from 'node:crypto';
import { NonRetriableError, type Inngest } from 'inngest';
import type { ConcurrencyOption } from 'inngest/types';
import { NullScanner, scannerFromEnv } from '@recouple/ingest';
import {
  InvalidJobPayloadError,
  readDocumentJob,
  readInboundEmailJob,
  type JobDeps,
  type ReadDocumentJobResult,
  type ReadInboundEmailJobResult,
} from '@recouple/pipeline';
import { PostgresInboundStore } from '@recouple/store-postgres';
import { env } from './env';
import { asJobFailure, inngestKeysFromEnv, type JobStoreHandle } from './inngest';
import { isUuid } from './request';

/**
 * Email-in's binding: whether this deployment receives email, and what with
 * (ADR 0047 §14).
 *
 * `runnerFromEnv`'s shape, following `inngestKeysFromEnv`'s convention: both
 * variables give a binding, neither gives none, one without the other is an
 * error. A binding also needs a queued runner (an email's read would otherwise
 * run inside Postmark's two-minute wait), a scanner that is not `NullScanner`,
 * and a secret of at least 64 characters. Both variables are Production only:
 * a preview holds neither and answers 503, so Postmark's one webhook URL can
 * only ever reach production.
 */
export type InboundBinding =
  | { readonly kind: 'none' }
  | { readonly kind: 'misconfigured'; readonly reason: string }
  | { readonly kind: 'bound'; readonly secret: string; readonly domain: string };

export const INBOUND_SECRET_MIN_LENGTH = 64;

export function inboundEmailFromEnv(environment: NodeJS.ProcessEnv = process.env): InboundBinding {
  const secret = environment.POSTMARK_INBOUND_SECRET ?? '';
  const domain = (environment.INBOUND_DOMAIN ?? '').trim().toLowerCase();
  if (secret === '' && domain === '') return { kind: 'none' };
  if (secret === '' || domain === '') {
    return {
      kind: 'misconfigured',
      reason: `${secret === '' ? 'POSTMARK_INBOUND_SECRET' : 'INBOUND_DOMAIN'} is not set, and the other is`,
    };
  }
  if (secret.length < INBOUND_SECRET_MIN_LENGTH) {
    return {
      kind: 'misconfigured',
      reason: `POSTMARK_INBOUND_SECRET is shorter than ${INBOUND_SECRET_MIN_LENGTH} characters (use openssl rand -hex 32)`,
    };
  }
  let keys;
  try {
    keys = inngestKeysFromEnv(environment);
  } catch {
    return { kind: 'misconfigured', reason: 'the Inngest binding is half-configured' };
  }
  if (keys === undefined) {
    return {
      kind: 'misconfigured',
      reason: 'email is served only where reads are queued, and this deployment has no Inngest keys',
    };
  }
  if (scannerFromEnv(environment) instanceof NullScanner) {
    return { kind: 'misconfigured', reason: 'no virus scanner is configured, so nothing could be read' };
  }
  return { kind: 'bound', secret, domain };
}

/** The user name in the webhook URL: `https://postmark:<secret>@…`. */
export const POSTMARK_WEBHOOK_USER = 'postmark';

const sha256 = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/**
 * Whether the request carries our Basic credential (§2).
 *
 * Postmark signs nothing, so this is the webhook's whole authentication. The
 * SHA-256 of the presented `user:password` is compared with the SHA-256 of the
 * expected pair in constant time, so neither the length nor any prefix of the
 * secret leaks through timing — the two existing precedents compare lengths
 * first, and this deliberately does not.
 */
export function presentsInboundCredential(authorization: string | null, secret: string): boolean {
  const presented =
    authorization !== null && /^basic\s+/i.test(authorization)
      ? Buffer.from(authorization.replace(/^basic\s+/i, '').trim(), 'base64').toString('utf8')
      : '';
  return timingSafeEqual(sha256(presented), sha256(`${POSTMARK_WEBHOOK_USER}:${secret}`));
}

/** The config the inbound stores and the lookup connect with: as `app_rw`. */
export function inboundDbConfig() {
  return { connectionString: env.databaseUrl };
}

export function inboundStoreFor(identity: { readonly orgId: string; readonly userId: string }) {
  return new PostgresInboundStore(inboundDbConfig(), identity);
}

// ---------------------------------------------------------------------------
// The job: one event per email (§8)
// ---------------------------------------------------------------------------

export const INBOUND_READ_REQUESTED = 'email/read.requested';

/** Ids only, like every event this app sends. The acting member is `userId`. */
export interface InboundReadRequestedData {
  readonly orgId: string;
  readonly userId: string;
  readonly inboundMessageId: string;
  /** The message's id: a redelivery of one email's event is one read. */
  readonly readKey: string;
}

export function inboundReadRequestedEvent(data: InboundReadRequestedData) {
  return { name: INBOUND_READ_REQUESTED, data };
}

export function parseInboundReadRequested(data: unknown): InboundReadRequestedData {
  if (data === null || typeof data !== 'object') {
    throw new NonRetriableError(`${INBOUND_READ_REQUESTED} carried no payload object`);
  }
  const raw = data as Record<string, unknown>;
  for (const field of ['orgId', 'userId', 'inboundMessageId', 'readKey'] as const) {
    if (!isUuid(raw[field])) {
      throw new NonRetriableError(`${INBOUND_READ_REQUESTED} needs ${field} to be an id`);
    }
  }
  return {
    orgId: raw.orgId as string,
    userId: raw.userId as string,
    inboundMessageId: raw.inboundMessageId as string,
    readKey: raw.readKey as string,
  };
}

export interface InboundJobContext {
  readonly storeFor: (identity: { orgId: string; userId: string }) => JobStoreHandle;
  readonly depsFor: (store: JobStoreHandle) => JobDeps;
  readonly inboundFor: (identity: { orgId: string; userId: string }) => PostgresInboundStore;
}

export interface InboundReadInvocation {
  readonly event: { readonly data: unknown };
  readonly step: {
    run<T>(id: string, work: () => Promise<T>): Promise<T>;
  };
}

/**
 * Each part's read is its own step, so a retry does not re-read a part that
 * already finished, and each read is `readDocumentJob`'s — under the
 * document's claim, answered from the record when it was already read. Logs
 * carry ids and closed-set words only (§13).
 */
export function readInboundEmailSteps(context: InboundJobContext) {
  return async ({ event, step }: InboundReadInvocation): Promise<ReadInboundEmailJobResult> => {
    const payload = parseInboundReadRequested(event.data);
    const where = `message ${payload.inboundMessageId} org ${payload.orgId}`;
    console.log(`[recouple] inbound read job: run entered, ${where}`);
    const store = context.storeFor({ orgId: payload.orgId, userId: payload.userId });
    try {
      const deps = { ...context.depsFor(store), inbound: context.inboundFor(payload) };
      const result = await readInboundEmailJob(
        deps,
        payload,
        (documentId) =>
          step.run(`read-${documentId}`, async (): Promise<ReadDocumentJobResult> => {
            try {
              const read = await readDocumentJob(deps, {
                documentId,
                orgId: payload.orgId,
                actor: { userId: payload.userId },
              });
              console.log(
                `[recouple] inbound read job: read document ${documentId}, ${where}, ` +
                  `doc type ${read.docType ?? 'none'}, held ${read.held ?? 'no'}`,
              );
              return read;
            } catch (error) {
              throw asJobFailure(error, { documentId, orgId: payload.orgId });
            }
          }),
      );
      console.log(
        `[recouple] inbound read job: run returned, ${where}, ${result.reads.length} read(s), ` +
          `body ${result.bodyRead ? 'read' : 'not read'}`,
      );
      return result;
    } catch (error) {
      // A member who may no longer write is a settled answer: asking three
      // more times changes nothing. Said by class name and ids, like the rest.
      if (error instanceof InvalidJobPayloadError) {
        console.error(`[recouple] inbound read job: refused, ${where} (InvalidJobPayloadError)`);
        throw new NonRetriableError(`InvalidJobPayloadError reading ${where}`);
      }
      throw error;
    } finally {
      await store.close();
    }
  };
}

/**
 * How many emails this app reads at once, across every tenant.
 *
 * Keyless, like `READS_IN_FLIGHT`, and for the same reason: a key makes a
 * limit per value, and this is the fleet's. Each email's parts are read one
 * after another inside its run, so two emails in flight is at most two reads
 * at once from this function. It must stay at or below
 * `INNGEST_PLAN_CONCURRENCY_LIMIT`, or the app does not sync at all.
 */
export const INBOUND_EMAILS_IN_FLIGHT = 2;

/** One email per tenant at a time: a burst to one address queues behind itself. */
export const INBOUND_EMAILS_IN_FLIGHT_PER_ORG = 1;

export const READ_INBOUND_EMAIL_CONFIG = {
  id: 'read-inbound-email',
  name: 'Read an email’s documents',
  triggers: [{ event: INBOUND_READ_REQUESTED }],
  retries: 3 as const,
  // The message id: the route re-sends this event on every retry Postmark
  // makes, and the window swallows all but the first.
  idempotency: 'event.data.readKey',
  concurrency: [
    { key: 'event.data.orgId', limit: INBOUND_EMAILS_IN_FLIGHT_PER_ORG },
    { limit: INBOUND_EMAILS_IN_FLIGHT },
  ] as [ConcurrencyOption, ConcurrencyOption],
};

export function readInboundEmailFunction(client: Inngest, context: InboundJobContext) {
  return client.createFunction(READ_INBOUND_EMAIL_CONFIG, readInboundEmailSteps(context));
}

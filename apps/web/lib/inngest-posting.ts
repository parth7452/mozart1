import { NonRetriableError, type Inngest } from 'inngest';
import type { ConcurrencyOption } from 'inngest/types';
import {
  PostingRefusedError,
  WritebackFailedError,
  postWritebackJob,
  type PostingJobResult,
} from '@recouple/pipeline';
import { PostgresPostingStore } from '@recouple/store-postgres';
import { env } from './env';
import { qboPostingFromEnv, type QboPoster } from './qbo-posting';
import { isUuid } from './request';

/**
 * `post-writeback` (ADR 0060 §3): one approved `writebacks` row, posted to
 * QuickBooks by a job, never by the request. The event carries ids only; the
 * job runs as `app_rw` with the approver's claims. One at a time per
 * connection, keyed on the writeback, and never retried by the runtime: a
 * send whose outcome is unknown is a failed row a person retries.
 */
export const WRITEBACK_REQUESTED = 'qbo/writeback.requested';

export interface WritebackRequestedData {
  readonly writebackId: string;
  readonly connectionId: string;
  readonly orgId: string;
  /** The approver whose claims the job acts with. */
  readonly userId: string;
  /**
   * The runtime's idempotency key: the writeback id on the first send, a
   * fresh id on a person's retry — keyed on the row alone, a retry inside the
   * window would be swallowed by the first send's key.
   */
  readonly sendKey: string;
  /** A person's "Check QuickBooks and retry": read back by reference first. */
  readonly retry: boolean;
}

export const POST_WRITEBACK_CONFIG = {
  id: 'post-writeback',
  name: 'Post one approved write-back to QuickBooks',
  triggers: [{ event: WRITEBACK_REQUESTED }],
  retries: 0 as const,
  idempotency: 'event.data.sendKey',
  concurrency: [{ key: 'event.data.connectionId', limit: 1 }] as [ConcurrencyOption],
};

export function writebackRequestedEvent(data: WritebackRequestedData): {
  readonly name: typeof WRITEBACK_REQUESTED;
  readonly data: WritebackRequestedData;
} {
  return { name: WRITEBACK_REQUESTED, data };
}

export function parseWritebackRequested(data: unknown): WritebackRequestedData {
  if (data === null || typeof data !== 'object') {
    throw new NonRetriableError(`${WRITEBACK_REQUESTED} carried no payload object`);
  }
  const raw = data as Record<string, unknown>;
  const id = (field: string): string => {
    const value = raw[field];
    if (!isUuid(value)) throw new NonRetriableError(`${WRITEBACK_REQUESTED} needs ${field} to be an id`);
    return value;
  };
  return {
    writebackId: id('writebackId'),
    connectionId: id('connectionId'),
    orgId: id('orgId'),
    userId: id('userId'),
    sendKey: raw['sendKey'] === undefined ? id('writebackId') : id('sendKey'),
    retry: raw['retry'] === true,
  };
}

export interface PostingContext {
  /** `qboPostingFromEnv()` unless a test names one. */
  readonly poster?: QboPoster | undefined;
  readonly storeFor?: (identity: { readonly orgId: string; readonly userId: string }) => PostgresPostingStore;
}

export interface PostWritebackInvocation {
  readonly event: { readonly data: unknown };
  readonly step: { run<T>(id: string, work: () => Promise<T>): Promise<T> };
}

export async function runPostWriteback(
  data: unknown,
  context: PostingContext = {},
): Promise<PostingJobResult> {
  const payload = parseWritebackRequested(data);
  const identity = { orgId: payload.orgId, userId: payload.userId };
  const poster = 'poster' in context ? context.poster : qboPostingFromEnv();
  const where = `writeback ${payload.writebackId} connection ${payload.connectionId} org ${payload.orgId}`;
  try {
    // The deployment's answer first: without QBO_POSTING nothing is built,
    // not even the store.
    const store =
      poster === undefined
        ? undefined
        : (context.storeFor ?? ((id) => new PostgresPostingStore({ connectionString: env.databaseUrl }, id)))(
            identity,
          );
    const result = await postWritebackJob(
      {
        postingAllowed: poster !== undefined && store !== undefined,
        store: store ?? {
          memberMayWrite: async () => false,
          writebackForPosting: async () => undefined,
          recordWritebackAttempt: async () => {
            throw new Error('nothing is recorded where posting is not configured');
          },
        },
        clientFor: (connection) => poster?.clientFor(identity, connection),
      },
      { writebackId: payload.writebackId, retry: payload.retry },
    );
    console.log(`[recouple] post-writeback: ${result.status}, ${where}, qbo ${result.qboTxnId ?? 'none'}`);
    return result;
  } catch (error) {
    // Ids, a status and a reason constant; never a body or a message.
    const reason =
      error instanceof PostingRefusedError || error instanceof WritebackFailedError
        ? error.reason
        : error instanceof Error
          ? error.name
          : typeof error;
    console.error(`[recouple] post-writeback: failed ${reason}, ${where}`);
    throw new NonRetriableError(`${reason} posting ${where}`);
  }
}

export function postWritebackSteps(
  context: PostingContext = {},
): (invocation: PostWritebackInvocation) => Promise<PostingJobResult> {
  return async ({ event, step }) =>
    step.run('post-writeback', () => runPostWriteback(event.data, context));
}

export function postingFunctions(client: Inngest, context: PostingContext = {}) {
  return [client.createFunction(POST_WRITEBACK_CONFIG, postWritebackSteps(context))];
}

import { randomUUID } from 'node:crypto';
import { PostgresPostingStore } from '@recouple/store-postgres';
import { env } from './env';
import { inngestClient, inngestKeysFromEnv } from './inngest';
import { writebackRequestedEvent, type WritebackRequestedData } from './inngest-posting';
import type { Session } from './session';

/**
 * The web half of posting to QuickBooks (ADR 0060): the store as the signed-in
 * member, and the one way a request reaches the posting job.
 *
 * Nothing here decides whether posting may happen. `qboPostingFromEnv()` is
 * the deployment's answer, the connection's `posting_enabled` the owner's, and
 * the `approvals` row the database's; the job asks all three again before it
 * builds a request.
 */
export function postingStoreFor(session: Session): PostgresPostingStore {
  return new PostgresPostingStore(
    { connectionString: env.databaseUrl },
    { orgId: session.org.orgId, userId: session.userId },
  );
}

/**
 * Queues one writeback row, acting as this member. A first send is keyed on
 * the row; a person's retry on a fresh key, so the runtime's idempotency
 * window cannot swallow it, and reads back by reference before it sends.
 *
 * Answers false — never throws — when there is no queue or the send failed:
 * the row stays as it is, and the case page offers the retry.
 */
export async function queueWriteback(
  session: Session,
  input: { readonly writebackId: string; readonly connectionId: string; readonly retry: boolean },
): Promise<boolean> {
  const keys = inngestKeysFromEnv();
  if (keys === undefined) {
    console.error(`[recouple] post-writeback: no queue, writeback ${input.writebackId} not sent`);
    return false;
  }
  const data: WritebackRequestedData = {
    writebackId: input.writebackId,
    connectionId: input.connectionId,
    orgId: session.org.orgId,
    userId: session.userId,
    sendKey: input.retry ? randomUUID() : input.writebackId,
    retry: input.retry,
  };
  try {
    await inngestClient(keys).send(writebackRequestedEvent(data));
    return true;
  } catch (error) {
    const name = error instanceof Error ? error.name : typeof error;
    console.error(`[recouple] post-writeback: queue refused (${name}), writeback ${input.writebackId}`);
    return false;
  }
}

/**
 * Inserts a decision's writeback rows — the journal entry, and the zero
 * Payment when one applies — and queues the entry. The Payment is sent only
 * after its entry reads back as sent, from the case page.
 *
 * Answers whether the entry was queued. A row the database refuses (no
 * approval, a second press) is thrown, never swallowed.
 */
export async function queueDecisionPostings(
  session: Session,
  store: PostgresPostingStore,
  input: {
    readonly decisionId: string;
    readonly connectionId: string;
    readonly withPayment: boolean;
  },
): Promise<boolean> {
  const { writebackId } = await store.insertWriteback({
    decisionId: input.decisionId,
    method: 'journal_entry',
    connectionId: input.connectionId,
  });
  if (input.withPayment) {
    await store.insertWriteback({
      decisionId: input.decisionId,
      method: 'payment_application',
      connectionId: input.connectionId,
    });
  }
  return queueWriteback(session, { writebackId, connectionId: input.connectionId, retry: false });
}

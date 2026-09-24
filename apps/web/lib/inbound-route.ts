import {
  InboundPayloadError,
  parsePostmarkInbound,
  scannerFromEnv,
  type InboundEmail,
} from '@recouple/ingest';
import {
  InboundActingMemberRefusedError,
  receiveInboundEmail,
  type InboundAddressResolution,
  type InboundDeps,
  type InboundReceipt,
} from '@recouple/pipeline';
import { inboundAddressFor } from '@recouple/store-postgres';
import {
  inboundDbConfig,
  inboundEmailFromEnv,
  inboundReadRequestedEvent,
  inboundStoreFor,
  presentsInboundCredential,
  type InboundBinding,
  type InboundReadRequestedData,
} from './inbound';
import { inngestClient, inngestKeysFromEnv } from './inngest';
import { storeForActor } from './pipeline';

/**
 * `POST /api/inbound/postmark`, as a function of what it reaches (ADR 0047).
 *
 * The route file is a line; this is the door, with every dependency named so
 * each row of §11's table can be exercised without Postmark, Inngest or a
 * database. Postmark treats 200 as done, stops on 403 and retries anything
 * else, so 403 is answered only where no retry and no deploy could change the
 * outcome, and 5xx wherever one could.
 *
 * What a log line may carry is §13's list: Postmark's MessageID, our ids, an
 * outcome key and a class name. Never the recipient or its token, a sender, a
 * subject, a filename, a header value, the Authorization header, or an error's
 * message. The response body is a fixed word.
 */
export interface InboundRouteDeps {
  readonly binding: () => InboundBinding;
  readonly lookup: (token: string) => Promise<InboundAddressResolution | undefined>;
  readonly receive: (email: InboundEmail, address: InboundAddressResolution) => Promise<InboundReceipt>;
  /** Records a delivery refused at a retired address, as its retirer. */
  readonly recordRefusal: (address: InboundAddressResolution, providerMessageId: string) => Promise<void>;
  readonly memberMayWrite: (actor: { orgId: string; userId: string }) => Promise<boolean>;
  readonly send: (data: InboundReadRequestedData) => Promise<void>;
  readonly log: Pick<Console, 'info' | 'error'>;
}

const WORD: Record<number, string> = {
  200: 'ok',
  401: 'unauthorized',
  403: 'refused',
  405: 'method not allowed',
  503: 'unavailable',
};

function answer(status: number, headers: Record<string, string> = {}): Response {
  return new Response(WORD[status] ?? 'error', {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...headers },
  });
}

const className = (error: unknown): string =>
  error instanceof Error ? error.name || error.constructor.name : typeof error;

export async function handleInboundPostmark(
  request: Request,
  deps: InboundRouteDeps,
): Promise<Response> {
  // This route does not call isCrossSite: a server-to-server POST sends no
  // Sec-Fetch-Site and would pass it, and a webhook has no session to be the
  // real check (lib/request.ts). What replaces it is the credential below.
  const binding = deps.binding();
  if (binding.kind === 'none') return answer(503);
  if (binding.kind === 'misconfigured') {
    deps.log.error(`[recouple] inbound email refuses to serve: ${binding.reason}`);
    return answer(503);
  }

  // Before the body is read. A missing or wrong credential gets a challenge,
  // so a client that authenticates only when asked is asked, and nothing else
  // happens. 401 keeps real mail in Postmark's retry schedule across a
  // rotation (§2).
  if (!presentsInboundCredential(request.headers.get('authorization'), binding.secret)) {
    return answer(401, { 'www-authenticate': 'Basic realm="inbound"' });
  }

  let email: InboundEmail;
  try {
    email = parsePostmarkInbound(await request.json(), binding.domain);
  } catch (error) {
    // Only our own Postmark server holds the credential, so a payload we
    // cannot read is ours to fix: 503, and Postmark retries while a deploy
    // does.
    deps.log.error(
      `[recouple] inbound email: payload refused (${error instanceof InboundPayloadError ? error.name : className(error)})`,
    );
    return answer(503);
  }
  const messageId = email.providerMessageId;

  if (email.recipient.kind === 'not_our_domain') {
    // Also a misconfiguration: the MX or the inbound stream points elsewhere.
    // Postmark's Check button posts a sample addressed to its own domain and
    // lands here, as expected.
    deps.log.error(`[recouple] inbound email ${messageId}: not_our_domain`);
    return answer(503);
  }
  if (email.recipient.kind === 'not_a_token') {
    deps.log.info(`[recouple] inbound email ${messageId}: not_a_token`);
    return answer(403);
  }

  let address: InboundAddressResolution | undefined;
  try {
    address = await deps.lookup(email.recipient.token);
  } catch (error) {
    // The database, not the sender: a retry can change this answer.
    deps.log.error(`[recouple] inbound email ${messageId}: address lookup failed (${className(error)})`);
    return answer(503);
  }
  if (address === undefined) {
    deps.log.info(`[recouple] inbound email ${messageId}: unknown_token`);
    return answer(403);
  }

  if (address.retired) {
    // Recorded as the owner who retired it, when they may still write, so the
    // workspace can see mail still arriving at an old address (§11). A record
    // that fails is a 503: the retry records it, and then refuses.
    try {
      if (await deps.memberMayWrite({ orgId: address.orgId, userId: address.actingMember })) {
        await deps.recordRefusal(address, messageId);
      }
    } catch (error) {
      deps.log.error(
        `[recouple] inbound email ${messageId}: refusal at retired address ${address.addressId} ` +
          `org ${address.orgId} not recorded (${className(error)})`,
      );
      return answer(503);
    }
    deps.log.info(
      `[recouple] inbound email ${messageId}: refused_retired, address ${address.addressId} org ${address.orgId}`,
    );
    return answer(403);
  }

  let receipt: InboundReceipt;
  try {
    receipt = await deps.receive(email, address);
  } catch (error) {
    if (error instanceof InboundActingMemberRefusedError) {
      deps.log.error(
        `[recouple] inbound email ${messageId}: acting member may not write, address ${address.addressId} org ${address.orgId}`,
      );
      return answer(503);
    }
    deps.log.error(
      `[recouple] inbound email ${messageId}: not recorded (${className(error)}), address ${address.addressId} org ${address.orgId}`,
    );
    return answer(503);
  }

  if (receipt.kind === 'busy') {
    deps.log.info(`[recouple] inbound email ${messageId}: busy (${receipt.reason}), org ${address.orgId}`);
    return answer(503);
  }

  // 200 only once the record is durable and the read is queued. A send that
  // fails is a 503; the retry finds the record and sends again, and the
  // runtime's window on the message id swallows a duplicate.
  try {
    await deps.send({
      orgId: address.orgId,
      userId: address.actingMember,
      inboundMessageId: receipt.inboundMessageId,
      readKey: receipt.inboundMessageId,
    });
  } catch (error) {
    deps.log.error(
      `[recouple] inbound email ${messageId}: recorded as ${receipt.inboundMessageId}, read not queued (${className(error)})`,
    );
    return answer(503);
  }

  deps.log.info(
    `[recouple] inbound email ${messageId}: ${receipt.alreadyRecorded ? 'already recorded' : 'recorded'} ` +
      `as ${receipt.inboundMessageId}, org ${address.orgId}, parts ` +
      `${receipt.parts.map((p) => p.outcome).join(',') || 'none'}`,
  );
  return answer(200);
}

/** Anything but POST. */
export function inboundMethodNotAllowed(): Response {
  return answer(405, { allow: 'POST' });
}

/** The real dependencies, built per request from the environment. */
export function defaultInboundRouteDeps(): InboundRouteDeps {
  return {
    binding: () => inboundEmailFromEnv(),
    lookup: (token) => inboundAddressFor(inboundDbConfig(), token),
    receive: async (email, address) => {
      const identity = { orgId: address.orgId, userId: address.actingMember };
      const store = storeForActor(identity);
      try {
        const deps: InboundDeps = {
          store,
          scanner: scannerFromEnv(),
          inbound: inboundStoreFor(identity),
          now: () => new Date(),
        };
        return await receiveInboundEmail(email, address, deps);
      } finally {
        await store.close();
      }
    },
    recordRefusal: async (address, providerMessageId) => {
      await inboundStoreFor({ orgId: address.orgId, userId: address.actingMember }).recordInboundMessage(
        { addressId: address.addressId, provider: 'postmark', providerMessageId, outcome: 'refused_retired' },
        [],
      );
    },
    memberMayWrite: async (actor) => {
      const store = storeForActor(actor);
      try {
        return await store.memberMayWrite(actor);
      } finally {
        await store.close();
      }
    },
    send: async (data) => {
      const keys = inngestKeysFromEnv();
      if (keys === undefined) throw new Error('no Inngest binding');
      await inngestClient(keys).send(inboundReadRequestedEvent(data));
    },
    log: console,
  };
}

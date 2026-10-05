import type { LedgerInvoiceMatches } from '@recouple/core-domain';
import {
  QboClient,
  readObject,
  readString,
  type QboAccount,
  type SetupAccountSpec,
} from '@recouple/qbo';
import type { LedgerConnectionRecord, PostingLedgerClient } from '@recouple/pipeline';
import { qboAppConfigFromEnv, qboTokenStoreFromEnv, type EnvVars } from './ledger-sync';

/**
 * Whether this deployment may post to QuickBooks at all (ADR 0060 §5), in
 * `scannerFromEnv`'s shape: one answer, in one place, a typed value.
 *
 * Only `QBO_POSTING=1` builds a poster. Anything else — unset, empty, `true`,
 * `0` — builds none, and the posting job refuses before it builds a request.
 * It is on in Production: the founder set it there on 2026-09-27 and waived
 * the sandbox run ADR 0060 §5 asked for first. So Turn on posting creates its
 * accounts in a production company (ADR 0063), the first write this path
 * makes there; each connection's map and switch, and each case's approval,
 * still gate every post. Previews never get it.
 */
export const QBO_POSTING = 'QBO_POSTING';

export interface QboPoster {
  /** The connection's client as this member, or nothing if one cannot be built. */
  clientFor(
    identity: { readonly orgId: string; readonly userId: string },
    connection: { readonly connectionId: string; readonly realmId: string },
  ): PostingLedgerClient | undefined;
  /**
   * The account-type reader a map is checked with, or nothing if it cannot be
   * built. `options`, here and below, bound the client for a settings request
   * that must answer within its route's `maxDuration`: how long each request to
   * the accounting API waits, and how many pages a read takes. Without them the
   * client has `QboClient`'s defaults.
   */
  accountTypesFor(
    identity: { readonly orgId: string; readonly userId: string },
    connection: { readonly connectionId: string; readonly realmId: string },
    options?: QboRequestOptions,
  ): ((ids: readonly string[]) => Promise<ReadonlyMap<string, string>>) | undefined;
  /**
   * The company's whole chart of accounts, inactive ones included, read live
   * (ADR 0063 §1), or nothing if a client cannot be built. A read: what setup
   * proposes and what a press re-reads before it creates anything. A chart
   * that has not ended by `options.maxPages` is `QboChartTooLarge`, never the
   * part of it read.
   */
  accountsFor(
    identity: { readonly orgId: string; readonly userId: string },
    connection: { readonly connectionId: string; readonly realmId: string },
    options?: QboRequestOptions,
  ): (() => Promise<readonly QboAccount[]>) | undefined;
  /**
   * Creates one account and reads it back (ADR 0063 §2), or nothing if a
   * client cannot be built. Only `setUpPosting` calls it, and only with one of
   * `SETUP_ACCOUNTS` and the request id its request row was recorded under.
   */
  /**
   * What the company holds for the invoice a person named — by internal id
   * and by printed number — read live when a settlement is prepared (ADR 0069
   * §1), or nothing if a client cannot be built. Two reads, no write.
   */
  invoiceLookupFor(
    identity: { readonly orgId: string; readonly userId: string },
    connection: { readonly connectionId: string; readonly realmId: string },
    options?: QboRequestOptions,
  ): ((stated: string) => Promise<LedgerInvoiceMatches>) | undefined;
  accountCreatorFor(
    identity: { readonly orgId: string; readonly userId: string },
    connection: { readonly connectionId: string; readonly realmId: string },
    options?: QboRequestOptions,
  ): ((spec: SetupAccountSpec, requestId: string) => Promise<QboAccount>) | undefined;
}

/**
 * How a settings request bounds a client (ADR 0063 §1, §2): how long each
 * request to the accounting API may wait, and how many pages one read may
 * take. `QboClient`'s defaults — a minute, a thousand pages — without them.
 */
export interface QboRequestOptions {
  readonly timeoutMs?: number;
  readonly maxPages?: number;
}

export function qboPostingFromEnv(environment: EnvVars = process.env): QboPoster | undefined {
  if (environment[QBO_POSTING] !== '1') return undefined;
  const qboClientFor = (
    identity: { readonly orgId: string; readonly userId: string },
    connection: { readonly connectionId: string; readonly realmId: string },
    options: QboRequestOptions = {},
  ): QboClient | undefined => {
    const app = qboAppConfigFromEnv(environment);
    if ('missing' in app) return undefined;
    const record: LedgerConnectionRecord = {
      connectionId: connection.connectionId,
      orgId: identity.orgId,
      provider: 'qbo',
      providerAccountId: connection.realmId,
      enabled: true,
      createdBy: identity.userId,
    };
    const tokenStore = qboTokenStoreFromEnv(identity, record, environment);
    if (tokenStore === undefined) return undefined;
    return new QboClient({
      realmId: connection.realmId,
      baseUrl: app.baseUrl,
      clientId: app.clientId,
      clientSecret: app.clientSecret,
      tokenStore,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.maxPages === undefined ? {} : { maxPages: options.maxPages }),
    });
  };
  return {
    accountTypesFor(identity, connection, options) {
      const client = qboClientFor(identity, connection, options);
      return client === undefined ? undefined : (ids) => client.accountTypes(ids);
    },
    accountsFor(identity, connection, options) {
      const client = qboClientFor(identity, connection, options);
      return client === undefined ? undefined : () => client.listAccounts();
    },
    accountCreatorFor(identity, connection, options) {
      const client = qboClientFor(identity, connection, options);
      return client === undefined
        ? undefined
        : (spec, requestId) => client.createAccount(spec, requestId);
    },
    invoiceLookupFor(identity, connection, options) {
      const client = qboClientFor(identity, connection, options);
      return client === undefined ? undefined : (stated) => client.findInvoices(stated);
    },
    clientFor(identity, connection) {
      const client = qboClientFor(identity, connection);
      if (client === undefined) return undefined;
      return {
        post: (entity, body, requestId) => client.post(entity, body, requestId),
        getById: (entity, id) => client.getById(entity, id),
        findByReference: (entity, reference) => client.findByReference(entity, reference),
        async invoiceCustomer(invoiceId) {
          const rows = await client.queryByIds('Invoice', [invoiceId]);
          // An id QuickBooks does not have is an answer, not a malformed one:
          // the job records it as `invoice_not_found` (ADR 0069 §2).
          if (rows[0] === undefined) return undefined;
          const invoice = readObject(rows[0], 'Invoice');
          return readString(readObject(invoice['CustomerRef'], 'CustomerRef'), 'value', 'CustomerRef');
        },
      };
    },
  };
}

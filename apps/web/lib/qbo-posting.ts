import { QboClient, readObject, readString } from '@recouple/qbo';
import type { LedgerConnectionRecord, PostingLedgerClient } from '@recouple/pipeline';
import { qboAppConfigFromEnv, qboTokenStoreFromEnv, type EnvVars } from './ledger-sync';

/**
 * Whether this deployment may post to QuickBooks at all (ADR 0060 §5), in
 * `scannerFromEnv`'s shape: one answer, in one place, a typed value.
 *
 * Only `QBO_POSTING=1` builds a poster. Anything else — unset, empty, `true`,
 * `0` — builds none, and the posting job refuses before it builds a request.
 * Nobody sets it in this work: the founder turns it on in the sandbox first.
 */
export const QBO_POSTING = 'QBO_POSTING';

export interface QboPoster {
  /** The connection's client as this member, or nothing if one cannot be built. */
  clientFor(
    identity: { readonly orgId: string; readonly userId: string },
    connection: { readonly connectionId: string; readonly realmId: string },
  ): PostingLedgerClient | undefined;
  /** The account-type reader a map is checked with, or nothing if it cannot be built. */
  accountTypesFor(
    identity: { readonly orgId: string; readonly userId: string },
    connection: { readonly connectionId: string; readonly realmId: string },
  ): ((ids: readonly string[]) => Promise<ReadonlyMap<string, string>>) | undefined;
}

export function qboPostingFromEnv(environment: EnvVars = process.env): QboPoster | undefined {
  if (environment[QBO_POSTING] !== '1') return undefined;
  const qboClientFor = (
    identity: { readonly orgId: string; readonly userId: string },
    connection: { readonly connectionId: string; readonly realmId: string },
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
    });
  };
  return {
    accountTypesFor(identity, connection) {
      const client = qboClientFor(identity, connection);
      return client === undefined ? undefined : (ids) => client.accountTypes(ids);
    },
    clientFor(identity, connection) {
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
      const client = new QboClient({
        realmId: connection.realmId,
        baseUrl: app.baseUrl,
        clientId: app.clientId,
        clientSecret: app.clientSecret,
        tokenStore,
      });
      return {
        post: (entity, body, requestId) => client.post(entity, body, requestId),
        getById: (entity, id) => client.getById(entity, id),
        findByReference: (entity, reference) => client.findByReference(entity, reference),
        async invoiceCustomer(invoiceId) {
          const rows = await client.queryByIds('Invoice', [invoiceId]);
          const invoice = readObject(rows[0], 'Invoice');
          return readString(readObject(invoice['CustomerRef'], 'CustomerRef'), 'value', 'CustomerRef');
        },
      };
    },
  };
}

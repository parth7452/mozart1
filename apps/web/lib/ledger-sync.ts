import { QBO_PRODUCTION_BASE_URL, QBO_SANDBOX_BASE_URL, QboAccountingSource } from '@recouple/qbo';
import type { QboTokenStore } from '@recouple/qbo';
import type {
  LedgerConnectionRecord,
  LedgerSourceFactory,
  LedgerSyncJobDeps,
  ResolvedLedgerSource,
} from '@recouple/pipeline';
import {
  PostgresDiscoveryStore,
  PostgresLedgerSyncStore,
  listConnectionsToSync,
  type ConnectionToSync,
} from '@recouple/store-postgres';
import { env } from './env';
import { tenantStore } from './store';

/**
 * What a scheduled ledger sync is assembled from, decided by configuration
 * (ADR 0031 §7).
 *
 * `scannerFromEnv`'s shape, for `scannerFromEnv`'s reason (ADR 0018): the
 * question "can this deployment read a customer's ledger" has one answer, in
 * one place, and it is a typed value rather than a throw or an object that
 * throws on use. A connection nothing can be built for gets a run row saying
 * `not_configured` and the rest of the fleet is unaffected.
 *
 * Today the answer is always "no", and deliberately so: there is no production
 * `QboTokenStore`. ADR 0026 left it as a port whose only implementation is the
 * in-memory one under `@recouple/qbo/testing`, placed there so no production
 * path can reach it, and a KMS-backed one is its own task (ADR 0031 §7). This
 * file is the seam that will take it — one function returns it, and everything
 * else here already works.
 */

/** Which Intuit environment a connection is read from. Never defaulted. */
export type QboEnvironment = 'sandbox' | 'production';

/**
 * The environment, as these factories read it.
 *
 * `Record` rather than `NodeJS.ProcessEnv` — which `scannerFromEnv` takes —
 * only because Next augments that type with a required `NODE_ENV`, so a test
 * naming the three variables it cares about would have to cast. `process.env`
 * is assignable to this, and nothing here reads a variable outside the three it
 * names.
 */
export type EnvVars = Readonly<Record<string, string | undefined>>;

/**
 * `accountingSourceFromEnv`'s answer, narrowed.
 *
 * `LedgerSourceFactory.resolve` may be async, because a later factory (a KMS
 * token store's) will be. This one is not, and saying so is what lets a caller
 * — and a test — read the verdict without awaiting it.
 */
export interface EnvAccountingSourceFactory extends LedgerSourceFactory {
  resolve(connection: LedgerConnectionRecord): ResolvedLedgerSource;
}

/**
 * The token store a production sync would use. There is none yet.
 *
 * Returning `undefined` rather than throwing is the whole design: the caller
 * turns it into a `not_configured` run row per connection, so the scheduler is
 * proven to run end to end before the vendor is wired rather than after.
 *
 * What is missing is an implementation of `QboTokenStore` that keeps one token
 * set per `realmId` in KMS-backed storage — never in an application table
 * (CLAUDE.md) — and persists a rotated refresh token *before* the next API call
 * (ADR 0026): Intuit replaces the refresh token on every refresh and kills the
 * old one immediately, so a process that refreshes and does not persist has
 * stranded the connection and the repair is going back to the customer for
 * consent.
 */
export function qboTokenStoreFromEnv(_env: EnvVars = process.env): QboTokenStore | undefined {
  return undefined;
}

/**
 * The Intuit app's credentials and environment, or a reason there are none.
 *
 * Half-configured is configured wrong and says so: a `QBO_ENVIRONMENT` that is
 * neither `sandbox` nor `production` throws rather than defaulting, because ADR
 * 0026 refused to default that value — production is not a fallback for a
 * missing config, and a sandbox read presented as a production one is a
 * coverage number computed over the wrong books.
 */
export interface QboAppConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly environment: QboEnvironment;
  readonly baseUrl: string;
}

export function qboAppConfigFromEnv(
  env: EnvVars = process.env,
): QboAppConfig | { readonly missing: string } {
  const clientId = nonEmpty(env.QBO_CLIENT_ID);
  const clientSecret = nonEmpty(env.QBO_CLIENT_SECRET);
  const environment = nonEmpty(env.QBO_ENVIRONMENT);

  const absent = [
    clientId === undefined ? 'QBO_CLIENT_ID' : undefined,
    clientSecret === undefined ? 'QBO_CLIENT_SECRET' : undefined,
    environment === undefined ? 'QBO_ENVIRONMENT' : undefined,
  ].filter((name): name is string => name !== undefined);

  if (clientId === undefined || clientSecret === undefined || environment === undefined) {
    return { missing: `${absent.join(', ')} ${absent.length === 1 ? 'is' : 'are'} not set` };
  }

  if (environment !== 'sandbox' && environment !== 'production') {
    throw new Error(
      `QBO_ENVIRONMENT must be "sandbox" or "production"; this environment has ` +
        `${JSON.stringify(environment)}. It is not defaulted: reading a sandbox company and ` +
        'reporting it as a customer\'s books, or the reverse, is not a failure anybody would ' +
        'notice (ADR 0026).',
    );
  }

  return {
    clientId,
    clientSecret,
    environment,
    baseUrl: environment === 'production' ? QBO_PRODUCTION_BASE_URL : QBO_SANDBOX_BASE_URL,
  };
}

/**
 * The factory the job asks. One `resolve` per connection, and it never throws
 * for want of configuration.
 *
 * The token store is a parameter with a default rather than read inside,
 * because `QboAccountingSource` takes its credentials injected and never reads
 * `process.env` itself (ADR 0026) — and because that is what lets a test
 * exercise the configured path with the in-memory store without the store being
 * reachable from here.
 */
export function accountingSourceFromEnv(
  environment: EnvVars = process.env,
  tokenStore: QboTokenStore | undefined = qboTokenStoreFromEnv(environment),
): EnvAccountingSourceFactory {
  return {
    resolve(connection: LedgerConnectionRecord): ResolvedLedgerSource {
      if (connection.provider !== 'qbo') {
        // The database's check constraint admits `qbo` and nothing else, so
        // this is a registry row from a future migration that this build has no
        // source for. Not configured rather than thrown: the fleet carries on
        // and the row says which connection nobody could read.
        return {
          kind: 'not_configured',
          reason: `provider ${connection.provider} has no accounting source in this build`,
        };
      }

      const app = qboAppConfigFromEnv(environment);
      if ('missing' in app) return { kind: 'not_configured', reason: app.missing };

      if (tokenStore === undefined) {
        return {
          kind: 'not_configured',
          reason:
            'no QuickBooks token store is configured: QboTokenStore has no production ' +
            'implementation yet, and its credentials belong in KMS-backed storage rather ' +
            'than in an application table (ADR 0026, ADR 0031 §7)',
        };
      }

      return {
        kind: 'ready',
        source: new QboAccountingSource({
          realmId: connection.providerAccountId,
          baseUrl: app.baseUrl,
          clientId: app.clientId,
          clientSecret: app.clientSecret,
          tokenStore,
        }),
      };
    },
  };
}

/**
 * The stores a sync runs through, built for one tenant and one member.
 *
 * `PostgresStore` as `app_rw` with those claims — the same construction a
 * request makes and the same one `storeForActor` makes for the read job. A cron
 * is not a privileged context: it sees exactly what that member sees, because
 * RLS is what decides, and the service-role key appears nowhere in this app
 * (invariant 6).
 *
 * `close` is returned with them so the function that built them is the function
 * that ends them.
 */
export interface LedgerSyncHandle {
  readonly deps: LedgerSyncJobDeps;
  close(): Promise<void>;
}

export function ledgerSyncDepsFor(
  identity: { readonly orgId: string; readonly userId: string },
  sources: LedgerSourceFactory = accountingSourceFromEnv(),
): LedgerSyncHandle {
  const store = tenantStore(identity);
  const config = { connectionString: env.databaseUrl };
  const runs = new PostgresLedgerSyncStore(config, identity, store);
  const discovery = new PostgresDiscoveryStore(config, identity, store);

  return {
    deps: { runs, discovery, sources, now: () => new Date() },
    async close(): Promise<void> {
      // The same call `runReadRequested` makes in its `finally` — and today the
      // same no-op, because the pools are shared per connection string and
      // outlive any one job (`sessionPool`): ending them here would close the
      // pool the next delivery is about to use. Called anyway, so a store that
      // ever does hold something per instance is released by the code that
      // built it rather than by nobody.
      await store.close();
    },
  };
}

/** Every enabled connection, as ids, with no tenant claims (ADR 0031 §5). */
export async function connectionsToSync(): Promise<readonly ConnectionToSync[]> {
  return listConnectionsToSync({ connectionString: env.databaseUrl });
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value;
}

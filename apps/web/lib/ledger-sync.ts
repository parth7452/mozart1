import {
  QBO_PRODUCTION_BASE_URL,
  QBO_SANDBOX_BASE_URL,
  QboAccountingSource,
  deadGrantOf,
} from '@recouple/qbo';
import type { QboTokenStore } from '@recouple/qbo';
import { KmsTokenCipher, type TokenCipher } from '@recouple/crypto';
import type {
  LedgerConnectionRecord,
  LedgerSourceFactory,
  LedgerSyncJobDeps,
  ResolvedLedgerSource,
} from '@recouple/pipeline';
import {
  PostgresDiscoveryStore,
  PostgresLedgerSyncStore,
  PostgresQboTokenStore,
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
 * Since ADR 0033 the answer can be "yes". `QBO_TOKEN_KMS_KEY_ID` builds a
 * `KmsTokenCipher`, and that cipher plus the identity the sync is already
 * acting as builds a `PostgresQboTokenStore` **per connection** — sealed rows
 * in `accounting_credentials`, opened with credentials the database does not
 * have. Absent the key id nothing is built and every connection still gets a
 * `not_configured` run row, which is `scannerFromEnv`'s rule rather than a
 * different one: no key, no store, and no fallback that looks like one.
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
 * `LedgerSourceFactory.resolve` may be async, and the KMS token store did not
 * make it so: building a cipher and a store is construction, not a round trip,
 * and the first KMS call happens when the adapter asks for a token. So this one
 * is still synchronous, which is what lets a caller — and a test — read the
 * verdict without awaiting it.
 */
export interface EnvAccountingSourceFactory extends LedgerSourceFactory {
  resolve(connection: LedgerConnectionRecord): ResolvedLedgerSource;
}

/** The one environment variable this file reads on the cipher's behalf. */
export const QBO_TOKEN_KMS_KEY_ID = 'QBO_TOKEN_KMS_KEY_ID';

/**
 * The cipher a production sync seals tokens with, or nothing.
 *
 * One variable: the KMS key. AWS credentials are deliberately **not** read here
 * — `KmsTokenCipher` leaves them to the SDK's own provider chain, so a Vercel
 * deployment uses static keys and a later instance role needs no code change
 * (ADR 0033 §3). Naming them here would be this file deciding how AWS
 * authenticates, which is not its business and would go stale.
 *
 * `undefined` rather than a throw, and rather than a cipher that throws on
 * first use: the caller turns it into a `not_configured` run row per connection
 * and the rest of the fleet is unaffected. `scannerFromEnv`'s shape (ADR 0018).
 */
export function qboTokenCipherFromEnv(
  environment: EnvVars = process.env,
): TokenCipher | undefined {
  const keyId = nonEmpty(environment[QBO_TOKEN_KMS_KEY_ID]);
  if (keyId === undefined) return undefined;
  const region = nonEmpty(environment.AWS_REGION) ?? nonEmpty(environment.AWS_DEFAULT_REGION);
  return KmsTokenCipher.forKey(keyId, region === undefined ? {} : { region });
}

/**
 * The token store for **one connection**, or nothing.
 *
 * Three things have to be true and all three are checked here: there is a
 * cipher (so there is a KMS key), the connection names a company, and there is
 * a database to read — a token store with no claims and no connection string is
 * not a token store. Any of them missing is `undefined`, which the caller turns
 * into `not_configured` naming the variable.
 *
 * Per connection rather than one store with a realm-keyed map, for ADR 0033
 * §5's reason: the realm is fixed from the connection row the job already read
 * through RLS, so a call naming another company is a named error rather than a
 * lookup.
 *
 * The cipher is a parameter with a default so a test can inject one built over
 * a stubbed KMS client. `@recouple/crypto/testing` — where the local cipher
 * lives — is a separate entry point and nothing in `apps/web` imports it
 * outside a test (ADR 0033 §4).
 */
export function qboTokenStoreFromEnv(
  identity: { readonly orgId: string; readonly userId: string },
  connection: LedgerConnectionRecord,
  environment: EnvVars = process.env,
  cipher: TokenCipher | undefined = qboTokenCipherFromEnv(environment),
): QboTokenStore | undefined {
  if (cipher === undefined) return undefined;
  if (connection.providerAccountId.trim() === '') return undefined;

  // The app's own loud accessor, except where a caller named one — which is
  // what lets a test build a store against a scratch database without setting
  // the process environment. `env.databaseUrl` throws when it is unset, which
  // is the behaviour every other caller in this app wants.
  const connectionString = nonEmpty(environment.DATABASE_URL) ?? env.databaseUrl;

  return new PostgresQboTokenStore(
    { connectionString },
    identity,
    { connectionId: connection.connectionId, realmId: connection.providerAccountId },
    cipher,
  );
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
 * What `accountingSourceFromEnv` needs beyond the environment.
 *
 * `identity` is the member the sync acts as — the connection's `created_by`,
 * which the event already carries (ADR 0031 §3). The token store runs under
 * exactly those claims, so a factory built without one can build no store: fail
 * closed, and `ledgerSyncDepsFor` is the caller that always has one.
 *
 * `tokenStoreFor` is the seam a test uses. It is not how production builds one:
 * the default is `qboTokenStoreFromEnv`, which reads the key id and nothing
 * else.
 */
export interface AccountingSourceOptions {
  readonly identity?: { readonly orgId: string; readonly userId: string };
  readonly cipher?: TokenCipher;
  readonly tokenStoreFor?: (connection: LedgerConnectionRecord) => QboTokenStore | undefined;
}

/**
 * The factory the job asks. One `resolve` per connection, and it never throws
 * for want of configuration.
 *
 * The store is built *inside* `resolve`, because it is per connection: the
 * realm it is scoped to comes off the connection row (ADR 0033 §5), which the
 * job read under the tenant's own claims. `QboAccountingSource` takes it
 * injected and never reads `process.env` itself (ADR 0026), so the only place
 * a variable is read is here.
 */
export function accountingSourceFromEnv(
  environment: EnvVars = process.env,
  options: AccountingSourceOptions = {},
): EnvAccountingSourceFactory {
  const tokenStoreFor =
    options.tokenStoreFor ??
    ((connection: LedgerConnectionRecord): QboTokenStore | undefined => {
      if (options.identity === undefined) return undefined;
      return qboTokenStoreFromEnv(
        options.identity,
        connection,
        environment,
        options.cipher ?? qboTokenCipherFromEnv(environment),
      );
    });

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

      const tokenStore = tokenStoreFor(connection);
      if (tokenStore === undefined) {
        return {
          kind: 'not_configured',
          reason:
            `no QuickBooks token store could be built for connection ${connection.connectionId}: ` +
            `${QBO_TOKEN_KMS_KEY_ID} is not set, or this sync has no member to act as. ` +
            'Tokens are sealed with a KMS key and kept as rows nothing without that key can ' +
            'read, never as plaintext in an application table (ADR 0033)',
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
        // Intuit refused the stored sign-in for good, and which stored row it
        // was: the one the store opened last, since the client reads again
        // under the lock before it refreshes (ADR 0046). A store that cannot
        // name its rows cannot be released automatically.
        deadGrant: (error: unknown) => {
          const reason = deadGrantOf(error);
          const credentialId = tokenStore.loadedCredential?.();
          return reason === undefined || credentialId === undefined
            ? undefined
            : { reason, credentialId };
        },
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
  // The identity goes to the factory as well as to the stores: the token store
  // it builds per connection runs as `app_rw` with exactly these claims, the
  // same as every other read and write on this path (ADR 0033 §5).
  sources: LedgerSourceFactory = accountingSourceFromEnv(process.env, { identity }),
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

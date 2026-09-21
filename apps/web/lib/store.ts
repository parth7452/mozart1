import { PostgresStore, type TenantContext } from '@recouple/store-postgres';
import { env } from './env';

/**
 * A store scoped to a tenant and an actor.
 *
 * One construction for both paths: the request builds it from the session
 * (`storeFor` in lib/session.ts) and the job builds it from the identity the
 * event names (`storeForActor` in lib/pipeline.ts). A job is not a privileged
 * context — it sees exactly what that member sees, because every query runs as
 * `app_rw` with these claims set transaction-locally and RLS is what decides
 * (invariant 6).
 *
 * `PostgresStore` itself, with nothing wrapped around it. It answers the two
 * questions a job asks — `memberMayWrite` and `caseForDocument` — beside every
 * other query it makes, so this app writes no SQL of its own and there is one
 * copy of `withTenant`'s transaction discipline rather than a second one here
 * that has to be kept in step with it.
 */
export function tenantStore(tenant: TenantContext): PostgresStore {
  return new PostgresStore({ connectionString: env.databaseUrl }, tenant);
}

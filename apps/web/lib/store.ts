import { PostgresStore, sessionPool, type TenantContext } from '@recouple/store-postgres';
import type { JobStore } from '@recouple/pipeline';
import { env } from './env';

/**
 * What this file needs of a pooled client, named structurally.
 *
 * The client itself comes from the pool `@recouple/store-postgres` hands out —
 * one pool per connection string for the life of the process, as that package's
 * comment explains — rather than from a driver this app imports for itself.
 * `pg` is not a dependency of this app and does not become one for a type.
 */
interface TenantClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
}

/**
 * The tenant's store, plus the two questions a job has to be able to ask
 * (`JobStore` in `packages/pipeline/src/jobs.ts`).
 *
 * Both belong in `PostgresStore` beside every other query, and both are written
 * here instead because the review that asked for them also said not to touch
 * `packages/store-postgres` in this change. Moving them there is a rename and a
 * deletion; nothing else about them changes. Until then this class is the only
 * place in the app that writes SQL, and it writes it the way `PostgresStore`
 * does — as `app_rw`, with the tenant's claims set transaction-locally so a
 * pooled connection cannot carry one tenant's claims into another's query, on
 * the same shared pool, and with no service-role key anywhere near it
 * (invariant 6).
 *
 * Neither question is answered from memory. `app.member_may_write()` is the
 * database's own predicate (migration 0010), so what this reports and what the
 * write policies enforce cannot drift apart.
 */
export class TenantStore extends PostgresStore implements JobStore {
  private readonly claims: TenantContext;
  private readonly connectionString: string;

  constructor(connectionString: string, tenant: TenantContext) {
    super({ connectionString }, tenant);
    this.claims = tenant;
    this.connectionString = connectionString;
  }

  /**
   * Whether this member may write in this tenant, asked of the database.
   *
   * The actor must be the one this store already carries: the claims are what
   * `app.member_may_write()` reads, so answering for anyone else would be
   * answering a different question than the one asked. A mismatch is a
   * programming error and says so rather than returning `false`, which would
   * look like a refused member.
   */
  async memberMayWrite(actor: {
    readonly orgId: string;
    readonly userId: string;
  }): Promise<boolean> {
    if (actor.orgId !== this.claims.orgId || actor.userId !== this.claims.userId) {
      throw new Error(
        'this store acts as a different member than the one being asked about: ' +
          `store ${this.claims.userId}@${this.claims.orgId}, asked ${actor.userId}@${actor.orgId}`,
      );
    }
    return this.asTenant(async (client) => {
      const { rows } = await client.query('select app.member_may_write() as may');
      // `=== true` and not a truthiness check: no row, or a null, is a member
      // who may not write.
      return rows[0]?.may === true;
    });
  }

  /**
   * The case this document is already filed against, if any.
   *
   * The notice link first: a document that opened a case is on that case, and a
   * document can also be evidence on another. RLS scopes the read, so a document
   * of another tenant's answers nothing rather than answering wrongly.
   */
  async caseForDocument(documentId: string): Promise<string | undefined> {
    return this.asTenant(async (client) => {
      const { rows } = await client.query(
        `select deduction_id from deduction_documents
          where document_id = $1
          order by (role = 'notice') desc, observed_at asc, id asc
          limit 1`,
        [documentId],
      );
      const deductionId = rows[0]?.deduction_id;
      return typeof deductionId === 'string' ? deductionId : undefined;
    });
  }

  /**
   * `PostgresStore.withTenant`, which is private there. Same three statements in
   * the same order, and they are the load-bearing part: `set local role` and
   * `set_config(..., true)` both end with the transaction.
   */
  private async asTenant<T>(work: (client: TenantClient) => Promise<T>): Promise<T> {
    const client = await sessionPool({ connectionString: this.connectionString }).connect();
    try {
      await client.query('begin');
      await client.query('set local role app_rw');
      await client.query('select set_config($1, $2, true)', [
        'request.jwt.claims',
        JSON.stringify({ org_id: this.claims.orgId, sub: this.claims.userId }),
      ]);
      const result = await work(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

/**
 * A store scoped to a tenant and an actor.
 *
 * One construction for both paths: the request builds it from the session
 * (`storeFor` in lib/session.ts) and the job builds it from the identity the
 * event names (`storeForActor` in lib/pipeline.ts). A job is not a privileged
 * context — it sees exactly what that member sees.
 */
export function tenantStore(tenant: TenantContext): TenantStore {
  return new TenantStore(env.databaseUrl, tenant);
}

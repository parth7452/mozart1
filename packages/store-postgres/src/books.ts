/**
 * The Books page's one read of our own data (ADR 0066 §3): the tenant's cases
 * dated inside a window, to set beside the ledger's lines.
 *
 * A read and nothing else: one SELECT in one tenant transaction as `app_rw`
 * under the caller's claims, no `org_id` filter of its own — RLS decides whose
 * cases these are — and no write, lock or function call. The ledger half of
 * the reconciliation is never stored (ADR 0066 §4 is a proposal), so there is
 * nothing here to keep in step with it.
 *
 * In its own file and its own small class, in the manner of
 * `PostgresPostingStore`, rather than as another method on `PostgresStore`.
 */

import type { Pool, PoolClient } from 'pg';
import { sessionPool, type PostgresStoreConfig, type TenantContext } from './store';

/** A read that came back in a shape it should never have. Ids and column names only. */
export class BooksReadError extends Error {
  override readonly name = 'BooksReadError';
}

/** How many cases one window lists. The total is never capped. */
export const BOOKS_CASES_LIMIT = 500;
export const BOOKS_CASES_MAX = 2_000;

/** One case as the reconciliation reads it. */
export interface BooksCaseRow {
  readonly deductionId: string;
  readonly state: string;
  readonly claimId?: string;
  readonly amountCents: number;
  /**
   * The deduction's own date, as its document printed it. Absent when none
   * did — such a case is in the window by the day it was opened (UTC), and
   * can be a candidate for a ledger line but never an exact match.
   */
  readonly deductionDate?: string;
  /** The debtor a person matched, else the payer's name as printed. */
  readonly payerName?: string;
  /** False when `payerName` is only what a document printed (ADR 0019). */
  readonly payerMatched: boolean;
}

export interface BooksCasesRead {
  readonly rows: readonly BooksCaseRow[];
  /** Every case in the window, whatever `limit` cut the list to. */
  readonly total: number;
  readonly limit: number;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export class PostgresBooksStore {
  private readonly pool: Pool;
  private readonly role: string;

  constructor(
    config: PostgresStoreConfig,
    private readonly tenant: TenantContext,
  ) {
    this.pool = sessionPool(config);
    this.role = config.role ?? 'app_rw';
  }

  /** As `PostgresStore.withTenant`: role and claims transaction-local. */
  private async withTenant<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`set local role ${this.role}`);
      await client.query('select set_config($1, $2, true)', [
        'request.jwt.claims',
        JSON.stringify({ org_id: this.tenant.orgId, sub: this.tenant.userId }),
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

  /**
   * The tenant's cases dated inside `window`, both ends counted, oldest first.
   *
   * A case is in the window by its `deduction_date`; one with no date, by the
   * UTC day it was opened. A merged-away case is left out: its survivor is the
   * deduction (ADR 0042), and listing both would show one deduction twice
   * beside a ledger that has it once. Every other state is in — a won or
   * written-off deduction is exactly what the books should show.
   *
   * At most `limit` rows, with the window's whole count beside them so a page
   * can say what it is not listing.
   */
  async casesInWindow(
    window: { readonly from: string; readonly to: string },
    options: { readonly limit?: number } = {},
  ): Promise<BooksCasesRead> {
    if (!ISO_DAY.test(window.from) || !ISO_DAY.test(window.to) || window.from > window.to) {
      throw new BooksReadError('a books window is two YYYY-MM-DD days, in order');
    }
    const limit = options.limit ?? BOOKS_CASES_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > BOOKS_CASES_MAX) {
      throw new BooksReadError(`a books case limit is a whole number from 1 to ${BOOKS_CASES_MAX}`);
    }
    return this.withTenant(async (client) => {
      const { rows } = await client.query<{
        id: string;
        state: string;
        claim_id: string | null;
        amount: string;
        deduction_date: string | null;
        payer_name: string | null;
        payer_matched: boolean;
        total: string;
      }>(
        `select d.id, d.state, d.claim_id,
                d.deduction_amount_cents::text as amount,
                d.deduction_date::text as deduction_date,
                coalesce(b.display_name, d.retailer_name_as_printed) as payer_name,
                (b.id is not null) as payer_matched,
                count(*) over ()::text as total
           from deductions d
           left join debtors b on b.id = d.debtor_id
          where d.state not in ('merged', 'removed')
            and coalesce(d.deduction_date, (d.created_at at time zone 'UTC')::date)
                between $1::date and $2::date
          order by coalesce(d.deduction_date, (d.created_at at time zone 'UTC')::date),
                   d.deduction_amount_cents, d.id
          limit $3`,
        [window.from, window.to, limit],
      );
      return {
        rows: rows.map((row) => ({
          deductionId: row.id,
          state: row.state,
          ...(row.claim_id === null ? {} : { claimId: row.claim_id }),
          amountCents: exactCount(row.amount, 'deduction_amount_cents'),
          ...(row.deduction_date === null ? {} : { deductionDate: row.deduction_date }),
          ...(row.payer_name === null ? {} : { payerName: row.payer_name }),
          payerMatched: row.payer_matched,
        })),
        total: rows.length === 0 ? 0 : exactCount(rows[0]?.total ?? '0', 'total'),
        limit,
      };
    });
  }
}

/** A bigint the database sent as text, as a number it fits in exactly. */
function exactCount(text: string, column: string): number {
  const value = Number(text);
  if (!/^-?\d+$/.test(text) || !Number.isSafeInteger(value)) {
    throw new BooksReadError(`${column} is not a whole number this process can hold`);
  }
  return value;
}

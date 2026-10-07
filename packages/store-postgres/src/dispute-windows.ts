/**
 * Payer dispute windows, on Postgres (ADR 0071, migration 0043).
 *
 * One member of one tenant, as `app_rw` with that member's claims set
 * transaction-locally, in `PostgresPayerCodeMapStore`'s shape. RLS decides
 * whose rows these are; no query here filters by `org_id`. The database is
 * the referee for who may add a window (an owner or approver, writing as
 * themselves), and this file names what it answered.
 *
 * Which row applies on a date is `app.payer_dispute_windows_as_of()` in SQL
 * and `resolveDisputeWindow` in `core-domain`; `dispute-windows.test.ts` holds
 * the two to one answer. A window fills a deadline only when a case is opened
 * (`PostgresStore.openCaseOn`); nothing here writes to a case. The service
 * role appears nowhere (invariant 6).
 */

import type { Pool, PoolClient } from 'pg';
import {
  CLOSED_STATES,
  deadlineFromWindow,
  isDisputeWindowDays,
  isIsoDate,
  isPayerCodeConfidence,
  isPayerCodeSource,
  PAYER_CODE_SOURCE_NOTE_MAX_LENGTH,
  type DisputeWindowRow,
  type PayerCodeConfidence,
  type PayerCodeSource,
} from '@recouple/core-domain';
import { DECLINED_SQL } from './review-queue';
import { sessionPool, type PostgresStoreConfig, type TenantContext } from './store';

/** What a person supplies to add a window. The author is the store's member. */
export interface NewDisputeWindow {
  readonly debtorId: string;
  readonly windowDays: number;
  readonly effectiveFrom: string;
  readonly effectiveTo?: string | undefined;
  readonly source: PayerCodeSource;
  readonly sourceNote?: string | undefined;
  readonly confidence: PayerCodeConfidence;
}

export type DisputeWindowRefusal = 'invalid' | 'not_permitted' | 'unknown_debtor' | 'already_recorded';

/** A window that was not written, by name. Carries ids and a field name only. */
export class DisputeWindowRefusedError extends Error {
  override readonly name = 'DisputeWindowRefusedError';
  constructor(
    readonly orgId: string,
    readonly refusal: DisputeWindowRefusal,
    readonly field?: string,
  ) {
    super(`dispute window in org ${orgId} was refused: ${refusal}${field === undefined ? '' : ` (${field})`}`);
  }
}

/** A window in force, with its payer's name, as Settings lists them. */
export interface DisputeWindowListed extends DisputeWindowRow {
  readonly debtorName: string;
}

/** What a case's payer window says, evaluated on its deduction date. */
export type DisputeWindowAnswer =
  /** No case this tenant can see, or no window in force on the date. */
  | { readonly kind: 'none' }
  | { readonly kind: 'no_debtor' }
  | { readonly kind: 'no_date' }
  | { readonly kind: 'window'; readonly window: DisputeWindowRow; readonly deadline: string };

/** A payer with open cases and no window in force. */
export interface PayerWithoutWindow {
  readonly debtorId: string;
  readonly displayName: string;
  readonly openCases: number;
  readonly openCasesWithoutDeadline: number;
}

interface WindowRow {
  id: string;
  debtor_id: string;
  window_days: number;
  measured_from: string;
  effective_from: string;
  effective_to: string | null;
  source: string;
  source_note: string | null;
  confidence: string;
  recorded_by: string;
  created_at: Date | string;
}

const WINDOW_COLUMNS = `w.id, w.debtor_id, w.window_days, w.measured_from,
        w.effective_from::text as effective_from, w.effective_to::text as effective_to,
        w.source, w.source_note, w.confidence, w.recorded_by, w.created_at`;

function windowFromRow(row: WindowRow): DisputeWindowRow {
  if (!isPayerCodeSource(row.source) || !isPayerCodeConfidence(row.confidence)) {
    throw new Error(`payer_dispute_windows ${row.id}: unknown source or confidence`);
  }
  if (row.measured_from !== 'deduction_date') {
    throw new Error(`payer_dispute_windows ${row.id}: unknown measured_from`);
  }
  return {
    id: row.id,
    debtorId: row.debtor_id,
    windowDays: row.window_days,
    measuredFrom: row.measured_from,
    effectiveFrom: row.effective_from,
    ...(row.effective_to === null ? {} : { effectiveTo: row.effective_to }),
    source: row.source,
    ...(row.source_note === null ? {} : { sourceNote: row.source_note }),
    confidence: row.confidence,
    recordedBy: row.recorded_by,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
  };
}

export class PostgresDisputeWindowStore {
  private readonly pool: Pool;
  private readonly role: string;

  constructor(
    config: PostgresStoreConfig,
    private readonly tenant: TenantContext,
  ) {
    this.pool = sessionPool(config);
    this.role = config.role ?? 'app_rw';
  }

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

  private refuse(refusal: DisputeWindowRefusal, field?: string): never {
    throw new DisputeWindowRefusedError(this.tenant.orgId, refusal, field);
  }

  /**
   * Adds one window, written by this store's member. Append-only: a
   * correction is another call. Checked here first so a refusal names its
   * field; the table's constraints, its insert policy and its authorship
   * trigger are what decide.
   */
  async recordDisputeWindow(input: NewDisputeWindow): Promise<DisputeWindowRow> {
    if (!isDisputeWindowDays(input.windowDays)) this.refuse('invalid', 'windowDays');
    if (!isIsoDate(input.effectiveFrom)) this.refuse('invalid', 'effectiveFrom');
    if (input.effectiveTo !== undefined) {
      if (!isIsoDate(input.effectiveTo) || input.effectiveTo < input.effectiveFrom) {
        this.refuse('invalid', 'effectiveTo');
      }
    }
    if (!isPayerCodeSource(input.source)) this.refuse('invalid', 'source');
    if (!isPayerCodeConfidence(input.confidence)) this.refuse('invalid', 'confidence');
    const note = input.sourceNote?.trim();
    if (note !== undefined && [...note].length > PAYER_CODE_SOURCE_NOTE_MAX_LENGTH) {
      this.refuse('invalid', 'sourceNote');
    }

    try {
      return await this.withTenant(async (client) => {
        const { rows } = await client.query<WindowRow>(
          `insert into payer_dispute_windows as w (org_id, debtor_id, window_days, effective_from,
             effective_to, source, source_note, confidence, recorded_by)
           values ($1, $2, $3, $4::date, $5::date, $6, $7, $8, $9)
           returning ${WINDOW_COLUMNS}`,
          [
            this.tenant.orgId,
            input.debtorId,
            input.windowDays,
            input.effectiveFrom,
            input.effectiveTo ?? null,
            input.source,
            note === undefined || note === '' ? null : note,
            input.confidence,
            this.tenant.userId,
          ],
        );
        const row = rows[0];
        if (row === undefined) throw new Error('dispute window insert returned no row');
        return windowFromRow(row);
      });
    } catch (error) {
      const state = (error as { code?: unknown } | null)?.code;
      if (state === '42501' || state === '23001') this.refuse('not_permitted');
      if (state === '23503') this.refuse('unknown_debtor', 'debtorId');
      if (state === '23505') this.refuse('already_recorded');
      if (state === '23514') this.refuse('invalid', (error as { constraint?: string }).constraint);
      if (state === '22P02' || state === '22007' || state === '22008') this.refuse('invalid');
      throw error;
    }
  }

  /** Every debtor's window in force on a date, with the debtor's name. */
  async currentDisputeWindows(asOf: string): Promise<readonly DisputeWindowListed[]> {
    if (!isIsoDate(asOf)) throw new RangeError(`asOf is not a YYYY-MM-DD date: ${asOf}`);
    return this.withTenant(async (client) => {
      const { rows } = await client.query<WindowRow & { debtor_name: string }>(
        `select ${WINDOW_COLUMNS}, b.display_name as debtor_name
           from app.payer_dispute_windows_as_of($1::date) w
           join debtors b on b.id = w.debtor_id
          order by b.display_name, w.debtor_id`,
        [asOf],
      );
      return rows.map((row) => ({ ...windowFromRow(row), debtorName: row.debtor_name }));
    });
  }

  /** Every window ever recorded, newest first: the history behind a deadline. */
  async allDisputeWindows(): Promise<readonly DisputeWindowRow[]> {
    return this.withTenant(async (client) => {
      const { rows } = await client.query<WindowRow>(
        `select ${WINDOW_COLUMNS} from payer_dispute_windows w
          order by w.debtor_id, w.effective_from desc, w.created_at desc, w.id desc`,
      );
      return rows.map(windowFromRow);
    });
  }

  /**
   * What this case's payer window says, as of its deduction date. Shown on
   * the case page; never written to the case.
   */
  async disputeWindowForCase(deductionId: string): Promise<DisputeWindowAnswer> {
    return this.withTenant(async (client) => {
      const found = await client.query<{ debtor_id: string | null; deduction_date: string | null }>(
        `select d.debtor_id, d.deduction_date::text as deduction_date from deductions d where d.id = $1`,
        [deductionId],
      );
      const row = found.rows[0];
      if (row === undefined) return { kind: 'none' };
      if (row.debtor_id === null) return { kind: 'no_debtor' };
      if (row.deduction_date === null) return { kind: 'no_date' };
      const { rows } = await client.query<WindowRow>(
        `select ${WINDOW_COLUMNS} from app.payer_dispute_windows_as_of($1::date) w
          where w.debtor_id = $2`,
        [row.deduction_date, row.debtor_id],
      );
      const w = rows[0];
      if (w === undefined) return { kind: 'none' };
      const window = windowFromRow(w);
      return { kind: 'window', window, deadline: deadlineFromWindow(row.deduction_date, window.windowDays) };
    });
  }

  /**
   * Every payer with open cases (not closed, not declined) and no window in
   * force on `asOf`, with how many of those cases have no deadline.
   */
  async payersWithoutWindow(asOf: string): Promise<readonly PayerWithoutWindow[]> {
    if (!isIsoDate(asOf)) throw new RangeError(`asOf is not a YYYY-MM-DD date: ${asOf}`);
    return this.withTenant(async (client) => {
      const { rows } = await client.query<{
        debtor_id: string;
        display_name: string;
        open_cases: string;
        without_deadline: string;
      }>(
        `select b.id as debtor_id, b.display_name,
                count(*)::text as open_cases,
                count(*) filter (where d.dispute_deadline is null)::text as without_deadline
           from deductions d
           join debtors b on b.id = d.debtor_id
          where not (d.state = any($2::text[]))
            and not ${DECLINED_SQL}
            and not exists (select 1 from app.payer_dispute_windows_as_of($1::date) w
                             where w.debtor_id = d.debtor_id)
          group by b.id, b.display_name
          order by count(*) filter (where d.dispute_deadline is null) desc, count(*) desc,
                   b.display_name, b.id`,
        [asOf, [...CLOSED_STATES]],
      );
      return rows.map((r) => ({
        debtorId: r.debtor_id,
        displayName: r.display_name,
        openCases: Number(r.open_cases),
        openCasesWithoutDeadline: Number(r.without_deadline),
      }));
    });
  }
}

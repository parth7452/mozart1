/**
 * Payer code mappings, on Postgres (ADR 0067, migration 0040).
 *
 * One member of one tenant, as `app_rw` with that member's claims set
 * transaction-locally, in `PostgresTeamStore`'s shape. RLS decides whose rows
 * these are; no query here filters by `org_id`. The database is the referee
 * for who may add a mapping (an owner or approver, writing as themselves), and
 * this file names what it answered.
 *
 * Which row applies on a date is `app.payer_code_maps_as_of()` in SQL and
 * `resolveCanonicalCode` in `core-domain`; `payer-code-maps.test.ts` holds the
 * two to one answer. The service role appears nowhere (invariant 6).
 */

import type { Pool, PoolClient } from 'pg';
import {
  isCanonicalReasonCode,
  isIsoDate,
  isPayerCodeConfidence,
  isPayerCodeSource,
  isStorablePayerCode,
  normalisePayerCode,
  PAYER_CODE_SOURCE_NOTE_MAX_LENGTH,
  resolveCanonicalCode,
  type CanonicalReasonCode,
  type PayerCodeConfidence,
  type PayerCodeMapRow,
  type PayerCodeSource,
  type PayerTermsAnswer,
} from '@recouple/core-domain';
import { sessionPool, type PostgresStoreConfig, type TenantContext } from './store';

/** What a person supplies to add a mapping. The author is the store's member. */
export interface NewPayerCodeMap {
  readonly debtorId: string;
  /** As printed; normalised here by `normalisePayerCode`. */
  readonly payerCode: string;
  readonly canonicalCode: CanonicalReasonCode;
  readonly effectiveFrom: string;
  readonly effectiveTo?: string | undefined;
  readonly source: PayerCodeSource;
  readonly sourceNote?: string | undefined;
  readonly confidence: PayerCodeConfidence;
}

export type PayerCodeMapRefusal =
  /** A field is not one the table takes; `field` says which. */
  | 'invalid'
  /** The caller is not an owner or approver of this tenant. */
  | 'not_permitted'
  /** No such debtor in this tenant. */
  | 'unknown_debtor'
  /** A row for this debtor, code and start date already exists. */
  | 'already_recorded';

/** A mapping that was not written, by name. Carries ids and a field name only. */
export class PayerCodeMapRefusedError extends Error {
  override readonly name = 'PayerCodeMapRefusedError';
  constructor(
    readonly orgId: string,
    readonly refusal: PayerCodeMapRefusal,
    readonly field?: string,
  ) {
    super(`payer code map in org ${orgId} was refused: ${refusal}${field === undefined ? '' : ` (${field})`}`);
  }
}

/** A current mapping with the debtor it belongs to, as Settings lists them. */
export interface PayerCodeMapListed extends PayerCodeMapRow {
  readonly debtorName: string;
}

/** A debtor a mapping can be added for. */
export interface MappableDebtor {
  readonly debtorId: string;
  readonly displayName: string;
  readonly retailerKey: string;
}

/**
 * What a case's payer code maps to, on the day its deduction was taken (else
 * the day the case was opened). Shown, never applied: nothing writes a
 * canonical code onto a case because of it.
 */
export type PayerCodeMappingAnswer =
  /** The case has no single payer code: none printed, or its documents disagree. */
  | { readonly kind: 'no_code' }
  /** A code, and no debtor to hold a mapping for it. */
  | { readonly kind: 'no_debtor'; readonly payerCode: string }
  | {
      readonly kind: 'unmapped';
      readonly payerCode: string;
      readonly debtorId: string;
      readonly asOf: string;
      /** False for a code the table would refuse (over-long, a control character). */
      readonly mappable: boolean;
    }
  | {
      readonly kind: 'mapped';
      readonly payerCode: string;
      readonly debtorId: string;
      readonly asOf: string;
      readonly map: PayerCodeMapRow;
    };

/** One line of the reconciliation list: a payer code with no mapping. */
export interface UnmappedPayerCode {
  /** Normalised. */
  readonly payerCode: string;
  readonly debtorId?: string;
  readonly debtorName?: string;
  /** The payer as printed, for cases matched to no debtor. */
  readonly printedName?: string;
  readonly caseCount: number;
  /** Integer cents, summed over those cases. */
  readonly totalCents: number;
  /** Whether a mapping can be added: a debtor to hold it and a code the table takes. */
  readonly mappable: boolean;
}

export interface UnmappedPayerCodes {
  readonly rows: readonly UnmappedPayerCode[];
  /** Cases read, newest first. */
  readonly casesExamined: number;
  /** Of those, the ones with a single payer code. */
  readonly casesWithCode: number;
  /** Of those, the ones whose code has a mapping in force. */
  readonly casesMapped: number;
  /** True when the tenant has more cases than `UNMAPPED_CASES_LIMIT`. */
  readonly truncated: boolean;
}

/** The most cases the reconciliation list reads; it says when it stopped. */
export const UNMAPPED_CASES_LIMIT = 2000;

interface MapRow {
  id: string;
  org_id: string;
  debtor_id: string;
  payer_code: string;
  canonical_code: string;
  effective_from: string;
  effective_to: string | null;
  source: string;
  source_note: string | null;
  confidence: string;
  recorded_by: string;
  created_at: Date | string;
}

const MAP_COLUMNS = `m.id, m.org_id, m.debtor_id, m.payer_code, m.canonical_code,
        m.effective_from::text as effective_from, m.effective_to::text as effective_to,
        m.source, m.source_note, m.confidence, m.recorded_by, m.created_at`;

function mapFromRow(row: MapRow): PayerCodeMapRow {
  // The database's checks say these hold; a row that breaks them is a schema
  // this code cannot speak about, and saying so beats rendering it.
  if (!isCanonicalReasonCode(row.canonical_code)) {
    throw new Error(`payer_code_maps ${row.id}: ${row.canonical_code} is not a canonical reason code`);
  }
  if (!isPayerCodeSource(row.source) || !isPayerCodeConfidence(row.confidence)) {
    throw new Error(`payer_code_maps ${row.id}: unknown source or confidence`);
  }
  return {
    id: row.id,
    orgId: row.org_id,
    debtorId: row.debtor_id,
    payerCode: row.payer_code,
    canonicalCode: row.canonical_code,
    effectiveFrom: row.effective_from,
    ...(row.effective_to === null ? {} : { effectiveTo: row.effective_to }),
    source: row.source,
    ...(row.source_note === null ? {} : { sourceNote: row.source_note }),
    confidence: row.confidence,
    recordedBy: row.recorded_by,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
  };
}

/** A case's payer code: its own column, else the one its documents agree on. */
function payerCodeOf(own: string | null, terms: PayerTermsAnswer | undefined): string | undefined {
  if (own !== null && own.trim() !== '') return own;
  return terms?.kind === 'derived' ? terms.terms.reasonCode : undefined;
}

export class PostgresPayerCodeMapStore {
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

  private refuse(refusal: PayerCodeMapRefusal, field?: string): never {
    throw new PayerCodeMapRefusedError(this.tenant.orgId, refusal, field);
  }

  /**
   * Adds one mapping, written by this store's member. Append-only: a
   * correction is another call with a later `effectiveFrom`.
   *
   * Checked here first so a refusal names its field; the table's constraints,
   * its insert policy and its authorship trigger are what decide.
   */
  async recordPayerCodeMap(input: NewPayerCodeMap): Promise<PayerCodeMapRow> {
    const payerCode = normalisePayerCode(input.payerCode);
    if (!isStorablePayerCode(payerCode)) this.refuse('invalid', 'payerCode');
    if (!isCanonicalReasonCode(input.canonicalCode)) this.refuse('invalid', 'canonicalCode');
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
        const { rows } = await client.query<MapRow>(
          `insert into payer_code_maps as m (org_id, debtor_id, payer_code, canonical_code,
             effective_from, effective_to, source, source_note, confidence, recorded_by)
           values ($1, $2, $3, $4, $5::date, $6::date, $7, $8, $9, $10)
           returning ${MAP_COLUMNS}`,
          [
            this.tenant.orgId,
            input.debtorId,
            payerCode,
            input.canonicalCode,
            input.effectiveFrom,
            input.effectiveTo ?? null,
            input.source,
            note === undefined || note === '' ? null : note,
            input.confidence,
            this.tenant.userId,
          ],
        );
        const row = rows[0];
        if (row === undefined) throw new Error('payer code map insert returned no row');
        return mapFromRow(row);
      });
    } catch (error) {
      const state = (error as { code?: unknown } | null)?.code;
      // 42501: the insert policy (not an owner or approver). 23001: the
      // authorship trigger, which this store cannot trip but is named anyway.
      if (state === '42501' || state === '23001') this.refuse('not_permitted');
      if (state === '23503') this.refuse('unknown_debtor', 'debtorId');
      if (state === '23505') this.refuse('already_recorded');
      if (state === '23514') this.refuse('invalid', (error as { constraint?: string }).constraint);
      if (state === '22P02' || state === '22007' || state === '22008') this.refuse('invalid');
      throw error;
    }
  }

  /** Every mapping ever recorded for a debtor, newest start first: the history. */
  async payerCodeMapsFor(debtorId: string): Promise<readonly PayerCodeMapRow[]> {
    return this.withTenant(async (client) => {
      const { rows } = await client.query<MapRow>(
        `select ${MAP_COLUMNS} from payer_code_maps m
          where m.debtor_id = $1
          order by m.payer_code, m.effective_from desc`,
        [debtorId],
      );
      return rows.map(mapFromRow);
    });
  }

  /** A debtor's mappings in force on a date, one per payer code. */
  async currentPayerCodeMaps(debtorId: string, asOf: string): Promise<readonly PayerCodeMapRow[]> {
    if (!isIsoDate(asOf)) throw new RangeError(`asOf is not a YYYY-MM-DD date: ${asOf}`);
    return this.withTenant(async (client) => {
      const { rows } = await client.query<MapRow>(
        `select ${MAP_COLUMNS} from app.payer_code_maps_as_of($2::date) m
          where m.debtor_id = $1
          order by m.payer_code`,
        [debtorId, asOf],
      );
      return rows.map(mapFromRow);
    });
  }

  /** Every debtor's mappings in force on a date, with the debtor's name. */
  async allCurrentPayerCodeMaps(asOf: string): Promise<readonly PayerCodeMapListed[]> {
    if (!isIsoDate(asOf)) throw new RangeError(`asOf is not a YYYY-MM-DD date: ${asOf}`);
    return this.withTenant(async (client) => {
      const { rows } = await client.query<MapRow & { debtor_name: string }>(
        `select ${MAP_COLUMNS}, b.display_name as debtor_name
           from app.payer_code_maps_as_of($1::date) m
           join debtors b on b.id = m.debtor_id
          order by b.display_name, m.debtor_id, m.payer_code`,
        [asOf],
      );
      return rows.map((row) => ({ ...mapFromRow(row), debtorName: row.debtor_name }));
    });
  }

  /** The tenant's debtors, for the form's picker. */
  async mappableDebtors(): Promise<readonly MappableDebtor[]> {
    return this.withTenant(async (client) => {
      const { rows } = await client.query<{ id: string; display_name: string; retailer_key: string }>(
        `select id, display_name, retailer_key from debtors order by display_name, id`,
      );
      return rows.map((row) => ({
        debtorId: row.id,
        displayName: row.display_name,
        retailerKey: row.retailer_key,
      }));
    });
  }

  /**
   * What this case's payer code maps to. `terms` is `payerTermsForCase`'s
   * answer, which the case page has already read; a case with its own
   * `reason_code_as_printed` uses that and ignores it.
   *
   * A case another tenant holds, or none, answers `no_code`: RLS returns no
   * row, and there is nothing to say about it.
   */
  async payerCodeMappingForCase(
    deductionId: string,
    terms: PayerTermsAnswer | undefined,
  ): Promise<PayerCodeMappingAnswer> {
    return this.withTenant(async (client) => {
      const found = await client.query<{ debtor_id: string | null; own: string | null; as_of: string }>(
        `select d.debtor_id, d.reason_code_as_printed as own,
                coalesce(d.deduction_date, (d.created_at at time zone 'UTC')::date)::text as as_of
           from deductions d where d.id = $1`,
        [deductionId],
      );
      const row = found.rows[0];
      if (row === undefined) return { kind: 'no_code' };
      const printed = payerCodeOf(row.own, terms);
      if (printed === undefined) return { kind: 'no_code' };
      const payerCode = normalisePayerCode(printed);
      if (payerCode === '') return { kind: 'no_code' };
      if (row.debtor_id === null) return { kind: 'no_debtor', payerCode };
      const base = { payerCode, debtorId: row.debtor_id, asOf: row.as_of };
      if (!isStorablePayerCode(payerCode)) return { kind: 'unmapped', ...base, mappable: false };

      const { rows } = await client.query<MapRow>(
        `select ${MAP_COLUMNS} from app.payer_code_maps_as_of($1::date) m
          where m.debtor_id = $2 and m.payer_code = $3`,
        [row.as_of, row.debtor_id, payerCode],
      );
      const map = rows[0];
      return map === undefined
        ? { kind: 'unmapped', ...base, mappable: true }
        : { kind: 'mapped', ...base, map: mapFromRow(map) };
    });
  }

  /**
   * The reconciliation list: every payer code on this tenant's cases that has
   * no mapping in force on its case's date, with how many cases print it and
   * what they add up to, largest first.
   *
   * A case's code is its own column, else the one `payerTermsForCases` derives
   * from its linked documents (asked through `terms`, the one matcher). A case
   * merged into another is not counted; its survivor is. The newest
   * `UNMAPPED_CASES_LIMIT` cases are read and the answer says when there were
   * more. Normalisation and the as-of rule are `core-domain`'s, over the rows
   * RLS returned.
   */
  async unmappedPayerCodes(terms: {
    payerTermsForCases(ids: readonly string[]): Promise<Map<string, PayerTermsAnswer>>;
  }): Promise<UnmappedPayerCodes> {
    const { cases, maps } = await this.withTenant(async (client) => {
      const cases = await client.query<{
        id: string;
        debtor_id: string | null;
        debtor_name: string | null;
        printed_name: string | null;
        own: string | null;
        amount: string;
        as_of: string;
        has_documents: boolean;
      }>(
        `select d.id, d.debtor_id, b.display_name as debtor_name,
                d.retailer_name_as_printed as printed_name,
                d.reason_code_as_printed as own,
                d.deduction_amount_cents::text as amount,
                coalesce(d.deduction_date, (d.created_at at time zone 'UTC')::date)::text as as_of,
                exists (select 1 from deduction_documents dd where dd.deduction_id = d.id)
                  as has_documents
           from deductions d
           left join debtors b on b.id = d.debtor_id
          where d.state not in ('merged', 'removed')
          order by d.created_at desc, d.id
          limit $1`,
        [UNMAPPED_CASES_LIMIT + 1],
      );
      const maps = await client.query<MapRow>(`select ${MAP_COLUMNS} from payer_code_maps m`);
      return { cases: cases.rows, maps: maps.rows.map(mapFromRow) };
    });

    const truncated = cases.length > UNMAPPED_CASES_LIMIT;
    const examined = truncated ? cases.slice(0, UNMAPPED_CASES_LIMIT) : cases;
    const toDerive = examined
      .filter((c) => (c.own === null || c.own.trim() === '') && c.has_documents)
      .map((c) => c.id);
    const derived = toDerive.length === 0 ? new Map<string, PayerTermsAnswer>() : await terms.payerTermsForCases(toDerive);

    const groups = new Map<string, { row: Omit<UnmappedPayerCode, 'caseCount' | 'totalCents'>; count: number; cents: bigint }>();
    let casesWithCode = 0;
    let casesMapped = 0;
    for (const c of examined) {
      const printed = payerCodeOf(c.own, derived.get(c.id));
      if (printed === undefined) continue;
      const payerCode = normalisePayerCode(printed);
      if (payerCode === '') continue;
      casesWithCode += 1;
      const storable = isStorablePayerCode(payerCode);
      if (
        c.debtor_id !== null &&
        storable &&
        resolveCanonicalCode(maps, { debtorId: c.debtor_id, payerCode, asOf: c.as_of }) !== undefined
      ) {
        casesMapped += 1;
        continue;
      }
      const printedName = c.printed_name?.trim();
      const key =
        c.debtor_id !== null
          ? JSON.stringify(['debtor', c.debtor_id, payerCode])
          : JSON.stringify(['printed', printedName ?? '', payerCode]);
      const group = groups.get(key) ?? {
        row: {
          payerCode,
          ...(c.debtor_id === null ? {} : { debtorId: c.debtor_id }),
          ...(c.debtor_name === null ? {} : { debtorName: c.debtor_name }),
          ...(c.debtor_id === null && printedName !== undefined && printedName !== '' ? { printedName } : {}),
          mappable: c.debtor_id !== null && storable,
        },
        count: 0,
        cents: 0n,
      };
      group.count += 1;
      group.cents += BigInt(c.amount);
      groups.set(key, group);
    }

    const rows = [...groups.values()]
      .map(({ row, count, cents }): UnmappedPayerCode => {
        const totalCents = Number(cents);
        if (!Number.isSafeInteger(totalCents)) {
          throw new RangeError(`unmapped payer code total is not a safe integer of cents: ${cents}`);
        }
        return { ...row, caseCount: count, totalCents };
      })
      .sort(
        (a, b) =>
          b.totalCents - a.totalCents ||
          b.caseCount - a.caseCount ||
          (a.payerCode < b.payerCode ? -1 : a.payerCode > b.payerCode ? 1 : 0) ||
          ((a.debtorId ?? a.printedName ?? '') < (b.debtorId ?? b.printedName ?? '') ? -1 : 1),
      );

    return { rows, casesExamined: examined.length, casesWithCode, casesMapped, truncated };
  }
}

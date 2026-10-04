/**
 * The database half of `pnpm seed:payer-codes` (ADR 0066), apart from the
 * command line so `scripts/test/seed-payer-codes.test.ts` can run it against
 * the scratch database. `seed-payer-codes.ts` says what the command is for.
 */

import type { DraftCodeTable } from '@recouple/core-domain';
import {
  PayerCodeMapRefusedError,
  PostgresPayerCodeMapStore,
  resolveOperator,
  type PostgresStoreConfig,
} from '@recouple/store-postgres';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SeedPayerCodesInput {
  readonly config: PostgresStoreConfig;
  readonly slug: string;
  readonly actorEmail: string;
  /** A `retailer_key` or a debtor id. */
  readonly debtor: string;
  readonly table: DraftCodeTable;
  /** Required to write: a draft states no date its codes took effect. */
  readonly effectiveFrom: string | undefined;
  /** False is a dry run: nothing is inserted. */
  readonly write: boolean;
  /** `YYYY-MM-DD`; the date a dry run with no `effectiveFrom` checks existing mappings on. */
  readonly today: string;
  readonly log: (line: string) => void;
}

export interface SeedPayerCodesResult {
  readonly inserted: number;
  readonly alreadyMapped: number;
  readonly wouldInsert: number;
  readonly refused: number;
}

export async function seedPayerCodes(input: SeedPayerCodesInput): Promise<SeedPayerCodesResult> {
  const { config, slug, actorEmail, table, effectiveFrom, write, log } = input;
  if (write && effectiveFrom === undefined) {
    throw new Error('writing needs an effective-from date: a draft states no date its codes took effect');
  }
  // The member the rows are attributed to, and whether they may write them:
  // both the database's answer. The role is checked here only to say so before
  // the first refusal; the insert policy is what decides.
  const actor = await resolveOperator(config, { slug, email: actorEmail });
  if (actor.role !== 'owner' && actor.role !== 'approver') {
    throw new Error(
      `${actorEmail} is ${actor.role} in ${slug}; only an owner or approver may add a payer code mapping`,
    );
  }
  const store = new PostgresPayerCodeMapStore(config, { orgId: actor.orgId, userId: actor.userId });
  const debtors = await store.mappableDebtors();
  const debtor = debtors.find((d) =>
    UUID.test(input.debtor) ? d.debtorId === input.debtor.toLowerCase() : d.retailerKey === input.debtor,
  );
  if (debtor === undefined) {
    throw new Error(
      `no debtor ${JSON.stringify(input.debtor)} in ${slug}. This script never creates one. ` +
        `Known keys: ${debtors.map((d) => d.retailerKey).join(', ') || '(none)'}`,
    );
  }
  if (table.retailerKey !== undefined && table.retailerKey !== debtor.retailerKey) {
    log(`note: the draft is for ${table.retailerKey} and the debtor is ${debtor.retailerKey} (${debtor.displayName})`);
  }

  const asOf = effectiveFrom ?? input.today;
  const inForce = new Map((await store.currentPayerCodeMaps(debtor.debtorId, asOf)).map((r) => [r.payerCode, r]));
  let inserted = 0;
  let alreadyMapped = 0;
  let wouldInsert = 0;
  let refused = 0;
  for (const row of table.proposed) {
    const existing = inForce.get(row.payerCode);
    const line = `${JSON.stringify(row.payerCode)} → ${row.canonicalCode}`;
    if (existing !== undefined) {
      alreadyMapped += 1;
      log(
        `  mapped   ${line}  already ${existing.canonicalCode} from ${existing.effectiveFrom} ` +
          `(${existing.source}, ${existing.confidence}); left alone`,
      );
      continue;
    }
    if (!write) {
      wouldInsert += 1;
      log(`  would insert  ${line}  glimpse_guide, low, from ${effectiveFrom ?? '(no --effective-from given)'}`);
      continue;
    }
    try {
      await store.recordPayerCodeMap({
        debtorId: debtor.debtorId,
        payerCode: row.payerCode,
        canonicalCode: row.canonicalCode,
        effectiveFrom: effectiveFrom as string,
        source: row.source,
        sourceNote: row.sourceNote,
        confidence: row.confidence,
      });
      inserted += 1;
      log(`  inserted ${line}`);
    } catch (error) {
      if (!(error instanceof PayerCodeMapRefusedError)) throw error;
      refused += 1;
      log(`  REFUSED  ${line}  ${error.refusal}${error.field === undefined ? '' : ` (${error.field})`}`);
    }
  }
  log(
    write
      ? `${inserted} inserted for ${debtor.displayName}, ${refused} refused, ${alreadyMapped} already mapped`
      : `dry run: nothing was written. --write (with --effective-from) inserts the rows above for ${debtor.displayName}`,
  );
  return { inserted, alreadyMapped, wouldInsert, refused };
}

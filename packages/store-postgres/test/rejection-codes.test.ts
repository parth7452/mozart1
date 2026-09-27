import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { CELL_TYPES, type RejectionCode } from '@recouple/ingest';
import type { InboundPartOutcome } from '@recouple/pipeline';

/**
 * The closed sets the code names and the check constraints that store them,
 * kept identical (the `doc-types.test.ts` pattern): the inbound part outcome
 * check is every `RejectionCode` plus the outcomes that are not refusals at
 * the door, and the cell type check is `CELL_TYPES`. A new code is a
 * migration; this is what fails when one is added without it.
 */

const connectionString = process.env.TEST_DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

const REJECTION_CODES = {
  empty_file: true,
  body_too_short: true,
  too_large: true,
  type_not_allowed: true,
  content_does_not_match_type: true,
  encrypted_pdf: true,
  active_content_pdf: true,
  decompression_bomb: true,
  malformed_pdf: true,
  macro_enabled_spreadsheet: true,
  active_content_spreadsheet: true,
  legacy_or_encrypted_office: true,
  xml_dtd_refused: true,
  malformed_spreadsheet: true,
  spreadsheet_too_large: true,
} satisfies Record<RejectionCode, true>;

const OTHER_OUTCOMES = {
  stored: true,
  already_held: true,
  over_daily_budget: true,
  not_clean: true,
  inline_image: true,
  too_many_parts: true,
  not_base64: true,
} satisfies Partial<Record<InboundPartOutcome, true>>;

// Every InboundPartOutcome is one or the other, and nothing else.
type Covered = keyof typeof REJECTION_CODES | keyof typeof OTHER_OUTCOMES;
const _exhaustive: Record<InboundPartOutcome, true> = { ...REJECTION_CODES, ...OTHER_OUTCOMES } satisfies Record<Covered, true>;
void _exhaustive;

describeDb('closed sets match their check constraints', () => {
  const admin = new Pool({ connectionString });
  afterAll(async () => {
    await admin.end();
  });

  async function checkValues(table: string, like: string): Promise<string[]> {
    const { rows } = await admin.query<{ def: string }>(
      `select pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid = $1::regclass and contype = 'c' and pg_get_constraintdef(oid) like $2`,
      [table, like],
    );
    expect(rows).toHaveLength(1);
    return [...(rows[0]?.def ?? '').matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1] as string).sort();
  }

  it('inbound_message_parts.outcome is every RejectionCode and the other outcomes', async () => {
    const expected = [...Object.keys(REJECTION_CODES), ...Object.keys(OTHER_OUTCOMES)].sort();
    expect(await checkValues('inbound_message_parts', '%malformed_pdf%')).toEqual(expected);
  });

  it('extraction_result_cells.cell_type is CELL_TYPES', async () => {
    expect(await checkValues('extraction_result_cells', '%cell_type%')).toEqual([...CELL_TYPES].sort());
  });
});

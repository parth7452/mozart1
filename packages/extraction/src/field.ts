/**
 * Every extracted value carries its own provenance.
 *
 * `source_page` and `source_quote` are what make a value checkable: we search
 * the cited page for the quote and record whether it was there. A value we
 * cannot point at in the document is a value we do not have.
 *
 * The model is not asked for a bounding box (ADR 0008). Two reasons: a vision
 * model's box is an estimate, and the reviewer UI highlights the quote anyway;
 * and an array-of-number box repeated across every field was a large part of a
 * structured-output grammar the API rejected as too big. `extraction_results`
 * keeps the nullable `source_bbox` column for a layout-aware extractor to fill.
 *
 * Optional fields are a nullable *value* inside the same object, never a
 * nullable object: one shape everywhere keeps the schema closed and the grammar
 * small, and the model still has to say "not present" explicitly.
 */

import { z } from 'zod';

export const SCHEMA_VERSION = '1.1.0';

const ABSENT = 'If this is not on the document, return null — never a guess.';

export function Field<T extends z.ZodType>(value: T, description: string) {
  return z.object({
    value: value.describe(description),
    confidence: z
      .number()
      .describe('0..1, calibrated. A low number is useful; a wrong high number is not.'),
    source_page: z.number().int().describe('1-indexed page this value was read from.'),
    source_quote: z
      .string()
      .describe(
        'The text exactly as printed, copied verbatim including currency symbols and punctuation. Empty string if the value is null.',
      ),
  });
}

/** An optional field: same shape, with null standing for "not on the document". */
export function OptionalField<T extends z.ZodType>(value: T, description: string) {
  return Field(value.nullable(), `${description} ${ABSENT}`);
}

/**
 * Money is captured as written and parsed to cents by our own code
 * (`parseMoneyToCents`), never by the model. A model that does its own
 * arithmetic leaves us nothing to check.
 */
export const MoneyText = () =>
  z
    .string()
    .describe(
      'The amount exactly as printed, e.g. "$3,120.00" or "(1,234.56)". Do not convert, round, or restate it as a number.',
    );

export type FieldValue<T> = {
  readonly value: T;
  readonly confidence: number;
  readonly source_page: number;
  readonly source_quote: string;
  readonly source_bbox?: readonly number[] | null;
};

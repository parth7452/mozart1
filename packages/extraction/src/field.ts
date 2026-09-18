/**
 * Every extracted value carries its own provenance.
 *
 * `source_page` and `source_quote` are required: a value we cannot point at in
 * the document is a value we do not have. `source_bbox` is nullable because a
 * vision model's box is an estimate — the reviewer UI highlights the quote and
 * uses the box only as a hint (ADR 0007).
 *
 * Optional document fields are modelled as a nullable Field rather than an
 * absent key, so the structured-output schema stays closed and a missing value
 * is an explicit null rather than something the model can quietly omit.
 */

import { z } from 'zod';

export const SCHEMA_VERSION = '1.0.0';

export const BboxSchema = z
  .array(z.number())
  .describe(
    'Normalised [x0, y0, x1, y1] in 0..1 from the top-left of the page, or null if you cannot place the value precisely. Never guess a box.',
  )
  .nullable();

export function Field<T extends z.ZodType>(value: T, description: string) {
  return z.object({
    value: value.describe(description),
    confidence: z
      .number()
      .describe('0..1. Your calibrated confidence in this value. Be honest: a low number is useful, a wrong high number is not.'),
    source_page: z.number().int().describe('1-indexed page this value was read from.'),
    source_quote: z
      .string()
      .describe(
        'The text exactly as it appears on the page, copied verbatim, including any currency symbol or punctuation. Do not paraphrase or reformat.',
      ),
    source_bbox: BboxSchema,
  });
}

/** An optional field: present in the schema, explicitly null when absent. */
export function OptionalField<T extends z.ZodType>(value: T, description: string) {
  return Field(value, description).nullable();
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
  readonly source_bbox: readonly number[] | null;
};

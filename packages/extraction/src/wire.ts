/**
 * The wire format: a flat array of field records.
 *
 * One repeated shape, so the grammar stays small whatever the document type
 * (ADR 0008). It also maps one-to-one onto `extraction_results`, which is how
 * the data is stored anyway — the nested typed object is reassembled from it and
 * validated here, on our side, where a failure is visible and recorded.
 */

import { z } from 'zod';
import type { FieldDescriptor, ValueType } from './paths';
import { rowIndexOf, templatePath } from './paths';

export const WireFieldSchema = z.object({
  path: z
    .string()
    .describe(
      'The field path from the list, exactly as written. For a repeating group use the row number, e.g. lines[0].sku_upc.',
    ),
  value: z
    .string()
    .describe(
      'The value as text. Amounts stay exactly as printed ("$3,120.00"). Quantities are digits. Booleans are "true" or "false". Omit the field entirely if it is not on the document — never send an empty value.',
    ),
  confidence: z.number().describe('0..1, calibrated.'),
  source_page: z.number().int().describe('1-indexed page you read this from.'),
  source_quote: z
    .string()
    .describe('The text exactly as printed on that page, copied verbatim.'),
});

export const WireExtractionSchema = z.object({
  fields: z
    .array(WireFieldSchema)
    .describe('One entry per field you found. Leave out fields the document does not carry.'),
});

export type WireField = z.infer<typeof WireFieldSchema>;

export interface ReassemblyIssue {
  readonly path: string;
  readonly problem: string;
}

export interface Reassembly {
  readonly document: unknown;
  readonly validated: boolean;
  readonly issues: readonly ReassemblyIssue[];
}

function coerce(
  raw: string,
  valueType: ValueType,
): { ok: true; value: unknown } | { ok: false; problem: string } {
  const text = raw.trim();
  switch (valueType) {
    case 'string':
      return { ok: true, value: text };
    case 'integer': {
      const cleaned = text.replace(/[,\s]/g, '');
      if (!/^-?\d+$/.test(cleaned)) return { ok: false, problem: `"${raw}" is not a whole number` };
      return { ok: true, value: Number(cleaned) };
    }
    case 'number': {
      const cleaned = text.replace(/[,\s]/g, '');
      if (!/^-?\d*\.?\d+$/.test(cleaned)) return { ok: false, problem: `"${raw}" is not a number` };
      return { ok: true, value: Number(cleaned) };
    }
    case 'boolean': {
      const lowered = text.toLowerCase();
      if (['true', 'yes', 'y', '1'].includes(lowered)) return { ok: true, value: true };
      if (['false', 'no', 'n', '0'].includes(lowered)) return { ok: true, value: false };
      return { ok: false, problem: `"${raw}" is not true or false` };
    }
  }
}

const absentField = () => ({ value: null, confidence: 0, source_page: 1, source_quote: '' });

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  let node: Record<string, unknown> = target;

  segments.forEach((segment, index) => {
    const match = /^([^[]+)\[(\d+)\]$/.exec(segment);
    const last = index === segments.length - 1;

    if (match?.[1] !== undefined && match[2] !== undefined) {
      const key = match[1];
      const row = Number(match[2]);
      const array = (node[key] as unknown[] | undefined) ?? [];
      node[key] = array;
      const existing = (array[row] as Record<string, unknown> | undefined) ?? {};
      array[row] = existing;
      node = existing;
      return;
    }
    if (last) {
      node[segment] = value;
      return;
    }
    const existing = (node[segment] as Record<string, unknown> | undefined) ?? {};
    node[segment] = existing;
    node = existing;
  });
}

/**
 * Rebuilds the typed document from what the model sent, then validates it.
 *
 * Unknown paths are dropped with an issue rather than passed through: a field
 * that is not in the schema is one we have nowhere to put and no way to check.
 * Fields the model left out are filled with an explicit "not present", which is
 * how a valid absence is represented — and which makes a *required* field the
 * model skipped fail validation loudly instead of vanishing.
 */
export function reassemble(
  wireFields: readonly WireField[],
  descriptors: readonly FieldDescriptor[],
  schema: z.ZodType,
): Reassembly {
  const byTemplate = new Map(descriptors.map((d) => [d.path, d] as const));
  const issues: ReassemblyIssue[] = [];
  const document: Record<string, unknown> = {};
  const seen = new Set<string>();
  const rowsPerGroup = new Map<string, number>();

  for (const field of wireFields) {
    const template = templatePath(field.path);
    const descriptor = byTemplate.get(template);
    if (descriptor === undefined) {
      issues.push({ path: field.path, problem: 'not a field in this document type' });
      continue;
    }
    if (field.value.trim() === '') {
      issues.push({ path: field.path, problem: 'empty value: treated as not present' });
      continue;
    }

    const coerced = coerce(field.value, descriptor.valueType);
    if (!coerced.ok) {
      issues.push({ path: field.path, problem: coerced.problem });
      continue;
    }

    setPath(document, field.path, {
      value: coerced.value,
      confidence: field.confidence,
      source_page: field.source_page,
      source_quote: field.source_quote,
    });
    seen.add(field.path);

    if (descriptor.group !== undefined) {
      const row = rowIndexOf(field.path);
      if (row !== undefined) {
        rowsPerGroup.set(descriptor.group, Math.max(rowsPerGroup.get(descriptor.group) ?? 0, row + 1));
      }
    }
  }

  // Fill every field the model did not send, so absence is explicit.
  for (const descriptor of descriptors) {
    if (descriptor.group === undefined) {
      if (!seen.has(descriptor.path)) setPath(document, descriptor.path, absentField());
      continue;
    }
    const rows = rowsPerGroup.get(descriptor.group) ?? 0;
    const leaf = descriptor.path.split('.').slice(1).join('.');
    for (let row = 0; row < rows; row++) {
      const concrete = `${descriptor.group}[${row}].${leaf}`;
      if (!seen.has(concrete)) setPath(document, concrete, absentField());
    }
  }
  // A group with no rows is an empty array, not a missing key.
  for (const group of new Set(descriptors.map((d) => d.group).filter((g) => g !== undefined))) {
    if (document[group as string] === undefined) document[group as string] = [];
  }

  const parsed = schema.safeParse(document);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 20)) {
      issues.push({ path: issue.path.join('.'), problem: issue.message });
    }
  }

  return { document, validated: parsed.success, issues };
}

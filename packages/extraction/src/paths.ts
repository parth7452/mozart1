/**
 * The field list for a document type, derived from its Zod schema.
 *
 * The typed schemas stay the source of truth for what a document type contains.
 * They are just no longer the wire format: the API compiles a structured-output
 * schema into a grammar, and a bespoke nested object per document type exceeds
 * what it will compile (ADR 0008). So we describe the fields to the model as a
 * list and take back a flat array of records.
 */

import { z } from 'zod';

export type ValueType = 'string' | 'integer' | 'number' | 'boolean';

export interface FieldDescriptor {
  /** `claim_id`, or `lines[].sku_upc` for a field inside a repeating group. */
  readonly path: string;
  readonly description: string;
  readonly valueType: ValueType;
  /** False when the schema allows null, i.e. the field is optional. */
  readonly required: boolean;
  readonly repeating: boolean;
  /** The array property this field belongs to, for repeating fields. */
  readonly group?: string;
}

interface JsonSchemaNode {
  type?: string | string[];
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  anyOf?: JsonSchemaNode[];
  description?: string;
}

function typeNames(node: JsonSchemaNode): string[] {
  if (Array.isArray(node.type)) return node.type;
  if (typeof node.type === 'string') return [node.type];
  if (node.anyOf !== undefined) return node.anyOf.flatMap(typeNames);
  return [];
}

function valueTypeOf(node: JsonSchemaNode): ValueType {
  const names = typeNames(node).filter((t) => t !== 'null');
  if (names.includes('integer')) return 'integer';
  if (names.includes('number')) return 'number';
  if (names.includes('boolean')) return 'boolean';
  return 'string';
}

function isFieldNode(node: JsonSchemaNode): boolean {
  return node.properties?.value !== undefined && node.properties?.source_quote !== undefined;
}

function describeOne(
  key: string,
  node: JsonSchemaNode,
  prefix: string,
  group?: string,
): FieldDescriptor {
  const value = node.properties?.value as JsonSchemaNode;
  return {
    path: `${prefix}${key}`,
    description: value.description ?? '',
    valueType: valueTypeOf(value),
    required: !typeNames(value).includes('null'),
    repeating: group !== undefined,
    ...(group !== undefined ? { group } : {}),
  };
}

/** Every field the model should look for, in the order a reader would meet them. */
export function describeFields(schema: z.ZodType): FieldDescriptor[] {
  const json = z.toJSONSchema(schema, { io: 'output' }) as JsonSchemaNode;
  const out: FieldDescriptor[] = [];

  for (const [key, node] of Object.entries(json.properties ?? {})) {
    if (isFieldNode(node)) {
      out.push(describeOne(key, node, ''));
      continue;
    }
    if (node.type === 'array' && node.items?.properties !== undefined) {
      for (const [subKey, subNode] of Object.entries(node.items.properties)) {
        if (!isFieldNode(subNode)) continue;
        out.push(describeOne(subKey, subNode, `${key}[].`, key));
      }
    }
  }
  return out;
}

/** `lines[2].sku_upc` → `lines[].sku_upc`, so a concrete path can be looked up. */
export function templatePath(path: string): string {
  return path.replace(/\[\d+\]/g, '[]');
}

/** The row index in `lines[2].sku_upc`, or undefined for a flat field. */
export function rowIndexOf(path: string): number | undefined {
  const match = /\[(\d+)\]/.exec(path);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/** The field list as the model sees it. */
export function renderFieldList(descriptors: readonly FieldDescriptor[]): string {
  const flat = descriptors.filter((d) => !d.repeating);
  const groups = new Map<string, FieldDescriptor[]>();
  for (const descriptor of descriptors.filter((d) => d.repeating)) {
    const group = descriptor.group as string;
    groups.set(group, [...(groups.get(group) ?? []), descriptor]);
  }

  const lines: string[] = [];
  for (const descriptor of flat) {
    lines.push(
      `- ${descriptor.path} (${descriptor.valueType}${descriptor.required ? '' : ', optional'}): ${descriptor.description}`,
    );
  }
  for (const [group, fields] of groups) {
    lines.push(
      `\nRepeating group "${group}" — one set of these per row on the document, numbered from 0 (${group}[0].…, ${group}[1].…):`,
    );
    for (const descriptor of fields) {
      const leaf = descriptor.path.split('.').slice(1).join('.');
      lines.push(
        `- ${group}[N].${leaf} (${descriptor.valueType}${descriptor.required ? '' : ', optional'}): ${descriptor.description}`,
      );
    }
  }
  return lines.join('\n');
}

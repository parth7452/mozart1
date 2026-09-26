/**
 * Reading a document in page ranges (ADR 0053).
 *
 * One reply cannot carry a remittance past about 120 rows: a row costs about
 * 250 output tokens and the budget is 32,000. When a read stops there, the
 * extractor asks for the rows page range by page range over the same whole
 * document, and this module plans the ranges and joins the replies.
 *
 * Everything here is pure. The join happens on the wire format, before
 * `reassemble`, so reassembly, validation, flattening, provenance and the quote
 * check run on the joined list exactly as they run on one reply. What the join
 * drops it says out loud, as an issue naming a path and page numbers — never as
 * text off the page.
 */

import type { DocumentPayload } from './ports';
import type { FieldDescriptor } from './paths';
import { rowIndexOf, templatePath } from './paths';
import type { ReassemblyIssue, WireField } from './wire';

/** One part of a paged read: pages `first` to `last`, 1-indexed, inclusive. */
export interface PageRange {
  readonly first: number;
  readonly last: number;
}

export interface PagingPolicy {
  /** Pages asked for in one part before any halving. */
  readonly pagesPerChunk: number;
  /** Every call a paged read may make, the first (cut-off) call included. */
  readonly maxCalls: number;
  /** Parts asked at once. */
  readonly concurrency: number;
}

/**
 * Two pages a part: a printed remittance holds 40–50 rows a page, so two pages
 * is about 100 rows, under the 32,000-token budget with room. 24 calls is 23
 * parts after the first call, 46 pages — at 46 rows a page already past
 * `MAX_ROWS_PER_GROUP`, so the cap refuses nothing the row cap would keep.
 */
export const PAGING_POLICY: PagingPolicy = {
  pagesPerChunk: 2,
  maxCalls: 24,
  concurrency: 4,
};

export function rangeLabel(range: PageRange): string {
  return range.first === range.last ? `${range.first}` : `${range.first}-${range.last}`;
}

/** Pages 1..pageCount in ranges of `pagesPerChunk`, in page order. */
export function planPageChunks(pageCount: number, pagesPerChunk: number): PageRange[] {
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    throw new RangeError(`cannot plan a paged read of ${pageCount} pages`);
  }
  if (!Number.isInteger(pagesPerChunk) || pagesPerChunk < 1) {
    throw new RangeError(`cannot read ${pagesPerChunk} pages a part`);
  }
  const ranges: PageRange[] = [];
  for (let first = 1; first <= pageCount; first += pagesPerChunk) {
    ranges.push({ first, last: Math.min(pageCount, first + pagesPerChunk - 1) });
  }
  return ranges;
}

/** A range cut in two, the first half the larger; undefined for one page. */
export function halveRange(range: PageRange): readonly [PageRange, PageRange] | undefined {
  if (range.last <= range.first) return undefined;
  const middle = range.first + Math.ceil((range.last - range.first + 1) / 2) - 1;
  return [
    { first: range.first, last: middle },
    { first: middle + 1, last: range.last },
  ];
}

/** The repeating groups a document type declares, in declaration order. */
export function repeatingGroupsOf(descriptors: readonly FieldDescriptor[]): string[] {
  return [
    ...new Set(
      descriptors.map((d) => d.group).filter((group): group is string => group !== undefined),
    ),
  ];
}

/**
 * Whether a read that ran out of budget may be re-asked in page ranges.
 *
 * A PDF of two or more pages whose type has a repeating group. An image is one
 * page and cannot be ranged; an email body has no pages; a type with no rows
 * has nothing a range would shorten.
 */
export function pageable(
  document: Pick<DocumentPayload, 'mimeType' | 'pageText'>,
  descriptors: readonly FieldDescriptor[],
): boolean {
  return (
    document.mimeType === 'application/pdf' &&
    (document.pageText?.length ?? 0) >= 2 &&
    repeatingGroupsOf(descriptors).length > 0
  );
}

/**
 * The block that turns a read into one part of a paged read. It follows the
 * extraction instruction, which every part shares; only this block differs.
 */
export function chunkInstruction(input: {
  readonly range: PageRange;
  readonly pageCount: number;
  readonly groups: readonly string[];
}): string {
  const { range, pageCount, groups } = input;
  const pages = range.first === range.last ? `page ${range.first}` : `pages ${range.first} to ${range.last}`;
  const named = groups.map((g) => `\`${g}\``).join(' and ');
  const first = groups[0] ?? 'lines';
  const lines = [
    `PAGED READ. This ${pageCount}-page document has too many rows to report in one reply, so it is being read in parts by page. This part is ${pages}.`,
    '',
    `- Report the rows of ${named} whose first line is printed on ${pages}, and no others. A row that starts on an earlier page belongs to an earlier part, even when it ends on ${pages}; a row that starts on a later page belongs to a later part.`,
    `- Number this part's rows from ${first}[0], in the order they are printed, as if the first row on page ${range.first} were the first row of the document.`,
    `- Cite source_page with the document's own page numbers (1 to ${pageCount}), never a page number within this part.`,
    '- A column heading, a page heading or a subtotal repeated on each page is not a row.',
  ];
  if (range.first === 1) {
    lines.push(
      '- Also report every field outside the repeating groups, wherever in the document it is printed, including totals on the last page.',
    );
  } else {
    lines.push(
      '- Do not report any field outside the repeating groups: the part that includes page 1 reports those.',
    );
  }
  return lines.join('\n');
}

/** One part's reply: the range asked for and the fields that came back. */
export interface ChunkReading {
  readonly range: PageRange;
  readonly fields: readonly WireField[];
}

export interface ChunkMerge {
  /** The joined wire fields, rows renumbered in page order, for `reassemble`. */
  readonly fields: WireField[];
  /** What the join dropped, each naming a path and page numbers. */
  readonly issues: ReassemblyIssue[];
  /** Rows kept per part, per group, in page order: `lines 1-2:92`. */
  readonly kept: readonly string[];
  /**
   * Adjacent rows either side of a part boundary that print the same values.
   * Kept — two identical lines are two deductions (ADR 0048) — and named.
   */
  readonly identicalAtBoundary: readonly string[];
}

interface Row {
  readonly index: number;
  readonly fields: WireField[];
}

/** `lines[12].invoice_number` → `lines[4].invoice_number`. Group fields are top-level. */
function renumber(path: string, group: string, row: number): string {
  const prefix = `${group}[`;
  const close = path.indexOf(']', prefix.length);
  return `${group}[${row}]${path.slice(close + 1)}`;
}

function signature(row: Row, group: string): string {
  return row.fields
    .map((f) => `${templatePath(f.path).slice(group.length + 3)}=${f.value.trim()}`)
    .sort()
    .join('|');
}

/**
 * Joins the parts of a paged read into one wire list (ADR 0053 §3).
 *
 * - Fields outside every repeating group come from the part that includes
 *   page 1 only; any other part's are dropped with an issue.
 * - A row is its part's when it starts inside the part's range: the smallest
 *   `source_page` among its fields. A row that starts outside was read by, or
 *   belongs to, another part, and is dropped with an issue. A row split across
 *   the boundary starts on the earlier page, so the earlier part keeps it whole.
 * - Kept rows are renumbered in page order: parts sorted by first page, the
 *   model's own order inside a part, gaps in its numbering closed.
 *
 * Parts must not overlap; that is a planning error, not the model's.
 */
export function mergeChunkFields(
  chunks: readonly ChunkReading[],
  descriptors: readonly FieldDescriptor[],
): ChunkMerge {
  const ordered = [...chunks].sort((a, b) => a.range.first - b.range.first);
  for (let i = 1; i < ordered.length; i++) {
    const before = ordered[i - 1] as ChunkReading;
    const after = ordered[i] as ChunkReading;
    if (after.range.first <= before.range.last) {
      throw new RangeError(
        `paged read parts overlap: pages ${rangeLabel(before.range)} and ${rangeLabel(after.range)}`,
      );
    }
  }

  const groupOf = new Map(descriptors.map((d) => [d.path, d.group] as const));
  const groups = repeatingGroupsOf(descriptors);
  const fields: WireField[] = [];
  const issues: ReassemblyIssue[] = [];
  const kept: string[] = [];
  const identicalAtBoundary: string[] = [];
  const offsets = new Map<string, number>(groups.map((g) => [g, 0]));
  const lastRowOf = new Map<string, { row: Row; range: PageRange; merged: number }>();

  for (const chunk of ordered) {
    const { range } = chunk;
    const part = `part ${rangeLabel(range)}`;
    const rowsByGroup = new Map<string, Map<number, Row>>();

    for (const field of chunk.fields) {
      const group = groupOf.get(templatePath(field.path));
      const index = group === undefined ? undefined : rowIndexOf(field.path);
      if (group === undefined || index === undefined) {
        // Outside every repeating group, or not a field of this type at all
        // (which `reassemble` names). Only the part with page 1 reports these.
        if (range.first === 1) {
          fields.push(field);
        } else {
          issues.push({
            path: field.path,
            problem: `reported by ${part}; only the part with page 1 reports fields outside a repeating group: dropped`,
          });
        }
        continue;
      }
      const rows = rowsByGroup.get(group) ?? new Map<number, Row>();
      rowsByGroup.set(group, rows);
      const row = rows.get(index) ?? { index, fields: [] };
      rows.set(index, row);
      row.fields.push(field);
    }

    for (const group of groups) {
      const rows = [...(rowsByGroup.get(group)?.values() ?? [])].sort((a, b) => a.index - b.index);
      let keptHere = 0;
      for (const row of rows) {
        const starts = Math.min(...row.fields.map((f) => f.source_page));
        if (starts < range.first || starts > range.last) {
          issues.push({
            path: `${group}[${row.index}]`,
            problem: `${part} reported a row that starts on page ${starts}, outside its pages: dropped`,
          });
          continue;
        }
        const merged = offsets.get(group) as number;
        const previous = lastRowOf.get(group);
        if (
          keptHere === 0 &&
          previous !== undefined &&
          previous.range.first !== range.first &&
          signature(previous.row, group) === signature(row, group)
        ) {
          identicalAtBoundary.push(`${group}[${previous.merged}]=${group}[${merged}]`);
        }
        for (const field of row.fields) {
          fields.push({ ...field, path: renumber(field.path, group, merged) });
        }
        lastRowOf.set(group, { row, range, merged });
        offsets.set(group, merged + 1);
        keptHere += 1;
      }
      kept.push(`${group} ${rangeLabel(range)}:${keptHere}`);
    }
  }

  return { fields, issues, kept, identicalAtBoundary };
}

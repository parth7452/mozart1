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
 * parts after the first call, 46 pages. The call cap is the looser of the two
 * bounds: at 46 rows a page `MAX_ROWS_PER_GROUP` is reached near page 11, and
 * a paged read that would keep more rows than that is refused outright, as
 * soon as it has read them (`readInPages`), never cut down to the cap.
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
   * Kept — two identical lines are two deductions (ADR 0048) — and named. They
   * are as likely one row read twice under two citations, so a read that has
   * any is not trusted to open cases on its own (`doubtful`).
   */
  readonly identicalAtBoundary: readonly string[];
  /**
   * The first row a part kept whose every value the previous part's last row
   * also prints, and prints more besides: the tail of a row split across the
   * boundary, read again as a row of its own. Kept, named and doubtful.
   */
  readonly fragmentsAtBoundary: readonly string[];
  /**
   * What the join dropped that no kept reading accounts for: a row that starts
   * outside its part where the part that owns that page kept no row printing
   * its values, or a field outside the rows that the part with page 1 did not
   * report. Something printed is then in no reading at all, so a read with any
   * is doubtful — never a quiet loss (ADR 0053 §3).
   */
  readonly unaccounted: readonly string[];
  /** Rows kept per repeating group, after the join. */
  readonly rowCounts: ReadonlyMap<string, number>;
}

/**
 * Whether a join left something only a person can settle: a dropped row or
 * field nothing kept, or a row that may be counted twice at a boundary. A
 * doubtful read is recorded as not validated, so the document is held rather
 * than opening cases for a subset — or a superset — of its lines.
 */
export function doubtful(merge: ChunkMerge): boolean {
  return (
    merge.unaccounted.length > 0 ||
    merge.identicalAtBoundary.length > 0 ||
    merge.fragmentsAtBoundary.length > 0
  );
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

/** A row's values by leaf: `invoice_number=A`. Pages and quotes are not part of it. */
function cells(row: Row, group: string): string[] {
  return row.fields
    .map((f) => `${templatePath(f.path).slice(group.length + 3)}=${f.value.trim()}`)
    .sort();
}

function signature(row: Row, group: string): string {
  return cells(row, group).join('|');
}

/** Whether every value `part` prints, `whole` prints too. */
function printedWithin(part: Row, whole: Row, group: string): boolean {
  const within = new Set(cells(whole, group));
  return cells(part, group).every((cell) => within.has(cell));
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
 * - A drop is accounted for only when the part owning the page it starts on
 *   kept a row printing every value the dropped one does (a header field: when
 *   the part with page 1 reported that path). Anything else is `unaccounted`,
 *   and the read is `doubtful`: a mis-cited row, or one cited by its page within
 *   the part, would otherwise vanish from a read that still validates.
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
  const fragmentsAtBoundary: string[] = [];
  const unaccounted: string[] = [];
  const offsets = new Map<string, number>(groups.map((g) => [g, 0]));
  const lastRowOf = new Map<string, { row: Row; range: PageRange; merged: number }>();
  /** Rows kept, by group and by the part that kept them. */
  const keptRows = new Map<string, { range: PageRange; row: Row }[]>(groups.map((g) => [g, []]));
  /** Dropped rows, checked against the kept ones once every part is in. */
  const droppedRows: { group: string; part: string; starts: number; row: Row }[] = [];
  const headerPaths = new Set<string>();
  const droppedHeader: { path: string; part: string }[] = [];

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
          headerPaths.add(field.path);
        } else {
          issues.push({
            path: field.path,
            problem: `reported by ${part}; only the part with page 1 reports fields outside a repeating group: dropped`,
          });
          droppedHeader.push({ path: field.path, part });
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
          droppedRows.push({ group, part, starts, row });
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
        } else if (
          keptHere === 0 &&
          previous !== undefined &&
          previous.range.first !== range.first &&
          printedWithin(row, previous.row, group)
        ) {
          fragmentsAtBoundary.push(`${group}[${merged}]⊂${group}[${previous.merged}]`);
        }
        keptRows.get(group)?.push({ range, row });
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

  for (const dropped of droppedRows) {
    const owner = (keptRows.get(dropped.group) ?? []).filter(
      (k) => dropped.starts >= k.range.first && dropped.starts <= k.range.last,
    );
    if (!owner.some((k) => printedWithin(dropped.row, k.row, dropped.group))) {
      unaccounted.push(`${dropped.group}[${dropped.row.index}] of ${dropped.part} (page ${dropped.starts})`);
    }
  }
  for (const dropped of droppedHeader) {
    if (!headerPaths.has(dropped.path)) unaccounted.push(`${dropped.path} of ${dropped.part}`);
  }

  const rowCounts = new Map(groups.map((g) => [g, offsets.get(g) as number] as const));
  return { fields, issues, kept, identicalAtBoundary, fragmentsAtBoundary, unaccounted, rowCounts };
}

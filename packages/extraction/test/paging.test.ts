import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import {
  DENSE_PAGED_PAGES,
  DENSE_PAGED_ROWS,
  DENSE_PAGED_SPLIT_ROW,
  densePagedRemittance,
} from '@recouple/fixtures';
import { ClaudeExtractor } from '../src/claude';
import { flattenExtraction } from '../src/flatten';
import { costMicros } from '../src/models';
import {
  PAGING_POLICY,
  chunkInstruction,
  halveRange,
  doubtful,
  mergeChunkFields,
  pageable,
  planPageChunks,
  type ChunkReading,
  type PageRange,
  type PagingPolicy,
} from '../src/paging';
import { describeFields } from '../src/paths';
import { ExtractionError, ModelRefusalError, type DocumentPayload } from '../src/ports';
import { RemittanceAdviceSchema } from '../src/schemas';
import { verifyQuotes } from '../src/verify';
import { MAX_ROWS_PER_GROUP, reassemble, type WireField } from '../src/wire';

/**
 * Paged extraction (ADR 0053), with no API: the reader's client is a stub that
 * answers each call from the fixture's expected extraction, so what is tested is
 * the planning, the join and the bookkeeping — not a model.
 */

const descriptors = describeFields(RemittanceAdviceSchema);

const field = (path: string, value: string, page: number, quote = value): WireField => ({
  path,
  value,
  confidence: 0.97,
  source_page: page,
  source_quote: quote,
});

describe('planning the parts', () => {
  it('cuts the pages into two-page ranges, in order', () => {
    expect(planPageChunks(5, 2)).toEqual([
      { first: 1, last: 2 },
      { first: 3, last: 4 },
      { first: 5, last: 5 },
    ]);
    expect(planPageChunks(1, 2)).toEqual([{ first: 1, last: 1 }]);
  });

  it('covers every page exactly once, whatever the count', () => {
    for (let pages = 1; pages <= 100; pages++) {
      for (const size of [1, 2, 3, 4]) {
        const covered = planPageChunks(pages, size).flatMap((r) =>
          Array.from({ length: r.last - r.first + 1 }, (_, i) => r.first + i),
        );
        expect(covered).toEqual(Array.from({ length: pages }, (_, i) => i + 1));
      }
    }
  });

  it('refuses a plan it cannot make', () => {
    expect(() => planPageChunks(0, 2)).toThrow(RangeError);
    expect(() => planPageChunks(3, 0)).toThrow(RangeError);
  });

  it('halves a range, and cannot halve one page', () => {
    expect(halveRange({ first: 3, last: 4 })).toEqual([
      { first: 3, last: 3 },
      { first: 4, last: 4 },
    ]);
    expect(halveRange({ first: 1, last: 5 })).toEqual([
      { first: 1, last: 3 },
      { first: 4, last: 5 },
    ]);
    expect(halveRange({ first: 5, last: 5 })).toBeUndefined();
  });

  it('keeps a 100-page document inside the call cap only where the row cap would', () => {
    // 1 cut-off call + 50 parts: over the cap, refused before any part is asked.
    expect(1 + planPageChunks(100, PAGING_POLICY.pagesPerChunk).length).toBeGreaterThan(
      PAGING_POLICY.maxCalls,
    );
    // 46 pages fit: at 46 rows a page that is already past the 500-row cap.
    expect(1 + planPageChunks(46, PAGING_POLICY.pagesPerChunk).length).toBeLessThanOrEqual(
      PAGING_POLICY.maxCalls,
    );
    expect(46 * 46).toBeGreaterThan(MAX_ROWS_PER_GROUP);
  });

  it('pages only a PDF of two or more pages whose type has rows', () => {
    const pdf = { mimeType: 'application/pdf', pageText: ['one', 'two'] };
    expect(pageable(pdf, descriptors)).toBe(true);
    expect(pageable({ ...pdf, pageText: ['one'] }, descriptors)).toBe(false);
    expect(pageable({ mimeType: 'application/pdf' }, descriptors)).toBe(false);
    expect(pageable({ ...pdf, mimeType: 'image/jpeg' }, descriptors)).toBe(false);
    expect(pageable({ ...pdf, mimeType: 'text/plain' }, descriptors)).toBe(false);
    expect(pageable(pdf, descriptors.filter((d) => d.group === undefined))).toBe(false);
  });

  it('tells the part with page 1, and only that part, to report the header', () => {
    const one = chunkInstruction({ range: { first: 1, last: 2 }, pageCount: 5, groups: ['lines'] });
    const later = chunkInstruction({ range: { first: 3, last: 4 }, pageCount: 5, groups: ['lines'] });
    expect(one).toContain('pages 1 to 2');
    expect(one).toMatch(/every field outside the repeating groups/);
    expect(later).toContain('pages 3 to 4');
    expect(later).toMatch(/Do not report any field outside the repeating groups/);
    for (const text of [one, later]) {
      expect(text).toContain('whose first line is printed on');
      expect(text).toContain('lines[0]');
      expect(text).toMatch(/own page numbers \(1 to 5\)/);
    }
  });
});

describe('joining the parts', () => {
  const header = [
    field('payer_name', 'Lakeshore', 1),
    field('payment_reference', 'ACH-1', 1),
    field('payment_date', '09/28/2026', 1),
    field('payment_total', '$10.00', 5),
  ];
  const row = (index: number, invoice: string, page: number, net = '$1.00'): WireField[] => [
    field(`lines[${index}].invoice_number`, invoice, page),
    field(`lines[${index}].net_amount`, net, page),
  ];

  it('renumbers each part’s rows after the rows before it, in page order', () => {
    const parts: ChunkReading[] = [
      // Given out of order: the join sorts by first page.
      { range: { first: 3, last: 4 }, fields: [...row(0, 'C', 3), ...row(1, 'D', 4)] },
      { range: { first: 1, last: 2 }, fields: [...header, ...row(0, 'A', 1), ...row(1, 'B', 2)] },
      { range: { first: 5, last: 5 }, fields: row(0, 'E', 5) },
    ];
    const merged = mergeChunkFields(parts, descriptors);
    const invoices = merged.fields
      .filter((f) => f.path.endsWith('.invoice_number'))
      .map((f) => `${f.path}=${f.value}`);
    expect(invoices).toEqual([
      'lines[0].invoice_number=A',
      'lines[1].invoice_number=B',
      'lines[2].invoice_number=C',
      'lines[3].invoice_number=D',
      'lines[4].invoice_number=E',
    ]);
    expect(merged.issues).toEqual([]);
    expect(merged.kept).toEqual(['lines 1-2:2', 'lines 3-4:2', 'lines 5:1']);
    expect(merged.rowCounts.get('lines')).toBe(5);
    expect(doubtful(merged)).toBe(false);
    const rebuilt = reassemble(merged.fields, descriptors, RemittanceAdviceSchema);
    expect(rebuilt.validated).toBe(true);
    expect((rebuilt.document as { lines: unknown[] }).lines).toHaveLength(5);
  });

  it('takes header fields from the part with page 1 only, and names what it drops', () => {
    const merged = mergeChunkFields(
      [
        { range: { first: 1, last: 2 }, fields: [...header, ...row(0, 'A', 1)] },
        {
          range: { first: 3, last: 4 },
          fields: [field('payment_total', '$99.00', 4), ...row(0, 'C', 3)],
        },
      ],
      descriptors,
    );
    expect(merged.fields.filter((f) => f.path === 'payment_total').map((f) => f.value)).toEqual([
      '$10.00',
    ]);
    expect(merged.issues).toEqual([
      {
        path: 'payment_total',
        problem:
          'reported by part 3-4; only the part with page 1 reports fields outside a repeating group: dropped',
      },
    ]);
    // The part with page 1 reported the total, so nothing printed was lost.
    expect(merged.unaccounted).toEqual([]);
    expect(doubtful(merged)).toBe(false);
  });

  it('holds a field outside the rows that only a later part reported', () => {
    const merged = mergeChunkFields(
      [
        {
          range: { first: 1, last: 2 },
          fields: [...header.filter((f) => f.path !== 'payment_total'), ...row(0, 'A', 1)],
        },
        { range: { first: 3, last: 4 }, fields: [field('payment_total', '$10.00', 4), ...row(0, 'C', 3)] },
      ],
      descriptors,
    );
    expect(merged.unaccounted).toEqual(['payment_total of part 3-4']);
    expect(doubtful(merged)).toBe(true);
  });

  it('counts a row both parts read once: the part it starts in keeps it', () => {
    const merged = mergeChunkFields(
      [
        // The first part reads on into page 3's first row.
        { range: { first: 1, last: 2 }, fields: [...header, ...row(0, 'A', 2), ...row(1, 'C', 3)] },
        // The second part reads back into page 2's last row.
        { range: { first: 3, last: 4 }, fields: [...row(0, 'A', 2), ...row(1, 'C', 3)] },
      ],
      descriptors,
    );
    const invoices = merged.fields
      .filter((f) => f.path.endsWith('.invoice_number'))
      .map((f) => `${f.path}=${f.value}`);
    expect(invoices).toEqual(['lines[0].invoice_number=A', 'lines[1].invoice_number=C']);
    expect(merged.issues).toEqual([
      {
        path: 'lines[1]',
        problem: 'part 1-2 reported a row that starts on page 3, outside its pages: dropped',
      },
      {
        path: 'lines[0]',
        problem: 'part 3-4 reported a row that starts on page 2, outside its pages: dropped',
      },
    ]);
    // Each dropped reading is the row its own part kept: nothing is lost.
    expect(merged.unaccounted).toEqual([]);
    expect(doubtful(merged)).toBe(false);
  });

  it('holds a row that starts on an earlier page when the earlier part never read it', () => {
    // Review, case A: B starts on page 2, part 1-2 misses it, part 3-4 reads it.
    const merged = mergeChunkFields(
      [
        { range: { first: 1, last: 2 }, fields: [...header, ...row(0, 'A', 1)] },
        { range: { first: 3, last: 4 }, fields: [...row(0, 'B', 2, '$2.00'), ...row(1, 'C', 3)] },
      ],
      descriptors,
    );
    expect(merged.unaccounted).toEqual(['lines[0] of part 3-4 (page 2)']);
    expect(doubtful(merged)).toBe(true);
  });

  it('holds rows a later part cited by their page within the part', () => {
    // Review, case C: part 3-4 cites pages 1 and 2, which is what its
    // instruction tells it not to do. Both rows would vanish from a read that
    // still validates.
    const merged = mergeChunkFields(
      [
        { range: { first: 1, last: 2 }, fields: [...header, ...row(0, 'A', 1)] },
        { range: { first: 3, last: 4 }, fields: [...row(0, 'C', 1), ...row(1, 'D', 2)] },
      ],
      descriptors,
    );
    expect(merged.unaccounted).toEqual(['lines[0] of part 3-4 (page 1)', 'lines[1] of part 3-4 (page 2)']);
    expect(doubtful(merged)).toBe(true);
    const rebuilt = reassemble(merged.fields, descriptors, RemittanceAdviceSchema);
    // What makes the doubt necessary: the schema alone would pass it.
    expect(rebuilt.validated).toBe(true);
  });

  it('holds a later row with one field cited a page early, which neither part keeps', () => {
    const early = [
      // The invoice number is cited to page 2 (a label printed above the
      // boundary); the rest of the row is on page 3.
      field('lines[0].invoice_number', 'C', 2),
      field('lines[0].net_amount', '$1.00', 3),
    ];
    const merged = mergeChunkFields(
      [
        { range: { first: 1, last: 2 }, fields: [...header, ...row(0, 'A', 1)] },
        { range: { first: 3, last: 4 }, fields: [...early, ...row(1, 'D', 4)] },
      ],
      descriptors,
    );
    expect(merged.unaccounted).toEqual(['lines[0] of part 3-4 (page 2)']);
    expect(doubtful(merged)).toBe(true);
  });

  it('holds the tail of a split row read again as a row of its own', () => {
    // Review, case B: part 1-2 reads B whole; part 3-4 reports only its
    // wrapped page-3 cell.
    const merged = mergeChunkFields(
      [
        {
          range: { first: 1, last: 2 },
          fields: [
            ...header,
            field('lines[0].invoice_number', 'B', 2),
            field('lines[0].deduction_amount', '$1.00', 3),
          ],
        },
        {
          range: { first: 3, last: 4 },
          fields: [field('lines[0].deduction_amount', '$1.00', 3), ...row(1, 'C', 3)],
        },
      ],
      descriptors,
    );
    expect(merged.fragmentsAtBoundary).toEqual(['lines[1]⊂lines[0]']);
    expect(doubtful(merged)).toBe(true);
  });

  it('keeps a row split across the boundary whole, in the part it starts in', () => {
    const split = [
      field('lines[1].invoice_number', 'B', 2),
      field('lines[1].gross_amount', '$5.00', 2),
      // Its last cell wrapped onto the next page.
      field('lines[1].net_amount', '$4.00', 3),
    ];
    const merged = mergeChunkFields(
      [
        { range: { first: 1, last: 2 }, fields: [...header, ...row(0, 'A', 1), ...split] },
        { range: { first: 3, last: 4 }, fields: row(0, 'C', 3) },
      ],
      descriptors,
    );
    expect(merged.issues).toEqual([]);
    expect(merged.fields.filter((f) => f.path.startsWith('lines[1].')).map((f) => f.value)).toEqual([
      'B',
      '$5.00',
      '$4.00',
    ]);
    expect(merged.fields.find((f) => f.path === 'lines[2].invoice_number')?.value).toBe('C');
  });

  it('closes a gap in a part’s numbering rather than filling it', () => {
    const merged = mergeChunkFields(
      [{ range: { first: 1, last: 2 }, fields: [...header, ...row(0, 'A', 1), ...row(7, 'B', 2)] }],
      descriptors,
    );
    expect(merged.fields.find((f) => f.path === 'lines[1].invoice_number')?.value).toBe('B');
    const rebuilt = reassemble(merged.fields, descriptors, RemittanceAdviceSchema);
    expect((rebuilt.document as { lines: unknown[] }).lines).toHaveLength(2);
  });

  it('keeps two identical rows either side of a boundary, and names them', () => {
    const merged = mergeChunkFields(
      [
        { range: { first: 1, last: 2 }, fields: [...header, ...row(0, 'A', 2, '$3.00')] },
        { range: { first: 3, last: 4 }, fields: row(0, 'A', 3, '$3.00') },
      ],
      descriptors,
    );
    expect(merged.fields.filter((f) => f.path.endsWith('.invoice_number'))).toHaveLength(2);
    expect(merged.identicalAtBoundary).toEqual(['lines[0]=lines[1]']);
    // Two deductions, or one read twice under two citations: a person says.
    expect(doubtful(merged)).toBe(true);
  });

  it('refuses parts that overlap: that is a planning error', () => {
    expect(() =>
      mergeChunkFields(
        [
          { range: { first: 1, last: 2 }, fields: [] },
          { range: { first: 2, last: 3 }, fields: [] },
        ],
        descriptors,
      ),
    ).toThrow(/overlap/);
  });

  it('leaves the row cap to reassemble, which drops past it out loud', () => {
    const many = (first: number, count: number): WireField[] =>
      Array.from({ length: count }, (_, i) => row(i, `R${first + i}`, first === 0 ? 1 : 3)).flat();
    const merged = mergeChunkFields(
      [
        { range: { first: 1, last: 2 }, fields: [...header, ...many(0, 300)] },
        { range: { first: 3, last: 4 }, fields: many(300, 250) },
      ],
      descriptors,
    );
    const rebuilt = reassemble(merged.fields, descriptors, RemittanceAdviceSchema);
    expect((rebuilt.document as { lines: unknown[] }).lines).toHaveLength(MAX_ROWS_PER_GROUP);
    expect(rebuilt.issues.some((i) => /past the 500-row cap/.test(i.problem))).toBe(true);
    // Which is why the extractor asks the count first and refuses the read.
    expect(merged.rowCounts.get('lines')).toBe(550);
  });
});

// ─── The extractor, over a stub client ───────────────────────────────────────

interface StubReply {
  readonly stop_reason: 'end_turn' | 'max_tokens' | 'refusal';
  readonly fields?: readonly WireField[];
  readonly usage?: Record<string, number>;
  /** Finished, spent its tokens, and would not parse. */
  readonly unparseable?: true;
}

/**
 * Every request the extractor made, and a client that answers from `reply` the
 * way the SDK's `MessageStream` does: each stream event hands its listeners the
 * message snapshot, and `finalMessage` parses the structured output, so a reply
 * that stopped short of its JSON (cut off, or refused) throws "Failed to parse
 * structured output" there, as the real one did on the first recording.
 * `sdkResolvesCutOff` is the other shape: a message with no parsed output.
 */
function stubClient(
  reply: (params: Record<string, unknown>, call: number) => StubReply | Error,
  options: { readonly sdkResolvesCutOff?: boolean } = {},
) {
  const requests: Record<string, unknown>[] = [];
  const client = {
    messages: {
      stream(params: Record<string, unknown>) {
        requests.push(params);
        const answer = reply(params, requests.length);
        const listeners: ((event: unknown, snapshot: unknown) => void)[] = [];
        return {
          on(name: string, listener: (event: unknown, snapshot: unknown) => void) {
            if (name === 'streamEvent') listeners.push(listener);
            return this;
          },
          finalMessage: async () => {
            if (answer instanceof Error) throw answer;
            const snapshot = {
              stop_reason: answer.stop_reason,
              stop_details: null,
              usage: answer.usage ?? { input_tokens: 1_000, output_tokens: 2_000 },
            };
            for (const listener of listeners) listener({ type: 'message_delta' }, snapshot);
            if (answer.unparseable === true) {
              throw new Error('Failed to parse structured output: bad JSON');
            }
            if (answer.stop_reason === 'end_turn') {
              return { ...snapshot, parsed_output: { fields: answer.fields ?? [] } };
            }
            if (options.sdkResolvesCutOff === true) return { ...snapshot, parsed_output: null };
            throw new Error(
              'Failed to parse structured output: Error: Failed to parse structured output as JSON: ' +
                'Unterminated string in JSON at position 48026',
            );
          },
        };
      },
    },
  };
  return { client: client as unknown as Anthropic, requests };
}

const fixture = densePagedRemittance();

function payload(overrides: Partial<DocumentPayload> = {}): DocumentPayload {
  return {
    documentId: 'doc-paged',
    orgId: 'org',
    filename: fixture.document.filename,
    mimeType: 'application/pdf',
    base64: 'JVBERi0=',
    byteSize: 5,
    pageText: fixture.document.pageText,
    ...overrides,
  };
}

/** The fixture's expected extraction as wire fields, one row numbering per part. */
interface ExpectedField {
  readonly value: unknown;
  readonly source_page: number;
  readonly source_quote: string;
}
const expected = fixture.expected as { readonly lines: readonly Record<string, ExpectedField>[] };
/** Every expected field outside the rows. */
const expectedHeader = Object.entries(fixture.expected as Record<string, unknown>).filter(
  (entry): entry is [string, ExpectedField] => entry[0] !== 'lines',
);

function wireOf(path: string, f: ExpectedField) {
  return field(path, String(f.value), f.source_page, f.source_quote);
}

/** What a perfect reader answers for pages `range`, rows numbered from 0. */
function perfectPart(range: PageRange, extra: { before?: number[]; after?: number[] } = {}) {
  const fields: WireField[] = [];
  if (range.first === 1) {
    for (const [key, f] of expectedHeader) {
      if (f.value !== null) fields.push(wireOf(key, f));
    }
  }
  const indices = [
    ...(extra.before ?? []),
    ...fixture.rowPages.flatMap((page, index) =>
      page >= range.first && page <= range.last ? [index] : [],
    ),
    ...(extra.after ?? []),
  ];
  indices.forEach((index, local) => {
    for (const [leaf, f] of Object.entries(expected.lines[index] ?? {})) {
      if (f.value !== null) fields.push(wireOf(`lines[${local}].${leaf}`, f));
    }
  });
  return fields;
}

/** The part a request asks for, read back off its range block. */
function rangeAsked(params: Record<string, unknown>): PageRange | undefined {
  const messages = params.messages as { content: { type: string; text?: string }[] }[];
  const last = messages[0]?.content.at(-1)?.text ?? '';
  const match = /This part is pages? (\d+)(?: to (\d+))?\./.exec(last);
  if (match === null) return undefined;
  const first = Number(match[1]);
  return { first, last: match[2] === undefined ? first : Number(match[2]) };
}

function withoutTextLayer(): DocumentPayload {
  const { pageText: _, ...rest } = payload();
  return rest;
}

const cutOff: StubReply = {
  stop_reason: 'max_tokens',
  usage: { input_tokens: 9_000, output_tokens: 32_000 },
};

/** A reader whose first call runs out and whose parts answer perfectly. */
function pagedReader(
  part: (range: PageRange) => StubReply | Error = (range) => ({
    stop_reason: 'end_turn',
    fields: perfectPart(range),
    usage: { input_tokens: 300, output_tokens: 20_000, cache_read_input_tokens: 8_000, cache_creation_input_tokens: 700 },
  }),
  paging?: Partial<PagingPolicy>,
) {
  const stub = stubClient((params, call) => {
    if (call === 1) return cutOff;
    const range = rangeAsked(params);
    if (range === undefined) throw new Error('a part was asked with no range');
    return part(range);
  });
  const extractor = new ClaudeExtractor({
    client: stub.client,
    model: 'claude-sonnet-5',
    paging: paging ?? true,
  });
  return { extractor, requests: stub.requests };
}

describe('the fixture a paged read is measured on', () => {
  it('is five pages of 190 rows, with one invoice either side of the page 2 / 3 boundary', () => {
    expect(fixture.document.pageText).toHaveLength(DENSE_PAGED_PAGES);
    expect(fixture.rowPages).toHaveLength(DENSE_PAGED_ROWS);
    expect(fixture.rowPages[DENSE_PAGED_SPLIT_ROW - 1]).toBe(2);
    expect(fixture.rowPages[DENSE_PAGED_SPLIT_ROW]).toBe(3);
    const invoice = (i: number) => fixture.document.truth[`lines[${i}].invoice_number`];
    expect(invoice(DENSE_PAGED_SPLIT_ROW - 1)).toEqual(invoice(DENSE_PAGED_SPLIT_ROW));
  });

  it('has an expected extraction that satisfies its schema and quotes only its own pages', () => {
    expect(RemittanceAdviceSchema.safeParse(fixture.expected).success).toBe(true);
    const fields = verifyQuotes(flattenExtraction(fixture.expected), fixture.document.pageText);
    expect(fields.filter((f) => f.quoteVerified !== true).map((f) => f.fieldPath)).toEqual([]);
  });

  it('asserts nothing its expected extraction does not carry', () => {
    const values = new Map(
      flattenExtraction(fixture.expected).map((f) => [f.fieldPath, String(f.value)] as const),
    );
    for (const path of Object.keys(fixture.document.truth)) {
      expect(values.has(path), path).toBe(true);
    }
  });

  it('is too long for one reply: 190 rows at about 250 tokens a row', () => {
    expect(DENSE_PAGED_ROWS * 250).toBeGreaterThan(32_000);
  });
});

describe('ClaudeExtractor with paging', () => {
  it('makes exactly one request when the first call finishes, with no tools and no cache marker', async () => {
    const stub = stubClient(() => ({ stop_reason: 'end_turn', fields: perfectPart({ first: 1, last: 5 }) }));
    const extractor = new ClaudeExtractor({ client: stub.client, model: 'claude-sonnet-5' });
    const result = await extractor.extract(payload(), 'remittance_advice');
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]).not.toHaveProperty('tools');
    expect(JSON.stringify(stub.requests[0])).not.toContain('cache_control');
    expect(JSON.stringify(stub.requests[0])).not.toContain('PAGED READ');
    expect(result.call.detail).toBeUndefined();
    expect(result.call.costMicros).toBe(costMicros('claude-sonnet-5', { inputTokens: 1_000, outputTokens: 2_000 }));
  });

  it.each([
    ['a one-page PDF', payload({ pageText: [fixture.document.pageText[0] as string] })],
    ['a PDF with no text layer', withoutTextLayer()],
    ['an image', payload({ mimeType: 'image/jpeg' })],
  ])('fails %s that runs out exactly as before', async (_, document) => {
    const stub = stubClient(() => cutOff);
    const extractor = new ClaudeExtractor({ client: stub.client, model: 'claude-sonnet-5', paging: true });
    const error = await extractor.extract(document, 'remittance_advice').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExtractionError);
    expect((error as ExtractionError).message).toBe(
      'the extraction was cut off at 32000 output tokens: split the document and retry',
    );
    expect((error as ExtractionError).call).toMatchObject({
      outcome: 'schema_mismatch',
      detail: 'stop_reason=max_tokens',
      outputTokens: 32_000,
    });
    expect(stub.requests).toHaveLength(1);
  });

  it('does not page unless asked to: a reader built with no paging fails a cut-off loudly', async () => {
    const stub = stubClient(() => cutOff);
    const extractor = new ClaudeExtractor({ client: stub.client, model: 'claude-sonnet-5' });
    expect(extractor.pagesWhenCutOff).toBe(false);
    expect(new ClaudeExtractor({ client: stub.client, paging: true }).pagesWhenCutOff).toBe(true);
    const error = await extractor.extract(payload(), 'remittance_advice').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExtractionError);
    expect((error as ExtractionError).call).toMatchObject({
      outcome: 'schema_mismatch',
      detail: 'stop_reason=max_tokens',
      costMicros: costMicros('claude-sonnet-5', { inputTokens: 9_000, outputTokens: 32_000 }),
    });
    expect(stub.requests).toHaveLength(1);
  });

  it('fails as before when paging is turned off', async () => {
    const stub = stubClient(() => cutOff);
    const extractor = new ClaudeExtractor({ client: stub.client, model: 'claude-sonnet-5', paging: false });
    await expect(extractor.extract(payload(), 'remittance_advice')).rejects.toThrow(
      /split the document and retry/,
    );
    expect(stub.requests).toHaveLength(1);
  });

  it('reads the cut-off from the stream when the SDK cannot parse the reply, and records its cost', async () => {
    // The shape the first recording met: before this, the SDK's parse error
    // was the read's error, with no stop_reason and no cost recorded.
    const stub = stubClient(() => cutOff);
    const extractor = new ClaudeExtractor({ client: stub.client, model: 'claude-sonnet-5', paging: false });
    const error = await extractor.extract(payload(), 'remittance_advice').catch((e: unknown) => e);
    expect((error as ExtractionError).call).toMatchObject({
      outcome: 'schema_mismatch',
      detail: 'stop_reason=max_tokens',
      costMicros: costMicros('claude-sonnet-5', { inputTokens: 9_000, outputTokens: 32_000 }),
    });
  });

  it('pages a cut-off the SDK resolves with no parsed output, too', async () => {
    const stub = stubClient(
      (params, call) =>
        call === 1
          ? cutOff
          : { stop_reason: 'end_turn', fields: perfectPart(rangeAsked(params) as PageRange) },
      { sdkResolvesCutOff: true },
    );
    const extractor = new ClaudeExtractor({ client: stub.client, model: 'claude-sonnet-5', paging: true });
    const result = await extractor.extract(payload(), 'remittance_advice');
    expect(result.validated).toBe(true);
    expect(stub.requests).toHaveLength(4);
  });

  it('reports a refused first read as a refusal, not a parse error', async () => {
    const stub = stubClient(() => ({ stop_reason: 'refusal' }));
    const extractor = new ClaudeExtractor({ client: stub.client, model: 'claude-sonnet-5' });
    await expect(extractor.extract(payload(), 'remittance_advice')).rejects.toBeInstanceOf(
      ModelRefusalError,
    );
    expect(stub.requests).toHaveLength(1);
  });

  it('still throws a reply that finished and would not parse, as an error', async () => {
    const client = {
      messages: {
        stream() {
          const listeners: ((event: unknown, snapshot: unknown) => void)[] = [];
          return {
            on(_: string, listener: (event: unknown, snapshot: unknown) => void) {
              listeners.push(listener);
              return this;
            },
            finalMessage: async () => {
              for (const l of listeners) l({}, { stop_reason: 'end_turn', usage: {} });
              throw new Error('Failed to parse structured output: bad JSON');
            },
          };
        },
      },
    } as unknown as Anthropic;
    const extractor = new ClaudeExtractor({ client, model: 'claude-sonnet-5' });
    const error = await extractor.extract(payload(), 'remittance_advice').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExtractionError);
    expect((error as ExtractionError).call.outcome).toBe('error');
    expect((error as Error).message).toMatch(/Failed to parse structured output/);
  });

  it('records what a reply that finished and would not parse had spent', async () => {
    const stub = stubClient(() => ({
      stop_reason: 'end_turn',
      unparseable: true,
      usage: { input_tokens: 4_000, output_tokens: 7_000 },
    }));
    const extractor = new ClaudeExtractor({ client: stub.client, model: 'claude-sonnet-5' });
    const error = await extractor.extract(payload(), 'remittance_advice').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExtractionError);
    expect((error as Error).message).toBe(
      'extraction failed: Failed to parse structured output: bad JSON',
    );
    expect((error as ExtractionError).call).toMatchObject({
      outcome: 'error',
      inputTokens: 4_000,
      outputTokens: 7_000,
      costMicros: costMicros('claude-sonnet-5', { inputTokens: 4_000, outputTokens: 7_000 }),
    });
  });

  it('reads a document that ran out in two-page parts, and joins every row in page order', async () => {
    const { extractor, requests } = pagedReader();
    const result = await extractor.extract(payload(), 'remittance_advice');

    expect(requests.map(rangeAsked)).toEqual([
      undefined,
      { first: 1, last: 2 },
      { first: 3, last: 4 },
      { first: 5, last: 5 },
    ]);
    expect(result.validated).toBe(true);
    expect(result.document).toEqual(
      reassemble(
        flattenExpectedAsWire(),
        descriptors,
        RemittanceAdviceSchema,
      ).document,
    );
    const lines = (result.document as { lines: { invoice_number: { value: string } }[] }).lines;
    expect(lines).toHaveLength(DENSE_PAGED_ROWS);
    // ADR 0048's occurrence numbering counts in this order.
    expect(lines[DENSE_PAGED_SPLIT_ROW - 1]?.invoice_number.value).toBe(
      lines[DENSE_PAGED_SPLIT_ROW]?.invoice_number.value,
    );
    expect(
      (result.document as { lines: { reason_code: { value: string } }[] }).lines
        .slice(DENSE_PAGED_SPLIT_ROW - 1, DENSE_PAGED_SPLIT_ROW + 1)
        .map((l) => l.reason_code.value),
    ).toEqual(['SHORT', 'PRICE']);
    expect(result.fields.filter((f) => f.quoteVerified !== true)).toEqual([]);
  });

  it('never gives a part tools, and marks the shared blocks for the cache', async () => {
    const { extractor, requests } = pagedReader();
    await extractor.extract(payload(), 'remittance_advice');
    for (const request of requests) {
      expect(request).not.toHaveProperty('tools');
      expect(request).not.toHaveProperty('tool_choice');
    }
    const first = requests[0] as { messages: { content: Record<string, unknown>[] }[] };
    for (const request of requests.slice(1)) {
      const content = (request as { messages: { content: Record<string, unknown>[] }[] }).messages[0]
        ?.content as Record<string, unknown>[];
      const shared = first.messages[0]?.content as Record<string, unknown>[];
      // The first call's blocks, the last of them marked, then the range.
      expect(content).toHaveLength(shared.length + 1);
      content.slice(0, shared.length - 1).forEach((block, i) => expect(block).toEqual(shared[i]));
      expect(content[shared.length - 1]).toEqual({
        ...shared[shared.length - 1],
        cache_control: { type: 'ephemeral' },
      });
      expect(String(content.at(-1)?.text)).toMatch(/^PAGED READ\./);
      // The document stays inside its delimiters in every part.
      expect(JSON.stringify(content)).toContain('untrusted_document');
      expect(request.max_tokens).toBe(32_000);
    }
  });

  it('sums every call into one record whose detail names ranges, never page text', async () => {
    const { extractor } = pagedReader();
    const result = await extractor.extract(payload(), 'remittance_advice');
    const partUsage = { inputTokens: 300 + 8_000 + 700, outputTokens: 20_000, cachedTokens: 8_000 };
    const partCost = costMicros('claude-sonnet-5', { ...partUsage, cacheWriteTokens: 700 });
    const firstCost = costMicros('claude-sonnet-5', { inputTokens: 9_000, outputTokens: 32_000 });
    expect(result.call).toMatchObject({
      purpose: 'extract',
      outcome: 'ok',
      inputTokens: 9_000 + 3 * partUsage.inputTokens,
      outputTokens: 32_000 + 3 * 20_000,
      cachedTokens: 3 * 8_000,
      costMicros: firstCost + 3 * partCost,
    });
    expect(result.call.detail).toBe(
      'paged after stop_reason=max_tokens at 32000 output tokens: 4 calls, pages 1-2,3-4,5; ' +
        'rows kept lines 1-2:76, lines 3-4:84, lines 5:30',
    );
    expect(result.call.detail).not.toMatch(/INV-|\$|LAKESHORE/i);
  });

  it('prices cache writes above plain input and cache reads below it', () => {
    const plain = costMicros('claude-sonnet-5', { inputTokens: 1_000, outputTokens: 0 });
    expect(costMicros('claude-sonnet-5', { inputTokens: 1_000, outputTokens: 0, cacheWriteTokens: 1_000 })).toBe(
      plain * 1.25,
    );
    expect(costMicros('claude-sonnet-5', { inputTokens: 1_000, outputTokens: 0, cachedTokens: 1_000 })).toBe(
      plain / 10,
    );
  });

  it('counts a row both parts read once', async () => {
    const lastOfPage2 = DENSE_PAGED_SPLIT_ROW - 1;
    const firstOfPage3 = DENSE_PAGED_SPLIT_ROW;
    const { extractor } = pagedReader((range) => ({
      stop_reason: 'end_turn',
      fields:
        range.first === 1
          ? perfectPart(range, { after: [firstOfPage3] })
          : range.first === 3
            ? perfectPart(range, { before: [lastOfPage2] })
            : perfectPart(range),
    }));
    const result = await extractor.extract(payload(), 'remittance_advice');
    expect(result.validated).toBe(true);
    expect((result.document as { lines: unknown[] }).lines).toHaveLength(DENSE_PAGED_ROWS);
    expect(result.document).toEqual(
      reassemble(flattenExpectedAsWire(), descriptors, RemittanceAdviceSchema).document,
    );
    expect(result.call.outcome).toBe('ok');
    expect(result.call.detail).toContain('merge dropped 2: lines[76], lines[0]');
    expect(result.call.detail).not.toContain('held');
  });

  it('halves a part that runs out and asks both halves', async () => {
    const { extractor, requests } = pagedReader((range) =>
      range.first === 3 && range.last === 4
        ? cutOff
        : { stop_reason: 'end_turn', fields: perfectPart(range) },
    );
    const result = await extractor.extract(payload(), 'remittance_advice');
    expect(requests.map(rangeAsked).slice(1)).toEqual([
      { first: 1, last: 2 },
      { first: 3, last: 4 },
      { first: 5, last: 5 },
      { first: 3, last: 3 },
      { first: 4, last: 4 },
    ]);
    expect(result.validated).toBe(true);
    expect((result.document as { lines: unknown[] }).lines).toHaveLength(DENSE_PAGED_ROWS);
    expect(result.call.detail).toContain('6 calls, pages 1-2,3-4,5,3,4; halved 3-4→3+4');
  });

  it('fails loudly when one page alone runs out, recording what was spent', async () => {
    const { extractor } = pagedReader((range) =>
      range.first === 5 ? cutOff : { stop_reason: 'end_turn', fields: perfectPart(range) },
    );
    const error = await extractor.extract(payload(), 'remittance_advice').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExtractionError);
    expect((error as Error).message).toBe(
      'page 5 alone was cut off at 32000 output tokens: split the document and retry',
    );
    const call = (error as ExtractionError).call;
    expect(call.outcome).toBe('schema_mismatch');
    expect(call.outputTokens).toBe(32_000 + 2_000 + 2_000 + 32_000);
    expect(call.costMicros).toBeGreaterThan(0);
    expect(call.detail).toContain('stop_reason=max_tokens on page 5 alone');
  });

  it('refuses a plan past the call cap before asking any part', async () => {
    const { extractor, requests } = pagedReader(undefined, { maxCalls: 3 });
    const error = await extractor.extract(payload(), 'remittance_advice').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExtractionError);
    expect((error as Error).message).toMatch(/would need more than 3 calls/);
    expect(requests).toHaveLength(1);
    expect((error as ExtractionError).call.outputTokens).toBe(32_000);
  });

  it('counts halvings against the cap', async () => {
    const { extractor, requests } = pagedReader(
      (range) =>
        range.first === 3 && range.last === 4
          ? cutOff
          : { stop_reason: 'end_turn', fields: perfectPart(range) },
      { maxCalls: 5 },
    );
    await expect(extractor.extract(payload(), 'remittance_advice')).rejects.toThrow(
      /more than 5 calls/,
    );
    expect(requests).toHaveLength(4);
  });

  it('stops at the first batch with a failed part and records its cost', async () => {
    const { extractor, requests } = pagedReader(
      (range) =>
        range.first === 1 ? new Error('connection reset') : { stop_reason: 'end_turn', fields: perfectPart(range) },
      { concurrency: 1 },
    );
    const error = await extractor.extract(payload(), 'remittance_advice').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExtractionError);
    expect((error as Error).message).toBe('extraction failed on pages 1-2: connection reset');
    expect(requests).toHaveLength(2);
    expect((error as ExtractionError).call.costMicros).toBe(
      costMicros('claude-sonnet-5', { inputTokens: 9_000, outputTokens: 32_000 }),
    );
  });

  it('adds what a part that would not parse had spent to the failed read', async () => {
    const partUsage = { input_tokens: 500, output_tokens: 6_000 };
    const { extractor } = pagedReader(
      (range) =>
        range.first === 1
          ? { stop_reason: 'end_turn', unparseable: true, usage: partUsage }
          : { stop_reason: 'end_turn', fields: perfectPart(range) },
      { concurrency: 1 },
    );
    const error = await extractor.extract(payload(), 'remittance_advice').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExtractionError);
    expect((error as Error).message).toBe(
      'extraction failed on pages 1-2: Failed to parse structured output: bad JSON',
    );
    expect((error as ExtractionError).call).toMatchObject({
      outcome: 'error',
      inputTokens: 9_000 + 500,
      outputTokens: 32_000 + 6_000,
      costMicros:
        costMicros('claude-sonnet-5', { inputTokens: 9_000, outputTokens: 32_000 }) +
        costMicros('claude-sonnet-5', { inputTokens: 500, outputTokens: 6_000 }),
    });
  });

  it('refuses a read whose parts pass the row cap, and stops asking once they do', async () => {
    // Twelve pages of 46 rows each: 552 rows, past MAX_ROWS_PER_GROUP.
    const pages = Array.from({ length: 12 }, (_, i) => `page ${i + 1}`);
    const rowsOf = (range: PageRange): WireField[] => {
      const out: WireField[] = range.first === 1 ? [field('payer_name', 'Lakeshore', 1), field('payment_reference', 'ACH-1', 1), field('payment_date', '09/28/2026', 1), field('payment_total', '$1.00', 1)] : [];
      let local = 0;
      for (let page = range.first; page <= range.last; page++) {
        for (let r = 0; r < 46; r++) {
          out.push(field(`lines[${local}].invoice_number`, `P${page}-${r}`, page));
          out.push(field(`lines[${local}].net_amount`, '$1.00', page));
          local += 1;
        }
      }
      return out;
    };
    const { extractor, requests } = pagedReader(
      (range) => ({ stop_reason: 'end_turn', fields: rowsOf(range) }),
      { concurrency: 2 },
    );
    const error = await extractor
      .extract(payload({ pageText: pages }), 'remittance_advice')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExtractionError);
    expect((error as Error).message).toBe(
      `a paged read found more than ${MAX_ROWS_PER_GROUP} rows of lines: split the document and retry`,
    );
    expect((error as ExtractionError).call.outcome).toBe('schema_mismatch');
    expect((error as ExtractionError).call.detail).toMatch(/\b552 rows of lines, past the 500-row cap: refused/);
    // Six parts of two pages: the batch of parts 11-12 is the one that passed
    // the cap, and nothing was asked after it.
    expect(requests).toHaveLength(1 + 6);
  });

  it('stops before the last parts once the rows already read pass the cap', async () => {
    const pages = Array.from({ length: 16 }, (_, i) => `page ${i + 1}`);
    const rowsOf = (range: PageRange): WireField[] => {
      const out: WireField[] = [];
      let local = 0;
      for (let page = range.first; page <= range.last; page++) {
        for (let r = 0; r < 46; r++) {
          out.push(field(`lines[${local}].invoice_number`, `P${page}-${r}`, page));
          local += 1;
        }
      }
      return out;
    };
    const { extractor, requests } = pagedReader(
      (range) => ({ stop_reason: 'end_turn', fields: rowsOf(range) }),
      { concurrency: 2 },
    );
    await expect(
      extractor.extract(payload({ pageText: pages }), 'remittance_advice'),
    ).rejects.toThrow(/more than 500 rows/);
    // 552 rows are in hand after the third batch (pages 1-12); pages 13-16 are
    // never asked.
    expect(requests).toHaveLength(1 + 6);
  });

  it('holds a joined read that lost a row nothing kept, whatever the schema says', async () => {
    // The part for pages 3-4 cites its rows by their page within the part.
    const { extractor } = pagedReader((range) => ({
      stop_reason: 'end_turn',
      fields:
        range.first === 3
          ? perfectPart(range).map((f) =>
              f.path.startsWith('lines[') ? { ...f, source_page: f.source_page - 2 } : f,
            )
          : perfectPart(range),
    }));
    const result = await extractor.extract(payload(), 'remittance_advice');
    expect(result.validated).toBe(false);
    expect(result.call.outcome).toBe('schema_mismatch');
    expect(result.call.detail).toMatch(/; held for a person; unaccounted for 84: lines\[0\] of part 3-4 \(page 1\)/);
    expect(result.call.detail).not.toMatch(/INV-|\$|LAKESHORE/i);
  });

  it('holds a joined read with identical rows either side of a boundary', async () => {
    const lastOfPage2 = DENSE_PAGED_SPLIT_ROW - 1;
    // The part for pages 3-4 reads page 2's last row again, citing page 3.
    const { extractor } = pagedReader((range) => {
      if (range.first !== 3) return { stop_reason: 'end_turn', fields: perfectPart(range) };
      const again = perfectPart({ first: 2, last: 2 })
        .filter((f) => /^lines\[/.test(f.path))
        .filter((f) => {
          const index = Number(/^lines\[(\d+)\]/.exec(f.path)?.[1]);
          return index === fixture.rowPages.filter((p) => p === 2).length - 1;
        })
        .map((f) => ({ ...f, path: f.path.replace(/^lines\[\d+\]/, 'lines[0]'), source_page: 3 }));
      const rest = perfectPart(range).map((f) => ({
        ...f,
        path: f.path.replace(/^lines\[(\d+)\]/, (_, n: string) => `lines[${Number(n) + 1}]`),
      }));
      return { stop_reason: 'end_turn', fields: [...again, ...rest] };
    });
    const result = await extractor.extract(payload(), 'remittance_advice');
    expect(result.validated).toBe(false);
    expect(result.call.outcome).toBe('schema_mismatch');
    expect(result.call.detail).toContain(
      `held for a person; identical rows either side of a part boundary, both kept 1: lines[${lastOfPage2}]=lines[${lastOfPage2 + 1}]`,
    );
  });

  it('reports a part the model declined as a refusal', async () => {
    const { extractor } = pagedReader((range) =>
      range.first === 3 ? { stop_reason: 'refusal' } : { stop_reason: 'end_turn', fields: perfectPart(range) },
    );
    const error = await extractor.extract(payload(), 'remittance_advice').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelRefusalError);
    expect((error as ModelRefusalError).call.outcome).toBe('refusal');
  });

  it('records a joined read that does not satisfy its schema as schema_mismatch', async () => {
    // The part with page 1 loses the payment reference, which is required.
    const { extractor } = pagedReader((range) => ({
      stop_reason: 'end_turn',
      fields: perfectPart(range).filter((f) => f.path !== 'payment_reference'),
    }));
    const result = await extractor.extract(payload(), 'remittance_advice');
    expect(result.validated).toBe(false);
    expect(result.call.outcome).toBe('schema_mismatch');
    expect(result.call.detail).toContain('payment_reference');
  });
});

/** The fixture's expected extraction as one read's wire fields, rows in order. */
function flattenExpectedAsWire(): WireField[] {
  const fields: WireField[] = [];
  for (const [key, f] of expectedHeader) {
    if (f.value !== null) fields.push(wireOf(key, f));
  }
  expected.lines.forEach((row, index) => {
    for (const [leaf, f] of Object.entries(row)) {
      if (f.value !== null) fields.push(wireOf(`lines[${index}].${leaf}`, f));
    }
  });
  return fields;
}

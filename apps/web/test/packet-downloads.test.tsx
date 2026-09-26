import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { unzipSync } from 'fflate';
import type { CaseWorkflow } from '@recouple/pipeline';
import { CaseNotVisibleError, type ServingRefusal } from '@recouple/pipeline';
import type { PostgresStore } from '@recouple/store-postgres';
import { enclosureName, zipEnclosures } from '../lib/enclosures-zip';
import { DisputeLetter } from '../components/dispute-letter';

/**
 * What a supplier takes away from a packet: the letter, printed, and the
 * enclosures, zipped. Each has to be exactly the packet — the approval names
 * a hash, and a download that was anything else would be sending something
 * nobody approved.
 */

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const CASE_ID = '33333333-3333-3333-3333-333333333333';
const DOC_A = '55555555-5555-5555-5555-555555555555';
const DOC_B = '66666666-6666-6666-6666-666666666666';
const NOT_ENCLOSED = '77777777-7777-7777-7777-777777777777';
const HASH = 'f00dcafe1234'.padEnd(64, '0');

const harness = vi.hoisted(() => ({
  store: undefined as unknown,
  sessions: 0,
}));

vi.mock('../lib/session', () => ({
  requireSession: async () => {
    harness.sessions += 1;
    return {
      userId: '22222222-2222-2222-2222-222222222222',
      email: 'reader@example.test',
      org: { orgId: ORG_ID, slug: 'acme', name: 'Acme', role: 'read_only' },
      orgs: [],
    };
  },
  storeFor: () => harness.store as PostgresStore,
}));

const { GET: enclosures } = await import('../app/cases/[id]/packet/enclosures/route');

/** A store with one case whose packet encloses two of its three documents. */
function fakeStore(
  options: {
    packet?: boolean;
    missing?: string;
    /** Documents that are not served, and why — for every ask or from the nth. */
    refused?: ReadonlyMap<string, { refusal: ServingRefusal; fromAsk?: number }>;
  } = {},
) {
  const documents = new Map([
    [DOC_A, { filename: 'notice.pdf', bytes: new Uint8Array([37, 80, 68, 70, 1]) }],
    [DOC_B, { filename: '../../etc/pod scan (1).jpg', bytes: new Uint8Array([255, 216, 255]) }],
    [NOT_ENCLOSED, { filename: 'not-in-the-packet.pdf', bytes: new Uint8Array([9]) }],
  ]);
  const fake = {
    reads: [] as string[],
    asked: [] as string[],
    closed: 0,
    /** How many times the whole packet's verdicts were asked for. */
    batches: 0,
    verdict(id: string): { refusal: ServingRefusal | undefined } | undefined {
      fake.asked.push(id);
      if (id === options.missing) return undefined;
      const refused = options.refused?.get(id);
      const ask = fake.asked.filter((asked) => asked === id).length;
      if (refused !== undefined && ask >= (refused.fromAsk ?? 1)) {
        return { refusal: refused.refusal };
      }
      return { refusal: undefined };
    },
    async documentsServing(ids: readonly string[]) {
      fake.batches += 1;
      const answers = new Map<string, { refusal: ServingRefusal | undefined }>();
      for (const id of ids) {
        const answer = fake.verdict(id);
        if (answer !== undefined) answers.set(id, answer);
      }
      return answers;
    },
    // The verdict asked again and the bytes read in the same call, as the
    // store does in one transaction: a refused document's bytes are never read.
    async servableDocument(id: string) {
      const answer = fake.verdict(id);
      if (answer === undefined) return undefined;
      if (answer.refusal !== undefined) return { refusal: answer.refusal };
      fake.reads.push(id);
      const document = documents.get(id);
      return document === undefined ? undefined : { document };
    },
    async getWorkflow(id: string): Promise<CaseWorkflow | undefined> {
      if (id !== CASE_ID) throw new CaseNotVisibleError(id);
      return {
        deductionId: CASE_ID,
        state: 'awaiting_approval',
        ...(options.packet === false
          ? {}
          : {
              packet: {
                packetId: '88888888-8888-8888-8888-888888888888',
                decisionId: '99999999-9999-9999-9999-999999999999',
                contentHash: HASH,
                narrative: 'DISPUTE OF DEDUCTION\n',
                fileDocumentIds: [DOC_A, DOC_B],
                assembledBy: 'someone',
                assembledAt: new Date('2026-09-26T10:00:00Z'),
              },
            }),
      } as CaseWorkflow;
    },
    async getDocument(id: string): Promise<never> {
      throw new Error(`enclosures read ${id} outside servableDocument`);
    },
    async documentServing(id: string): Promise<never> {
      throw new Error(`enclosures asked ${id} one transaction at a time`);
    },
    async close() {
      fake.closed += 1;
    },
  };
  return fake;
}

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  harness.sessions = 0;
});

describe('the enclosures zip', () => {
  it('holds exactly the packet’s documents, in its order, under safe names', async () => {
    const store = fakeStore();
    harness.store = store;
    const response = await enclosures(new Request('https://app.example.test/'), params(CASE_ID));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="enclosures-${CASE_ID.slice(0, 8)}.zip"`,
    );
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    // Streamed: the store is still open when the handler returns, and is
    // closed by the stream once the last document is written.
    expect(response.body).not.toBeNull();

    const zipped = new Uint8Array(await response.arrayBuffer());
    const entries = unzipSync(zipped);
    expect(Object.keys(entries)).toEqual(['01-notice.pdf', '02-_.._etc_pod scan _1_.jpg']);
    expect([...(entries['01-notice.pdf'] ?? [])]).toEqual([37, 80, 68, 70, 1]);
    expect([...(entries['02-_.._etc_pod scan _1_.jpg'] ?? [])]).toEqual([255, 216, 255]);
    // Nothing the packet does not name, however the case holds it.
    expect(store.reads).toEqual([DOC_A, DOC_B]);
    // Every enclosure's verdict up front in one query, then each asked again
    // as it is read.
    expect(store.batches).toBe(1);
    expect(store.asked).toEqual([DOC_A, DOC_B, DOC_A, DOC_B]);
    expect(store.closed).toBe(1);
  });

  it('fails the download rather than leaving a document out', async () => {
    const store = fakeStore({ missing: DOC_B });
    harness.store = store;
    const response = await enclosures(new Request('https://app.example.test/'), params(CASE_ID));
    await expect(response.arrayBuffer()).rejects.toThrow(/could not be read/);
    expect(store.closed).toBe(1);
  });

  it('refuses a packet holding a document the scan refused, before a byte is written', async () => {
    for (const refusal of ['infected', 'unscanned'] as const) {
      const store = fakeStore({ refused: new Map([[DOC_B, { refusal }]]) });
      harness.store = store;
      const response = await enclosures(new Request('https://app.example.test/'), params(CASE_ID));
      expect(response.status).toBe(409);
      expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
      expect(response.headers.get('content-disposition')).toBeNull();
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      const body = await response.text();
      expect(body).toContain(refusal === 'infected' ? 'infected' : 'no clean scan verdict');
      // Not the filename of the refused file, and not the zip with it left out.
      expect(body).not.toContain('pod scan');
      expect(store.reads).toEqual([]);
      expect(store.closed).toBe(1);
    }
  });

  it('fails the download when a verdict recorded after the check refuses an enclosure', async () => {
    // Clean when the route asks up front, infected by the time it is read.
    const store = fakeStore({ refused: new Map([[DOC_B, { refusal: 'infected', fromAsk: 2 }]]) });
    harness.store = store;
    const response = await enclosures(new Request('https://app.example.test/'), params(CASE_ID));
    expect(response.status).toBe(200);
    await expect(response.arrayBuffer()).rejects.toThrow(/is not served \(infected\)/);
    // The first enclosure was read; the refused one never was.
    expect(store.reads).toEqual([DOC_A]);
    expect(store.closed).toBe(1);
  });

  it('is the same 404 for no packet, another tenant’s case and a malformed id', async () => {
    for (const [id, store] of [
      [CASE_ID, fakeStore({ packet: false })],
      ['44444444-4444-4444-4444-444444444444', fakeStore()],
    ] as const) {
      harness.store = store;
      const response = await enclosures(new Request('https://app.example.test/'), params(id));
      expect(response.status).toBe(404);
      expect(store.reads).toEqual([]);
      expect(store.closed).toBe(1);
    }
    const sessions = harness.sessions;
    const malformed = await enclosures(
      new Request('https://app.example.test/'),
      params('------------------------------------'),
    );
    expect(malformed.status).toBe(404);
    expect(harness.sessions).toBe(sessions);
  });
});

describe('an enclosure’s name in the zip', () => {
  it('can never be a path, a hidden file or empty, and keeps the packet’s order', () => {
    expect(enclosureName(0, 'notice.pdf')).toBe('01-notice.pdf');
    expect(enclosureName(9, '../../x.pdf')).toBe('10-_.._x.pdf');
    expect(enclosureName(1, '..\\..\\x.pdf')).toBe('02-_.._x.pdf');
    expect(enclosureName(2, '.hidden')).toBe('03-hidden');
    expect(enclosureName(3, '\u0000\u202e')).toBe('04-__');
    expect(enclosureName(4, '   ')).toBe('05-document');
    expect(enclosureName(5, 'a'.repeat(500))).toBe(`06-${'a'.repeat(120)}`);
    for (const name of ['../a', '/etc/passwd', 'C:\\x', 'é.pdf']) {
      expect(enclosureName(0, name)).toMatch(/^\d{2}-[\w.\- ]+$/);
    }
  });

  it('streams one document at a time, and says when it is done however it ends', async () => {
    let done = 0;
    const read = vi.fn(async (id: string) => ({ filename: `${id}.pdf`, bytes: new Uint8Array([1]) }));
    const stream = zipEnclosures(['a', 'b', 'c'], read, async () => {
      done += 1;
    });
    const reader = stream.getReader();
    await reader.read();
    // The first pull has read at most the first document, not all three.
    expect(read.mock.calls.length).toBeLessThan(3);
    await reader.cancel();
    expect(done).toBe(1);
  });
});

describe('the printable letter', () => {
  const narrative = 'DISPUTE OF DEDUCTION\n\nFrom: Acme <script>alert(1)</script>\n';

  it('prints the stored narrative as text, with the packet it came from', () => {
    const html = renderToStaticMarkup(
      <DisputeLetter deductionId={CASE_ID} narrative={narrative} contentHash={HASH} approved />,
    );
    // Text, never markup: the narrative carries values off somebody's page.
    expect(html).toContain('From: Acme &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('Packet f00dcafe1234');
    expect(html).toContain(`href="/cases/${CASE_ID}/packet/enclosures"`);
    expect(html).toContain('@media print');
    expect(html).not.toContain('Draft');
  });

  it('marks a letter nobody has approved yet as a draft, in print too', () => {
    const html = renderToStaticMarkup(
      <DisputeLetter
        deductionId={CASE_ID}
        narrative={narrative}
        contentHash={HASH}
        approved={false}
      />,
    );
    expect(html).toContain('Draft — awaiting approval. Not for sending.');
  });
});

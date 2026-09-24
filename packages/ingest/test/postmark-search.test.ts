import { describe, expect, it } from 'vitest';
import {
  easternDateTime,
  easternDayStart,
  PostmarkInboundSearch,
  PostmarkSearchError,
  POSTMARK_SEARCH_PAGE,
} from '../src/postmark-search';

/**
 * Postmark's inbound search, as the operator's sweep reads it (ADR 0047 §12).
 *
 * Hand-written responses in the documented shape (Postmark's messages-api
 * page): `TotalCount` and `InboundMessages`, each with `MessageID`,
 * `OriginalRecipient` and the sender's own `Date` — and no receipt time, which
 * is why the sweep asks one Eastern day at a time. A recorded response
 * replaces these after the founder's first sweep (ADR 0047 §15).
 */

const TOKEN = 'server-token-DO-NOT-PRINT';

interface Asked {
  readonly url: URL;
  readonly headers: Record<string, string>;
}

function fakeFetch(pages: readonly unknown[], status = 200) {
  const asked: Asked[] = [];
  let next = 0;
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    asked.push({
      url: new URL(String(input)),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    });
    const body = pages[Math.min(next, pages.length - 1)];
    next += 1;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { impl, asked };
}

const listing = (id: number) => ({
  From: 'ap@payer.example',
  OriginalRecipient: `0123456789abcdef0123456789abcdef@in.mozart.example`,
  Subject: 'Deduction notice',
  Date: 'Thu, 13 Feb 2014 17:48:22 +0300',
  MessageID: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
  Status: 'Failed',
});

describe('Eastern time, which the search speaks', () => {
  it('writes an instant as the Eastern wall clock, in daylight time and out of it', () => {
    expect(easternDateTime(new Date('2026-09-24T16:05:09Z'))).toBe('2026-09-24T12:05:09');
    expect(easternDateTime(new Date('2026-01-15T16:05:09Z'))).toBe('2026-01-15T11:05:09');
  });

  it('finds the start of the Eastern day, before and after a clock change', () => {
    // 01:30 UTC on the 24th is still the 23rd in New York.
    expect(easternDayStart(new Date('2026-09-24T01:30:00Z')).toISOString()).toBe('2026-09-23T04:00:00.000Z');
    expect(easternDayStart(new Date('2026-01-15T16:05:09Z')).toISOString()).toBe('2026-01-15T05:00:00.000Z');
    // 1 November 2026: clocks fall back at 2 a.m.; the day began in daylight time.
    expect(easternDayStart(new Date('2026-11-01T20:00:00Z')).toISOString()).toBe('2026-11-01T04:00:00.000Z');
    // 8 March 2026: clocks spring forward at 2 a.m.; the day began in standard time.
    expect(easternDayStart(new Date('2026-03-08T20:00:00Z')).toISOString()).toBe('2026-03-08T05:00:00.000Z');
  });
});

describe('the search', () => {
  it('asks with the server token, the status and an Eastern window, and reads the two facts', async () => {
    const { impl, asked } = fakeFetch([{ TotalCount: 1, InboundMessages: [listing(1)] }]);
    const search = new PostmarkInboundSearch({ serverToken: TOKEN, fetch: impl });
    const found = await search.list({
      status: 'failed',
      from: new Date('2026-09-23T04:00:00Z'),
      to: new Date('2026-09-24T03:59:59Z'),
    });

    expect(found).toEqual([
      {
        messageId: '00000000-0000-4000-8000-000000000001',
        originalRecipient: '0123456789abcdef0123456789abcdef@in.mozart.example',
      },
    ]);
    const [request] = asked;
    expect(request?.url.pathname).toBe('/messages/inbound');
    expect(Object.fromEntries(request?.url.searchParams ?? [])).toEqual({
      count: String(POSTMARK_SEARCH_PAGE),
      offset: '0',
      status: 'failed',
      fromdate: '2026-09-23T00:00:00',
      todate: '2026-09-23T23:59:59',
    });
    expect(request?.headers['x-postmark-server-token']).toBe(TOKEN);
    expect(request?.headers.accept).toBe('application/json');
  });

  it('pages until it has every message the window holds', async () => {
    const first = Array.from({ length: POSTMARK_SEARCH_PAGE }, (_, i) => listing(i));
    const { impl, asked } = fakeFetch([
      { TotalCount: POSTMARK_SEARCH_PAGE + 2, InboundMessages: first },
      { TotalCount: POSTMARK_SEARCH_PAGE + 2, InboundMessages: [listing(900), listing(901)] },
    ]);
    const found = await new PostmarkInboundSearch({ serverToken: TOKEN, fetch: impl }).list({
      status: 'failed',
      from: new Date('2026-09-23T04:00:00Z'),
      to: new Date('2026-09-24T03:59:59Z'),
    });
    expect(found).toHaveLength(POSTMARK_SEARCH_PAGE + 2);
    expect(asked.map((a) => a.url.searchParams.get('offset'))).toEqual(['0', String(POSTMARK_SEARCH_PAGE)]);
  });

  it('refuses a window holding more than the search will list, rather than report part of it', async () => {
    const { impl } = fakeFetch([{ TotalCount: 10_001, InboundMessages: [listing(1)] }]);
    await expect(
      new PostmarkInboundSearch({ serverToken: TOKEN, fetch: impl }).list({
        status: 'failed',
        from: new Date('2026-09-23T04:00:00Z'),
        to: new Date('2026-09-24T03:59:59Z'),
      }),
    ).rejects.toMatchObject({ name: 'PostmarkSearchError', reason: 'window_too_large' });
  });

  it('counts with a total alone, everything received at or before the moment given', async () => {
    const { impl, asked } = fakeFetch([{ TotalCount: 3, InboundMessages: [listing(1)] }]);
    const count = await new PostmarkInboundSearch({ serverToken: TOKEN, fetch: impl }).count({
      status: 'queued',
      before: new Date('2026-09-24T14:00:00Z'),
    });
    expect(count).toBe(3);
    expect(Object.fromEntries(asked[0]?.url.searchParams ?? [])).toEqual({
      count: '1',
      offset: '0',
      status: 'queued',
      todate: '2026-09-24T10:00:00',
    });
  });

  it('says a refusal by its status, and never with the token or the body', async () => {
    const { impl } = fakeFetch([{ ErrorCode: 10, Message: `No Account or Server API tokens were supplied ${TOKEN}` }], 401);
    const error = await new PostmarkInboundSearch({ serverToken: TOKEN, fetch: impl })
      .count({ status: 'queued', before: new Date() })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PostmarkSearchError);
    expect(error).toMatchObject({ reason: 'http', httpStatus: 401 });
    expect(String((error as Error).message)).not.toContain(TOKEN);
    expect(JSON.stringify(error)).not.toContain(TOKEN);
  });

  it('refuses a body it cannot read as a search result', async () => {
    for (const body of ['not json', { InboundMessages: [] }, { TotalCount: 1, InboundMessages: [{ Status: 'Failed' }] }]) {
      const { impl } = fakeFetch([body]);
      await expect(
        new PostmarkInboundSearch({ serverToken: TOKEN, fetch: impl }).count({ status: 'failed', before: new Date() }),
      ).rejects.toMatchObject({ reason: 'shape' });
    }
  });

  it('gives up on a search that does not answer in time', async () => {
    const hang = ((_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      })) as typeof fetch;
    await expect(
      new PostmarkInboundSearch({ serverToken: TOKEN, fetch: hang, timeoutMs: 20 }).count({
        status: 'failed',
        before: new Date(),
      }),
    ).rejects.toMatchObject({ reason: 'timeout' });
  });

  it('reads a listing with no envelope recipient as one with an empty one', async () => {
    const { impl } = fakeFetch([{ TotalCount: 1, InboundMessages: [{ MessageID: 'm-1', Status: 'Failed' }] }]);
    const found = await new PostmarkInboundSearch({ serverToken: TOKEN, fetch: impl }).list({
      status: 'failed',
      from: new Date('2026-09-23T04:00:00Z'),
      to: new Date('2026-09-24T03:59:59Z'),
    });
    expect(found).toEqual([{ messageId: 'm-1', originalRecipient: '' }]);
  });

  it('will not be built without a token', () => {
    expect(() => new PostmarkInboundSearch({ serverToken: ' ' })).toThrow(/server token/);
  });
});

/**
 * Postmark's inbound message search, read-only (ADR 0047 §12).
 *
 * The operator's sweep asks Postmark which inbound messages it accepted and
 * could not deliver to us — an email over Vercel's 4.5 MB request cap never
 * reaches our code at all, so Postmark is the only party that knows it was
 * sent. This is the one outbound call email-in adds, and it only reads: no
 * retry, no bypass, no mail.
 *
 * **What the search does not say.** Its results carry no time Postmark received
 * a message — only `Date`, the sender's own header, which is forgeable and
 * which the ADR never stores. So the search is asked one Eastern-time day at a
 * time (`fromdate`/`todate` are in that zone), and a message's day is the
 * window it was listed in: that is Postmark's date, to the day, with nothing
 * the sender wrote in it.
 *
 * **The server token.** `X-Postmark-Server-Token` reads every tenant's inbound
 * messages and authenticates the calls that can read or repoint the webhook
 * URL, so it lives in the operator's `.env` and never on Vercel (§12). Nothing
 * here puts it in an error, a log line or a return value.
 */

export const POSTMARK_API_URL = 'https://api.postmarkapp.com';

/** Postmark's statuses for an inbound message, as its search filters them. */
export type PostmarkInboundStatus = 'blocked' | 'processed' | 'queued' | 'failed' | 'scheduled';

/** The two facts the sweep reads off a listing. Nothing the sender wrote besides. */
export interface PostmarkInboundListing {
  /** Postmark's MessageID: its own UUID, the key our record is written under. */
  readonly messageId: string;
  /** The envelope recipient, parsed by `tokenFromRecipient` and never printed. */
  readonly originalRecipient: string;
}

/** A page is at most 500, and count + offset may not pass 10,000. */
export const POSTMARK_SEARCH_PAGE = 500;
export const POSTMARK_SEARCH_LIMIT = 10_000;

/**
 * A search Postmark refused, or answered in a shape we cannot read. Carries the
 * HTTP status and a closed reason, never the token and never a body.
 */
export class PostmarkSearchError extends Error {
  override readonly name = 'PostmarkSearchError';
  constructor(
    readonly reason: 'http' | 'shape' | 'timeout' | 'network' | 'window_too_large',
    readonly httpStatus?: number,
  ) {
    super(
      reason === 'http'
        ? `Postmark's inbound search answered ${httpStatus ?? 'an error'}`
        : reason === 'window_too_large'
          ? `Postmark's inbound search listed more than ${POSTMARK_SEARCH_LIMIT} messages in one day`
          : `Postmark's inbound search failed (${reason})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Eastern time, which is what Postmark's search dates are in
// ---------------------------------------------------------------------------

const EASTERN = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

interface WallClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function easternWallClock(instant: Date): WallClock {
  const parts = Object.fromEntries(
    EASTERN.formatToParts(instant).map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

/** `2026-09-24T13:05:09`: the instant as an Eastern wall clock, Postmark's format. */
export function easternDateTime(instant: Date): string {
  const w = easternWallClock(instant);
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}`;
}

/** How far the Eastern wall clock is from UTC at this instant, in milliseconds. */
function easternOffsetMs(instant: Date): number {
  const w = easternWallClock(instant);
  const wallAsUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return wallAsUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The instant the Eastern day holding `instant` began. Midnight is never inside
 * a daylight-saving jump (those are at 2 a.m.), so it always exists and is
 * never doubled; the offset is re-read at the answer so a day that changes
 * offset still starts at its own midnight.
 */
export function easternDayStart(instant: Date): Date {
  const w = easternWallClock(instant);
  const midnightAsUtc = Date.UTC(w.year, w.month - 1, w.day);
  const guess = midnightAsUtc - easternOffsetMs(instant);
  return new Date(midnightAsUtc - easternOffsetMs(new Date(guess)));
}

// ---------------------------------------------------------------------------
// The search
// ---------------------------------------------------------------------------

export interface PostmarkSearchConfig {
  readonly serverToken: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly baseUrl?: string;
}

interface SearchPage {
  readonly total: number;
  readonly listings: readonly PostmarkInboundListing[];
}

function readPage(body: unknown): SearchPage {
  if (body === null || typeof body !== 'object') throw new PostmarkSearchError('shape');
  const { TotalCount, InboundMessages } = body as Record<string, unknown>;
  if (typeof TotalCount !== 'number' || !Number.isInteger(TotalCount) || TotalCount < 0) {
    throw new PostmarkSearchError('shape');
  }
  if (!Array.isArray(InboundMessages)) throw new PostmarkSearchError('shape');
  const listings = InboundMessages.map((entry: unknown): PostmarkInboundListing => {
    if (entry === null || typeof entry !== 'object') throw new PostmarkSearchError('shape');
    const { MessageID, OriginalRecipient } = entry as Record<string, unknown>;
    if (typeof MessageID !== 'string' || MessageID.trim() === '') {
      throw new PostmarkSearchError('shape');
    }
    // A listing with no envelope recipient resolves to no address, which the
    // sweep reports; it is not a reason to stop reading the rest.
    return {
      messageId: MessageID,
      originalRecipient: typeof OriginalRecipient === 'string' ? OriginalRecipient : '',
    };
  });
  return { total: TotalCount, listings };
}

/**
 * Reads Postmark's inbound search with a server token. `list` pages through a
 * window and refuses one that holds more than the search will return, rather
 * than reporting a part of it as the whole; `count` asks only for the total.
 */
export class PostmarkInboundSearch {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;

  constructor(private readonly config: PostmarkSearchConfig) {
    if (config.serverToken.trim() === '') {
      throw new Error('a Postmark server token is required to search inbound messages');
    }
    this.fetchImpl = config.fetch ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.baseUrl = config.baseUrl ?? POSTMARK_API_URL;
  }

  private async page(query: Record<string, string>): Promise<SearchPage> {
    const url = new URL('/messages/inbound', this.baseUrl);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: 'GET',
          headers: {
            accept: 'application/json',
            'x-postmark-server-token': this.config.serverToken,
          },
          signal: abort.signal,
        });
      } catch (error) {
        throw new PostmarkSearchError(
          error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'network',
        );
      }
      if (!response.ok) {
        // The body is Postmark's, and says nothing we would print; the status does.
        await response.body?.cancel().catch(() => undefined);
        throw new PostmarkSearchError('http', response.status);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new PostmarkSearchError('shape');
      }
      return readPage(body);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Every message with this status in the window, inclusive at both ends. */
  async list(query: {
    readonly status: PostmarkInboundStatus;
    readonly from: Date;
    readonly to: Date;
  }): Promise<readonly PostmarkInboundListing[]> {
    const listings: PostmarkInboundListing[] = [];
    let offset = 0;
    for (;;) {
      const page = await this.page({
        count: String(POSTMARK_SEARCH_PAGE),
        offset: String(offset),
        status: query.status,
        fromdate: easternDateTime(query.from),
        todate: easternDateTime(query.to),
      });
      if (page.total > POSTMARK_SEARCH_LIMIT) throw new PostmarkSearchError('window_too_large');
      listings.push(...page.listings);
      offset += page.listings.length;
      if (page.listings.length === 0 || offset >= page.total) return listings;
    }
  }

  /** How many messages with this status Postmark received at or before `before`. */
  async count(query: { readonly status: PostmarkInboundStatus; readonly before: Date }): Promise<number> {
    const page = await this.page({
      count: '1',
      offset: '0',
      status: query.status,
      todate: easternDateTime(query.before),
    });
    return page.total;
  }
}

import {
  easternDayStart,
  tokenFromRecipient,
  type PostmarkInboundListing,
} from '@recouple/ingest';
import type { InboundAddressResolution } from './inbound-ports';

/**
 * The operator's sweep for email Postmark accepted and never delivered (ADR
 * 0047 §12).
 *
 * An email over Vercel's 4.5 MB request cap is refused before any of our code
 * runs; Postmark retries it, marks it Inbound Error, and keeps no attachment
 * we can fetch. The email is lost to us whatever we do, and this is how it is
 * not lost silently: each failed message whose envelope recipient is a live
 * address becomes a `not_received` row on that tenant's record, written as the
 * member the address acts as, and shows under "Email that filed nothing".
 *
 * A pure function over two ports — Postmark's search and our record — so it
 * runs in a test with neither. It reads Postmark and writes our database; it
 * never calls Postmark's retry or bypass, and it sends no mail.
 */

/** How far back the sweep looks: inside the seven days Postmark retains. */
export const INBOUND_SWEEP_DAYS = 6;

/** A message queued or scheduled for longer than this is worth a look. */
export const INBOUND_STALE_AFTER_HOURS = 2;

/** Postmark's search, as the sweep asks it. */
export interface InboundSearchPort {
  /** Every message Postmark failed to deliver in the window, inclusive. */
  listFailed(window: { readonly from: Date; readonly to: Date }): Promise<readonly PostmarkInboundListing[]>;
  /** How many messages with this status arrived at or before `before`. */
  countOlderThan(status: 'queued' | 'scheduled', before: Date): Promise<number>;
}

export interface InboundSweepDeps {
  readonly postmark: InboundSearchPort;
  /** `INBOUND_DOMAIN`: the only domain whose addresses are ours. */
  readonly inboundDomain: string;
  /** `app.inbound_address_for()`: a token's tenant and acting member, claimless. */
  readonly lookup: (token: string) => Promise<InboundAddressResolution | undefined>;
  /** `app.member_may_write()`, asked as the address's acting member. */
  readonly memberMayWrite: (actor: { readonly orgId: string; readonly userId: string }) => Promise<boolean>;
  /**
   * Writes the `not_received` row through `app.record_inbound_message()` as
   * the address's acting member, and returns its id. Idempotent on the
   * message: a second sweep of the same failure writes nothing new.
   */
  readonly recordNotReceived: (
    address: InboundAddressResolution,
    providerMessageId: string,
    providerReceivedAt: Date,
  ) => Promise<string>;
  readonly now: () => Date;
}

/** Why a failed message has no live address to be recorded against. */
export type SweepUnresolved = 'not_our_domain' | 'not_a_token' | 'unknown_token' | 'retired';

/**
 * One line of the sweep's report. Ids and closed words only (§13): Postmark's
 * MessageID, ours, and a reason — never the recipient or its token.
 */
export type InboundSweepLine =
  | {
      readonly kind: 'recorded';
      readonly providerMessageId: string;
      readonly inboundMessageId: string;
      readonly addressId: string;
      readonly orgId: string;
      /** The Eastern-time day Postmark's search listed it under. */
      readonly day: string;
    }
  | {
      readonly kind: 'no_live_address';
      readonly providerMessageId: string;
      readonly reason: SweepUnresolved;
    }
  | {
      readonly kind: 'member_may_not_write';
      readonly providerMessageId: string;
      readonly addressId: string;
      readonly orgId: string;
    };

export interface SweepWindow {
  readonly from: Date;
  readonly to: Date;
  /** The Eastern day this window is, `YYYY-MM-DD`. */
  readonly day: string;
}

export interface InboundSweepReport {
  /** Newest first: today so far, then each whole day before it. */
  readonly windows: readonly (SweepWindow & { readonly failed: number })[];
  readonly lines: readonly InboundSweepLine[];
  readonly staleQueued: number;
  readonly staleScheduled: number;
}

/**
 * The windows the sweep searches: today in Eastern time so far, and each of
 * the `INBOUND_SWEEP_DAYS - 1` whole days before it. One day per window
 * because a window is all that says which day Postmark received a message —
 * its search returns no receipt time, and the `Date` it does return is the
 * sender's.
 */
export function sweepWindows(now: Date): readonly SweepWindow[] {
  const windows: SweepWindow[] = [];
  let end = now;
  for (let index = 0; index < INBOUND_SWEEP_DAYS; index += 1) {
    const start = easternDayStart(end);
    windows.push({ from: start, to: end, day: easternDayLabel(start) });
    // The last second of the day before: the search is inclusive to the second.
    end = new Date(start.getTime() - 1000);
  }
  return windows;
}

/** An Eastern day's start as the date it is there. */
function easternDayLabel(start: Date): string {
  // Midnight Eastern is 04:00 or 05:00 UTC the same date, so the UTC date is it.
  return start.toISOString().slice(0, 10);
}

export async function sweepInboundFailures(deps: InboundSweepDeps): Promise<InboundSweepReport> {
  const now = deps.now();
  const addresses = new Map<string, Promise<InboundAddressResolution | undefined>>();
  const lookup = (token: string) => {
    const known = addresses.get(token);
    if (known !== undefined) return known;
    const asked = deps.lookup(token);
    addresses.set(token, asked);
    return asked;
  };

  const seen = new Set<string>();
  const lines: InboundSweepLine[] = [];
  const windows: (SweepWindow & { failed: number })[] = [];

  for (const window of sweepWindows(now)) {
    const listed = await deps.postmark.listFailed({ from: window.from, to: window.to });
    windows.push({ ...window, failed: listed.length });
    for (const listing of listed) {
      // A window boundary is to the second; a message is counted once however
      // the search draws them.
      if (seen.has(listing.messageId)) continue;
      seen.add(listing.messageId);
      lines.push(await sweepOne(deps, lookup, listing, window));
    }
  }

  const staleBefore = new Date(now.getTime() - INBOUND_STALE_AFTER_HOURS * 3_600_000);
  return {
    windows,
    lines,
    staleQueued: await deps.postmark.countOlderThan('queued', staleBefore),
    staleScheduled: await deps.postmark.countOlderThan('scheduled', staleBefore),
  };
}

async function sweepOne(
  deps: InboundSweepDeps,
  lookup: (token: string) => Promise<InboundAddressResolution | undefined>,
  listing: PostmarkInboundListing,
  window: SweepWindow,
): Promise<InboundSweepLine> {
  const providerMessageId = listing.messageId;
  const recipient = tokenFromRecipient(listing.originalRecipient, deps.inboundDomain);
  if (recipient.kind !== 'token') {
    return { kind: 'no_live_address', providerMessageId, reason: recipient.kind };
  }
  const address = await lookup(recipient.token);
  if (address === undefined) return { kind: 'no_live_address', providerMessageId, reason: 'unknown_token' };
  if (address.retired) return { kind: 'no_live_address', providerMessageId, reason: 'retired' };

  const actor = { orgId: address.orgId, userId: address.actingMember };
  if (!(await deps.memberMayWrite(actor))) {
    return {
      kind: 'member_may_not_write',
      providerMessageId,
      addressId: address.addressId,
      orgId: address.orgId,
    };
  }
  const inboundMessageId = await deps.recordNotReceived(address, providerMessageId, window.from);
  return {
    kind: 'recorded',
    providerMessageId,
    inboundMessageId,
    addressId: address.addressId,
    orgId: address.orgId,
    day: window.day,
  };
}

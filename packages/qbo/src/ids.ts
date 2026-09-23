import { QboInvalidId } from './errors';
import { describe } from './reader';

/**
 * A QBO entity id, proven to be decimal digits.
 *
 * Not politeness, for `assertWindowDate`'s reason: the id is interpolated into
 * QBO's query language between single quotes, and it arrives off a ledger row
 * (a `LinkedTxn.TxnId`) rather than from our own code. A company's `realmId` is
 * one too, and since ADR 0039 it also arrives as a query parameter on Intuit's
 * redirect back to us, which anybody can edit — so it is checked here before it
 * goes into a URL path.
 */
export function assertQboId(value: string): string {
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value)) {
    throw new QboInvalidId(`a QuickBooks id must be decimal digits, got ${describe(value)}`);
  }
  return value;
}

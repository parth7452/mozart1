import type { InboundAddressRow } from '@recouple/store-postgres';
import { RETIRE_CONFIRM_DAYS } from './notices';

/**
 * Who may manage an address, and when retiring one asks first (ADR 0047 §4).
 *
 * Pure, so the page, its view and the three routes share one answer without
 * a view importing a route's server helpers.
 */

/** Issue, adopt and retire are an owner's; the database says the same. */
export function mayManageInboundAddresses(role: string): boolean {
  return role === 'owner';
}

/** Whether retiring this address asks first: it received mail recently. */
export function retireAsksFirst(address: InboundAddressRow, now: Date): boolean {
  if (address.lastReceivedAt === undefined) return false;
  return now.getTime() - address.lastReceivedAt.getTime() < RETIRE_CONFIRM_DAYS * 86_400_000;
}

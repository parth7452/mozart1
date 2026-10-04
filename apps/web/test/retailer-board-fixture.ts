import type { PayerTotals } from '@recouple/core-domain';
import type { RetailerBoard } from '@recouple/store-postgres';

/** A payer's figures with nothing in them, for a test to fill in what it is about. */
export const NO_TOTALS: PayerTotals = {
  openCases: 0,
  closedCases: 0,
  declinedCases: 0,
  awaitingApprovalCases: 0,
  inDisputeCents: 0,
  recoveredCents: 0,
  recoveredUnrecordedCases: 0,
  declinedCents: 0,
  atRiskCases: 0,
  atRiskCents: 0,
  listableCases: 0,
};

/**
 * What `PostgresStore.retailerBoard` answers for a tenant with no case: for
 * the tests about the rest of the case list.
 */
export const NO_BOARD: RetailerBoard = { groups: [], totals: NO_TOTALS, casesPerGroup: 8 };

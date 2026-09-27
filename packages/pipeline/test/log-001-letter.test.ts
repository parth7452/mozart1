/**
 * LOG-001's dispute letter, built the way the packet route builds it: the
 * case's reconcile findings filtered to `supports_dispute` and to the codes a
 * letter may print, so the waiver sentence off the page never reaches it.
 */
import { describe, expect, it } from 'vitest';
import { buildPacketNarrative } from '@recouple/core-domain';
import { LETTER_SAFE_FINDING_CODES } from '@recouple/extraction';
import { LOG_001_DEDUCTION_CENTS } from '@recouple/fixtures';
import { walkTheDemo } from './log-001-walk';

describe("LOG-001's dispute letter", () => {
  it('prints the safe findings and never the waiver sentence', async () => {
    const { reconciliation } = await walkTheDemo();
    const findings = (reconciliation?.findings ?? [])
      .filter((f) => f.severity === 'supports_dispute' && LETTER_SAFE_FINDING_CODES.includes(f.code))
      .map(({ code, message }) => ({ code, message }));
    const waiver = reconciliation?.findings.find((f) => f.code === 'charge_waived_in_writing');
    expect(waiver).toBeDefined();

    const narrative = buildPacketNarrative({
      supplier: 'Crestline Freight Lines',
      claimId: 'LOG-001',
      payer: 'Westhaven Paper Supply',
      invoiceNumbers: ['CFL-INV-1001'],
      deductionAmountCents: LOG_001_DEDUCTION_CENTS,
      reason: 'shortage_never_received',
      rationale: 'The detention charge was waived in writing and the truck arrived early.',
      findings,
      documents: [
        { role: 'notice', filename: 'short-pay-remittance.pdf', sha256: 'a'.repeat(64) },
        { role: 'evidence', filename: 'proof-of-delivery.pdf', sha256: 'b'.repeat(64) },
      ],
    });
    expect(narrative).toBe(GOLDEN);
    expect(narrative).toContain('$600.00');
    expect(narrative).not.toContain(waiver?.message ?? '');
    expect(narrative).not.toContain('“');
  });
});

const GOLDEN = [
  "DISPUTE OF DEDUCTION",
  "",
  "From: Crestline Freight Lines",
  "To: Westhaven Paper Supply",
  "",
  "Claim or deduction reference: LOG-001",
  "Invoice number: CFL-INV-1001",
  "Amount deducted: $600.00",
  "Deduction date: (not recorded)",
  "",
  "Crestline Freight Lines disputes this deduction in full and asks that $600.00 be repaid.",
  "",
  "Reason for dispute: Shipment deducted as never received, though delivery is documented",
  "",
  "Findings:",
  "  1. gate check-in was 18 minutes before the confirmed appointment (August 13, 2026, 1:42 PM Eastern against August 13, 2026, 2:00 PM Eastern)",
  "",
  "Explanation:",
  "The detention charge was waived in writing and the truck arrived early.",
  "",
  "Enclosures:",
  "  1. Deduction notice: short-pay-remittance.pdf (SHA-256 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)",
  "  2. Supporting document: proof-of-delivery.pdf (SHA-256 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb)",
  "",
  "Please quote the claim or deduction reference above in any reply about this dispute.",
  "",
].join('\n');

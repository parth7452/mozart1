import { describe, expect, it } from 'vitest';
import { LETTER_SAFE_FINDING_CODES } from '../src/reconcile';

describe('the findings a dispute letter may print', () => {
  it('is the audited list, and nothing else', () => {
    expect([...LETTER_SAFE_FINDING_CODES]).toEqual([
      'arrived_before_appointment',
      'delivery_confirms_shortage',
      'delivery_shows_full_receipt',
      'item_not_on_invoice',
      'line_arithmetic_differs',
      'unit_cost_differs_from_po',
    ]);
  });

  it('leaves out every finding that quotes a sentence off the page', () => {
    expect(LETTER_SAFE_FINDING_CODES).not.toContain('charge_waived_in_writing');
    expect(LETTER_SAFE_FINDING_CODES).not.toContain('appointment_superseded');
  });
});

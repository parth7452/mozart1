import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  deadlineFromWindow,
  DISPUTE_WINDOW_MAX_DAYS,
  resolveDisputeWindow,
  type DisputeWindowRow,
} from '../src/dispute-windows';

function row(over: Partial<DisputeWindowRow> = {}): DisputeWindowRow {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    debtorId: 'debtor',
    windowDays: 30,
    measuredFrom: 'deduction_date',
    effectiveFrom: '2026-01-01',
    source: 'payer_guide_url',
    confidence: 'high',
    recordedBy: 'user',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

const DAY_0 = Date.UTC(2000, 0, 1);
const isoAt = (offset: number): string => new Date(DAY_0 + offset * 86_400_000).toISOString().slice(0, 10);

describe('deadlineFromWindow', () => {
  it('crosses month, year and leap boundaries', () => {
    expect(deadlineFromWindow('2024-02-28', 1)).toBe('2024-02-29');
    expect(deadlineFromWindow('2024-02-29', 1)).toBe('2024-03-01');
    expect(deadlineFromWindow('2025-02-28', 1)).toBe('2025-03-01');
    expect(deadlineFromWindow('2025-12-31', 1)).toBe('2026-01-01');
    expect(deadlineFromWindow('2026-01-15', 30)).toBe('2026-02-14');
    expect(deadlineFromWindow('2026-01-01', 730)).toBe('2028-01-01');
  });

  it('refuses a non-ISO date and days outside 1..730', () => {
    expect(() => deadlineFromWindow('2026-02-30', 1)).toThrow(RangeError);
    expect(() => deadlineFromWindow('01/02/2026', 1)).toThrow(RangeError);
    expect(() => deadlineFromWindow('2026-01-01', 0)).toThrow(RangeError);
    expect(() => deadlineFromWindow('2026-01-01', 731)).toThrow(RangeError);
    expect(() => deadlineFromWindow('2026-01-01', 1.5)).toThrow(RangeError);
  });

  it('equals Date.UTC arithmetic and is monotone in days', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 40_000 }),
        fc.integer({ min: 1, max: DISPUTE_WINDOW_MAX_DAYS }),
        fc.integer({ min: 1, max: DISPUTE_WINDOW_MAX_DAYS }),
        (offset, d1, d2) => {
          const date = isoAt(offset);
          expect(deadlineFromWindow(date, d1)).toBe(isoAt(offset + d1));
          const [lo, hi] = d1 <= d2 ? [d1, d2] : [d2, d1];
          expect(deadlineFromWindow(date, lo) <= deadlineFromWindow(date, hi)).toBe(true);
          if (lo < hi) expect(deadlineFromWindow(date, lo) < deadlineFromWindow(date, hi)).toBe(true);
        },
      ),
    );
  });
});

describe('resolveDisputeWindow', () => {
  const rows = [
    row({ id: 'a', windowDays: 30, effectiveFrom: '2026-01-01' }),
    row({ id: 'b', windowDays: 60, effectiveFrom: '2026-03-01', effectiveTo: '2026-03-31', createdAt: '2026-01-02T00:00:00.000Z' }),
    row({ id: 'c', windowDays: 45, effectiveFrom: '2026-06-01', createdAt: '2026-05-01T00:00:00.000Z' }),
    row({ id: 'd', windowDays: 90, effectiveFrom: '2026-06-01', createdAt: '2026-05-02T00:00:00.000Z' }),
    row({ id: 'e', debtorId: 'other', windowDays: 10, effectiveFrom: '2025-01-01' }),
  ];

  it('applies the same rule as the SQL function', () => {
    expect(resolveDisputeWindow(rows, 'debtor', '2025-12-31')).toBeUndefined();
    expect(resolveDisputeWindow(rows, 'debtor', '2026-02-15')?.windowDays).toBe(30);
    expect(resolveDisputeWindow(rows, 'debtor', '2026-03-31')?.windowDays).toBe(60);
    expect(resolveDisputeWindow(rows, 'debtor', '2026-04-01')?.windowDays).toBe(30);
    expect(resolveDisputeWindow(rows, 'debtor', '2026-06-01')?.windowDays).toBe(90);
    expect(resolveDisputeWindow(rows, 'other', '2026-06-01')?.windowDays).toBe(10);
    expect(resolveDisputeWindow(rows, 'nobody', '2026-06-01')).toBeUndefined();
  });

  it('does not depend on the order of the list', () => {
    fc.assert(
      fc.property(fc.shuffledSubarray(rows, { minLength: rows.length, maxLength: rows.length }), (shuffled) => {
        for (const day of ['2026-02-15', '2026-03-15', '2026-04-01', '2026-06-01']) {
          expect(resolveDisputeWindow(shuffled, 'debtor', day)?.id).toBe(resolveDisputeWindow(rows, 'debtor', day)?.id);
        }
      }),
    );
  });

  it('refuses an as-of that is not a date', () => {
    expect(() => resolveDisputeWindow(rows, 'debtor', 'today')).toThrow(RangeError);
  });
});

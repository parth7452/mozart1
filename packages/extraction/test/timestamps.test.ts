import { describe, expect, it } from 'vitest';
import { minutesLate, parseTimestamp } from '../src/timestamps';

describe('reading a timestamp off a page', () => {
  it('reads the forms these documents actually print', () => {
    expect(parseTimestamp('August 13, 2026, 1:42 PM Eastern')).toMatchObject({
      date: '2026-08-13',
      minutesOfDay: 13 * 60 + 42,
      zone: 'eastern',
    });
    expect(parseTimestamp('August 13, 2026 at 2:00 PM Eastern')).toMatchObject({
      date: '2026-08-13',
      minutesOfDay: 14 * 60,
      zone: 'eastern',
    });
    expect(parseTimestamp('08/13/2026 13:42')).toMatchObject({
      date: '2026-08-13',
      minutesOfDay: 13 * 60 + 42,
      zone: null,
    });
    expect(parseTimestamp('2026-08-13 09:05 UTC')).toMatchObject({
      date: '2026-08-13',
      minutesOfDay: 9 * 60 + 5,
      zone: 'utc',
    });
  });

  it('gets midnight and noon the right way round', () => {
    // The classic off-by-twelve. 12:xx AM is hour zero, 12:xx PM is hour twelve.
    expect(parseTimestamp('August 13, 2026, 12:30 AM')?.minutesOfDay).toBe(30);
    expect(parseTimestamp('August 13, 2026, 12:30 PM')?.minutesOfDay).toBe(12 * 60 + 30);
  });

  it('keeps what was printed, so a reviewer can always check the reading', () => {
    expect(parseTimestamp('August 13, 2026, 1:42 PM Eastern')?.asPrinted).toBe(
      'August 13, 2026, 1:42 PM Eastern',
    );
  });

  it('returns nothing rather than a guess when it cannot read one', () => {
    for (const text of ['', 'sometime Tuesday', 'August 13, 2026', '25:99', 'February 30, 2026 1:00 PM']) {
      expect(parseTimestamp(text), text).toBeNull();
    }
    expect(parseTimestamp(undefined)).toBeNull();
  });
});

describe('comparing two timestamps', () => {
  const appointment = parseTimestamp('August 13, 2026, 2:00 PM Eastern');
  const checkIn = parseTimestamp('August 13, 2026, 1:42 PM Eastern');

  it('measures the real case: 18 minutes early', () => {
    const result = minutesLate(checkIn!, appointment!);
    expect(result).toEqual({ comparable: true, minutesLate: -18 });
  });

  it('counts across a day boundary', () => {
    const late = parseTimestamp('August 14, 2026, 9:00 AM Eastern');
    expect(minutesLate(late!, appointment!)).toEqual({
      comparable: true,
      minutesLate: 19 * 60,
    });
  });

  it('refuses to compare different zones rather than be confidently wrong', () => {
    // This is the failure that matters: subtract a UTC stamp from an Eastern one
    // and an early arrival becomes a four-hour-late one, with a plausible number
    // to show for it.
    const utc = parseTimestamp('August 13, 2026, 1:42 PM UTC');
    const result = minutesLate(utc!, appointment!);
    expect(result.comparable).toBe(false);
    if (!result.comparable) expect(result.why).toMatch(/different zones/);
  });

  it('compares when neither states a zone', () => {
    const a = parseTimestamp('08/13/2026 13:42');
    const b = parseTimestamp('08/13/2026 14:00');
    expect(minutesLate(a!, b!)).toEqual({ comparable: true, minutesLate: -18 });
  });
});

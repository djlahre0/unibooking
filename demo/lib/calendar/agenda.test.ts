import { describe, expect, it } from 'vitest';
import type { Booking } from 'unibooking';
import { dayLabel, groupByDay, shiftDate, todayIn, windowRange } from './agenda';

function booking(id: string, start: string, end: string, extra: Partial<Booking> = {}): Booking {
  return {
    id,
    provider: 'google',
    title: id,
    range: { start, end },
    status: 'confirmed',
    raw: {},
    ...extra,
  };
}

describe('dates and windows', () => {
  it('shifts calendar dates across month and year ends', () => {
    expect(shiftDate('2026-09-30', 1)).toBe('2026-10-01');
    expect(shiftDate('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('computes today in the display zone', () => {
    expect(todayIn('Asia/Kolkata', new Date('2026-09-20T20:00:00Z'))).toBe('2026-09-21');
    expect(todayIn('America/Los_Angeles', new Date('2026-09-21T02:00:00Z'))).toBe('2026-09-20');
  });

  it('turns a window of days into zone-anchored instants', () => {
    expect(windowRange('2026-09-21', 7, 'Asia/Kolkata')).toEqual({
      start: '2026-09-21T00:00:00+05:30',
      end: '2026-09-28T00:00:00+05:30',
    });
  });

  it('labels a day deterministically', () => {
    expect(dayLabel('2026-09-21')).toBe('Mon, 21 Sep');
  });
});

describe('groupByDay', () => {
  it('places a timed event on its local day, with a local time label', () => {
    const days = groupByDay(
      [booking('late', '2026-09-21T20:00:00Z', '2026-09-21T21:00:00Z')],
      'Asia/Kolkata',
      '2026-09-21',
      7,
    );
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({ date: '2026-09-22', label: 'Tue, 22 Sep' });
    expect(days[0]!.items[0]!.timeLabel).toBe('01:30–02:30');
  });

  it('spreads an all-day event across its days and sorts it first', () => {
    const days = groupByDay(
      [
        booking('meeting', '2026-09-21T05:00:00Z', '2026-09-21T06:00:00Z'),
        booking('offsite', '2026-09-21T00:00:00Z', '2026-09-23T00:00:00Z', { allDay: true }),
      ],
      'UTC',
      '2026-09-21',
      7,
    );
    expect(days.map((d) => d.date)).toEqual(['2026-09-21', '2026-09-22']);
    expect(days[0]!.items.map((i) => i.booking.id)).toEqual(['offsite', 'meeting']);
    expect(days[0]!.items[0]).toMatchObject({ allDay: true, timeLabel: 'All day' });
  });

  it('marks an event that ends on a later day', () => {
    const [day] = groupByDay(
      [booking('overnight', '2026-09-21T22:00:00Z', '2026-09-22T01:00:00Z')],
      'UTC',
      '2026-09-21',
      1,
    );
    expect(day!.items[0]!.timeLabel).toBe('22:00–01:00 (+1d)');
  });

  it('drops events outside the window and omits empty days', () => {
    const days = groupByDay(
      [
        booking('before', '2026-09-19T10:00:00Z', '2026-09-19T11:00:00Z'),
        booking('after', '2026-09-30T10:00:00Z', '2026-09-30T11:00:00Z'),
      ],
      'UTC',
      '2026-09-21',
      7,
    );
    expect(days).toEqual([]);
  });

  it('shows an event already in progress at the start of the window', () => {
    const [day] = groupByDay(
      [booking('carryover', '2026-09-20T23:00:00Z', '2026-09-21T02:00:00Z')],
      'UTC',
      '2026-09-21',
      1,
    );
    expect(day!.date).toBe('2026-09-21');
  });
});

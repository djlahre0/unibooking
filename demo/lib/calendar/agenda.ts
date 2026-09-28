import { instantToZoned, zonedToInstant, type Booking } from 'unibooking';

/**
 * Pure agenda logic for My Calendar: the visible window, and events grouped by
 * day in the DISPLAY timezone the user picked, which may differ from the zone
 * an event was created in. No React, no fetch; unit-tested on its own.
 *
 * Dates are `YYYY-MM-DD` strings throughout. Date arithmetic goes through
 * Date.UTC so it never depends on the machine's own time zone.
 */

export type WindowDays = 1 | 7 | 30;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function utcDate(date: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

export function shiftDate(date: string, days: number): string {
  const t = utcDate(date);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((utcDate(to).getTime() - utcDate(from).getTime()) / 86_400_000);
}

export function todayIn(tz: string, now: Date = new Date()): string {
  return instantToZoned(now.toISOString(), tz).date;
}

/** The instants a window of whole days covers, anchored at local midnight. */
export function windowRange(
  startDate: string,
  days: WindowDays,
  tz: string,
): { start: string; end: string } {
  return {
    start: zonedToInstant(`${startDate}T00:00`, tz),
    end: zonedToInstant(`${shiftDate(startDate, days)}T00:00`, tz),
  };
}

/** `Mon, 21 Sep`: built by hand so it reads the same on every locale/ICU. */
export function dayLabel(date: string): string {
  const d = utcDate(date);
  return `${WEEKDAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

export interface AgendaItem {
  booking: Booking;
  allDay: boolean;
  timeLabel: string;
}

export interface AgendaDay {
  date: string;
  label: string;
  items: AgendaItem[];
}

/**
 * Group events into the window's days.
 *
 * - An all-day event's dates are the calendar dates in its range (UTC
 *   midnights, end exclusive: the canonical form), shown on every day it
 *   covers and never shifted by the display zone: "all day on the 21st" is the
 *   21st everywhere.
 * - A timed event goes on its start day in the display zone; one already in
 *   progress when the window opens goes on the first day.
 */
export function groupByDay(
  bookings: Booking[],
  tz: string,
  startDate: string,
  days: WindowDays,
): AgendaDay[] {
  const endDate = shiftDate(startDate, days);
  const byDate = new Map<string, AgendaItem[]>();
  const add = (date: string, item: AgendaItem) => {
    if (date < startDate || date >= endDate) return;
    byDate.set(date, [...(byDate.get(date) ?? []), item]);
  };

  for (const b of bookings) {
    if (b.allDay) {
      const first = b.range.start.slice(0, 10);
      const last = b.range.end.slice(0, 10);
      for (let d = first; d < last; d = shiftDate(d, 1)) {
        add(d, { booking: b, allDay: true, timeLabel: 'All day' });
      }
      continue;
    }
    const s = instantToZoned(b.range.start, tz);
    const e = instantToZoned(b.range.end, tz);
    const spill = daysBetween(s.date, e.date);
    const timeLabel = `${s.time}–${e.time}${spill > 0 ? ` (+${spill}d)` : ''}`;
    const inProgress =
      s.date < startDate &&
      Date.parse(b.range.end) > Date.parse(windowRange(startDate, 1, tz).start);
    add(inProgress ? startDate : s.date, { booking: b, allDay: false, timeLabel });
  }

  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, items]) => ({
      date,
      label: dayLabel(date),
      items: items.sort(
        (a, b) =>
          Number(b.allDay) - Number(a.allDay) ||
          Date.parse(a.booking.range.start) - Date.parse(b.booking.range.start),
      ),
    }));
}

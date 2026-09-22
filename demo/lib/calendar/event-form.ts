import { instantToZoned, zonedToInstant, type Booking } from 'unibooking';
import { shiftDate } from './agenda';
import type { EventInput } from './types';

/**
 * The event form's model and rules, kept pure so they are unit-tested without
 * a browser. People type wall-clock dates and times in a timezone they choose;
 * this converts them to the canonical instants the library takes, via the
 * library's own `zonedToInstant` — the form never does offset math itself.
 *
 * All-day end dates are INCLUSIVE in the form ("21–22 Sep" is two days) and
 * exclusive on the wire, so conversion adds a day and reading back removes it.
 */
export interface EventFormValues {
  title: string;
  allDay: boolean;
  date: string;
  startTime: string;
  endDate: string;
  endTime: string;
  timezone: string;
  location: string;
  description: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

const pad = (n: number): string => String(n).padStart(2, '0');

export function isValidZone(tz: string): boolean {
  if (!tz) return false;
  try {
    zonedToInstant('2000-01-01T00:00', tz);
    return true;
  } catch {
    return false;
  }
}

/** A new event: the next whole hour, for one hour, in `tz`. */
export function defaultValues(tz: string, now: Date = new Date()): EventFormValues {
  const local = instantToZoned(now.toISOString(), tz);
  let date = local.date;
  let hour = Number(local.time.slice(0, 2)) + 1;
  if (hour >= 24) {
    hour = 0;
    date = shiftDate(date, 1);
  }
  const endHour = hour + 1;
  return {
    title: '',
    allDay: false,
    date,
    startTime: `${pad(hour)}:00`,
    endDate: endHour >= 24 ? shiftDate(date, 1) : date,
    endTime: `${pad(endHour % 24)}:00`,
    timezone: tz,
    location: '',
    description: '',
  };
}

/** An existing event, shown in its own zone when it has a usable one. */
export function valuesFromBooking(b: Booking, fallbackTz: string): EventFormValues {
  const timezone =
    b.range.timezone && isValidZone(b.range.timezone) ? b.range.timezone : fallbackTz;
  const common = {
    title: b.title,
    timezone,
    location: b.location ?? '',
    description: b.description ?? '',
  };
  if (b.allDay) {
    const date = b.range.start.slice(0, 10);
    const last = shiftDate(b.range.end.slice(0, 10), -1);
    return {
      ...common,
      allDay: true,
      date,
      endDate: last < date ? date : last,
      startTime: '09:00',
      endTime: '10:00',
    };
  }
  const s = instantToZoned(b.range.start, timezone);
  const e = instantToZoned(b.range.end, timezone);
  return {
    ...common,
    allDay: false,
    date: s.date,
    startTime: s.time,
    endDate: e.date,
    endTime: e.time,
  };
}

function instants(v: EventFormValues): { start: string; end: string } {
  if (v.allDay) {
    return {
      start: zonedToInstant(`${v.date}T00:00`, v.timezone),
      end: zonedToInstant(`${shiftDate(v.endDate, 1)}T00:00`, v.timezone),
    };
  }
  return {
    start: zonedToInstant(`${v.date}T${v.startTime}`, v.timezone),
    end: zonedToInstant(`${v.endDate}T${v.endTime}`, v.timezone),
  };
}

/** The first problem with the form, phrased for the person filling it in. */
export function validate(v: EventFormValues): string | null {
  if (!v.title.trim()) return 'Title is required';
  if (!isValidZone(v.timezone)) return 'Unknown timezone';
  if (!DATE_RE.test(v.date) || !DATE_RE.test(v.endDate)) return 'Enter valid dates';
  if (v.allDay) {
    return v.endDate < v.date ? 'End date must be on or after the start date' : null;
  }
  if (!TIME_RE.test(v.startTime) || !TIME_RE.test(v.endTime)) return 'Enter valid times';
  try {
    const { start, end } = instants(v);
    return Date.parse(end) > Date.parse(start) ? null : 'End must be after start';
  } catch {
    return 'Enter a valid date and time';
  }
}

function timing(v: EventFormValues): EventInput {
  return { ...instants(v), timezone: v.timezone, allDay: v.allDay };
}

/** Everything the form holds, for a create. Empty optional fields are left out. */
export function toEventInput(v: EventFormValues): EventInput {
  return {
    title: v.title.trim(),
    ...timing(v),
    ...(v.location.trim() ? { location: v.location.trim() } : {}),
    ...(v.description.trim() ? { description: v.description.trim() } : {}),
  };
}

const TIMING_KEYS = ['allDay', 'date', 'startTime', 'endDate', 'endTime', 'timezone'] as const;

/** Only what changed, for an update. Timing travels as one group — the
 *  library rewrites start, end, zone and all-day together. A cleared text field
 *  is sent as '' so the provider clears it too. */
export function changedInput(before: EventFormValues, after: EventFormValues): EventInput {
  const timingChanged = TIMING_KEYS.some((k) => before[k] !== after[k]);
  return {
    ...(after.title.trim() !== before.title.trim() ? { title: after.title.trim() } : {}),
    ...(timingChanged ? timing(after) : {}),
    ...(after.location.trim() !== before.location.trim()
      ? { location: after.location.trim() }
      : {}),
    ...(after.description.trim() !== before.description.trim()
      ? { description: after.description.trim() }
      : {}),
  };
}

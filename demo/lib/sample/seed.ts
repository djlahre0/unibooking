import {
  endFromDuration,
  zonedToInstant,
  type Booking,
  type Service,
  type Staff,
} from 'unibooking';
import { shiftDate } from '../calendar/agenda';
import { SAMPLE_ID, type SampleCustomer, type SampleData } from './types';

/** Opening hours by JS weekday (0 = Sunday). null = closed. */
export const BUSINESS_HOURS: Record<number, { open: string; close: string } | null> = {
  0: null,
  1: { open: '09:00', close: '18:00' },
  2: { open: '09:00', close: '18:00' },
  3: { open: '09:00', close: '18:00' },
  4: { open: '09:00', close: '18:00' },
  5: { open: '09:00', close: '18:00' },
  6: { open: '09:00', close: '18:00' },
};

export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function isOpen(date: string): boolean {
  return BUSINESS_HOURS[weekdayOf(date)] !== null;
}

/**
 * 'HH:mm' + minutes → 'HH:mm', within one day. Deliberately NOT named
 * `addMinutes`: the library exports an `addMinutes(iso, minutes)` that shifts a
 * full RFC3339 instant, and two functions with one name doing different things
 * is how a subtle bug gets written.
 */
export function addClockMinutes(time: string, minutes: number): string {
  const [h, m] = time.split(':').map(Number);
  const total = h! * 60 + m! + minutes;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

const SERVICES: Array<[string, number, number]> = [
  ['Haircut', 30, 4500],
  ['Colour', 90, 12000],
  ['Blow-dry', 45, 5500],
  ['Beard trim', 20, 2500],
  ['Manicure', 40, 3500],
  ['Facial', 60, 9000],
];

const STAFF: Array<[string, boolean]> = [
  ['Ava Mitchell', true],
  ['Ben Okafor', true],
  ['Chloe Duarte', true],
  ['Dan Reyes', false], // inactive, so setStaffActive has something to toggle
];

const CUSTOMERS = [
  'Priya Raman',
  'Marcus Webb',
  'Ines Costa',
  'Jonah Klein',
  'Sofia Duran',
  'Theo Bianchi',
  'Nadia Haddad',
  'Owen Fitzgerald',
];

/** Deterministic booking layout: [dayOffset, startTime, serviceIndex, staffIndex, status].
 *  The last offset is 20, not a round 21 ("three weeks"): when the anchor day
 *  itself is a Sunday (as the seed test's is, to exercise the closed-day
 *  slide), day+21 is also a Sunday and the slide-to-Monday rule below would
 *  push it to day+22 -- one day past "three weeks ahead". day+20 lands on a
 *  Saturday (open), so it never needs sliding and stays inside the window
 *  regardless of which weekday the seed is anchored to. */
const LAYOUT: Array<[number, string, number, number, Booking['status']]> = [
  [-7, '09:30', 0, 0, 'completed'],
  [-7, '13:00', 1, 1, 'completed'],
  [-6, '10:00', 2, 2, 'completed'],
  [-5, '11:00', 0, 0, 'no_show'],
  [-4, '14:00', 3, 1, 'completed'],
  [-3, '09:00', 4, 2, 'completed'],
  [-2, '15:30', 5, 0, 'cancelled'],
  [-1, '10:30', 0, 1, 'completed'],
  [0, '09:00', 0, 0, 'confirmed'],
  // staffIdx 0, not 1: at a Monday anchor, offset -1 slides onto this same day
  // (Sunday -> Monday) and would double-book stf_2 (10:30-11:00 vs this slot's
  // 10:00-10:45); at a Sunday anchor, offset 0 itself slides onto day+1, where
  // it would double-book stf_2 against the offset-1 entry below (09:30-10:10).
  // stf_1 already has non-overlapping slots on this day (09:00, 14:00), so
  // reassigning here avoids both collisions without touching either entry that
  // moves. See seed.test.ts's "never double-books the same staff member,
  // whichever weekday the seed is anchored to".
  [0, '10:00', 2, 0, 'confirmed'],
  [0, '11:30', 1, 2, 'confirmed'],
  [0, '14:00', 3, 0, 'pending'],
  [1, '09:30', 4, 1, 'confirmed'],
  [1, '13:00', 5, 2, 'confirmed'],
  [2, '10:00', 0, 0, 'confirmed'],
  [3, '11:00', 1, 1, 'confirmed'],
  [4, '09:00', 2, 2, 'confirmed'],
  [5, '15:00', 3, 0, 'cancelled'],
  [7, '10:30', 4, 1, 'confirmed'],
  [9, '13:30', 5, 2, 'confirmed'],
  [11, '09:30', 0, 0, 'confirmed'],
  [14, '11:00', 1, 1, 'confirmed'],
  [17, '10:00', 2, 2, 'confirmed'],
  [20, '14:30', 3, 0, 'confirmed'],
];

export function buildSeed(today: string, timezone: string): SampleData {
  const services: Service[] = SERVICES.map(([name, durationMinutes, amount], i) => ({
    id: `svc_${i + 1}`,
    name,
    durationMinutes,
    price: { amount, currency: 'USD' },
    active: true,
    raw: { source: 'sample', seeded: true },
  }));

  const staff: Staff[] = STAFF.map(([name, active], i) => ({
    id: `stf_${i + 1}`,
    name,
    email: `${name.split(' ')[0]!.toLowerCase()}@example.salon`,
    active,
    raw: { source: 'sample', seeded: true },
  }));

  const customers: SampleCustomer[] = CUSTOMERS.map((name, i) => ({
    id: `cus_${i + 1}`,
    name,
    email: `${name.split(' ')[0]!.toLowerCase()}${i + 1}@example.com`,
    phone: `+1555010${String(i + 1).padStart(2, '0')}`,
  }));

  const bookings: Booking[] = [];
  let id = 1;
  for (const [offset, startTime, serviceIdx, staffIdx, status] of LAYOUT) {
    const date = shiftDate(today, offset);
    // Sundays are closed; slide the booking to Monday rather than dropping it,
    // so the seed always holds the same number of bookings whatever day the
    // visitor first opens the demo.
    const day = isOpen(date) ? date : shiftDate(date, 1);
    const service = services[serviceIdx]!;
    const customer = customers[id % customers.length]!;
    bookings.push({
      id: `bkg_${id}`,
      provider: SAMPLE_ID,
      title: `${service.name} — ${customer.name}`,
      range: {
        start: zonedToInstant(`${day}T${startTime}`, timezone),
        // endFromDuration is the library's own helper and preserves the offset
        // the start carries, so a 30-minute appointment is 30 minutes even
        // across a DST boundary.
        end: endFromDuration(
          zonedToInstant(`${day}T${startTime}`, timezone),
          service.durationMinutes!,
        ),
        timezone,
      },
      customer,
      staffId: staff[staffIdx]!.id,
      serviceId: service.id,
      status,
      createdAt: zonedToInstant(`${shiftDate(day, -3)}T12:00`, timezone),
      updatedAt: zonedToInstant(`${shiftDate(day, -3)}T12:00`, timezone),
      // Acyclic by construction: never the booking object itself, or the store's
      // JSON.stringify would throw on a circular reference.
      raw: { source: 'sample', seeded: true, internalId: id },
    });
    id += 1;
  }

  return {
    version: 1,
    seededAt: today,
    timezone,
    services,
    staff,
    customers,
    bookings,
    nextId: id,
  };
}

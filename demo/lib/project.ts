import { toInstant } from './datetime';
import { shiftDate, todayIn } from './calendar/agenda';
import { loadRecords, saveRecords, type UbRecord } from './record-sync';

/**
 * "Your project": the salon's own booking platform, which uses unibooking to
 * reach providers. In this demo it lives in the browser; in a real app it is
 * that platform's database.
 *
 * Staff and services are the project records the Mapping tab links to a
 * booking provider (record-sync.ts). This module adds what calendar sync
 * needs: the project's own bookings, and -- per calendar provider, never
 * shared between providers -- which calendar each staff member / service is
 * linked to, which event copies which booking, and the busy time read back.
 */

export type ProjectBooking = {
  id: string;
  /** UbRecord ids from the project store. */
  staffId?: string;
  serviceId?: string;
  customer?: string;
  start: string;
  end: string;
  status: 'confirmed' | 'cancelled';
  /** Bumped on every change made in the project. */
  updatedAt: string;
};

/** A booking's copy in a calendar, as last written or read. */
export type CalendarCopy = {
  calendarId: string;
  eventId: string;
  start: string;
  end: string;
  title: string;
};

/** An event in a linked calendar that is not one of our copies. */
export type BusyBlock = { calendarId: string; eventId: string; title: string; start: string; end: string };

/** Everything calendar sync keeps for ONE calendar provider. */
export type CalendarLinks = {
  /** Staff or service id -> calendar id. A booking uses its staff member's
   *  calendar, else its service's, else `all`. */
  staff: Record<string, string>;
  services: Record<string, string>;
  all?: string;
  /** Project booking id -> its copy. */
  copies: Record<string, CalendarCopy>;
  busy: BusyBlock[];
  lastSyncedAt?: string;
};

export const emptyCalendarLinks = (): CalendarLinks => ({
  staff: {},
  services: {},
  copies: {},
  busy: [],
});

export type Project = {
  bookings: ProjectBooking[];
  /** Keyed by calendar provider id ('google' | 'outlook' | 'apple'). */
  calendars: Record<string, CalendarLinks>;
  nextId: number;
};

export const PROJECT_KEY = 'unibooking:demo:project:v1';

export function loadProject(storage?: Storage): Project {
  try {
    const raw = (storage ?? localStorage).getItem(PROJECT_KEY);
    const p = raw ? JSON.parse(raw) : null;
    if (p && Array.isArray(p.bookings) && p.calendars && typeof p.nextId === 'number') {
      return p as Project;
    }
  } catch {
    // Blocked or corrupt storage: start empty.
  }
  return { bookings: [], calendars: {}, nextId: 1 };
}

export function saveProject(p: Project, storage?: Storage): void {
  try {
    (storage ?? localStorage).setItem(PROJECT_KEY, JSON.stringify(p));
  } catch {
    // Quota or blocked storage: it just won't survive a reload.
  }
}

export function clearProject(storage?: Storage): void {
  try {
    (storage ?? localStorage).removeItem(PROJECT_KEY);
  } catch {
    // Nothing to clear.
  }
}

export function linksFor(p: Project, provider: string): CalendarLinks {
  return { ...emptyCalendarLinks(), ...p.calendars[provider] };
}

export function withLinks(p: Project, provider: string, links: CalendarLinks): Project {
  return { ...p, calendars: { ...p.calendars, [provider]: links } };
}

export function addBooking(
  p: Project,
  b: Omit<ProjectBooking, 'id' | 'updatedAt' | 'status'>,
  now = () => new Date().toISOString(),
): Project {
  return {
    ...p,
    nextId: p.nextId + 1,
    bookings: [
      ...p.bookings,
      { ...b, id: `pb_${p.nextId}`, status: 'confirmed', updatedAt: now() },
    ],
  };
}

export function changeBooking(
  p: Project,
  id: string,
  change: Partial<Pick<ProjectBooking, 'start' | 'end' | 'status' | 'customer'>>,
  now = () => new Date().toISOString(),
): Project {
  return {
    ...p,
    bookings: p.bookings.map((b) => (b.id === id ? { ...b, ...change, updatedAt: now() } : b)),
  };
}

export function deleteBooking(p: Project, id: string): Project {
  return { ...p, bookings: p.bookings.filter((b) => b.id !== id) };
}

/* ── Demo data ─────────────────────────────────────────────────────────── */

const DEMO_STAFF: [string, string][] = [
  ['Maya Chen', 'maya@glowstudio.test'],
  ['Leo Park', 'leo@glowstudio.test'],
  ['Sofia Rossi', 'sofia@glowstudio.test'],
];

const DEMO_SERVICES: [string, number, number][] = [
  ['Manicure', 45, 3500],
  ['Pedicure', 60, 5000],
  ['Eyebrow shaping', 20, 2000],
  ['Eyelash lift', 50, 6500],
];

/** [day offset, HH:MM, staff index, service index, customer] */
const DEMO_BOOKINGS: [number, string, number, number, string][] = [
  [1, '10:00', 0, 0, 'Priya R.'],
  [1, '11:30', 1, 1, 'Marcus W.'],
  [2, '09:30', 2, 2, 'Ines C.'],
  [2, '14:00', 0, 3, 'Jonah K.'],
  [3, '12:00', 1, 0, 'Hana S.'],
  [4, '16:00', 2, 1, 'Omar T.'],
];

/**
 * A small salon: staff, services and a week of bookings, so calendar sync has
 * something to show. Adds to what the project already has (by name, so it is
 * safe to run twice) and returns both stores.
 */
export function seedDemoProject(timezone: string): { project: Project; records: ReturnType<typeof loadRecords> } {
  let records = loadRecords();
  let project = loadProject();
  const ensure = (kind: UbRecord['kind'], name: string, extra: Partial<UbRecord>): string => {
    const found = records.records.find((r) => r.kind === kind && r.name === name);
    if (found) return found.id;
    const id = `ub_${records.nextId}`;
    records = {
      nextId: records.nextId + 1,
      records: [...records.records, { id, kind, name, active: true, links: {}, ...extra }],
    };
    return id;
  };
  const staff = DEMO_STAFF.map(([name, email]) => ensure('staff', name, { email }));
  const services = DEMO_SERVICES.map(([name, durationMinutes, amount]) =>
    ensure('services', name, { durationMinutes, price: { amount, currency: 'USD' } }),
  );
  const today = todayIn(timezone);
  for (const [day, time, si, vi, customer] of DEMO_BOOKINGS) {
    const start = toInstant(shiftDate(today, day), time, timezone);
    const exists = project.bookings.some(
      (b) => b.start === start && b.staffId === staff[si] && b.customer === customer,
    );
    if (exists) continue;
    const mins = DEMO_SERVICES[vi]![1];
    const end = new Date(Date.parse(start) + mins * 60_000).toISOString();
    project = addBooking(project, {
      staffId: staff[si]!,
      serviceId: services[vi]!,
      customer,
      start,
      end,
    });
  }
  saveRecords(records);
  saveProject(project);
  return { project, records };
}

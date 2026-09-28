import type {
  AvailabilitySlot,
  Booking,
  ClassSession,
  Service,
  ServiceCategory,
  Staff,
  TimeRange,
} from '../types';
import {
  asArray,
  asRecord,
  bookingsWithinRange,
  decimalToMinorUnits,
  defineAdapter,
  probeConnection,
  reqString,
} from '../adapter-kit';
import { UnibookingError } from '../errors';
import { assertValidRange, endFromDuration } from '../time';
import { slotsWithinRange } from '../availability';

/**
 * Acuity Scheduling. Auth is either HTTP Basic (account user id + API key) or,
 * for multi-account OAuth2 apps, a bearer access token. "Calendars" act as
 * staff/resources; "appointment types" are services.
 */
export type AcuityCredentials = (
  | /** HTTP Basic: your account's user id + API key. */
    { userId: string; apiKey: string }
    /** OAuth2 bearer, for apps acting on behalf of a connected account. */
  | { accessToken: string }
) & {
  /** ISO-4217 code for the account's currency, e.g. `'USD'`.
   *
   *  Acuity returns a bare `price` on appointment types with no currency
   *  alongside it, and a `Money` without a currency is not usable. Supply this
   *  and `listServices` fills in `Service.price`; omit it and `price` is left
   *  undefined rather than guessed, with the raw value still in `raw`. */
  currency?: string;
};

const BASE = 'https://acuityscheduling.com/api/v1/';

// --- Classes ---------------------------------------------------------------
//
// Acuity has no per-occurrence class id: `/availability/classes` identifies an
// occurrence by appointmentTypeID + datetime, and enrolling is a POST to
// `/appointments` with that same pair. So `ClassSession.id` carries both, which
// is exactly the contract the `Service.id` doc-comment sets out: the canonical
// id is whatever that provider's write path accepts.
const CLASS_ID_SEP = '@';

function classSessionId(appointmentTypeId: string, datetime: string): string {
  return `${appointmentTypeId}${CLASS_ID_SEP}${datetime}`;
}

function parseClassSessionId(id: string): { appointmentTypeId: string; datetime: string } {
  const cut = id.indexOf(CLASS_ID_SEP);
  // The datetime itself contains no '@', so the FIRST separator is the split.
  if (cut <= 0 || cut === id.length - 1) {
    throw new UnibookingError({
      provider: 'acuity',
      code: 'INVALID_INPUT',
      message: `malformed class id "${id}"; expected "<appointmentTypeID>@<datetime>"`,
    });
  }
  return { appointmentTypeId: id.slice(0, cut), datetime: id.slice(cut + 1) };
}

/** `YYYY-MM` months spanned by a range, as Acuity's `month` parameter wants
 *  one request per month. Capped so an absurd range cannot fan out unbounded. */
const MAX_MONTHS = 12;

function monthsIn(range: TimeRange | undefined): string[] {
  const startMs = range ? Date.parse(range.start) : Date.now();
  const endMs = range ? Date.parse(range.end) : startMs;
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return [monthKey(Date.now())];
  const months: string[] = [];
  const cursor = new Date(
    Date.UTC(new Date(startMs).getUTCFullYear(), new Date(startMs).getUTCMonth(), 1),
  );
  while (cursor.getTime() <= endMs && months.length < MAX_MONTHS) {
    months.push(monthKey(cursor.getTime()));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months.length ? months : [monthKey(startMs)];
}

function monthKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function toClassSession(raw: unknown, currency?: string): ClassSession {
  const k = asRecord(raw, 'acuity', 'class');
  const start = normalizeInstant(k.time);
  if (start === undefined) {
    throw new UnibookingError({
      provider: 'acuity',
      code: 'UPSTREAM',
      message: 'class is missing time',
    });
  }
  const duration = Number(k.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new UnibookingError({
      provider: 'acuity',
      code: 'UPSTREAM',
      message: `class at ${start} has no positive duration to derive an end`,
    });
  }
  const appointmentTypeId = reqString(
    String(k.appointmentTypeID ?? ''),
    'acuity',
    'class.appointmentTypeID',
  );
  const capacity = toNum(k.slots);
  const remaining = toNum(k.slotsAvailable);
  const amount = decimalToMinorUnits(k.price);
  const name = typeof k.name === 'string' ? k.name : undefined;
  return {
    id: classSessionId(appointmentTypeId, start),
    provider: 'acuity',
    serviceId: appointmentTypeId,
    title: name && name.trim() ? name : 'Class',
    range: {
      start,
      end: endFromDuration(start, duration),
      ...(typeof k.timezone === 'string' && k.timezone ? { timezone: k.timezone } : {}),
    },
    ...(k.calendarID !== undefined ? { staffId: String(k.calendarID) } : {}),
    ...(typeof k.calendar === 'string' && k.calendar ? { location: k.calendar } : {}),
    ...(capacity !== undefined ? { capacity } : {}),
    ...(capacity !== undefined && remaining !== undefined
      ? { booked: Math.max(0, capacity - remaining) }
      : {}),
    ...(remaining !== undefined ? { available: remaining } : {}),
    // `slotsAvailable` is Acuity's own remaining count: authoritative.
    full: remaining !== undefined ? remaining <= 0 : false,
    status: Date.parse(start) < Date.now() ? 'completed' : 'scheduled',
    ...(amount !== undefined && currency ? { price: { amount, currency } } : {}),
    raw: k,
  };
}

function toNum(v: unknown): number | undefined {
  const n = Number(v);
  return v === undefined || v === null || v === '' || !Number.isFinite(n) ? undefined : n;
}

/** Acuity returns offsets like `-0700` (no colon); make them RFC3339. */
function normalizeInstant(s: unknown): string | undefined {
  if (typeof s !== 'string' || !s) return undefined;
  return s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
}

/** The offset token (`Z` or `±HH:MM`) of an RFC3339 instant. */
function offsetToken(iso: string): string {
  const m = /([+-]\d{2}:\d{2}|Z)$/.exec(iso);
  return m ? m[1]! : 'Z';
}

/** Acuity's `availability/times` is single-date, so a multi-day range needs one
 *  call per day. Bound the fan-out so an over-wide range can't issue hundreds of
 *  requests (Vagaro 31, Setmore 62: same idea, same contract). */
const MAX_AVAILABILITY_DAYS = 31;

/** The `YYYY-MM-DD` dates (in `range.start`'s offset) that the window overlaps.
 *  Past the cap this throws: exhausting the loop and returning the first N days
 *  answered a quarter-long query with a month of slots and no indication that
 *  the rest had been dropped. */
function datesInRange(startIso: string, endIso: string, cap = MAX_AVAILABILITY_DAYS): string[] {
  const offset = offsetToken(startIso);
  const endMs = Date.parse(endIso);
  const dates: string[] = [];
  let dateStr = startIso.slice(0, 10);
  for (;;) {
    const dayStartMs = Date.parse(`${dateStr}T00:00:00${offset}`);
    if (dayStartMs >= endMs) break;
    if (dates.length >= cap) {
      throw new UnibookingError({
        provider: 'acuity',
        code: 'INVALID_INPUT',
        message: `Acuity availability is queried one day at a time; ranges may not exceed ${cap} days`,
      });
    }
    dates.push(dateStr);
    const d = new Date(`${dateStr}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    dateStr = d.toISOString().slice(0, 10);
  }
  return dates.length > 0 ? dates : [startIso.slice(0, 10)];
}

function splitName(name: string): { firstName: string; lastName: string } {
  const [first, ...rest] = name.trim().split(/\s+/);
  return { firstName: first ?? name, lastName: rest.join(' ') };
}

/** Acuity marks firstName, lastName and email required on POST /appointments:
 *  email being "optional for admins" only. We send `admin=true` exactly when a
 *  staffId is present, so email is enforced only on the non-admin path, which is
 *  the one that previously produced an opaque upstream 400. */
function requireCustomerFields(input: {
  staffId?: string;
  customer?: { name?: string; email?: string };
}): { firstName: string; lastName: string; email?: string } {
  const name = input.customer?.name;
  const email = input.customer?.email;
  const isAdmin = input.staffId !== undefined;
  if (!name) {
    throw new UnibookingError({
      provider: 'acuity',
      code: 'INVALID_INPUT',
      message: 'Acuity requires customer.name (firstName/lastName) to create an appointment',
    });
  }
  if (!email && !isAdmin) {
    throw new UnibookingError({
      provider: 'acuity',
      code: 'INVALID_INPUT',
      message:
        'Acuity requires customer.email to create an appointment ' +
        '(it is optional only for admin bookings, i.e. when a staffId is supplied)',
    });
  }
  return { ...splitName(name), ...(email ? { email } : {}) };
}

function toBooking(raw: unknown): Booking {
  const a = asRecord(raw, 'acuity', 'appointment');
  const start = normalizeInstant(a.datetime);
  if (start === undefined) {
    throw new UnibookingError({
      provider: 'acuity',
      code: 'UPSTREAM',
      message: 'appointment is missing datetime',
    });
  }
  const duration = Number(a.duration);
  // A missing/zero duration would yield end === start (violating end > start);
  // surface it as UPSTREAM rather than emit a zero-length booking (matches Square).
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new UnibookingError({
      provider: 'acuity',
      code: 'UPSTREAM',
      message: `appointment ${String(a.id ?? '')} has no positive duration to derive an end`,
    });
  }
  const end = endFromDuration(start, duration);
  const name = `${a.firstName ?? ''} ${a.lastName ?? ''}`.trim();
  const customer =
    name || a.email || a.phone
      ? {
          ...(name ? { name } : {}),
          ...(a.email ? { email: a.email } : {}),
          ...(a.phone ? { phone: a.phone } : {}),
        }
      : undefined;
  return {
    id: reqString(String(a.id ?? ''), 'acuity', 'appointment.id'),
    provider: 'acuity',
    title: typeof a.type === 'string' && a.type ? a.type : name || 'Appointment',
    range: {
      start,
      end,
      ...(typeof a.timezone === 'string' && a.timezone ? { timezone: a.timezone } : {}),
    },
    ...(a.calendarID !== undefined ? { staffId: String(a.calendarID) } : {}),
    ...(a.appointmentTypeID !== undefined ? { serviceId: String(a.appointmentTypeID) } : {}),
    ...(customer ? { customer } : {}),
    // A no-show IS a cancelled appointment in Acuity's model (`noShow` rides on
    // top of `canceled`), so check the more specific flag first: testing
    // `canceled` first made 'no_show' unreachable on real data.
    status: a.noShow === true ? 'no_show' : a.canceled === true ? 'cancelled' : 'confirmed',
    raw: a,
  };
}

function parseAcuityError(
  _status: number,
  body: unknown,
): { providerCode?: string; message?: string } {
  const b = body as any;
  if (!b || typeof b !== 'object') return {};
  return {
    ...(typeof b.message === 'string' ? { message: b.message } : {}),
    ...(typeof b.error === 'string' ? { providerCode: b.error } : {}),
  };
}

function requireService(serviceId: string | undefined): string {
  if (!serviceId) {
    throw new UnibookingError({
      provider: 'acuity',
      code: 'INVALID_INPUT',
      message: 'Acuity requires a serviceId (appointmentTypeID)',
    });
  }
  return serviceId;
}

export const acuity = defineAdapter<AcuityCredentials>({
  id: 'acuity',
  capabilities: {
    availability: true,
    staff: true,
    services: true,
    webhooks: true,
    idempotency: false,
    customers: false,
    customerDirectory: false,
    customerWrite: false,
    customerDelete: false,
    serviceCatalog: true,
    staffDirectory: true,
    serviceCatalogWrite: false,
    staffDirectoryWrite: false,
    staffDeactivate: false,
    staffDelete: false,
    serviceDelete: false,
    calendarList: false,
    calendarWrite: false,
    staffServiceAssignment: true,
    staffServiceAssignmentWrite: false,
    serviceCategories: true,
    businessHours: false,
    classCatalog: true,
    classEnrollment: true,
    classWaitlist: false,
    changeFeed: false,
    changeNotifications: false,
    versionedWrites: false,
  },
  baseUrl: BASE,
  // OAuth2 apps send a bearer token; single-account keys use HTTP Basic.
  auth: (c) => ({
    headers: {
      authorization:
        'accessToken' in c ? `Bearer ${c.accessToken}` : `Basic ${btoa(`${c.userId}:${c.apiKey}`)}`,
    },
  }),
  parseError: parseAcuityError,
  build: (http) => {
    /** Occurrences of one class appointment type across the given months. */
    const classesForType = async (
      c: AcuityCredentials,
      appointmentTypeId: string,
      months: string[],
    ): Promise<ClassSession[]> => {
      const pages = await Promise.all(
        months.map((month) =>
          http.request(c, {
            path: 'availability/classes',
            query: { appointmentTypeID: appointmentTypeId, month, includeUnavailable: true },
          }),
        ),
      );
      return pages.flatMap((res) =>
        asArray(res, 'acuity', 'availability/classes').map((raw) =>
          toClassSession(raw, c.currency),
        ),
      );
    };

    /** Appointment type ids Acuity flags as classes. */
    const classTypeIds = async (c: AcuityCredentials): Promise<string[]> => {
      const res = await http.request(c, { path: 'appointment-types' });
      return asArray(res, 'acuity', 'appointment-types')
        .map((raw) => asRecord(raw, 'acuity', 'appointmentType'))
        .filter((t) => t.class === true)
        .map((t) => String(t.id ?? ''))
        .filter((id) => id !== '');
    };

    const fetchClass = async (id: string): Promise<ClassSession> => {
      const { appointmentTypeId, datetime } = parseClassSessionId(id);
      const c = await http.resolve();
      const found = (
        await classesForType(c, appointmentTypeId, monthsIn({ start: datetime, end: datetime }))
      ).find((k) => k.id === id);
      if (found === undefined) {
        throw new UnibookingError({
          provider: 'acuity',
          code: 'NOT_FOUND',
          message: `class ${id} not found`,
        });
      }
      return found;
    };

    return {
      async listClasses(query) {
        const c = await http.resolve();
        const months = monthsIn(query?.range);
        // Acuity's classes endpoint is per appointment type, so without an
        // explicit serviceId every class-flagged type has to be asked. Bounded by
        // the number of class types the account has, not by the range.
        const typeIds = query?.serviceId ? [query.serviceId] : await classTypeIds(c);
        const found = (
          await Promise.all(typeIds.map((id) => classesForType(c, id, months)))
        ).flat();
        const filtered = found.filter((k) => {
          if (query?.staffId && k.staffId !== query.staffId) return false;
          if (query?.range) {
            // Overlap, not containment: a class that starts before the window but
            // runs into it is still in the window.
            if (Date.parse(k.range.start) >= Date.parse(query.range.end)) return false;
            if (Date.parse(k.range.end) <= Date.parse(query.range.start)) return false;
          }
          return true;
        });
        filtered.sort((a, b) => Date.parse(a.range.start) - Date.parse(b.range.start));
        return { classes: filtered };
      },

      getClass: fetchClass,

      async enrollInClass(input) {
        const { appointmentTypeId } = parseClassSessionId(input.classId);
        const c = await http.resolve();
        const session = await fetchClass(input.classId);
        // Acuity has no class waitlist, so a full class is always a hard
        // conflict: `allowWaitlist` cannot rescue it. Saying so explicitly
        // beats letting Acuity reject the POST with a generic message.
        if (session.full) {
          throw new UnibookingError({
            provider: 'acuity',
            code: 'CONFLICT',
            message:
              input.allowWaitlist === true
                ? `class ${input.classId} is full and Acuity has no waitlist`
                : `class ${input.classId} is full`,
          });
        }
        const res = await http.request(c, {
          method: 'POST',
          path: 'appointments',
          body: {
            appointmentTypeID: appointmentTypeId,
            datetime: session.range.start,
            ...requireCustomerFields({ customer: input.customer }),
            ...(input.customer.phone ? { phone: input.customer.phone } : {}),
            ...(input.notes ? { notes: input.notes } : {}),
          },
        });
        return { ...toBooking(res), classId: input.classId };
      },

      async listServices(query) {
        const c = await http.resolve();
        // Acuity returns a bare array, not an envelope, and takes no paging.
        const res = await http.request(c, { path: 'appointment-types' });
        const services = asArray(res, 'acuity', 'appointment-types').map((raw): Service => {
          const t = asRecord(raw, 'acuity', 'appointmentType');
          const amount = decimalToMinorUnits(t.price);
          const duration = Number(t.duration);
          return {
            id: reqString(String(t.id ?? ''), 'acuity', 'appointmentType.id'),
            name: reqString(String(t.name ?? ''), 'acuity', 'appointmentType.name'),
            ...(t.description ? { description: String(t.description) } : {}),
            ...(Number.isFinite(duration) && duration > 0 ? { durationMinutes: duration } : {}),
            ...(amount !== undefined && c.currency
              ? { price: { amount, currency: c.currency } }
              : {}),
            ...(t.category
              ? { categoryName: String(t.category), categoryId: String(t.category) }
              : {}),
            // Acuity's "calendars" are its staff/resources, and an appointment
            // type lists the ones that offer it. That is the assignment link.
            ...(Array.isArray(t.calendarIDs)
              ? { staffIds: t.calendarIDs.map((id: unknown) => String(id)) }
              : {}),
            // Acuity's own flag; an inactive type cannot be booked.
            active: t.active !== false,
            raw: t,
          };
        });
        // Filtered locally: Acuity's appointment-types endpoint takes no
        // filters at all and returns the whole catalog either way.
        const filtered = services.filter((sv) => {
          if (query?.staffId && !(sv.staffIds?.includes(query.staffId) ?? false)) return false;
          if (query?.categoryId && sv.categoryId !== query.categoryId) return false;
          return true;
        });
        return { services: filtered };
      },

      async listCategories() {
        const c = await http.resolve();
        const res = await http.request(c, { path: 'appointment-types' });
        // Acuity has no category objects, only a name string on each type. The
        // name is therefore also the id, which is why `Service.categoryId` is
        // set to that same string -- the two have to join up.
        const seen = new Map<string, ServiceCategory>();
        for (const raw of asArray(res, 'acuity', 'appointment-types')) {
          const t = asRecord(raw, 'acuity', 'appointmentType');
          const name = typeof t.category === 'string' ? t.category.trim() : '';
          if (!name || seen.has(name)) continue;
          seen.set(name, { id: name, name, provider: 'acuity' as const, raw: { category: name } });
        }
        return { categories: [...seen.values()].sort((a, b) => a.name.localeCompare(b.name)) };
      },

      async listStaff() {
        const c = await http.resolve();
        // Acuity models staff as calendars, and `staffId` IS the calendarID that
        // createBooking sends, so the id round-trips.
        const res = await http.request(c, { path: 'calendars' });
        const staff = asArray(res, 'acuity', 'calendars').map((raw): Staff => {
          const k = asRecord(raw, 'acuity', 'calendar');
          return {
            id: reqString(String(k.id ?? ''), 'acuity', 'calendar.id'),
            name: reqString(String(k.name ?? ''), 'acuity', 'calendar.name'),
            ...(k.email ? { email: String(k.email) } : {}),
            // Calendars carry no active/inactive flag.
            active: true,
            raw: k,
          };
        });
        return { staff };
      },

      async checkConnection() {
        const c = await http.resolve();
        return probeConnection('acuity', async () => {
          const res = await http.request(c, { path: 'me' });
          const name = [res?.firstName, res?.lastName].filter(Boolean).join(' ');
          return {
            account: {
              ...(res?.id ? { id: String(res.id) } : {}),
              ...(name ? { name } : {}),
              ...(res?.email ? { email: String(res.email) } : {}),
            },
            raw: res,
          };
        });
      },
      async createBooking(input) {
        assertValidRange(input.range, 'acuity');
        const c = await http.resolve();
        const res = await http.request(c, {
          method: 'POST',
          path: 'appointments',
          // `admin=true` bypasses availability checks and unlocks `notes`, but Acuity
          // REQUIRES a valid `calendarID` in admin mode, so only enable it when a
          // staffId (calendarID) is present; otherwise Acuity picks the calendar and
          // validates availability normally.
          query: {
            ...(input.staffId ? { admin: true } : {}),
            ...(input.notify === false ? { noEmail: true } : {}),
          },
          body: {
            appointmentTypeID: requireService(input.serviceId),
            datetime: input.range.start,
            ...(input.staffId ? { calendarID: input.staffId } : {}),
            ...requireCustomerFields(input),
            ...(input.customer?.phone ? { phone: input.customer.phone } : {}),
            ...input.providerOptions,
          },
        });
        return toBooking(res);
      },

      async getBooking(id) {
        const c = await http.resolve();
        const res = await http.request(c, { path: `appointments/${encodeURIComponent(id)}` });
        return toBooking(res);
      },

      async updateBooking(id, input) {
        const c = await http.resolve();
        // Acuity's plain PUT silently ignores anything outside its white-list, so
        // reject the inputs it cannot honor rather than pretend they applied.
        if (input.status !== undefined) {
          throw new UnibookingError({
            provider: 'acuity',
            code: 'INVALID_INPUT',
            message:
              input.status === 'cancelled'
                ? 'Acuity appointment status is not writable; use cancelBooking() to cancel'
                : `Acuity appointment status is not writable (cannot set "${input.status}")`,
          });
        }
        if (input.serviceId !== undefined) {
          throw new UnibookingError({
            provider: 'acuity',
            code: 'UNSUPPORTED',
            message:
              'Acuity cannot change an appointment type on an existing appointment; ' +
              'cancel and rebook, or use the change-type flow via providerOptions',
          });
        }
        if (input.staffId !== undefined && input.range === undefined) {
          throw new UnibookingError({
            provider: 'acuity',
            code: 'UNSUPPORTED',
            message:
              'Acuity can only reassign the calendar (staffId) as part of a reschedule; ' +
              'pass a range alongside staffId',
          });
        }
        if (input.range) {
          assertValidRange(input.range, 'acuity');
          // Reschedule can also reassign the calendar (staff); Acuity derives the
          // end from the appointment type, so only the start is sent.
          const res = await http.request(c, {
            method: 'PUT',
            path: `appointments/${encodeURIComponent(id)}/reschedule`,
            query: { ...(input.notify === false ? { noEmail: true } : {}) },
            body: {
              datetime: input.range.start,
              ...(input.staffId ? { calendarID: input.staffId } : {}),
              ...input.providerOptions,
            },
          });
          return toBooking(res);
        }
        // Non-reschedule edits: map the fields Acuity accepts on a plain PUT.
        // (Changing staff/service requires the reschedule/change-type flows, so
        // those must come via input.range or providerOptions.)
        const res = await http.request(c, {
          method: 'PUT',
          path: `appointments/${encodeURIComponent(id)}`,
          // `notes` may only be written by an admin, without admin=true Acuity
          // silently drops it.
          query: { admin: true },
          body: {
            ...(input.title !== undefined ? { notes: input.title } : {}),
            ...input.providerOptions,
          },
        });
        return toBooking(res);
      },

      async cancelBooking(id, options) {
        const c = await http.resolve();
        await http.request(c, {
          method: 'PUT',
          path: `appointments/${encodeURIComponent(id)}/cancel`,
          query: {
            // Without admin=true, a cancellation past the account's client-cancel
            // window fails with cancel_too_close / cancel_not_allowed, even on an
            // admin key. Server-side API calls are administrative by nature.
            admin: true,
            ...(options?.notify === false ? { noEmail: true } : {}),
          },
          body: { ...(options?.reason ? { cancelNote: options.reason } : {}) },
          parse: 'none',
        });
      },

      async listBookings(query) {
        assertValidRange(query.range, 'acuity');
        const c = await http.resolve();
        const res = await http.request(c, {
          path: 'appointments',
          query: {
            minDate: query.range.start.slice(0, 10),
            maxDate: query.range.end.slice(0, 10),
            max: query.limit ?? 100,
            // Acuity "calendar" is the closest thing to a staff filter.
            calendarID: query.staffId,
            // `noShow` rides on top of `canceled` (see `toBooking`), so a no_show
            // query has to ask for cancelled rows too: leaving the default
            // excluded exactly the appointments it was looking for.
            canceled: query.status === 'cancelled' || query.status === 'no_show' ? true : undefined,
          },
        });
        // minDate/maxDate are whole dates in the business timezone, so Acuity
        // returns the entire end day (and part of the start day) regardless of the
        // range's times. Trim to the instants the caller actually asked for.
        const bookings = bookingsWithinRange(
          asArray(res, 'acuity', 'appointments').map(toBooking),
          query.range,
        );
        return { bookings };
      },

      async searchAvailability(query): Promise<AvailabilitySlot[]> {
        assertValidRange(query.range, 'acuity');
        // Acuity's availability/times returns start times only; without a duration
        // every slot would be zero-length. Require one (as calendly/zenoti/setmore do).
        if (typeof query.durationMinutes !== 'number' || query.durationMinutes <= 0) {
          throw new UnibookingError({
            provider: 'acuity',
            code: 'INVALID_INPUT',
            message:
              'Acuity available times are start-only; pass a positive durationMinutes to size each slot',
          });
        }
        const durationMinutes = query.durationMinutes;
        const serviceId = requireService(query.serviceId);
        const c = await http.resolve();
        // `availability/times` returns one date's slots, so page a call per day the
        // window overlaps and keep only slots that actually fall inside the range.
        const out: AvailabilitySlot[] = [];
        for (const date of datesInRange(query.range.start, query.range.end)) {
          const res = await http.request(c, {
            path: 'availability/times',
            query: { date, appointmentTypeID: serviceId, calendarID: query.staffId },
          });
          for (const t of asArray(res, 'acuity', 'availability/times')) {
            const start = normalizeInstant(t.time);
            if (start === undefined) continue;
            out.push({
              start,
              end: endFromDuration(start, durationMinutes),
              ...(query.staffId ? { staffId: query.staffId } : {}),
              raw: t,
            });
          }
        }
        return slotsWithinRange(out, query.range);
      },
    };
  },
});

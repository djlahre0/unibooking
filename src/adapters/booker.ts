import type {
  Booking,
  BookingStatus,
  ClassSession,
  HoursPeriod,
  Money,
  Service,
  ServiceCategory,
  Staff,
  Weekday,
} from '../types';
import {
  asArray,
  asRecord,
  bookingsWithinRange,
  defineAdapter,
  probeConnection,
  reqString,
  unsupported,
} from '../adapter-kit';
import { UnibookingError } from '../errors';
import { assertValidRange, formatWithOffset } from '../time';
import { localToInstant, zoneOffsetMinutes } from '../tz';

/**
 * Booker (Mindbody Booker, booker.com) — salon/spa platform, API v4.1 with v5
 * auth.
 *
 * Auth is a bearer access token **plus** an API subscription key header. Mint
 * the token with `POST /v5/auth/connect/token` (form-encoded
 * `grant_type=client_credentials` + `client_id`/`client_secret`/`scope`, with
 * the same `Ocp-Apim-Subscription-Key` header) — see `unibooking/oauth/booker`.
 * This package never stores it.
 *
 * IMPORTANT — two time hazards, both load-bearing:
 *
 * 1. Booker serialises datetimes in .NET form, `/Date(1758067200000-0500)/`.
 * 2. **Booker's server always speaks Eastern Time.** That epoch, rendered in
 *    `America/New_York`, is the *business's local wall clock* — not the real
 *    instant. So recovering a true instant means rendering the epoch in Eastern,
 *    taking those wall-clock digits, and re-anchoring them in the location's own
 *    zone. Writes go back through the same transform in reverse.
 *
 * Supply the location's IANA `timezone`; without it the wall clock is anchored
 * in Eastern, which is correct only for Eastern-zone locations.
 *
 * Endpoint paths, model field names, the `/Date(...)` format, the Eastern-time
 * rule and the `Results` envelope are all taken from the long-running
 * `HireFrederick/booker_ruby` client. Appointment (non-class) availability is
 * deliberately absent: that client never implements it, so there is no
 * trustworthy shape to copy and `searchAvailability` reports UNSUPPORTED rather
 * than guess. Validate against a live Booker account before production.
 */
export type BookerCredentials = {
  /** Bearer token from `POST /v5/auth/connect/token`. */
  accessToken: string;
  /** Sent as `Ocp-Apim-Subscription-Key`. Booker rejects calls without it. */
  subscriptionKey: string;
  locationId: string;
  /** Location IANA zone (e.g. `America/Chicago`). Strongly recommended — see
   *  the Eastern-time note above. Defaults to `America/New_York`, which is
   *  Booker's own server zone and so a no-op transform. */
  timezone?: string;
};

const BASE = 'https://api.booker.com/';

/** Booker's server zone. Every datetime it emits is wall clock in this zone. */
const SERVER_ZONE = 'America/New_York';

const WEEKDAYS: Weekday[] = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

function locationZone(c: BookerCredentials): string {
  return c.timezone ?? SERVER_ZONE;
}

/** Epoch millis out of `/Date(1758067200000-0500)/`. The trailing offset is
 *  Booker's own server offset and is deliberately ignored: the epoch already
 *  encodes the moment, and the offset would double-count it. */
function epochOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const dotNet = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(value.trim());
  if (dotNet) return Number(dotNet[1]);
  // Newer responses may already be ISO; accept those rather than fail.
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Booker datetime -> canonical instant, via the Eastern wall-clock rule. */
function toInstant(value: unknown, zone: string): string | undefined {
  const ms = epochOf(value);
  if (ms === undefined) return undefined;
  // An ISO string with a real offset is already an instant; only the .NET form
  // carries the Eastern-wall-clock convention.
  if (typeof value === 'string' && !value.startsWith('/Date(')) {
    return formatWithOffset(ms, 0);
  }
  const serverOffset = zoneOffsetMinutes(SERVER_ZONE, new Date(ms));
  if (serverOffset === null) return formatWithOffset(ms, 0);
  // Render in Eastern, strip the offset -> the business's local wall clock.
  const naive = formatWithOffset(ms, serverOffset).replace(/(Z|[+-]\d{2}:\d{2})$/, '');
  if (zone === SERVER_ZONE) return formatWithOffset(ms, serverOffset);
  const anchored = localToInstant(naive, zone, (at) => formatWithOffset(at, 0));
  return anchored ?? formatWithOffset(ms, serverOffset);
}

/** Canonical instant -> the `/Date(...)` form Booker expects, same rule inverted. */
function toBookerDate(instant: string, zone: string): string {
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) {
    throw new UnibookingError({
      provider: 'booker',
      code: 'INVALID_INPUT',
      message: `not a valid instant: "${instant}"`,
    });
  }
  const localOffset = zoneOffsetMinutes(zone, new Date(ms)) ?? 0;
  // Wall clock at the location...
  const naive = formatWithOffset(ms, localOffset).replace(/(Z|[+-]\d{2}:\d{2})$/, '');
  // ...re-read as if it were Eastern, which is how Booker wants to receive it.
  const asEastern = localToInstant(naive, SERVER_ZONE, (at) => formatWithOffset(at, 0));
  const epoch = asEastern !== undefined ? Date.parse(asEastern) : ms;
  return `/Date(${epoch})/`;
}

/** Booker's date-only parameters (FromStartDate / ToStartDate). */
function toBookerDay(instant: string, zone: string): string {
  const ms = Date.parse(instant);
  const offset = zoneOffsetMinutes(zone, new Date(ms)) ?? 0;
  return formatWithOffset(ms, offset).slice(0, 10);
}

function mapStatus(a: Record<string, unknown>): BookingStatus {
  if (a.IsCancelled === true) return 'cancelled';
  if (a.IsNoShow === true) return 'no_show';
  // `Status` is an int/enum whose spelling is not documented publicly; treat a
  // recognisable string form generously and fall back to confirmed, which is
  // what an appointment that is neither cancelled nor a no-show is.
  const s = a.Status;
  if (typeof s === 'string') {
    const t = s.toLowerCase();
    if (t.includes('cancel')) return 'cancelled';
    if (t.includes('noshow') || t.includes('no_show')) return 'no_show';
    if (t.includes('complete')) return 'completed';
    if (t.includes('pending') || t.includes('request')) return 'pending';
  }
  return 'confirmed';
}

function money(value: unknown): Money | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return undefined; // no currency to pair it with
  const p = value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  if (!p) return undefined;
  const amount = Number(p.Amount);
  const currency = typeof p.CurrencyCode === 'string' ? p.CurrencyCode : undefined;
  if (!Number.isFinite(amount) || !currency) return undefined;
  // Booker quotes a decimal major-unit amount; the canonical Money is minor units.
  return { amount: Math.round(amount * 100), currency };
}

function fullName(first: unknown, last: unknown): string {
  return [typeof first === 'string' ? first : '', typeof last === 'string' ? last : '']
    .filter(Boolean)
    .join(' ')
    .trim();
}

function toBooking(raw: unknown, zone: string): Booking {
  const a = asRecord(raw, 'booker', 'appointment');
  const start = toInstant(a.StartDateTime, zone);
  const end = toInstant(a.EndDateTime, zone);
  if (start === undefined || end === undefined) {
    throw new UnibookingError({
      provider: 'booker',
      code: 'UPSTREAM',
      message: 'appointment is missing StartDateTime/EndDateTime',
    });
  }
  const employee = asRecord(a.Employee ?? {}, 'booker', 'appointment.Employee');
  const customer = asRecord(a.Customer ?? {}, 'booker', 'appointment.Customer');
  const treatments = Array.isArray(a.AppointmentTreatments) ? a.AppointmentTreatments : [];
  const firstTreatment = asRecord(treatments[0] ?? {}, 'booker', 'appointmentTreatment');
  const treatment = asRecord(firstTreatment.Treatment ?? {}, 'booker', 'treatment');
  const customerName = fullName(customer.FirstName, customer.LastName);
  const title =
    typeof treatment.Name === 'string' && treatment.Name ? treatment.Name : 'Appointment';
  return {
    id: reqString(String(a.ID ?? ''), 'booker', 'appointment.ID'),
    provider: 'booker',
    title,
    range: { start, end, timezone: zone },
    ...(employee.ID !== undefined ? { staffId: String(employee.ID) } : {}),
    ...(treatment.ID !== undefined ? { serviceId: String(treatment.ID) } : {}),
    ...(a.CustomerID !== undefined || customerName || customer.Email
      ? {
          customer: {
            ...(a.CustomerID !== undefined ? { id: String(a.CustomerID) } : {}),
            ...(customerName ? { name: customerName } : {}),
            ...(typeof customer.Email === 'string' && customer.Email
              ? { email: customer.Email }
              : {}),
          },
        }
      : {}),
    status: mapStatus(a),
    ...(toInstant(a.DateCreated, zone) !== undefined
      ? { createdAt: toInstant(a.DateCreated, zone)! }
      : {}),
    raw: a,
  };
}

function toService(raw: unknown): Service {
  const t = asRecord(raw, 'booker', 'treatment');
  const duration = Number(t.TotalDuration ?? t.TreatmentDuration);
  const price = money(t.Price);
  const category = typeof t.Category === 'string' ? t.Category.trim() : '';
  const employeeIds = Array.isArray(t.EmployeeIDs)
    ? t.EmployeeIDs.map((id: unknown) => String(id))
    : undefined;
  return {
    id: reqString(String(t.ID ?? ''), 'booker', 'treatment.ID'),
    name: reqString(String(t.Name ?? ''), 'booker', 'treatment.Name'),
    ...(typeof t.Description === 'string' && t.Description ? { description: t.Description } : {}),
    ...(Number.isFinite(duration) && duration > 0 ? { durationMinutes: duration } : {}),
    ...(price ? { price } : {}),
    // Booker names categories without ids, so the name is the id — the same
    // choice Acuity forces, and it keeps `listCategories` joinable.
    ...(category ? { categoryId: category, categoryName: category } : {}),
    ...(employeeIds ? { staffIds: employeeIds } : {}),
    active: t.IsActive !== false,
    raw: t,
  };
}

function toStaff(raw: unknown): Staff {
  const e = asRecord(raw, 'booker', 'employee');
  const name = fullName(e.FirstName, e.LastName);
  const id = reqString(String(e.ID ?? ''), 'booker', 'employee.ID');
  return {
    id,
    name: name || id,
    ...(typeof e.MobilePhone === 'string' && e.MobilePhone ? { phone: e.MobilePhone } : {}),
    // Booker's Employee carries no active flag; everything it returns is live.
    active: true,
    raw: e,
  };
}

function toClassSession(raw: unknown, zone: string): ClassSession {
  const k = asRecord(raw, 'booker', 'classInstance');
  const start = toInstant(k.StartDateTime, zone);
  const end = toInstant(k.EndDateTime, zone);
  if (start === undefined || end === undefined) {
    throw new UnibookingError({
      provider: 'booker',
      code: 'UPSTREAM',
      message: 'class is missing StartDateTime/EndDateTime',
    });
  }
  const treatment = asRecord(k.Treatment ?? {}, 'booker', 'classInstance.Treatment');
  const teacher = asRecord(k.Teacher ?? {}, 'booker', 'classInstance.Teacher');
  const capacity = Number(k.TotalCapacity);
  const booked = Number(k.NumReserved);
  const hasCapacity = Number.isFinite(capacity) && capacity >= 0;
  const hasBooked = Number.isFinite(booked) && booked >= 0;
  const name = typeof treatment.Name === 'string' ? treatment.Name : '';
  const price = money(k.Price);
  return {
    id: reqString(String(k.ID ?? ''), 'booker', 'classInstance.ID'),
    provider: 'booker',
    ...(treatment.ID !== undefined ? { serviceId: String(treatment.ID) } : {}),
    title: name || 'Class',
    range: { start, end, timezone: zone },
    ...(teacher.ID !== undefined ? { staffId: String(teacher.ID) } : {}),
    ...(typeof k.RoomName === 'string' && k.RoomName ? { location: k.RoomName } : {}),
    ...(hasCapacity ? { capacity } : {}),
    ...(hasBooked ? { booked } : {}),
    ...(hasCapacity && hasBooked ? { available: Math.max(0, capacity - booked) } : {}),
    // `HasClassFilled` is Booker's own answer and can disagree with the counts
    // (members-only, not enrollable, already started) — prefer it, exactly as
    // the canonical `full` contract requires.
    full:
      k.HasClassFilled === true ||
      k.IsEnrollable === false ||
      (hasCapacity && hasBooked ? booked >= capacity : false),
    status: Date.parse(end) < Date.now() ? 'completed' : 'scheduled',
    ...(price ? { price } : {}),
    raw: k,
  };
}

/** Booker wraps list payloads in `Results`; single objects come back bare or
 *  under a model-named key, so both are tried. */
function results(res: any, key: string): unknown[] {
  if (Array.isArray(res?.Results)) return res.Results;
  if (Array.isArray(res?.[key])) return res[key];
  if (Array.isArray(res)) return res;
  return [];
}

function parseBookerError(_status: number, body: unknown): { message?: string } {
  const b = body as any;
  const msg = b?.ErrorMessage ?? b?.Message ?? b?.error_description ?? b?.error;
  return typeof msg === 'string' && msg ? { message: msg } : {};
}

/** Days either side of `now` covered by the id lookup, mirroring Mindbody's
 *  reasoning: Booker has no verified get-one path, so an id lookup has to scan
 *  a window, and a narrow one would report a real appointment as NOT_FOUND. */
const LOOKUP_WINDOW_DAYS = 400;

const NO_AVAILABILITY =
  'searchAvailability — Booker exposes appointment (non-class) time slots through an ' +
  'endpoint whose shape is not publicly documented, so this adapter will not guess at it. ' +
  'Class availability IS supported: use listClasses().';

export const booker = defineAdapter<BookerCredentials>({
  id: 'booker',
  capabilities: {
    // Class availability works; appointment slot search does not (see above).
    availability: false,
    staff: true,
    services: true,
    webhooks: false,
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
    businessHours: true,
    classCatalog: true,
    classEnrollment: true,
    classWaitlist: false,
    changeFeed: false,
    changeNotifications: false,
    versionedWrites: false,
  },
  baseUrl: BASE,
  auth: (c) => ({
    headers: {
      authorization: `Bearer ${c.accessToken}`,
      'Ocp-Apim-Subscription-Key': c.subscriptionKey,
    },
  }),
  parseError: parseBookerError,
  build: (http) => {
    const listAppointments = async (
      c: BookerCredentials,
      fromInstant: string,
      toInstant_: string,
      limit?: number,
      pageToken?: string,
    ) => {
      const zone = locationZone(c);
      const page = Number(pageToken ?? '1');
      return http.request(c, {
        method: 'POST',
        path: 'v4.1/merchant/appointments',
        body: {
          LocationID: c.locationId,
          FromStartDate: toBookerDay(fromInstant, zone),
          ToStartDate: toBookerDay(toInstant_, zone),
          UsePaging: true,
          PageSize: limit ?? 100,
          PageNumber: Number.isFinite(page) && page > 0 ? page : 1,
        },
      });
    };

    const fetchClasses = async (c: BookerCredentials, from: string, to: string) => {
      const zone = locationZone(c);
      const res = await http.request(c, {
        method: 'POST',
        path: 'v4.1/customer/availability/class',
        body: {
          LocationID: c.locationId,
          FromStartDateTime: toBookerDate(from, zone),
          ToStartDateTime: toBookerDate(to, zone),
          OnlyIfAvailable: false,
          ExcludeClosedDates: true,
        },
      });
      return results(res, 'ClassInstances').map((raw) => toClassSession(raw, zone));
    };

    const defaultWindow = (): { from: string; to: string } => {
      const now = Date.now();
      const span = 90 * 24 * 60 * 60 * 1000;
      return {
        from: new Date(now - span).toISOString(),
        to: new Date(now + span).toISOString(),
      };
    };

    return {
      async checkConnection() {
        const c = await http.resolve();
        return probeConnection('booker', async () => {
          const res = await http.request(c, {
            path: `v4.1/merchant/location/${encodeURIComponent(c.locationId)}`,
          });
          const location = asRecord(res?.Location ?? res ?? {}, 'booker', 'location');
          return {
            ...(location.ID !== undefined || location.Name !== undefined
              ? {
                  account: {
                    ...(location.ID !== undefined ? { id: String(location.ID) } : {}),
                    ...(typeof location.Name === 'string' ? { name: location.Name } : {}),
                  },
                }
              : {}),
            raw: res,
          };
        });
      },

      async createBooking(input) {
        assertValidRange(input.range, 'booker');
        const c = await http.resolve();
        const zone = locationZone(c);
        if (!input.serviceId) {
          throw new UnibookingError({
            provider: 'booker',
            code: 'INVALID_INPUT',
            message: 'Booker requires serviceId (TreatmentID)',
          });
        }
        const minutes = Math.round(
          (Date.parse(input.range.end) - Date.parse(input.range.start)) / 60_000,
        );
        const res = await http.request(c, {
          method: 'POST',
          path: 'v4.1/customer/appointment/create',
          body: {
            LocationID: c.locationId,
            ItineraryTimeSlotList: [
              {
                TreatmentTimeSlots: [
                  {
                    TreatmentID: input.serviceId,
                    StartDateTime: toBookerDate(input.range.start, zone),
                    Duration: minutes,
                    ...(input.staffId ? { EmployeeID: input.staffId } : {}),
                  },
                ],
              },
            ],
            Customer: {
              ...(input.customer?.id ? { CustomerID: input.customer.id } : {}),
              ...(input.customer?.email ? { Email: input.customer.email } : {}),
              ...(input.customer?.phone ? { MobilePhone: input.customer.phone } : {}),
              ...(input.customer?.name
                ? {
                    FirstName: input.customer.name.split(/\s+/)[0],
                    LastName: input.customer.name.split(/\s+/).slice(1).join(' ') || undefined,
                  }
                : {}),
            },
            ...input.providerOptions,
          },
        });
        return toBooking(res?.Appointment ?? res, zone);
      },

      async getBooking(id) {
        const c = await http.resolve();
        const zone = locationZone(c);
        const span = LOOKUP_WINDOW_DAYS * 24 * 60 * 60 * 1000;
        const res = await listAppointments(
          c,
          new Date(Date.now() - span).toISOString(),
          new Date(Date.now() + span).toISOString(),
          500,
        );
        const found = results(res, 'Appointments')
          .map((raw) => asRecord(raw, 'booker', 'appointment'))
          .find((a) => String(a.ID ?? '') === id);
        if (found === undefined) {
          throw new UnibookingError({
            provider: 'booker',
            code: 'NOT_FOUND',
            message: `appointment ${id} not found`,
          });
        }
        return toBooking(found, zone);
      },

      // Booker's only documented appointment mutation is `appointment/confirm`.
      // There is no verified reschedule/edit path, and silently confirming an
      // appointment when the caller asked to move it would be worse than
      // refusing.
      updateBooking: async () =>
        unsupported(
          'booker',
          'updateBooking — Booker exposes no documented appointment update endpoint ' +
            '(only confirm and cancel). Cancel and rebook instead.',
        ),

      async cancelBooking(id) {
        const c = await http.resolve();
        await http.request(c, {
          method: 'PUT',
          path: 'v4.1/customer/appointment/cancel',
          body: { ID: id },
        });
      },

      async listBookings(query) {
        const c = await http.resolve();
        const zone = locationZone(c);
        const res = await listAppointments(
          c,
          query.range.start,
          query.range.end,
          query.limit,
          query.pageToken,
        );
        const bookings = results(res, 'Appointments').map((raw) => toBooking(raw, zone));
        // Booker filters by whole DATES, so both edge days come back entire.
        const trimmed = bookingsWithinRange(bookings, query.range);
        const page = Number(query.pageToken ?? '1');
        const current = Number.isFinite(page) && page > 0 ? page : 1;
        // Booker reports no cursor; advance while a full page came back.
        const pageSize = query.limit ?? 100;
        return {
          bookings: trimmed,
          ...(bookings.length >= pageSize ? { nextPageToken: String(current + 1) } : {}),
        };
      },

      searchAvailability: async () => unsupported('booker', NO_AVAILABILITY),

      async listServices(query) {
        const c = await http.resolve();
        const res = await http.request(c, {
          method: 'POST',
          path: 'v4.1/merchant/treatments',
          body: { LocationID: c.locationId },
        });
        const services = results(res, 'Treatments').map(toService);
        return {
          services: services.filter((sv) => {
            if (query?.staffId && !(sv.staffIds?.includes(query.staffId) ?? false)) return false;
            if (query?.categoryId && sv.categoryId !== query.categoryId) return false;
            return true;
          }),
        };
      },

      async listStaff(query) {
        const c = await http.resolve();
        const res = await http.request(c, {
          method: 'POST',
          path: 'v4.1/merchant/employees',
          body: { LocationID: c.locationId },
        });
        let staff = results(res, 'Employees').map(toStaff);
        if (query?.serviceId) {
          // The link lives on the Treatment (EmployeeIDs), so answering "who
          // performs this" means reading it from there.
          const treatments = await http.request(c, {
            method: 'POST',
            path: 'v4.1/merchant/treatments',
            body: { LocationID: c.locationId },
          });
          const match = results(treatments, 'Treatments')
            .map(toService)
            .find((sv) => sv.id === query.serviceId);
          const ids = match?.staffIds ?? [];
          staff = staff.filter((m) => ids.includes(m.id));
        }
        return { staff };
      },

      async listCategories() {
        const c = await http.resolve();
        const res = await http.request(c, {
          method: 'POST',
          path: 'v4.1/merchant/treatments',
          body: { LocationID: c.locationId },
        });
        // Booker names categories without giving them ids, so the name is the
        // id — matching what `toService` writes into `categoryId`.
        const seen = new Map<string, ServiceCategory>();
        for (const raw of results(res, 'Treatments')) {
          const t = asRecord(raw, 'booker', 'treatment');
          const name = typeof t.Category === 'string' ? t.Category.trim() : '';
          if (!name || seen.has(name)) continue;
          seen.set(name, { id: name, name, provider: 'booker', raw: { Category: name } });
        }
        return { categories: [...seen.values()].sort((a, b) => a.name.localeCompare(b.name)) };
      },

      async getBusinessHours() {
        const c = await http.resolve();
        const zone = locationZone(c);
        const stamp = toBookerDate(new Date().toISOString(), zone);
        const res = await http.request(c, {
          path: `v4.1/merchant/location/${encodeURIComponent(c.locationId)}/schedule`,
          query: { getDefaultDaySchedule: true, fromDate: stamp, toDate: stamp },
        });
        const periods = asArray(res?.LocationDaySchedules ?? [], 'booker', 'LocationDaySchedules')
          .flatMap((raw): HoursPeriod[] => {
            const d = asRecord(raw, 'booker', 'locationDaySchedule');
            const day = weekdayOf(d.Weekday);
            const start = clock(d.StartTime);
            const end = clock(d.EndTime);
            if (!day || start === undefined || end === undefined) return [];
            return [{ dayOfWeek: day, start, end }];
          })
          .sort(
            (a, b) =>
              WEEKDAYS.indexOf(a.dayOfWeek) - WEEKDAYS.indexOf(b.dayOfWeek) ||
              a.start.localeCompare(b.start),
          );
        return { provider: 'booker', timezone: zone, periods, raw: res };
      },

      async listClasses(query) {
        const c = await http.resolve();
        const window = query?.range ?? defaultWindow();
        const from = 'start' in window ? window.start : window.from;
        const to = 'end' in window ? window.end : window.to;
        let classes = await fetchClasses(c, from, to);
        if (query?.staffId) classes = classes.filter((k) => k.staffId === query.staffId);
        if (query?.serviceId) classes = classes.filter((k) => k.serviceId === query.serviceId);
        classes.sort((a, b) => Date.parse(a.range.start) - Date.parse(b.range.start));
        return { classes };
      },

      async getClass(id) {
        const c = await http.resolve();
        const { from, to } = defaultWindow();
        const found = (await fetchClasses(c, from, to)).find((k) => k.id === id);
        if (found === undefined) {
          throw new UnibookingError({
            provider: 'booker',
            code: 'NOT_FOUND',
            message: `class ${id} not found`,
          });
        }
        return found;
      },

      async enrollInClass(input) {
        const c = await http.resolve();
        const zone = locationZone(c);
        const { from, to } = defaultWindow();
        const session = (await fetchClasses(c, from, to)).find((k) => k.id === input.classId);
        if (session === undefined) {
          throw new UnibookingError({
            provider: 'booker',
            code: 'NOT_FOUND',
            message: `class ${input.classId} not found`,
          });
        }
        if (session.full) {
          // Booker has no class waitlist, so `allowWaitlist` cannot rescue this.
          throw new UnibookingError({
            provider: 'booker',
            code: 'CONFLICT',
            message:
              input.allowWaitlist === true
                ? `class ${input.classId} is full and Booker has no waitlist`
                : `class ${input.classId} is full`,
          });
        }
        const res = await http.request(c, {
          method: 'POST',
          path: 'v4.1/customer/class_appointment/create',
          body: {
            LocationID: c.locationId,
            ClassInstanceID: input.classId,
            Customer: {
              ...(input.customer.id ? { CustomerID: input.customer.id } : {}),
              ...(input.customer.email ? { Email: input.customer.email } : {}),
              ...(input.customer.name
                ? {
                    FirstName: input.customer.name.split(/\s+/)[0],
                    LastName: input.customer.name.split(/\s+/).slice(1).join(' ') || undefined,
                  }
                : {}),
            },
          },
        });
        const created = res?.Appointment ?? res;
        const base =
          created && typeof created === 'object' && 'ID' in (created as object)
            ? toBooking(created, zone)
            : undefined;
        return {
          id: base?.id ?? session.id,
          provider: 'booker',
          title: session.title,
          range: session.range,
          classId: input.classId,
          customer: input.customer,
          ...(session.serviceId !== undefined ? { serviceId: session.serviceId } : {}),
          ...(session.staffId !== undefined ? { staffId: session.staffId } : {}),
          status: 'confirmed',
          raw: created,
        };
      },
    };
  },
});

/** Booker's `Weekday` is a day index; the Ruby client normalises it to a
 *  Ruby wday (0 = Sunday). Accept both that and a spelled-out name. */
function weekdayOf(value: unknown): Weekday | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) {
    // 0 = Sunday .. 6 = Saturday. Anything outside that is malformed, and
    // wrapping it modulo 7 would invent a day the business never claimed —
    // the caller would see opening hours that do not exist. Drop it instead;
    // the original stays in `raw`.
    if (value < 0 || value > 6) return undefined;
    const byWday: Weekday[] = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
    return byWday[value];
  }
  if (typeof value !== 'string') return undefined;
  const t = value.trim().toUpperCase().slice(0, 3);
  return WEEKDAYS.find((d) => d === t);
}

/** `HH:MM:SS` (the Ruby client's `%T`) or `HH:MM` -> canonical `HH:MM`. */
function clock(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const m = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(value.trim());
  if (!m) return undefined;
  if (Number(m[1]) > 23 || Number(m[2]) > 59) return undefined;
  return `${m[1]}:${m[2]}`;
}

import type { AvailabilitySlot, Booking, BookingStatus, Customer } from '../types';
import { asArray, asRecord, defineAdapter, reqString, unsupported } from '../adapter-kit';
import type { HttpContext } from '../http';
import { UnibookingError } from '../errors';
import { assertValidRange } from '../time';

/**
 * Phorest third-party API. HTTP Basic auth; `businessId`/`branchId` scope every
 * path. Appointment responses split time into `appointmentDate` (yyyy-MM-dd) plus
 * `startTime`/`endTime` as UTC LocalTime (HH:mm:ss) — recombined to RFC3339 here.
 * No webhooks (Phorest recommends polling via updated_from/updated_to).
 */
export type PhorestCredentials = {
  /** Includes the `global/` prefix Phorest issues, e.g. `global/api@salon.com`. */
  username: string;
  password: string;
  businessId: string;
  branchId: string;
};

// Default EU host; US/AUS customers pass options.baseUrl = platform-us.phorest.com/...
const BASE = 'https://platform.phorest.com/third-party-api-server/api/';

function enc(id: string): string {
  return encodeURIComponent(id);
}

function branchPath(c: PhorestCredentials, sub: string): string {
  return `business/${enc(c.businessId)}/branch/${enc(c.branchId)}/${sub}`;
}

function businessPath(c: PhorestCredentials, sub: string): string {
  return `business/${enc(c.businessId)}/${sub}`;
}

/** Recombine Phorest's date + UTC LocalTime into a single RFC3339 instant. */
function recombine(date: unknown, time: unknown): string | undefined {
  if (typeof date !== 'string' || typeof time !== 'string' || !date || !time) return undefined;
  return `${date}T${time}Z`;
}

/** The inverse of `recombine`: an instant -> Phorest's `appointmentDate`
 *  (yyyy-MM-dd) + LocalTime (HH:mm:ss) pair. Both are derived in UTC because
 *  "all API times for bookings are in UTC time". */
function splitUtc(instant: string): { date: string; time: string } {
  const iso = new Date(instant).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 19) };
}

/** RFC3339-with-offset -> UTC `Z` (Phorest request bodies want UTC ISO-8601). */
function toUtcZ(instant: string): string {
  return new Date(instant).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Basic auth over credentials that may contain non-Latin-1 characters (Phorest
 *  passwords are user-chosen). `btoa` throws above U+00FF, so base64 the UTF-8
 *  bytes instead of the code points. */
function basicAuth(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function mapStatus(a: any): BookingStatus {
  if (a.deleted === true || a.activationState === 'CANCELED') return 'cancelled';
  if (a.activationState === 'RESERVED') return 'pending';
  if (a.state === 'PAID') return 'completed';
  if (a.state === 'CHECKED_IN') return 'confirmed';
  if (a.activationState === 'ACTIVE') return a.confirmed === true ? 'confirmed' : 'pending';
  return 'unknown';
}

function toBooking(raw: unknown): Booking {
  const a = asRecord(raw, 'phorest', 'appointment');
  const start = recombine(a.appointmentDate, a.startTime);
  const end = recombine(a.appointmentDate, a.endTime);
  if (start === undefined || end === undefined) {
    throw new UnibookingError({
      provider: 'phorest',
      code: 'UPSTREAM',
      message: 'appointment is missing appointmentDate/startTime/endTime',
    });
  }
  // An appointment can cross midnight; Phorest reports one appointmentDate, so if the
  // recombined end precedes start, roll it to the next day to preserve end > start.
  let adjustedEnd = end;
  if (Date.parse(adjustedEnd) < Date.parse(start)) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() + 1);
    adjustedEnd = d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  // A same-instant start/end (no midnight cross to roll) is a zero-length range;
  // surface it rather than emit a booking that violates end > start.
  if (Date.parse(adjustedEnd) <= Date.parse(start)) {
    throw new UnibookingError({
      provider: 'phorest',
      code: 'UPSTREAM',
      message: `appointment ${String(a.appointmentId ?? '')} has no positive duration`,
    });
  }
  return {
    id: reqString(String(a.appointmentId ?? ''), 'phorest', 'appointment.appointmentId'),
    provider: 'phorest',
    title: typeof a.serviceName === 'string' && a.serviceName ? a.serviceName : 'Appointment',
    range: { start, end: adjustedEnd },
    ...(a.staffId ? { staffId: String(a.staffId) } : {}),
    ...(a.serviceId ? { serviceId: String(a.serviceId) } : {}),
    ...(a.clientId ? { customer: { id: String(a.clientId) } } : {}),
    status: mapStatus(a),
    ...(typeof a.createdAt === 'string' ? { createdAt: a.createdAt } : {}),
    ...(typeof a.updatedAt === 'string' ? { updatedAt: a.updatedAt } : {}),
    raw: a,
  };
}

function parsePhorestError(
  _status: number,
  body: unknown,
): { providerCode?: string; message?: string } {
  const b = body as any;
  if (!b || typeof b !== 'object') return {};
  return {
    ...(typeof b.detail === 'string'
      ? { message: b.detail + (typeof b.id === 'string' && b.id ? ` (id: ${b.id})` : '') }
      : {}),
    ...(typeof b.errorCode === 'string' ? { providerCode: b.errorCode } : {}),
  };
}

function splitName(name: string): { firstName: string; lastName: string } {
  const [first, ...rest] = name.trim().split(/\s+/);
  return { firstName: first ?? name, lastName: rest.join(' ') };
}

function requireService(serviceId: string | undefined): string {
  if (!serviceId) {
    throw new UnibookingError({
      provider: 'phorest',
      code: 'INVALID_INPUT',
      message: 'Phorest requires a serviceId',
    });
  }
  return serviceId;
}

/** `ServiceSchedule.staffId` is required on a booking — without it Phorest 400s,
 *  so reject client-side with a message that names the field. */
function requireStaff(staffId: string | undefined): string {
  if (!staffId) {
    throw new UnibookingError({
      provider: 'phorest',
      code: 'INVALID_INPUT',
      message: 'Phorest requires a staffId on every service schedule to create a booking',
    });
  }
  return staffId;
}

/** Every paged Phorest model is `{ links, _embedded, page }` with `_embedded` a
 *  bare array at the top level. (The one `data`-wrapped body in the spec is
 *  availability, which is mapped separately.) */
function embedded(res: any): any[] {
  return Array.isArray(res?._embedded) ? res._embedded : [];
}

/** BookingResponse (`{bookingStatus, clientId, schedules,
 *  clientAppointmentSchedules, bookingId, links}`) carries no top-level
 *  appointment id, and `bookingId` is NOT the appointment's `groupBookingId` —
 *  the created appointment's id lives on the nested service schedule. */
function createdAppointmentId(res: unknown): string {
  const b = asRecord(res, 'phorest', 'booking');
  for (const cs of asArray(
    b.clientAppointmentSchedules,
    'phorest',
    'booking.clientAppointmentSchedules',
  )) {
    for (const ss of asArray(cs?.serviceSchedules, 'phorest', 'booking.serviceSchedules')) {
      if (ss?.appointmentId) return String(ss.appointmentId);
    }
  }
  throw new UnibookingError({
    provider: 'phorest',
    code: 'UPSTREAM',
    message:
      'booking response has no clientAppointmentSchedules[].serviceSchedules[].appointmentId',
  });
}

async function findOrCreateClient(
  http: HttpContext<PhorestCredentials>,
  c: PhorestCredentials,
  customer: Customer,
): Promise<string> {
  if (customer.id) return customer.id;
  if (customer.email) {
    const res = await http.request(c, {
      path: businessPath(c, 'client'),
      query: { email: customer.email, size: 1 },
    });
    const found = embedded(res)[0];
    if (found?.clientId) return String(found.clientId);
  }
  const created = await http.request(c, {
    method: 'POST',
    path: businessPath(c, 'client'),
    body: {
      ...(customer.name ? splitName(customer.name) : { firstName: 'Guest', lastName: 'Guest' }),
      ...(customer.email ? { email: customer.email } : {}),
      ...(customer.phone ? { mobile: customer.phone } : {}),
    },
  });
  return reqString(String(created?.clientId ?? ''), 'phorest', 'client.clientId');
}

async function getAppointment(
  http: HttpContext<PhorestCredentials>,
  c: PhorestCredentials,
  id: string,
): Promise<Booking> {
  const res = await http.request(c, { path: branchPath(c, `appointment/${enc(id)}`) });
  return toBooking(res);
}

/** State transitions are dedicated endpoints, not writable fields. `sub` is
 *  `appointment/cancel` or `appointment/confirm`; `appointment_id` is repeatable
 *  upstream, but a single canonical booking maps to exactly one id. */
async function transition(
  http: HttpContext<PhorestCredentials>,
  c: PhorestCredentials,
  sub: string,
  id: string,
): Promise<void> {
  await http.request(c, {
    method: 'POST',
    path: branchPath(c, sub),
    query: { appointment_id: id },
    parse: 'none',
  });
}

export const phorest = defineAdapter<PhorestCredentials>({
  id: 'phorest',
  capabilities: {
    availability: true,
    staff: true,
    services: true,
    webhooks: false,
    idempotency: false,
    customers: true,
  },
  baseUrl: BASE,
  auth: (c) => ({ headers: { authorization: `Basic ${basicAuth(c.username, c.password)}` } }),
  parseError: parsePhorestError,
  build: (http) => ({
    async createBooking(input) {
      assertValidRange(input.range, 'phorest');
      const c = await http.resolve();
      const serviceId = requireService(input.serviceId);
      const staffId = requireStaff(input.staffId);
      const clientId = input.customer
        ? await findOrCreateClient(http, c, input.customer)
        : undefined;
      if (!clientId) {
        throw new UnibookingError({
          provider: 'phorest',
          code: 'INVALID_INPUT',
          message: 'Phorest requires a customer (clientId) to create a booking',
        });
      }
      const res = await http.request(c, {
        method: 'POST',
        path: branchPath(c, 'booking'),
        body: {
          clientId,
          clientAppointmentSchedules: [
            {
              clientId,
              serviceSchedules: [
                {
                  serviceId,
                  staffId,
                  startTime: toUtcZ(input.range.start),
                  endTime: toUtcZ(input.range.end),
                },
              ],
            },
          ],
          ...input.providerOptions,
        },
      });
      // BookingResponse is a booking summary, not an appointment — it carries
      // none of the fields a canonical Booking needs, so read the new id off the
      // nested service schedule and fetch the appointment itself.
      return getAppointment(http, c, createdAppointmentId(res));
    },

    getBooking(id) {
      return http.resolve().then((c) => getAppointment(http, c, id));
    },

    async updateBooking(id, input) {
      if (input.range) assertValidRange(input.range, 'phorest');
      const c = await http.resolve();
      const editsFields =
        input.range !== undefined || input.staffId !== undefined || input.serviceId !== undefined;
      // Status is not a writable field on AppointmentUpdateRequest — Phorest
      // moves an appointment between states through dedicated endpoints. Route
      // them (never silently drop the caller's status).
      if (input.status !== undefined) {
        const sub =
          input.status === 'cancelled'
            ? 'appointment/cancel'
            : input.status === 'confirmed'
              ? 'appointment/confirm'
              : undefined;
        if (sub === undefined) {
          return unsupported(
            'phorest',
            `setting status "${input.status}" (only cancelled and confirmed have a Phorest transition)`,
          );
        }
        await transition(http, c, sub, id);
        if (!editsFields) return getAppointment(http, c, id);
      }
      // AppointmentUpdateRequest marks appointmentId, staffId, startTime and
      // version all required — so a partial patch (e.g. serviceId alone) has to
      // backfill the others from current state or the request is rejected.
      let version = input.providerOptions?.version;
      let currentStaffId: string | undefined;
      let currentDate: string | undefined;
      let currentStartTime: string | undefined;
      const needsBackfill = version === undefined || !input.staffId || !input.range;
      if (needsBackfill) {
        const current = asRecord(
          await http.request(c, { path: branchPath(c, `appointment/${enc(id)}`) }),
          'phorest',
          'appointment',
        );
        if (version === undefined) version = current.version;
        if (typeof current.staffId === 'string') currentStaffId = current.staffId;
        if (typeof current.appointmentDate === 'string') currentDate = current.appointmentDate;
        if (typeof current.startTime === 'string') currentStartTime = current.startTime;
      }
      // The update request takes the same date + UTC LocalTime pair the read side
      // returns — not an instant. Sending appointmentDate is what makes a
      // cross-day reschedule possible at all.
      const when = input.range ? splitUtc(input.range.start) : undefined;
      const res = await http.request(c, {
        method: 'PUT',
        path: branchPath(c, `appointment/${enc(id)}`),
        body: {
          appointmentId: id,
          version,
          staffId: input.staffId ?? currentStaffId,
          appointmentDate: when?.date ?? currentDate,
          startTime: when?.time ?? currentStartTime,
          // Note: when the staff or service changes, Phorest recomputes the
          // duration from the new staff/service and IGNORES endTime — so the
          // returned booking may not match the requested range.
          ...(input.range ? { endTime: splitUtc(input.range.end).time } : {}),
          ...(input.serviceId ? { serviceId: input.serviceId } : {}),
          ...input.providerOptions,
        },
      });
      return toBooking(res);
    },

    // Phorest's cancel endpoint takes no reason/notify params, so CancelOptions are not forwarded.
    async cancelBooking(id) {
      const c = await http.resolve();
      await transition(http, c, 'appointment/cancel', id);
    },

    async listBookings(query) {
      assertValidRange(query.range, 'phorest');
      const spanMs = Date.parse(query.range.end) - Date.parse(query.range.start);
      if (spanMs > 31 * 24 * 60 * 60 * 1000) {
        throw new UnibookingError({
          provider: 'phorest',
          code: 'INVALID_INPUT',
          message: 'Phorest listBookings supports a maximum 1-month (31-day) range',
        });
      }
      const c = await http.resolve();
      const res = await http.request(c, {
        path: branchPath(c, 'appointment'),
        query: {
          // Phorest dates are UTC, so derive them from the instant rather than
          // slicing the (possibly offset-local) RFC3339 string.
          from_date: splitUtc(query.range.start).date,
          to_date: splitUtc(query.range.end).date,
          staff_id: query.staffId,
          client_id: query.customerId,
          // fetch_canceled/fetch_deleted both default to false, so a
          // cancelled-status query would otherwise come back full of live
          // appointments.
          ...(query.status === 'cancelled' ? { fetch_canceled: true } : {}),
          // Documented max is 100; clamp rather than let an upstream 400 through.
          size: Math.min(query.limit ?? 100, 100),
          page: query.pageToken,
        },
      });
      // to_date is INCLUSIVE and both bounds are whole UTC days, so the response
      // overshoots the canonical (exclusive) range at both ends. Trim to the
      // instants actually asked for, then honor the requested status.
      const from = Date.parse(query.range.start);
      const to = Date.parse(query.range.end);
      const bookings = embedded(res)
        .map(toBooking)
        .filter((b) => {
          const s = Date.parse(b.range.start);
          return s >= from && s < to;
        })
        .filter((b) => query.status === undefined || b.status === query.status);
      const page = res?.page;
      const next =
        page && typeof page.number === 'number' && page.number + 1 < page.totalPages
          ? String(page.number + 1)
          : undefined;
      return { bookings, ...(next !== undefined ? { nextPageToken: next } : {}) };
    },

    async searchAvailability(query): Promise<AvailabilitySlot[]> {
      assertValidRange(query.range, 'phorest');
      const c = await http.resolve();
      const res = await http.request(c, {
        method: 'POST',
        path: branchPath(c, 'appointments/availability'),
        body: {
          startTime: toUtcZ(query.range.start),
          endTime: toUtcZ(query.range.end),
          clientServiceSelections: [
            {
              serviceSelections: [
                {
                  serviceId: requireService(query.serviceId),
                  ...(query.staffId ? { staffId: query.staffId } : {}),
                },
              ],
            },
          ],
        },
      });
      // Availability is the one `data`-wrapped body in the spec: `{ data: [...],
      // links: [...] }`. Each entry carries only the slot's startTime — the end
      // and the staff live one level down, per staff/service schedule, so a
      // single entry fans out to one slot per bookable staff member.
      const body = asRecord(res, 'phorest', 'availability');
      const out: AvailabilitySlot[] = [];
      for (const entry of asArray(body.data, 'phorest', 'availability.data')) {
        const start = entry?.startTime;
        if (typeof start !== 'string' || !start) continue;
        for (const cs of asArray(
          entry.clientSchedules,
          'phorest',
          'availability.clientSchedules',
        )) {
          for (const ss of asArray(
            cs?.serviceSchedules,
            'phorest',
            'availability.serviceSchedules',
          )) {
            // No endTime means no derivable end — skip rather than invent one.
            if (typeof ss?.endTime !== 'string' || !ss.endTime) continue;
            out.push({
              start,
              end: ss.endTime,
              ...(ss.staffId ? { staffId: String(ss.staffId) } : {}),
              // Both levels are kept: the schedule is what a follow-up booking
              // needs, the entry is the slot Phorest actually offered.
              raw: { availability: entry, serviceSchedule: ss },
            });
          }
        }
      }
      return out;
    },

    customers: {
      findOrCreate: async (customer) => {
        const c = await http.resolve();
        return findOrCreateClient(http, c, customer);
      },
    },
  }),
});

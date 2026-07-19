import type { AvailabilitySlot, Booking, BookingStatus, Customer } from '../types';
import { asArray, asRecord, defineAdapter, reqString } from '../adapter-kit';
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

/** RFC3339-with-offset -> UTC `Z` (Phorest request bodies want UTC ISO-8601). */
function toUtcZ(instant: string): string {
  return new Date(instant).toISOString().replace(/\.\d{3}Z$/, 'Z');
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

function parsePhorestError(_status: number, body: unknown): { providerCode?: string; message?: string } {
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

/** HAL paged models expose entities under `_embedded` (array), sometimes nested
 *  under `data`. Normalize to a plain array. TODO: verify per-endpoint wrapping. */
function embedded(res: any): any[] {
  const e = res?._embedded ?? res?.data?._embedded;
  if (Array.isArray(e)) return e;
  if (e && typeof e === 'object') {
    const firstArray = Object.values(e).find((v) => Array.isArray(v));
    if (Array.isArray(firstArray)) return firstArray;
  }
  return [];
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
  auth: (c) => ({ headers: { authorization: `Basic ${btoa(`${c.username}:${c.password}`)}` } }),
  parseError: parsePhorestError,
  build: (http) => ({
    async createBooking(input) {
      assertValidRange(input.range, 'phorest');
      const c = await http.resolve();
      const serviceId = requireService(input.serviceId);
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
                  startTime: toUtcZ(input.range.start),
                  endTime: toUtcZ(input.range.end),
                  ...(input.staffId ? { staffId: input.staffId } : {}),
                },
              ],
            },
          ],
          ...input.providerOptions,
        },
      });
      // A single-service create yields one appointment. If the response embeds it,
      // map directly; otherwise fetch by the returned bookingId.
      if (res?.appointmentId) return toBooking(res);
      const list = await http.request(c, {
        path: branchPath(c, 'appointment'),
        query: { group_booking_id: res?.bookingId },
      });
      const first = embedded(list)[0];
      if (first) return toBooking(first);
      // Fall back to the raw create response shape.
      return toBooking(res);
    },

    getBooking(id) {
      return http.resolve().then((c) => getAppointment(http, c, id));
    },

    async updateBooking(id, input) {
      if (input.range) assertValidRange(input.range, 'phorest');
      const c = await http.resolve();
      // AppointmentUpdateRequest marks appointmentId, staffId, startTime and
      // version all required — so a partial patch (e.g. serviceId alone) has to
      // backfill the others from current state or the request is rejected.
      let version = input.providerOptions?.version;
      let currentStaffId: string | undefined;
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
        if (typeof current.startTime === 'string') currentStartTime = current.startTime;
      }
      const res = await http.request(c, {
        method: 'PUT',
        path: branchPath(c, `appointment/${enc(id)}`),
        body: {
          appointmentId: id,
          version,
          staffId: input.staffId ?? currentStaffId,
          startTime: input.range ? toUtcZ(input.range.start) : currentStartTime,
          // Note: when the staff or service changes, Phorest recomputes the
          // duration from the new staff/service and IGNORES endTime — so the
          // returned booking may not match the requested range.
          ...(input.range ? { endTime: toUtcZ(input.range.end) } : {}),
          ...(input.serviceId ? { serviceId: input.serviceId } : {}),
          ...input.providerOptions,
        },
      });
      return toBooking(res);
    },

    // Phorest's cancel endpoint takes no reason/notify params, so CancelOptions are not forwarded.
    async cancelBooking(id) {
      const c = await http.resolve();
      await http.request(c, {
        method: 'POST',
        path: branchPath(c, 'appointment/cancel'),
        query: { appointment_id: id },
        parse: 'none',
      });
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
          from_date: query.range.start.slice(0, 10),
          to_date: query.range.end.slice(0, 10),
          staff_id: query.staffId,
          client_id: query.customerId,
          size: query.limit ?? 100,
          page: query.pageToken,
        },
      });
      const bookings = embedded(res).map(toBooking);
      const page = res?.page ?? res?.data?.page;
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
      // TODO: verify against live API — Phorest may wrap availability slots in a HAL
      // envelope (_embedded) rather than returning a bare array.
      const slots = asArray(res, 'phorest', 'availability');
      return slots.flatMap((s: any) => {
        if (typeof s.startTime !== 'string' || typeof s.endTime !== 'string') return [];
        return [
          {
            start: s.startTime,
            end: s.endTime,
            ...(s.staffId ? { staffId: String(s.staffId) } : {}),
            raw: s,
          },
        ];
      });
    },

    customers: {
      findOrCreate: async (customer) => {
        const c = await http.resolve();
        return findOrCreateClient(http, c, customer);
      },
    },
  }),
});

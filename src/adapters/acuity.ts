import type { AvailabilitySlot, Booking } from '../types';
import { asArray, asRecord, defineAdapter, reqString } from '../adapter-kit';
import { UnibookingError } from '../errors';
import { assertValidRange, endFromDuration } from '../time';

/**
 * Acuity Scheduling. HTTP Basic auth (user id + API key). "Calendars" act as
 * staff/resources; "appointment types" are services.
 */
export type AcuityCredentials = {
  userId: string;
  apiKey: string;
};

const BASE = 'https://acuityscheduling.com/api/v1/';

/** Acuity returns offsets like `-0700` (no colon); make them RFC3339. */
function normalizeInstant(s: unknown): string | undefined {
  if (typeof s !== 'string' || !s) return undefined;
  return s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
}

function splitName(name: string): { firstName: string; lastName: string } {
  const [first, ...rest] = name.trim().split(/\s+/);
  return { firstName: first ?? name, lastName: rest.join(' ') };
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
    status: a.canceled === true ? 'cancelled' : a.noShow === true ? 'no_show' : 'confirmed',
    raw: a,
  };
}

function parseAcuityError(_status: number, body: unknown): { providerCode?: string; message?: string } {
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
  },
  baseUrl: BASE,
  auth: (c) => ({ headers: { authorization: `Basic ${btoa(`${c.userId}:${c.apiKey}`)}` } }),
  parseError: parseAcuityError,
  build: (http) => ({
    async createBooking(input) {
      assertValidRange(input.range, 'acuity');
      const c = await http.resolve();
      const res = await http.request(c, {
        method: 'POST',
        path: 'appointments',
        query: { admin: true },
        body: {
          appointmentTypeID: requireService(input.serviceId),
          datetime: input.range.start,
          ...(input.staffId ? { calendarID: input.staffId } : {}),
          ...(input.customer?.name ? splitName(input.customer.name) : {}),
          ...(input.customer?.email ? { email: input.customer.email } : {}),
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
      if (input.range) {
        assertValidRange(input.range, 'acuity');
        // Reschedule can also reassign the calendar (staff); Acuity derives the
        // end from the appointment type, so only the start is sent.
        const res = await http.request(c, {
          method: 'PUT',
          path: `appointments/${encodeURIComponent(id)}/reschedule`,
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
        query: { ...(options?.notify === false ? { noEmail: true } : {}) },
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
          canceled: query.status === 'cancelled' ? true : undefined,
        },
      });
      const bookings = asArray(res, 'acuity', 'appointments').map(toBooking);
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
          message: 'Acuity available times are start-only; pass a positive durationMinutes to size each slot',
        });
      }
      const durationMinutes = query.durationMinutes;
      const c = await http.resolve();
      const res = await http.request(c, {
        path: 'availability/times',
        query: {
          date: query.range.start.slice(0, 10),
          appointmentTypeID: requireService(query.serviceId),
          calendarID: query.staffId,
        },
      });
      const times = asArray(res, 'acuity', 'availability/times');
      return times.flatMap((t: any) => {
        const start = normalizeInstant(t.time);
        if (start === undefined) return [];
        return [
          {
            start,
            end: endFromDuration(start, durationMinutes),
            ...(query.staffId ? { staffId: query.staffId } : {}),
            raw: t,
          },
        ];
      });
    },
  }),
});

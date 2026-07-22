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

/** The offset token (`Z` or `±HH:MM`) of an RFC3339 instant. */
function offsetToken(iso: string): string {
  const m = /([+-]\d{2}:\d{2}|Z)$/.exec(iso);
  return m ? m[1]! : 'Z';
}

/** The `YYYY-MM-DD` dates (in `range.start`'s offset) that the window overlaps —
 *  Acuity's `availability/times` is single-date, so a multi-day range needs one
 *  call per day. Capped so an over-wide range can't fan out unboundedly. */
function datesInRange(startIso: string, endIso: string, cap = 31): string[] {
  const offset = offsetToken(startIso);
  const endMs = Date.parse(endIso);
  const dates: string[] = [];
  let dateStr = startIso.slice(0, 10);
  for (let i = 0; i < cap; i++) {
    const dayStartMs = Date.parse(`${dateStr}T00:00:00${offset}`);
    if (dayStartMs >= endMs) break;
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

/** Acuity marks firstName, lastName and email required on POST /appointments —
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
    // top of `canceled`), so check the more specific flag first — testing
    // `canceled` first made 'no_show' unreachable on real data.
    status: a.noShow === true ? 'no_show' : a.canceled === true ? 'cancelled' : 'confirmed',
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
        // `admin=true` bypasses availability checks and unlocks `notes`, but Acuity
        // REQUIRES a valid `calendarID` in admin mode — so only enable it when a
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
        // `notes` may only be written by an admin — without admin=true Acuity
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
          // window fails with cancel_too_close / cancel_not_allowed — even on an
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
          canceled: query.status === 'cancelled' ? true : undefined,
        },
      });
      // minDate/maxDate are whole dates in the business timezone, so Acuity
      // returns the entire end day (and part of the start day) regardless of the
      // range's times. Trim to the instants the caller actually asked for.
      const from = Date.parse(query.range.start);
      const to = Date.parse(query.range.end);
      const bookings = asArray(res, 'acuity', 'appointments')
        .map(toBooking)
        .filter((b) => {
          const s = Date.parse(b.range.start);
          return s >= from && s < to;
        });
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
      const serviceId = requireService(query.serviceId);
      const c = await http.resolve();
      const windowStart = Date.parse(query.range.start);
      const windowEnd = Date.parse(query.range.end);
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
          const startMs = Date.parse(start);
          if (startMs < windowStart || startMs >= windowEnd) continue;
          out.push({
            start,
            end: endFromDuration(start, durationMinutes),
            ...(query.staffId ? { staffId: query.staffId } : {}),
            raw: t,
          });
        }
      }
      return out;
    },
  }),
});

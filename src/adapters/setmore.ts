import type { AvailabilitySlot, Booking, BookingStatus, Customer } from '../types';
import { asArray, asRecord, defineAdapter, reqString } from '../adapter-kit';
import type { HttpContext } from '../http';
import { UnibookingError } from '../errors';
import { assertValidRange, endFromDuration, isInstant } from '../time';

/**
 * Setmore (Booking API). Gated beta: a paid Setmore Pro account plus manual
 * access approval (email api@setmore.com). Bring your own bearer access token —
 * you exchange your long-lived refresh token for one yourself (per this
 * package's "bring your own credentials" contract).
 *
 * NOTE: docs-derived, not verified against a live Setmore account. The response
 * envelope, appointment time format, and slot format are the fields most likely
 * to differ in practice; each is marked `TODO: verify against live API`.
 */
export type SetmoreCredentials = {
  accessToken: string;
};

// Setmore's official docs use the developer.setmore.com host; override via
// options.baseUrl if your account uses a different one.
const BASE = 'https://developer.setmore.com/';

function enc(id: string): string {
  return encodeURIComponent(id);
}

/** Setmore wraps payloads as `{ response, data, msg }`. */
function dataOf(res: unknown): Record<string, any> {
  return asRecord((res as any)?.data, 'setmore', 'response.data');
}

/** Convert an epoch (ms or s) to an RFC3339 `Z` instant. */
function epochToIso(n: number): string {
  const ms = n < 1e12 ? n * 1000 : n;
  return new Date(ms).toISOString();
}

/** Coerce a Setmore time (offset-bearing ISO, or epoch) to a canonical instant.
 *  Returns undefined for ambiguous offset-less strings. */
function toInstant(v: unknown): string | undefined {
  if (typeof v === 'number') return epochToIso(v);
  if (typeof v === 'string') {
    if (isInstant(v)) return v;
    if (v.trim() !== '' && !Number.isNaN(Number(v))) return epochToIso(Number(v));
  }
  return undefined;
}

function offsetToken(iso: string): string {
  const m = /([+-]\d{2}:\d{2}|Z)$/.exec(iso);
  return m ? m[1]! : 'Z';
}

function mapStatus(s: unknown): BookingStatus {
  switch (String(s).toLowerCase()) {
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    case 'noshow':
    case 'no_show':
      return 'no_show';
    case 'completed':
      return 'completed';
    case 'pending':
      return 'pending';
    case '':
    case 'undefined':
    case 'null':
      return 'confirmed'; // Setmore appointments are confirmed unless flagged otherwise
    default:
      // An unrecognized, non-empty status is genuinely unknown — don't assume confirmed.
      return 'unknown';
  }
}

function toBooking(raw: unknown): Booking {
  const a = asRecord(raw, 'setmore', 'appointment');
  const start = toInstant(a.start_time);
  const end = toInstant(a.end_time);
  if (start === undefined || end === undefined) {
    throw new UnibookingError({
      provider: 'setmore',
      code: 'UPSTREAM',
      message: 'appointment is missing a usable start_time/end_time',
    });
  }
  return {
    id: reqString(String(a.key ?? a.appointment_key ?? ''), 'setmore', 'appointment.key'),
    provider: 'setmore',
    title: typeof a.label === 'string' && a.label ? a.label : 'Appointment',
    range: { start, end },
    ...(a.staff_key ? { staffId: String(a.staff_key) } : {}),
    ...(a.service_key ? { serviceId: String(a.service_key) } : {}),
    ...(a.customer_key ? { customer: { id: String(a.customer_key) } } : {}),
    status: mapStatus(a.status),
    raw: a,
  };
}

function parseSetmoreError(_status: number, body: unknown): { providerCode?: string; message?: string } {
  const b = body as any;
  const message = b?.msg ?? b?.message ?? b?.error;
  return { ...(typeof message === 'string' ? { message } : {}) };
}

function requireField(value: string | undefined, hint: string): string {
  if (!value) {
    throw new UnibookingError({ provider: 'setmore', code: 'INVALID_INPUT', message: `Setmore requires ${hint}` });
  }
  return value;
}

async function findOrCreateCustomer(
  http: HttpContext<SetmoreCredentials>,
  c: SetmoreCredentials,
  customer: Customer,
): Promise<string> {
  if (customer.id) return customer.id;
  if (customer.email) {
    const res = await http.request(c, {
      path: 'api/v1/bookingapi/customers',
      query: { email: customer.email },
    });
    const found = asArray(dataOf(res)?.customers, 'setmore', 'customers')[0];
    if (found?.key) return String(found.key);
  }
  const [first, ...rest] = (customer.name ?? 'Guest').trim().split(/\s+/);
  const created = await http.request(c, {
    method: 'POST',
    path: 'api/v1/bookingapi/customers',
    body: {
      first_name: first ?? 'Guest',
      ...(rest.length ? { last_name: rest.join(' ') } : {}),
      ...(customer.email ? { email_id: customer.email } : {}),
      ...(customer.phone ? { cell_no: customer.phone } : {}),
    },
  });
  return reqString(String(dataOf(created)?.customer?.key ?? ''), 'setmore', 'customer.key');
}

export const setmore = defineAdapter<SetmoreCredentials>({
  id: 'setmore',
  capabilities: {
    availability: true,
    staff: true,
    services: true,
    webhooks: false,
    idempotency: false,
    customers: true,
  },
  baseUrl: BASE,
  auth: (c) => ({ headers: { authorization: `Bearer ${c.accessToken}` } }),
  parseError: parseSetmoreError,
  build: (http) => ({
    async createBooking(input) {
      assertValidRange(input.range, 'setmore');
      const c = await http.resolve();
      const staffKey = requireField(input.staffId, 'a staffId (staff_key) to book');
      const serviceKey = requireField(input.serviceId, 'a serviceId (service_key) to book');
      let customerKey = input.customer?.id;
      if (customerKey === undefined && input.customer && (input.customer.email || input.customer.phone)) {
        customerKey = await findOrCreateCustomer(http, c, input.customer);
      }
      const res = await http.request(c, {
        method: 'POST',
        path: 'api/v1/bookingapi/appointments',
        body: {
          staff_key: staffKey,
          service_key: serviceKey,
          ...(customerKey ? { customer_key: customerKey } : {}),
          start_time: input.range.start,
          end_time: input.range.end,
          label: input.title,
          ...input.providerOptions,
        },
      });
      return toBooking(dataOf(res)?.appointment);
    },

    getBooking(id) {
      return http.resolve().then(async (c) => {
        const res = await http.request(c, { path: `api/v1/bookingapi/appointments/${enc(id)}` });
        return toBooking(dataOf(res)?.appointment);
      });
    },

    async updateBooking(id, input) {
      if (input.range) assertValidRange(input.range, 'setmore');
      const c = await http.resolve();
      // Setmore reschedules by updating the appointment in place (native).
      const res = await http.request(c, {
        method: 'PUT',
        path: `api/v1/bookingapi/appointments/${enc(id)}`,
        body: {
          ...(input.range ? { start_time: input.range.start, end_time: input.range.end } : {}),
          ...(input.staffId ? { staff_key: input.staffId } : {}),
          ...(input.serviceId ? { service_key: input.serviceId } : {}),
          ...(input.title !== undefined ? { label: input.title } : {}),
          ...input.providerOptions,
        },
      });
      return toBooking(dataOf(res)?.appointment);
    },

    async cancelBooking(id) {
      const c = await http.resolve();
      await http.request(c, {
        method: 'DELETE',
        path: `api/v1/bookingapi/appointments/${enc(id)}`,
        parse: 'none',
      });
    },

    async listBookings(query) {
      assertValidRange(query.range, 'setmore');
      const c = await http.resolve();
      const res = await http.request(c, {
        path: 'api/v1/bookingapi/appointments',
        query: {
          // TODO: verify against live API — Setmore list date param names.
          startDate: query.range.start,
          endDate: query.range.end,
          staff_key: query.staffId,
        },
      });
      const bookings = asArray(dataOf(res)?.appointments, 'setmore', 'appointments').map(toBooking);
      const cursor = dataOf(res)?.cursor;
      return { bookings, ...(typeof cursor === 'string' && cursor ? { nextPageToken: cursor } : {}) };
    },

    async searchAvailability(query): Promise<AvailabilitySlot[]> {
      assertValidRange(query.range, 'setmore');
      const serviceKey = requireField(query.serviceId, 'a serviceId (service_key) for availability');
      const staffKey = requireField(query.staffId, 'a staffId (staff_key) for availability');
      if (typeof query.durationMinutes !== 'number' || query.durationMinutes <= 0) {
        throw new UnibookingError({
          provider: 'setmore',
          code: 'INVALID_INPUT',
          message: 'Setmore slots are start-only; pass a positive durationMinutes to size each slot',
        });
      }
      const durationMinutes = query.durationMinutes;
      const selectedDate = query.range.start.slice(0, 10);
      const offset = offsetToken(query.range.start);
      const c = await http.resolve();
      const res = await http.request(c, {
        path: 'api/v1/bookingapi/slots',
        query: { staff_key: staffKey, service_key: serviceKey, selected_date: selectedDate },
      });
      const slots = asArray(dataOf(res)?.slots, 'setmore', 'slots');
      return slots.flatMap((raw: unknown): AvailabilitySlot[] => {
        let start = toInstant(raw);
        // Setmore also returns start times as local "HH:mm" for `selected_date`;
        // combine with the caller's offset to form a canonical instant.
        if (!start && typeof raw === 'string' && /^\d{1,2}:\d{2}$/.test(raw)) {
          const [hh, mm] = raw.split(':');
          start = `${selectedDate}T${hh!.padStart(2, '0')}:${mm}:00${offset}`;
        }
        if (!start || !isInstant(start)) return [];
        return [
          { start, end: endFromDuration(start, durationMinutes), staffId: staffKey, raw },
        ];
      });
    },

    customers: {
      findOrCreate: async (customer) => {
        const c = await http.resolve();
        return findOrCreateCustomer(http, c, customer);
      },
    },
  }),
});

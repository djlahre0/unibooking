import type { Booking, BookingStatus, Customer } from '../types';
import { asArray, asRecord, defineAdapter, reqString } from '../adapter-kit';
import { UnibookingError } from '../errors';
import type { HttpContext } from '../http';
import { assertValidRange, endFromDuration } from '../time';

/**
 * Square Appointments (Bookings API). Supports availability, staff, services,
 * idempotent creates, and customer resolution.
 */
export type SquareCredentials = {
  accessToken: string;
  locationId: string;
};

const BASE = 'https://connect.squareup.com/v2/';
const SQUARE_VERSION = '2026-07-15';

function enc(id: string): string {
  return encodeURIComponent(id);
}

function segmentsDuration(segments: any[]): number {
  return segments.reduce(
    (sum, s) => sum + (typeof s?.duration_minutes === 'number' ? s.duration_minutes : 0),
    0,
  );
}

/** End instant from a start + the summed segment durations. Throws UPSTREAM when
 *  there is no positive duration to derive from (Square returns per-segment
 *  durations, so a zero total means the response is unusable — better than
 *  silently emitting a zero-length range that violates `end > start`). */
function deriveEnd(start: string, segments: any[], ctx: string): string {
  const mins = segmentsDuration(segments);
  if (mins <= 0) {
    throw new UnibookingError({
      provider: 'square',
      code: 'UPSTREAM',
      message: `${ctx}: cannot derive an end (no positive segment duration)`,
    });
  }
  return endFromDuration(start, mins);
}

function requireService(serviceId: string | undefined): string {
  if (!serviceId) {
    throw new UnibookingError({
      provider: 'square',
      code: 'INVALID_INPUT',
      message: 'Square availability search requires a serviceId (service_variation_id)',
    });
  }
  return serviceId;
}

function mapStatus(s: unknown): BookingStatus {
  switch (s) {
    case 'ACCEPTED':
      return 'confirmed';
    case 'PENDING':
      return 'pending';
    case 'CANCELLED_BY_CUSTOMER':
    case 'CANCELLED_BY_SELLER':
      return 'cancelled';
    case 'DECLINED':
      return 'declined';
    case 'NO_SHOW':
      return 'no_show';
    default:
      return 'unknown';
  }
}

function toBooking(raw: unknown): Booking {
  const b = asRecord(raw, 'square', 'booking');
  const start = reqString(b.start_at, 'square', 'booking.start_at');
  const segments = Array.isArray(b.appointment_segments) ? b.appointment_segments : [];
  const first = segments[0];
  // Square returns a duration per segment; the reference bug copied start as
  // end (zero duration). Derive the real end from the summed durations.
  const end = deriveEnd(start, segments, 'booking');
  return {
    id: reqString(b.id, 'square', 'booking.id'),
    provider: 'square',
    title: typeof b.customer_note === 'string' && b.customer_note ? b.customer_note : 'Appointment',
    range: { start, end },
    ...(first?.team_member_id ? { staffId: first.team_member_id } : {}),
    ...(first?.service_variation_id ? { serviceId: first.service_variation_id } : {}),
    ...(b.customer_id ? { customer: { id: b.customer_id } } : {}),
    status: mapStatus(b.status),
    ...(typeof b.created_at === 'string' ? { createdAt: b.created_at } : {}),
    ...(typeof b.updated_at === 'string' ? { updatedAt: b.updated_at } : {}),
    raw: b,
  };
}

function parseSquareError(_status: number, body: unknown): { providerCode?: string; message?: string } {
  const errors = (body as any)?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return {};
  const message = errors.map((e: any) => e.detail ?? e.code).filter(Boolean).join('; ');
  return {
    ...(message ? { message } : {}),
    ...(errors[0]?.code ? { providerCode: errors[0].code } : {}),
  };
}

function splitName(name: string): { given_name: string; family_name?: string } {
  const [given, ...rest] = name.trim().split(/\s+/);
  return { given_name: given ?? name, ...(rest.length ? { family_name: rest.join(' ') } : {}) };
}

/** Resolve a canonical customer to a Square customer id, creating one if needed. */
async function findOrCreateCustomer(
  http: HttpContext<SquareCredentials>,
  c: SquareCredentials,
  customer: Customer,
): Promise<string> {
  if (customer.id) return customer.id;
  // Dedup by email, else by phone, so a phone-only customer isn't duplicated on
  // every call.
  const filter = customer.email
    ? { email_address: { exact: customer.email } }
    : customer.phone
      ? { phone_number: { exact: customer.phone } }
      : undefined;
  if (filter) {
    const search = await http.request(c, {
      method: 'POST',
      path: 'customers/search',
      body: { query: { filter }, limit: 1 },
    });
    const found = Array.isArray(search?.customers) ? search.customers[0] : undefined;
    if (found?.id) return found.id;
  }
  const created = await http.request(c, {
    method: 'POST',
    path: 'customers',
    body: {
      idempotency_key: globalThis.crypto.randomUUID(),
      ...(customer.name ? splitName(customer.name) : {}),
      ...(customer.email ? { email_address: customer.email } : {}),
      ...(customer.phone ? { phone_number: customer.phone } : {}),
    },
  });
  return reqString(created?.customer?.id, 'square', 'customer.id');
}

export const square = defineAdapter<SquareCredentials>({
  id: 'square',
  capabilities: {
    availability: true,
    staff: true,
    services: true,
    webhooks: true,
    idempotency: true,
    customers: true,
  },
  baseUrl: BASE,
  auth: (c) => ({
    headers: { authorization: `Bearer ${c.accessToken}`, 'Square-Version': SQUARE_VERSION },
  }),
  parseError: parseSquareError,
  build: (http) => ({
    async createBooking(input) {
      assertValidRange(input.range, 'square');
      const c = await http.resolve();
      let customerId = input.customer?.id;
      if (customerId === undefined && input.customer && (input.customer.email || input.customer.phone)) {
        customerId = await findOrCreateCustomer(http, c, input.customer);
      }
      // Square appointment bookings require a `service_variation_version` on the
      // segment (pins the catalog version). It has no canonical field, so pull it
      // out of providerOptions and put it in the SEGMENT rather than the booking
      // body. The rest of providerOptions still merges onto the booking (a caller
      // can also override `appointment_segments` wholesale that way).
      const { service_variation_version, ...bookingOptions } = input.providerOptions ?? {};
      const res = await http.request(c, {
        method: 'POST',
        path: 'bookings',
        body: {
          // Square requires an idempotency key on create. A caller-supplied
          // input.idempotencyKey makes retries safe; the generated fallback only
          // satisfies the API (it does NOT protect a cross-call retry).
          idempotency_key: input.idempotencyKey ?? globalThis.crypto.randomUUID(),
          booking: {
            location_id: c.locationId,
            start_at: input.range.start,
            ...(customerId ? { customer_id: customerId } : {}),
            appointment_segments: [
              {
                ...(input.staffId ? { team_member_id: input.staffId } : {}),
                ...(input.serviceId ? { service_variation_id: input.serviceId } : {}),
                ...(service_variation_version !== undefined ? { service_variation_version } : {}),
              },
            ],
            ...bookingOptions,
          },
        },
      });
      return toBooking(res.booking);
    },

    async getBooking(id) {
      const c = await http.resolve();
      const res = await http.request(c, { path: `bookings/${enc(id)}` });
      return toBooking(res.booking);
    },

    async updateBooking(id, input) {
      if (input.range) assertValidRange(input.range, 'square');
      const c = await http.resolve();
      // Square PUT requires the current version for optimistic concurrency, and
      // replaces appointment_segments wholesale — so to change staff/service we
      // must merge onto the current segment.
      const needSegment = input.staffId !== undefined || input.serviceId !== undefined;
      let version = input.providerOptions?.version;
      let curSeg: any;
      if (version === undefined || needSegment) {
        const current = asRecord(
          (await http.request(c, { path: `bookings/${enc(id)}` }))?.booking,
          'square',
          'booking',
        );
        if (version === undefined) version = current.version;
        const segs = Array.isArray(current.appointment_segments) ? current.appointment_segments : [];
        curSeg = segs[0];
      }
      const segment = needSegment
        ? {
            ...(curSeg ?? {}),
            ...(input.staffId ? { team_member_id: input.staffId } : {}),
            ...(input.serviceId ? { service_variation_id: input.serviceId } : {}),
          }
        : undefined;
      const res = await http.request(c, {
        method: 'PUT',
        path: `bookings/${enc(id)}`,
        body: {
          idempotency_key: globalThis.crypto.randomUUID(),
          booking: {
            version,
            ...(input.range ? { start_at: input.range.start } : {}),
            ...(segment ? { appointment_segments: [segment] } : {}),
            ...(input.title !== undefined ? { customer_note: input.title } : {}),
            ...input.providerOptions,
          },
        },
      });
      return toBooking(res.booking);
    },

    async cancelBooking(id, _options) {
      const c = await http.resolve();
      // Square's CancelBooking body is only { idempotency_key, booking_version };
      // there is no field to carry a cancellation reason (seller_note is not a
      // CancelBooking field — to set one you'd UpdateBooking first). `notify` is
      // also not controllable here.
      await http.request(c, {
        method: 'POST',
        path: `bookings/${enc(id)}/cancel`,
        body: { idempotency_key: globalThis.crypto.randomUUID() },
        parse: 'none',
      });
    },

    async listBookings(query) {
      assertValidRange(query.range, 'square');
      const c = await http.resolve();
      const res = await http.request(c, {
        path: 'bookings',
        query: {
          location_id: c.locationId,
          start_at_min: query.range.start,
          start_at_max: query.range.end,
          limit: query.limit ?? 50,
          cursor: query.pageToken,
          // Forward the staff + customer filters Square supports (the reference dropped them).
          team_member_id: query.staffId,
          customer_id: query.customerId,
        },
      });
      const bookings = asArray(res?.bookings, 'square', 'bookings').map(toBooking);
      return {
        bookings,
        ...(typeof res?.cursor === 'string' && res.cursor ? { nextPageToken: res.cursor } : {}),
      };
    },

    async searchAvailability(query) {
      assertValidRange(query.range, 'square');
      // Square's SearchAvailability rejects a request without segment_filters, so
      // require a serviceId up front with a clear client-side error.
      const serviceId = requireService(query.serviceId);
      const c = await http.resolve();
      const res = await http.request(c, {
        method: 'POST',
        path: 'bookings/availability/search',
        body: {
          query: {
            filter: {
              location_id: c.locationId,
              start_at_range: { start_at: query.range.start, end_at: query.range.end },
              segment_filters: [
                {
                  service_variation_id: serviceId,
                  ...(query.staffId ? { team_member_id_filter: { any: [query.staffId] } } : {}),
                },
              ],
            },
          },
        },
      });
      const availabilities = asArray(res?.availabilities, 'square', 'availabilities');
      return availabilities.map((a: any) => {
        const start = reqString(a.start_at, 'square', 'availability.start_at');
        const segs = Array.isArray(a.appointment_segments) ? a.appointment_segments : [];
        return {
          start,
          end: deriveEnd(start, segs, 'availability'),
          ...(segs[0]?.team_member_id ? { staffId: segs[0].team_member_id } : {}),
          raw: a,
        };
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

import type { AvailabilitySlot, Booking } from '../types';
import { asArray, asRecord, defineAdapter, reqString } from '../adapter-kit';
import { UnibookingError } from '../errors';
import { assertValidRange } from '../time';

/**
 * Bookeo. Auth is an API key + secret key passed as query params. Products are
 * services. Pagination beyond one page and async availability operations are not
 * modeled — pass extra fields through `providerOptions` when needed.
 */
export type BookeoCredentials = {
  apiKey: string;
  secretKey: string;
};

const BASE = 'https://api.bookeo.com/v2/';

function customerOf(b: any): Booking['customer'] | undefined {
  const cu = b?.customer;
  if (!cu) return undefined;
  const name = `${cu.firstName ?? ''} ${cu.lastName ?? ''}`.trim();
  const phone = Array.isArray(cu.phoneNumbers) ? cu.phoneNumbers[0]?.number : undefined;
  if (!name && !cu.emailAddress && !phone) return undefined;
  return {
    ...(cu.id ? { id: String(cu.id) } : {}),
    ...(name ? { name } : {}),
    ...(cu.emailAddress ? { email: cu.emailAddress } : {}),
    ...(phone ? { phone } : {}),
  };
}

function toBooking(raw: unknown): Booking {
  const b = asRecord(raw, 'bookeo', 'booking');
  const start = reqString(b.startTime, 'bookeo', 'booking.startTime');
  const end = reqString(b.endTime, 'bookeo', 'booking.endTime');
  const customer = customerOf(b);
  return {
    id: reqString(String(b.bookingNumber ?? ''), 'bookeo', 'booking.bookingNumber'),
    provider: 'bookeo',
    title: typeof b.title === 'string' && b.title ? b.title : 'Booking',
    range: { start, end },
    ...(b.productId ? { serviceId: String(b.productId) } : {}),
    ...(customer ? { customer } : {}),
    status: b.canceled === true ? 'cancelled' : 'confirmed',
    ...(typeof b.creationTime === 'string' ? { createdAt: b.creationTime } : {}),
    raw: b,
  };
}

function parseBookeoError(_status: number, body: unknown): { providerCode?: string; message?: string } {
  const b = body as any;
  if (!b || typeof b !== 'object') return {};
  // Bookeo's `code` is sometimes numeric — capture it either way.
  const code = b.code ?? b.errorCode;
  return {
    ...(typeof b.message === 'string' ? { message: b.message } : {}),
    ...(typeof code === 'string' || typeof code === 'number' ? { providerCode: String(code) } : {}),
  };
}

function requireProduct(serviceId: string | undefined): string {
  if (!serviceId) {
    throw new UnibookingError({
      provider: 'bookeo',
      code: 'INVALID_INPUT',
      message: 'Bookeo requires a serviceId (productId)',
    });
  }
  return serviceId;
}

export const bookeo = defineAdapter<BookeoCredentials>({
  id: 'bookeo',
  capabilities: {
    availability: true,
    staff: false,
    services: true,
    // Bookeo delivers webhooks but does not sign them, so no verifier is shipped.
    webhooks: false,
    idempotency: false,
    customers: false,
  },
  baseUrl: BASE,
  auth: (c) => ({ query: { apiKey: c.apiKey, secretKey: c.secretKey } }),
  parseError: parseBookeoError,
  build: (http) => ({
    async createBooking(input) {
      assertValidRange(input.range, 'bookeo');
      const c = await http.resolve();
      const res = await http.request(c, {
        method: 'POST',
        path: 'bookings',
        body: {
          productId: requireProduct(input.serviceId),
          startTime: input.range.start,
          endTime: input.range.end,
          ...(input.customer
            ? {
                customer: {
                  ...(input.customer.name ? nameFields(input.customer.name) : {}),
                  ...(input.customer.email ? { emailAddress: input.customer.email } : {}),
                  ...(input.customer.phone
                    ? { phoneNumbers: [{ number: input.customer.phone, type: 'mobile' }] }
                    : {}),
                },
              }
            : {}),
          ...input.providerOptions,
        },
      });
      return toBooking(res);
    },

    async getBooking(id) {
      const c = await http.resolve();
      const res = await http.request(c, { path: `bookings/${encodeURIComponent(id)}` });
      return toBooking(res);
    },

    async updateBooking(id, input) {
      if (input.range) assertValidRange(input.range, 'bookeo');
      const c = await http.resolve();
      const res = await http.request(c, {
        method: 'PUT',
        path: `bookings/${encodeURIComponent(id)}`,
        body: {
          ...(input.range ? { startTime: input.range.start, endTime: input.range.end } : {}),
          ...input.providerOptions,
        },
      });
      return toBooking(res);
    },

    async cancelBooking(id, options) {
      const c = await http.resolve();
      await http.request(c, {
        method: 'DELETE',
        path: `bookings/${encodeURIComponent(id)}`,
        query: { ...(options?.reason ? { reason: options.reason } : {}) },
        parse: 'none',
      });
    },

    async listBookings(query) {
      assertValidRange(query.range, 'bookeo');
      const c = await http.resolve();
      // Bookeo paginates with an opaque pageNavigationToken + a 1-based page
      // number. We pack both into the canonical pageToken as `token|page`.
      const sep = query.pageToken ? query.pageToken.indexOf('|') : -1;
      const navToken = sep >= 0 ? query.pageToken!.slice(0, sep) : undefined;
      const pageNumber = sep >= 0 ? query.pageToken!.slice(sep + 1) : undefined;
      const res = await http.request(c, {
        path: 'bookings',
        query: navToken
          ? { pageNavigationToken: navToken, pageNumber }
          : {
              startTime: query.range.start,
              endTime: query.range.end,
              itemsPerPage: query.limit ?? 100,
            },
      });
      const bookings = asArray(res?.data, 'bookeo', 'bookings.data').map(toBooking);
      const info = res?.info;
      const next =
        info &&
        typeof info.pageNavigationToken === 'string' &&
        typeof info.currentPage === 'number' &&
        typeof info.totalPages === 'number' &&
        info.currentPage < info.totalPages
          ? `${info.pageNavigationToken}|${info.currentPage + 1}`
          : undefined;
      return { bookings, ...(next !== undefined ? { nextPageToken: next } : {}) };
    },

    async searchAvailability(query): Promise<AvailabilitySlot[]> {
      assertValidRange(query.range, 'bookeo');
      const c = await http.resolve();
      // `/availability/slots` needs only product + range (unlike
      // `/availability/matchingslots`, which requires participant counts the
      // canonical query can't express). Works for fixed/course products; for
      // flexibleTime products use matchingslots via a manual call.
      const res = await http.request(c, {
        path: 'availability/slots',
        query: {
          productId: requireProduct(query.serviceId),
          startTime: query.range.start,
          endTime: query.range.end,
          itemsPerPage: 300,
        },
      });
      const slots = asArray(res?.data, 'bookeo', 'availability.slots');
      return slots.flatMap((s: any) => {
        if (typeof s.startTime !== 'string' || typeof s.endTime !== 'string') return [];
        // `raw` carries eventId — required to actually book a fixed-product slot.
        return [{ start: s.startTime, end: s.endTime, raw: s }];
      });
    },
  }),
});

function nameFields(name: string): { firstName: string; lastName: string } {
  const [first, ...rest] = name.trim().split(/\s+/);
  return { firstName: first ?? name, lastName: rest.join(' ') };
}

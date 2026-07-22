import type { AvailabilitySlot, Booking } from '../types';
import { asArray, asRecord, defineAdapter, reqString } from '../adapter-kit';
import { UnibookingError } from '../errors';
import { assertValidRange } from '../time';

/**
 * Bookeo. Auth is an API key + secret key passed as query params. Products are
 * services. Booking pagination is modeled (see `listBookings`); availability
 * paging and the async availability operations are not — pass extra fields
 * through `providerOptions` when needed.
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
    // `noShow` rides on top of `canceled`, and `accepted: false` is a booking
    // still awaiting approval — check the most specific flag first, or the
    // narrower statuses become unreachable on real data.
    status:
      b.noShow === true
        ? 'no_show'
        : b.canceled === true
          ? 'cancelled'
          : b.accepted === false
            ? 'pending'
            : 'confirmed',
    ...(typeof b.creationTime === 'string' ? { createdAt: b.creationTime } : {}),
    ...(typeof b.lastChangeTime === 'string' ? { updatedAt: b.lastChangeTime } : {}),
    raw: b,
  };
}

function parseBookeoError(_status: number, body: unknown): { providerCode?: string; message?: string } {
  const b = body as any;
  if (!b || typeof b !== 'object') return {};
  // The documented error body is {httpStatus, message, errorId}.
  const code = b.errorId;
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

/** `PeopleNumber` requires a `peopleCategoryId`, and the valid ids are defined
 *  per account/product — there is no safe default to invent, and a number-only
 *  block is rejected upstream. Make the caller supply it. */
function requireParticipants(providerOptions: Record<string, unknown> | undefined): void {
  if (providerOptions?.participants !== undefined) return;
  throw new UnibookingError({
    provider: 'bookeo',
    code: 'INVALID_INPUT',
    message:
      'Bookeo requires providerOptions.participants with a peopleCategoryId, e.g. ' +
      '{ numbers: [{ peopleCategoryId: "Cadults", number: 2 }] } — ' +
      'list the ids for your account via GET /settings/peoplecategories',
  });
}

/** Notification switches shared by POST /bookings and DELETE /bookings/{n}. The
 *  canonical `notify` is a single flag, so it drives both. */
function notifyQuery(notify: boolean | undefined): Record<string, boolean> {
  return notify === undefined ? {} : { notifyUsers: notify, notifyCustomer: notify };
}

/** Documented limit: startTime..endTime may not span more than 31 days. Surface
 *  it here rather than as an opaque upstream 400. */
function assertWithin31Days(start: string, end: string): void {
  if (Date.parse(end) - Date.parse(start) > 31 * 24 * 60 * 60 * 1000) {
    throw new UnibookingError({
      provider: 'bookeo',
      code: 'INVALID_INPUT',
      message: 'Bookeo booking ranges may not exceed 31 days',
    });
  }
}

export const bookeo = defineAdapter<BookeoCredentials>({
  id: 'bookeo',
  capabilities: {
    availability: true,
    staff: false,
    services: true,
    // Bookeo signs webhooks with HMAC-SHA256 (hex); see webhooks/bookeo.ts.
    // Verified against the vendor published test vector.
    webhooks: true,
    idempotency: false,
    customers: false,
  },
  baseUrl: BASE,
  auth: (c) => ({ query: { apiKey: c.apiKey, secretKey: c.secretKey } }),
  parseError: parseBookeoError,
  build: (http) => ({
    async createBooking(input) {
      assertValidRange(input.range, 'bookeo');
      // `participants` is required by the Booking schema and only the caller
      // knows their people categories, so it arrives via providerOptions.
      requireParticipants(input.providerOptions);
      const c = await http.resolve();
      const res = await http.request(c, {
        method: 'POST',
        path: 'bookings',
        query: notifyQuery(input.notify),
        body: {
          productId: requireProduct(input.serviceId),
          // `title` is required by the schema, and `toBooking` reads it back.
          title: input.title,
          startTime: input.range.start,
          endTime: input.range.end,
          // An existing customer is booked by id; describing them inline again
          // would create a duplicate record.
          ...(input.customer?.id
            ? { customerId: input.customer.id }
            : input.customer
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
      const res = await http.request(c, {
        path: `bookings/${encodeURIComponent(id)}`,
        // Bookeo omits the customer entirely unless this is set.
        query: { expandCustomer: true },
      });
      return toBooking(res);
    },

    async updateBooking(id, input) {
      if (input.range) assertValidRange(input.range, 'bookeo');
      // Bookeo cancels via DELETE, and its PUT is not a documented partial-update
      // contract — so only the times are safe to send. Reject the rest rather
      // than accept a field this call will quietly discard.
      if (input.status !== undefined) {
        throw new UnibookingError({
          provider: 'bookeo',
          code: 'INVALID_INPUT',
          message:
            input.status === 'cancelled'
              ? 'Bookeo booking status is not writable; use cancelBooking() to cancel'
              : `Bookeo booking status is not writable (cannot set "${input.status}")`,
        });
      }
      if (input.title !== undefined || input.staffId !== undefined || input.serviceId !== undefined) {
        throw new UnibookingError({
          provider: 'bookeo',
          code: 'UNSUPPORTED',
          message:
            'Bookeo updates only reschedule (startTime/endTime); change title, staff or ' +
            'product via providerOptions once you have confirmed the PUT contract for your product type',
        });
      }
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
        query: {
          ...(options?.reason ? { reason: options.reason } : {}),
          ...notifyQuery(options?.notify),
        },
        parse: 'none',
      });
    },

    async listBookings(query) {
      assertValidRange(query.range, 'bookeo');
      assertWithin31Days(query.range.start, query.range.end);
      const c = await http.resolve();
      // Bookeo paginates with an opaque pageNavigationToken + a 1-based page
      // number. We pack both into the canonical pageToken as `token|page`.
      const sep = query.pageToken ? query.pageToken.indexOf('|') : -1;
      const navToken = sep >= 0 ? query.pageToken!.slice(0, sep) : undefined;
      const pageNumber = sep >= 0 ? query.pageToken!.slice(sep + 1) : undefined;
      const res = await http.request(c, {
        path: 'bookings',
        query: {
          // Without this the customer field is omitted from every booking.
          expandCustomer: true,
          ...(navToken
            ? { pageNavigationToken: navToken, pageNumber }
            : {
                startTime: query.range.start,
                endTime: query.range.end,
                itemsPerPage: Math.min(query.limit ?? 100, 100),
                // Cancelled bookings are excluded by default, so asking for them
                // would otherwise return nothing.
                ...(query.status === 'cancelled' ? { includeCanceled: true } : {}),
              }),
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

function nameFields(name: string): { firstName: string; lastName?: string } {
  const [first, ...rest] = name.trim().split(/\s+/);
  // Omit lastName rather than sending '' — an explicit empty surname overwrites
  // whatever the customer record already has.
  return { firstName: first ?? name, ...(rest.length ? { lastName: rest.join(' ') } : {}) };
}

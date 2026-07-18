import type { AvailabilitySlot, Booking, BookingStatus, Customer } from '../types';
import { asArray, asRecord, defineAdapter, reqString, unsupported } from '../adapter-kit';
import type { HttpContext } from '../http';
import { UnibookingError } from '../errors';
import { assertValidRange, endFromDuration, isInstant } from '../time';

/**
 * Wix Bookings (headless REST). Bookings Writer V2 for create/reschedule/cancel,
 * Reader V2 for get/query, Time Slots V2 for availability, and CRM Contacts v4
 * for customer resolution.
 *
 * Auth: bring your own OAuth access token (Wix app instance / member / user
 * token). It is sent verbatim in the `Authorization` header — no `Bearer`
 * prefix, which is how Wix expects app tokens.
 *
 * NOTE: shapes here are docs-derived, not verified against a live Wix tenant.
 * Fields marked `TODO: verify against live API` are the ones most likely to need
 * a tweak once run against a real site.
 */
export type WixCredentials = {
  accessToken: string;
};

const BASE = 'https://www.wixapis.com/';

function enc(id: string): string {
  return encodeURIComponent(id);
}

function mapStatus(s: unknown): BookingStatus {
  switch (String(s).toUpperCase()) {
    case 'CONFIRMED':
    case 'CREATED': // a created booking is an active reservation
      return 'confirmed';
    case 'PENDING':
    case 'WAITING_LIST':
      return 'pending';
    case 'CANCELED':
    case 'CANCELLED':
      return 'cancelled';
    case 'DECLINED':
      return 'declined';
    default:
      return 'unknown';
  }
}

/** The bookable slot lives under `bookedEntity.slot` (single session) — Wix also
 *  supports `bookedEntity.schedule` for classes, which we surface via `raw`. */
function slotOf(b: Record<string, any>): Record<string, any> | undefined {
  const entity = b.bookedEntity;
  if (entity && typeof entity === 'object') {
    if (entity.slot && typeof entity.slot === 'object') return entity.slot;
    if (entity.schedule && typeof entity.schedule === 'object') return entity.schedule;
  }
  return undefined;
}

function customerOf(b: Record<string, any>): Customer | undefined {
  const cd = b.contactDetails;
  if (!cd || typeof cd !== 'object') return undefined;
  const name = `${cd.firstName ?? ''} ${cd.lastName ?? ''}`.trim();
  const id = cd.contactId;
  if (!id && !name && !cd.email && !cd.phone) return undefined;
  return {
    ...(id ? { id: String(id) } : {}),
    ...(name ? { name } : {}),
    ...(cd.email ? { email: String(cd.email) } : {}),
    ...(cd.phone ? { phone: String(cd.phone) } : {}),
  };
}

function toBooking(raw: unknown): Booking {
  const b = asRecord(raw, 'wix', 'booking');
  const slot = slotOf(b);
  const start = slot?.startDate;
  const end = slot?.endDate;
  if (typeof start !== 'string' || typeof end !== 'string') {
    throw new UnibookingError({
      provider: 'wix',
      code: 'UPSTREAM',
      message: 'booking is missing bookedEntity.slot start/end dates',
    });
  }
  const entity = b.bookedEntity ?? {};
  const customer = customerOf(b);
  return {
    id: reqString(String(b.id ?? ''), 'wix', 'booking.id'),
    provider: 'wix',
    title: typeof entity.title === 'string' && entity.title ? entity.title : 'Appointment',
    range: { start, end },
    ...(slot?.resource?.id ? { staffId: String(slot.resource.id) } : {}),
    ...(slot?.serviceId ? { serviceId: String(slot.serviceId) } : {}),
    ...(customer ? { customer } : {}),
    status: mapStatus(b.status),
    ...(typeof b.createdDate === 'string' ? { createdAt: b.createdDate } : {}),
    ...(typeof b.updatedDate === 'string' ? { updatedAt: b.updatedDate } : {}),
    raw: b,
  };
}

function parseWixError(_status: number, body: unknown): { providerCode?: string; message?: string } {
  const b = body as any;
  const message = b?.message ?? b?.details?.applicationError?.description;
  const code = b?.details?.applicationError?.code ?? b?.code;
  return {
    ...(typeof message === 'string' ? { message } : {}),
    ...(code ? { providerCode: String(code) } : {}),
  };
}

function splitName(name: string): { firstName: string; lastName?: string } {
  const [first, ...rest] = name.trim().split(/\s+/);
  return { firstName: first ?? name, ...(rest.length ? { lastName: rest.join(' ') } : {}) };
}

/** CRM Contacts v4 `info.name` shape ({ first, last }) — distinct from the
 *  booking `contactDetails` shape ({ firstName, lastName }). */
function contactName(name: string): { first: string; last?: string } {
  const [first, ...rest] = name.trim().split(/\s+/);
  return { first: first ?? name, ...(rest.length ? { last: rest.join(' ') } : {}) };
}

/** Resolve a canonical customer to a Wix CRM contact id, creating one if needed. */
async function findOrCreateContact(
  http: HttpContext<WixCredentials>,
  c: WixCredentials,
  customer: Customer,
): Promise<string> {
  if (customer.id) return customer.id;
  // TODO: verify against live API — Contacts v4 query filter uses `info.emails.email`.
  if (customer.email) {
    const search = await http.request(c, {
      method: 'POST',
      path: 'contacts/v4/contacts/query',
      body: { query: { filter: { 'info.emails.email': customer.email } } },
    });
    const found = asArray(search?.contacts, 'wix', 'contacts.query')[0];
    if (found?.id) return String(found.id);
  }
  const info = {
    // CRM Contacts v4 `info.name` is { first, last } — NOT { firstName, lastName }
    // (that shape is right for booking.contactDetails, but wrong here, so the
    // contact's name was being silently dropped).
    ...(customer.name ? { name: contactName(customer.name) } : {}),
    ...(customer.email ? { emails: { items: [{ email: customer.email }] } } : {}),
    ...(customer.phone ? { phones: { items: [{ phone: customer.phone }] } } : {}),
  };
  const created = await http.request(c, {
    method: 'POST',
    path: 'contacts/v4/contacts',
    body: { info },
  });
  return reqString(String(created?.contact?.id ?? ''), 'wix', 'contact.id');
}

async function getBooking(
  http: HttpContext<WixCredentials>,
  c: WixCredentials,
  id: string,
): Promise<Booking> {
  // TODO: verify against live API — Reader V2 may require the query endpoint instead of GET-by-id.
  const res = await http.request(c, { path: `bookings/reader/v2/bookings/${enc(id)}` });
  return toBooking(res?.booking ?? res);
}

export const wix = defineAdapter<WixCredentials>({
  id: 'wix',
  capabilities: {
    availability: true,
    staff: true,
    services: true,
    webhooks: true,
    idempotency: false,
    customers: true,
  },
  baseUrl: BASE,
  auth: (c) => ({ headers: { authorization: c.accessToken } }),
  parseError: parseWixError,
  build: (http) => ({
    async createBooking(input) {
      assertValidRange(input.range, 'wix');
      const c = await http.resolve();
      let contactId = input.customer?.id;
      if (contactId === undefined && input.customer && (input.customer.email || input.customer.phone)) {
        contactId = await findOrCreateContact(http, c, input.customer);
      }
      const cust = input.customer;
      const res = await http.request(c, {
        method: 'POST',
        path: 'bookings/v2/bookings',
        body: {
          booking: {
            bookedEntity: {
              title: input.title,
              slot: {
                ...(input.serviceId ? { serviceId: input.serviceId } : {}),
                startDate: input.range.start,
                endDate: input.range.end,
                ...(input.staffId ? { resource: { id: input.staffId } } : {}),
              },
            },
            ...(cust
              ? {
                  contactDetails: {
                    ...(contactId ? { contactId } : {}),
                    ...(cust.name ? splitName(cust.name) : {}),
                    ...(cust.email ? { email: cust.email } : {}),
                    ...(cust.phone ? { phone: cust.phone } : {}),
                  },
                }
              : {}),
            ...input.providerOptions,
          },
        },
      });
      return toBooking(res?.booking);
    },

    getBooking(id) {
      return http.resolve().then((c) => getBooking(http, c, id));
    },

    async updateBooking(id, input) {
      const c = await http.resolve();
      // Wix reschedules by posting a new slot; other field edits aren't a
      // reschedule. Cancellation routes to the cancel endpoint.
      if (input.range) {
        assertValidRange(input.range, 'wix');
        const res = await http.request(c, {
          method: 'POST',
          path: `bookings/v2/bookings/${enc(id)}/reschedule`,
          body: {
            slot: {
              startDate: input.range.start,
              endDate: input.range.end,
              ...(input.staffId ? { resource: { id: input.staffId } } : {}),
              ...(input.serviceId ? { serviceId: input.serviceId } : {}),
            },
            ...input.providerOptions,
          },
        });
        return toBooking(res?.booking);
      }
      if (input.status === 'cancelled') {
        // Wix's cancel endpoint returns the updated booking, so map it directly
        // rather than making a second round-trip.
        const res = await http.request(c, {
          method: 'POST',
          path: `bookings/v2/bookings/${enc(id)}/cancel`,
          body: {},
        });
        return toBooking(res?.booking);
      }
      return unsupported(
        'wix',
        'updateBooking without a range (Wix supports reschedule or cancel, not arbitrary field edits)',
      );
    },

    async cancelBooking(id, options) {
      const c = await http.resolve();
      await http.request(c, {
        method: 'POST',
        path: `bookings/v2/bookings/${enc(id)}/cancel`,
        body: {
          // TODO: verify against live API — Wix uses `participantNotification` to control emails.
          ...(options?.notify !== undefined
            ? { participantNotification: { notifyParticipants: options.notify } }
            : {}),
        },
        parse: 'none',
      });
    },

    async listBookings(query) {
      assertValidRange(query.range, 'wix');
      const c = await http.resolve();
      // TODO: verify against live API — Reader V2 query filter field/operators.
      const res = await http.request(c, {
        method: 'POST',
        path: 'bookings/reader/v2/bookings/query',
        body: {
          query: {
            filter: {
              startDate: { $gte: query.range.start, $lte: query.range.end },
              ...(query.staffId ? { 'bookedEntity.slot.resource.id': query.staffId } : {}),
            },
            cursorPaging: { limit: query.limit ?? 50, ...(query.pageToken ? { cursor: query.pageToken } : {}) },
          },
        },
      });
      const bookings = asArray(res?.bookings ?? res?.items, 'wix', 'bookings').map(toBooking);
      const next = res?.pagingMetadata?.cursors?.next;
      return { bookings, ...(typeof next === 'string' && next ? { nextPageToken: next } : {}) };
    },

    async searchAvailability(query): Promise<AvailabilitySlot[]> {
      assertValidRange(query.range, 'wix');
      const c = await http.resolve();
      // TODO: verify against live API — Time Slots V2 endpoint + request shape.
      const res = await http.request(c, {
        method: 'POST',
        path: 'bookings/v2/time-slots/list-availability-time-slots',
        body: {
          ...(query.serviceId ? { serviceId: query.serviceId } : {}),
          startDate: query.range.start,
          endDate: query.range.end,
          ...(query.staffId ? { resourceIds: [query.staffId] } : {}),
        },
      });
      const slots = asArray(
        res?.availabilityTimeSlots ?? res?.timeSlots ?? res?.slots,
        'wix',
        'availabilityTimeSlots',
      );
      return slots.flatMap((s: any): AvailabilitySlot[] => {
        const inner = s.slot ?? s;
        const start = inner.startDate;
        // Wix may return `localStartDate` (no offset) when a slot has a timezone;
        // those are not canonical instants, so we skip them rather than emit an
        // ambiguous time. Callers needing those should read `raw`.
        if (typeof start !== 'string' || !isInstant(start)) return [];
        const rawEnd = inner.endDate;
        const end =
          typeof rawEnd === 'string' && isInstant(rawEnd)
            ? rawEnd
            : query.durationMinutes
              ? endFromDuration(start, query.durationMinutes)
              : undefined;
        if (end === undefined) return [];
        const staffId = inner.resource?.id ?? query.staffId;
        return [{ start, end, ...(staffId ? { staffId: String(staffId) } : {}), raw: s }];
      });
    },

    customers: {
      findOrCreate: async (customer) => {
        const c = await http.resolve();
        return findOrCreateContact(http, c, customer);
      },
    },
  }),
});

import type { AvailabilitySlot, Booking } from '../types';
import { asArray, asRecord, defineAdapter, reqString } from '../adapter-kit';
import { UnibookingError } from '../errors';
import { assertValidRange } from '../time';
import { graphDateTime, graphToInstant, nextLinkFrom, parseGraphError, PREFER_UTC } from '../graph';

/**
 * Microsoft Bookings (via Microsoft Graph). Has real staff and services.
 * Scope: `Bookings.ReadWrite.All`.
 *
 * NOTE on availability: `getStaffAvailability` is GA in v1.0, but Graph documents
 * it as **application-permission only** — delegated user tokens are not
 * supported for that action, unlike every other call here. If your token is
 * delegated, `searchAvailability` will fail even though the rest works.
 */
export type MicrosoftBookingsCredentials = {
  accessToken: string;
  /** The booking business id (e.g. `contoso@contoso.onmicrosoft.com`). */
  businessId: string;
};

const BASE = 'https://graph.microsoft.com/v1.0/';

function base(c: MicrosoftBookingsCredentials): string {
  return `solutions/bookingBusinesses/${encodeURIComponent(c.businessId)}`;
}

function toBooking(raw: unknown): Booking {
  const a = asRecord(raw, 'microsoft_bookings', 'appointment');
  // Graph's bookingAppointment exposes the times as `start`/`end` (each a
  // dateTimeTimeZone) — NOT `startDateTime`/`endDateTime`. Reading the wrong
  // names made every read throw "missing start/end times".
  const start = graphToInstant(a.start);
  const end = graphToInstant(a.end);
  if (start === undefined || end === undefined) {
    throw new UnibookingError({
      provider: 'microsoft_bookings',
      code: 'UPSTREAM',
      message: 'appointment is missing start/end times',
    });
  }
  const cust = Array.isArray(a.customers) ? a.customers[0] : undefined;
  const customer =
    cust && (cust.emailAddress || cust.name)
      ? {
          ...(cust.emailAddress ? { email: cust.emailAddress } : {}),
          ...(cust.name ? { name: cust.name } : {}),
        }
      : undefined;
  const staffId = Array.isArray(a.staffMemberIds) ? a.staffMemberIds[0] : undefined;
  return {
    id: reqString(a.id, 'microsoft_bookings', 'appointment.id'),
    provider: 'microsoft_bookings',
    title: typeof a.serviceName === 'string' && a.serviceName ? a.serviceName : 'Appointment',
    range: { start, end },
    ...(staffId ? { staffId } : {}),
    ...(typeof a.serviceId === 'string' ? { serviceId: a.serviceId } : {}),
    ...(customer ? { customer } : {}),
    // The Graph bookingAppointment resource exposes no status/cancellation field,
    // so a returned appointment is always a live booking. (A cancelled one is
    // removed, not flagged.) Anything richer would be fabricated.
    status: 'confirmed',
    raw: a,
  };
}

function customerInfo(input: { customer?: { name?: string; email?: string; phone?: string } }) {
  const cu = input.customer;
  if (!cu) return [];
  return [
    {
      '@odata.type': '#microsoft.graph.bookingCustomerInformation',
      ...(cu.name ? { name: cu.name } : {}),
      ...(cu.email ? { emailAddress: cu.email } : {}),
      ...(cu.phone ? { phone: cu.phone } : {}),
    },
  ];
}

export const microsoftBookings = defineAdapter<MicrosoftBookingsCredentials>({
  id: 'microsoft_bookings',
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
  requestIdHeader: 'request-id',
  parseError: parseGraphError,
  build: (http) => ({
    async createBooking(input) {
      assertValidRange(input.range, 'microsoft_bookings');
      const c = await http.resolve();
      const res = await http.request(c, {
        method: 'POST',
        path: `${base(c)}/appointments`,
        headers: PREFER_UTC,
        body: {
          '@odata.type': '#microsoft.graph.bookingAppointment',
          start: graphDateTime(input.range.start),
          end: graphDateTime(input.range.end),
          // serviceName is optional (computed from the service when omitted),
          // but the caller's title is the closest canonical fit — don't drop it.
          ...(input.title ? { serviceName: input.title } : {}),
          ...(input.serviceId ? { serviceId: input.serviceId } : {}),
          ...(input.staffId ? { staffMemberIds: [input.staffId] } : {}),
          customers: customerInfo(input),
          ...input.providerOptions,
        },
      });
      return toBooking(res);
    },

    async getBooking(id) {
      const c = await http.resolve();
      const res = await http.request(c, {
        path: `${base(c)}/appointments/${encodeURIComponent(id)}`,
        headers: PREFER_UTC,
      });
      return toBooking(res);
    },

    async updateBooking(id, input) {
      if (input.range) assertValidRange(input.range, 'microsoft_bookings');
      // bookingAppointment has no writable status; silently PATCHing nothing and
      // returning a live booking would report a cancel as "done" when it wasn't.
      if (input.status === 'cancelled') {
        throw new UnibookingError({
          provider: 'microsoft_bookings',
          code: 'INVALID_INPUT',
          message: 'Bookings has no writable status; use cancelBooking() to cancel',
        });
      }
      const c = await http.resolve();
      const path = `${base(c)}/appointments/${encodeURIComponent(id)}`;
      // Graph's appointment PATCH returns 204 No Content, so there is no body to
      // map — issue the update, then re-GET to return the current appointment.
      await http.request(c, {
        method: 'PATCH',
        path,
        headers: PREFER_UTC,
        body: {
          // Graph's documented appointment PATCH examples all carry the type
          // annotation (as create does); omitting it is known to fail requests.
          '@odata.type': '#microsoft.graph.bookingAppointment',
          ...(input.range ? { start: graphDateTime(input.range.start), end: graphDateTime(input.range.end) } : {}),
          ...(input.title ? { serviceName: input.title } : {}),
          ...(input.staffId ? { staffMemberIds: [input.staffId] } : {}),
          ...(input.serviceId ? { serviceId: input.serviceId } : {}),
          ...input.providerOptions,
        },
        parse: 'none',
      });
      const res = await http.request(c, { path, headers: PREFER_UTC });
      return toBooking(res);
    },

    async cancelBooking(id, options) {
      const c = await http.resolve();
      await http.request(c, {
        method: 'POST',
        path: `${base(c)}/appointments/${encodeURIComponent(id)}/cancel`,
        body: { cancellationMessage: options?.reason ?? 'Cancelled' },
        parse: 'none',
      });
    },

    async listBookings(query) {
      assertValidRange(query.range, 'microsoft_bookings');
      const c = await http.resolve();
      // A pageToken is the full @odata.nextLink; follow it verbatim so any Graph
      // paging param ($skiptoken or $skip) is preserved.
      const follow =
        query.pageToken && /^https?:\/\//i.test(query.pageToken) ? query.pageToken : undefined;
      if (query.pageToken !== undefined && follow === undefined) {
        // Forwarding a hand-built `$skiptoken` returned page 1 forever: Graph
        // ignores unrecognized query params silently, and its paging docs say a
        // token must never be extracted and reused.
        throw new UnibookingError({
          provider: 'microsoft_bookings',
          code: 'INVALID_INPUT',
          message:
            'pageToken must be the full @odata.nextLink URL from a previous page; ' +
            'Graph paging tokens cannot be reconstructed',
        });
      }
      const res = follow
        ? await http.request(c, { path: follow, headers: PREFER_UTC })
        : await http.request(c, {
            path: `${base(c)}/calendarView`,
            headers: PREFER_UTC,
            query: {
              start: query.range.start,
              end: query.range.end,
              $top: query.limit ?? 50,
            },
          });
      const bookings = asArray(res?.value, 'microsoft_bookings', 'calendarView.value').map(toBooking);
      const next = nextLinkFrom(res);
      return { bookings, ...(next !== undefined ? { nextPageToken: next } : {}) };
    },

    async searchAvailability(query): Promise<AvailabilitySlot[]> {
      assertValidRange(query.range, 'microsoft_bookings');
      const c = await http.resolve();
      let staffIds: string[];
      if (query.staffId) {
        staffIds = [query.staffId];
      } else {
        // Enumerate all staff, following @odata.nextLink so businesses with more
        // than one page of staff members aren't silently truncated.
        staffIds = [];
        let page = await http.request(c, { path: `${base(c)}/staffMembers`, query: { $top: 200 } });
        // Bounded like `listAll`, so a misbehaving nextLink can't loop forever.
        for (let i = 0; i < 50; i++) {
          for (const s of asArray(page?.value, 'microsoft_bookings', 'staffMembers.value')) {
            if (typeof s?.id === 'string') staffIds.push(s.id);
          }
          const next = nextLinkFrom(page);
          if (next === undefined) break;
          page = await http.request(c, { path: next });
        }
      }
      if (staffIds.length === 0) return [];
      const res = await http.request(c, {
        method: 'POST',
        path: `${base(c)}/getStaffAvailability`,
        body: {
          staffIds,
          startDateTime: graphDateTime(query.range.start),
          endDateTime: graphDateTime(query.range.end),
        },
      });
      const out: AvailabilitySlot[] = [];
      // The documented response wraps the collection as `staffAvailabilityItem`
      // (not the usual OData `value`); read both defensively.
      const entries = (res as any)?.staffAvailabilityItem ?? (res as any)?.value;
      for (const entry of asArray(entries, 'microsoft_bookings', 'staffAvailability')) {
        const e = asRecord(entry, 'microsoft_bookings', 'staffAvailabilityItem');
        const staffId = typeof e.staffId === 'string' ? e.staffId : undefined;
        for (const item of asArray(e.availabilityItems ?? [], 'microsoft_bookings', 'availabilityItems')) {
          const slot = asRecord(item, 'microsoft_bookings', 'availabilityItem');
          // `available` windows are bookable; so are `slotsAvailable` ones (1:n
          // group services with remaining capacity). busy/out-of-office are not.
          const status = String(slot.status).toLowerCase();
          if (status !== 'available' && status !== 'slotsavailable') continue;
          const start = graphToInstant(slot.startDateTime);
          const end = graphToInstant(slot.endDateTime);
          if (start === undefined || end === undefined) continue;
          out.push({ start, end, ...(staffId ? { staffId } : {}), raw: slot });
        }
      }
      return out;
    },

    customers: {
      findOrCreate: async (customer) => {
        if (customer.id) return customer.id;
        const c = await http.resolve();
        const email = customer.email;
        if (email) {
          // Match an existing bookingCustomer by email, following @odata.nextLink
          // so a business with many customers still resolves. Bounded like the
          // other paged reads here, so a misbehaving nextLink can't loop forever.
          const wanted = email.toLowerCase();
          let page = await http.request(c, { path: `${base(c)}/customers`, query: { $top: 200 } });
          for (let i = 0; i < 50; i++) {
            for (const cust of asArray(page?.value, 'microsoft_bookings', 'customers.value')) {
              if (typeof cust?.emailAddress === 'string' && cust.emailAddress.toLowerCase() === wanted) {
                return reqString(cust.id, 'microsoft_bookings', 'customer.id');
              }
            }
            const next = nextLinkFrom(page);
            if (next === undefined) break;
            page = await http.request(c, { path: next });
          }
        }
        const created = await http.request(c, {
          method: 'POST',
          path: `${base(c)}/customers`,
          body: {
            '@odata.type': '#microsoft.graph.bookingCustomer',
            displayName: customer.name ?? customer.email ?? 'Guest',
            ...(customer.email ? { emailAddress: customer.email } : {}),
          },
        });
        return reqString(created?.id, 'microsoft_bookings', 'customer.id');
      },
    },
  }),
});

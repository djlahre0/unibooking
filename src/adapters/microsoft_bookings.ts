import type { Booking } from '../types';
import { asArray, asRecord, defineAdapter, reqString, unsupported } from '../adapter-kit';
import { UnibookingError } from '../errors';
import { assertValidRange } from '../time';
import { graphDateTime, graphToInstant, nextLinkFrom, parseGraphError, PREFER_UTC } from '../graph';

/**
 * Microsoft Bookings (via Microsoft Graph). Has real staff and services.
 * Scope: `Bookings.ReadWrite.All`. Availability search is not modeled here.
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
    availability: false,
    staff: true,
    services: true,
    webhooks: false,
    idempotency: false,
    customers: false,
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
      const c = await http.resolve();
      const path = `${base(c)}/appointments/${encodeURIComponent(id)}`;
      // Graph's appointment PATCH returns 204 No Content, so there is no body to
      // map — issue the update, then re-GET to return the current appointment.
      await http.request(c, {
        method: 'PATCH',
        path,
        headers: PREFER_UTC,
        body: {
          ...(input.range ? { start: graphDateTime(input.range.start), end: graphDateTime(input.range.end) } : {}),
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
      const res = follow
        ? await http.request(c, { path: follow, headers: PREFER_UTC })
        : await http.request(c, {
            path: `${base(c)}/calendarView`,
            headers: PREFER_UTC,
            query: {
              start: query.range.start,
              end: query.range.end,
              $top: query.limit ?? 50,
              ...(query.pageToken ? { $skiptoken: query.pageToken } : {}),
            },
          });
      const bookings = asArray(res?.value, 'microsoft_bookings', 'calendarView.value').map(toBooking);
      const next = nextLinkFrom(res);
      return { bookings, ...(next !== undefined ? { nextPageToken: next } : {}) };
    },

    async searchAvailability(_query) {
      return unsupported('microsoft_bookings', 'availability');
    },
  }),
});

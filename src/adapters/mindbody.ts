import type { AvailabilitySlot, Booking, BookingStatus } from '../types';
import { asArray, asRecord, defineAdapter, reqString, unsupported } from '../adapter-kit';
import { UnibookingError } from '../errors';
import { assertValidRange, formatWithOffset } from '../time';
import { localToInstant, zoneOffsetMinutes } from '../tz';

/**
 * Mindbody (public API v6). Auth is three headers: `Api-Key`, `SiteId`, and a
 * staff/user token as `Authorization` (obtain it via `/usertoken/issue` and pass
 * it in — this package never stores it).
 *
 * IMPORTANT: Mindbody returns site-LOCAL datetimes without an offset. Provide
 * either the site's IANA `timezone` (e.g. `America/Los_Angeles`, DST-correct) or
 * a fixed `utcOffset` (e.g. `-08:00`) so this adapter can produce correct
 * canonical instants; without either, times are treated as UTC. `timezone` is
 * preferred — a fixed offset is wrong for half the year in DST-observing zones.
 * The public API has no appointment-cancel endpoint, so `cancelBooking` throws
 * UNSUPPORTED. Validate endpoint shapes against a live sandbox before relying
 * on this in production.
 */
export type MindbodyCredentials = {
  apiKey: string;
  siteId: string;
  /** Staff/user token (the `Authorization` header value). */
  accessToken: string;
  locationId?: string;
  /** Site IANA time zone (e.g. `America/Los_Angeles`). DST-correct; preferred
   *  over `utcOffset`. Takes precedence when both are set. */
  timezone?: string;
  /** Fixed site UTC offset like `-08:00`; defaults to `Z` (UTC). Used when
   *  `timezone` is absent. Note: a fixed offset ignores DST. */
  utcOffset?: string;
};

/** How to interpret Mindbody's offset-less site-local datetimes. */
interface SiteTz {
  offset?: string;
  zone?: string;
}

function siteTz(c: MindbodyCredentials): SiteTz {
  return {
    ...(c.utcOffset ? { offset: c.utcOffset } : {}),
    ...(c.timezone ? { zone: c.timezone } : {}),
  };
}

const BASE = 'https://api.mindbodyonline.com/public/v6/';

function offsetMinutesOf(token: string): number {
  if (token.toUpperCase() === 'Z') return 0;
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(token);
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

/** Site-local (offset-less) datetime → canonical instant. Uses the IANA zone
 *  (DST-correct) when provided, else the fixed offset, else UTC. */
function toInstant(naive: unknown, tz: SiteTz): string | undefined {
  if (typeof naive !== 'string' || !naive) return undefined;
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(naive)) {
    return naive.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  }
  if (tz.zone) {
    const resolved = localToInstant(naive, tz.zone, (ms) => formatWithOffset(ms, 0));
    if (resolved !== undefined) return resolved;
  }
  const token = tz.offset ?? 'Z';
  return naive + (token.toUpperCase() === 'Z' ? 'Z' : token);
}

/** Canonical instant → the site-local (offset-less) datetime Mindbody expects.
 *  Resolves the zone's offset at that specific instant (so DST is applied). */
function toSiteLocal(instant: string, tz: SiteTz): string {
  const epoch = Date.parse(instant);
  const offsetMin = tz.zone
    ? (zoneOffsetMinutes(tz.zone, new Date(epoch)) ?? offsetMinutesOf(tz.offset ?? 'Z'))
    : offsetMinutesOf(tz.offset ?? 'Z');
  const local = formatWithOffset(epoch, offsetMin);
  return local.replace(/(Z|[+-]\d{2}:\d{2})$/, '');
}

function mapStatus(s: unknown): BookingStatus {
  switch (s) {
    case 'Booked':
    case 'Confirmed':
    case 'Arrived':
      return 'confirmed';
    case 'Requested':
      // An unconfirmed/requested booking is pending, not unknown.
      return 'pending';
    case 'Completed':
      return 'completed';
    case 'Cancelled':
    case 'LateCancelled':
      return 'cancelled';
    case 'NoShow':
      return 'no_show';
    default:
      return 'unknown';
  }
}

function toBooking(raw: unknown, tz: SiteTz): Booking {
  const a = asRecord(raw, 'mindbody', 'appointment');
  const start = toInstant(a.StartDateTime, tz);
  const end = toInstant(a.EndDateTime, tz);
  if (start === undefined || end === undefined) {
    throw new UnibookingError({
      provider: 'mindbody',
      code: 'UPSTREAM',
      message: 'appointment is missing StartDateTime/EndDateTime',
    });
  }
  const serviceId = a.SessionTypeId ?? a.AppointmentTypeId;
  return {
    id: reqString(String(a.Id ?? ''), 'mindbody', 'appointment.Id'),
    provider: 'mindbody',
    title: typeof a.Notes === 'string' && a.Notes ? a.Notes : 'Appointment',
    range: { start, end },
    ...(a.StaffId !== undefined ? { staffId: String(a.StaffId) } : {}),
    ...(serviceId !== undefined ? { serviceId: String(serviceId) } : {}),
    ...(a.ClientId !== undefined ? { customer: { id: String(a.ClientId) } } : {}),
    status: mapStatus(a.Status),
    raw: a,
  };
}

function parseMindbodyError(_status: number, body: unknown): { providerCode?: string; message?: string } {
  const err = (body as any)?.Error ?? body;
  if (!err || typeof err !== 'object') return {};
  return {
    ...(typeof err.Message === 'string' ? { message: err.Message } : {}),
    ...(typeof err.Code === 'string' ? { providerCode: err.Code } : {}),
  };
}

function required(value: string | undefined, name: string): string {
  if (!value) {
    throw new UnibookingError({
      provider: 'mindbody',
      code: 'INVALID_INPUT',
      message: `Mindbody requires ${name}`,
    });
  }
  return value;
}

export const mindbody = defineAdapter<MindbodyCredentials>({
  id: 'mindbody',
  capabilities: {
    availability: true,
    staff: true,
    services: true,
    // Mindbody ships a Webhooks API; see webhooks/mindbody.ts for signature
    // verification. (Appointment cancellation is only *observable* via the
    // `appointmentBooking.cancelled` event — there is no cancel endpoint.)
    webhooks: true,
    idempotency: false,
    customers: false,
  },
  baseUrl: BASE,
  auth: (c) => ({
    headers: { 'Api-Key': c.apiKey, SiteId: c.siteId, authorization: c.accessToken },
  }),
  parseError: parseMindbodyError,
  build: (http) => ({
    async createBooking(input) {
      assertValidRange(input.range, 'mindbody');
      const c = await http.resolve();
      const tz = siteTz(c);
      const res = await http.request(c, {
        method: 'POST',
        path: 'appointment/addappointment',
        body: {
          ClientId: required(input.customer?.id, 'customer.id (ClientId)'),
          StaffId: required(input.staffId, 'staffId (StaffId)'),
          SessionTypeId: required(input.serviceId, 'serviceId (SessionTypeId)'),
          // LocationId is REQUIRED by AddAppointment (not optional).
          LocationId: required(c.locationId, 'locationId (LocationId)'),
          StartDateTime: toSiteLocal(input.range.start, tz),
          ...input.providerOptions,
        },
      });
      return toBooking(res?.Appointment ?? res, tz);
    },

    async getBooking(id) {
      const c = await http.resolve();
      const tz = siteTz(c);
      const res = await http.request(c, {
        path: 'appointment/staffappointments',
        query: { AppointmentIds: id },
      });
      const appts = asArray(res?.Appointments, 'mindbody', 'Appointments');
      if (appts.length === 0) {
        throw new UnibookingError({ provider: 'mindbody', code: 'NOT_FOUND', message: `appointment ${id} not found` });
      }
      return toBooking(appts[0], tz);
    },

    async updateBooking(id, input) {
      if (input.range) assertValidRange(input.range, 'mindbody');
      const c = await http.resolve();
      const tz = siteTz(c);
      // Mindbody's UpdateAppointment is a POST (there is no PUT form).
      const res = await http.request(c, {
        method: 'POST',
        path: 'appointment/updateappointment',
        body: {
          AppointmentId: id,
          ...(input.range ? { StartDateTime: toSiteLocal(input.range.start, tz) } : {}),
          ...(input.staffId ? { StaffId: input.staffId } : {}),
          ...input.providerOptions,
        },
      });
      return toBooking(res?.Appointment ?? res, tz);
    },

    async cancelBooking(_id) {
      // The Mindbody public API has no appointment-cancel endpoint.
      return unsupported('mindbody', 'cancelBooking');
    },

    async listBookings(query) {
      assertValidRange(query.range, 'mindbody');
      const c = await http.resolve();
      const tz = siteTz(c);
      const requestedOffset = query.pageToken ? Number(query.pageToken) : 0;
      const limit = query.limit ?? 100;
      const res = await http.request(c, {
        path: 'appointment/staffappointments',
        query: {
          // Mindbody treats these as site-local; forward the site wall clock
          // (matching the write paths) so an offset doesn't shift the window.
          StartDate: toSiteLocal(query.range.start, tz),
          EndDate: toSiteLocal(query.range.end, tz),
          StaffIds: query.staffId,
          Offset: requestedOffset,
          Limit: limit,
        },
      });
      const appts = asArray(res?.Appointments, 'mindbody', 'Appointments');
      const bookings = appts.map((a) => toBooking(a, tz));
      const total = res?.PaginationResponse?.TotalResults;
      const nextOffset = requestedOffset + bookings.length;
      const hasMore = typeof total === 'number' && nextOffset < total && bookings.length > 0;
      return { bookings, ...(hasMore ? { nextPageToken: String(nextOffset) } : {}) };
    },

    async searchAvailability(query): Promise<AvailabilitySlot[]> {
      assertValidRange(query.range, 'mindbody');
      const c = await http.resolve();
      const tz = siteTz(c);
      const res = await http.request(c, {
        path: 'appointment/bookableitems',
        query: {
          SessionTypeIds: required(query.serviceId, 'serviceId (SessionTypeIds)'),
          StartDate: toSiteLocal(query.range.start, tz),
          EndDate: toSiteLocal(query.range.end, tz),
          StaffIds: query.staffId,
          ...(c.locationId ? { LocationIds: c.locationId } : {}),
        },
      });
      const items = asArray(res?.Availabilities, 'mindbody', 'Availabilities');
      return items.flatMap((a: any) => {
        const start = toInstant(a.StartDateTime, tz);
        const end = toInstant(a.EndDateTime, tz);
        if (start === undefined || end === undefined) return [];
        const staffId = a.Staff?.Id;
        return [{ start, end, ...(staffId !== undefined ? { staffId: String(staffId) } : {}), raw: a }];
      });
    },
  }),
});

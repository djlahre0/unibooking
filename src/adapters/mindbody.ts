import type { AvailabilitySlot, Booking, BookingStatus } from '../types';
import { asArray, asRecord, defineAdapter, reqString } from '../adapter-kit';
import { UnibookingError } from '../errors';
import { addMinutes, assertValidRange, formatWithOffset } from '../time';
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
 * Cancellation has no dedicated path — it is an action on the update endpoint
 * (`updateappointment` with `Execute: 'cancel'`), which is what `cancelBooking`
 * calls. Validate endpoint shapes against a live sandbox before relying on this
 * in production.
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
  const serviceId = a.SessionTypeId;
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

function parseMindbodyError(
  _status: number,
  body: unknown,
): { providerCode?: string; message?: string } {
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

/** Mindbody types AppointmentId as an int. `Number(id)` on a non-numeric string
 *  yields NaN, which serializes to `null` and reaches the API as "no id" — so
 *  reject it here instead, and send the same numeric form on every write. */
function appointmentId(id: string): number {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) {
    throw new UnibookingError({
      provider: 'mindbody',
      code: 'INVALID_INPUT',
      message: `appointment id must be a positive integer, got "${id}"`,
    });
  }
  return n;
}

const now = (): number => Date.now();

/** Days either side of `now` covered by the `getBooking` lookup window. */
const LOOKUP_WINDOW_DAYS = 730;

/** StaffAppointments defaults StartDate to TODAY (and EndDate to StartDate), so
 *  querying by AppointmentIds alone can only ever find an appointment happening
 *  today — anything else comes back empty and looks like a 404. Send a wide
 *  window around the current instant so a lookup by id works in both directions. */
function lookupWindow(tz: SiteTz): { StartDate: string; EndDate: string } {
  const span = LOOKUP_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  return {
    StartDate: toSiteLocal(new Date(now() - span).toISOString(), tz),
    EndDate: toSiteLocal(new Date(now() + span).toISOString(), tz),
  };
}

export const mindbody = defineAdapter<MindbodyCredentials>({
  id: 'mindbody',
  capabilities: {
    availability: true,
    staff: true,
    services: true,
    // Mindbody ships a Webhooks API; see webhooks/mindbody.ts for signature
    // verification.
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
          // Without EndDateTime the staff default duration is used, silently
          // ignoring the requested range.
          EndDateTime: toSiteLocal(input.range.end, tz),
          // Mindbody has no title field; `Notes` is what `toBooking` reads back
          // as the title, so write the caller's there too.
          ...(input.title ? { Notes: input.title } : {}),
          ...(input.notify !== undefined ? { SendEmail: input.notify } : {}),
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
        query: { AppointmentIds: id, ...lookupWindow(tz) },
      });
      const appts = asArray(res?.Appointments, 'mindbody', 'Appointments');
      if (appts.length === 0) {
        throw new UnibookingError({
          provider: 'mindbody',
          code: 'NOT_FOUND',
          message: `appointment ${id} not found`,
        });
      }
      return toBooking(appts[0], tz);
    },

    async updateBooking(id, input) {
      if (input.range) assertValidRange(input.range, 'mindbody');
      // UpdateAppointment only moves a status through its `Execute` actions, and
      // cancellation is `cancelBooking`'s job — so reject a status the plain
      // update cannot apply rather than silently dropping it.
      if (input.status !== undefined) {
        throw new UnibookingError({
          provider: 'mindbody',
          code: 'INVALID_INPUT',
          message:
            input.status === 'cancelled'
              ? 'Mindbody appointment status is not writable here; use cancelBooking() to cancel'
              : `Mindbody appointment status is not writable (cannot set "${input.status}")`,
        });
      }
      const appointment = appointmentId(id);
      const c = await http.resolve();
      const tz = siteTz(c);
      // Mindbody's UpdateAppointment is a POST (there is no PUT form).
      const res = await http.request(c, {
        method: 'POST',
        path: 'appointment/updateappointment',
        body: {
          AppointmentId: appointment,
          ...(input.range
            ? {
                StartDateTime: toSiteLocal(input.range.start, tz),
                // EndDateTime defaults to the staff member's default duration,
                // so omitting it turns every reschedule into a resize.
                EndDateTime: toSiteLocal(input.range.end, tz),
              }
            : {}),
          ...(input.staffId ? { StaffId: input.staffId } : {}),
          ...(input.serviceId ? { SessionTypeId: input.serviceId } : {}),
          ...(input.title !== undefined ? { Notes: input.title } : {}),
          ...input.providerOptions,
        },
      });
      return toBooking(res?.Appointment ?? res, tz);
    },

    async cancelBooking(id, options) {
      const appointment = appointmentId(id);
      const c = await http.resolve();
      // There is no dedicated cancel *path*, but cancellation is a documented
      // action on the update endpoint: `Execute` accepts confirm, unconfirm,
      // arrive, unarrive, cancel, latecancel, complete.
      await http.request(c, {
        method: 'POST',
        path: 'appointment/updateappointment',
        body: {
          AppointmentId: appointment,
          Execute: 'cancel',
          ...(options?.notify !== undefined ? { SendEmail: options.notify } : {}),
        },
      });
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
          ClientId: query.customerId,
          ...(c.locationId ? { LocationIds: c.locationId } : {}),
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
      // bookableitems paginates (default limit 100). Reading only the first page
      // silently truncated availability with no way for the caller to notice.
      const items: unknown[] = [];
      const PAGE = 100;
      for (let offset = 0, page = 0; page < 50; page++, offset += PAGE) {
        const res = await http.request(c, {
          path: 'appointment/bookableitems',
          query: {
            SessionTypeIds: required(query.serviceId, 'serviceId (SessionTypeIds)'),
            StartDate: toSiteLocal(query.range.start, tz),
            EndDate: toSiteLocal(query.range.end, tz),
            StaffIds: query.staffId,
            ...(c.locationId ? { LocationIds: c.locationId } : {}),
            limit: PAGE,
            offset,
          },
        });
        const batch = asArray(res?.Availabilities, 'mindbody', 'Availabilities');
        items.push(...batch);
        const total = res?.PaginationResponse?.TotalResults;
        const done =
          batch.length === 0 ||
          batch.length < PAGE ||
          (typeof total === 'number' && offset + batch.length >= total);
        if (done) break;
      }
      // An `Availabilities[]` entry is a staff availability WINDOW, not a slot —
      // emitting it verbatim turned a 9-to-5 shift into a single 8h "slot". Slice
      // it into bookable starts using the requested duration, else the session
      // type's default length. With neither we keep the window: it is coarse but
      // still truthful, and throwing would hide real availability.
      return items.flatMap((a: any): AvailabilitySlot[] => {
        const start = toInstant(a.StartDateTime, tz);
        const end = toInstant(a.EndDateTime, tz);
        if (start === undefined || end === undefined) return [];
        const staff = a.Staff?.Id !== undefined ? { staffId: String(a.Staff.Id) } : {};
        const size = query.durationMinutes ?? a.SessionType?.DefaultTimeLength;
        if (typeof size !== 'number' || size <= 0) return [{ start, end, ...staff, raw: a }];
        // BookableEndDateTime is "the time of day that the last appointment can
        // start" — a start cap, not an end cap.
        const lastStart = toInstant(a.BookableEndDateTime, tz);
        const latestStart = lastStart !== undefined ? Date.parse(lastStart) : Infinity;
        const windowEnd = Date.parse(end);
        const slots: AvailabilitySlot[] = [];
        for (let s = start; Date.parse(s) <= latestStart; s = addMinutes(s, size)) {
          const slotEnd = addMinutes(s, size);
          if (Date.parse(slotEnd) > windowEnd) break;
          slots.push({ start: s, end: slotEnd, ...staff, raw: a });
        }
        return slots;
      });
    },
  }),
});

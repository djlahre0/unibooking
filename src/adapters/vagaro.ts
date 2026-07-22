import type { AvailabilitySlot, Booking, BookingStatus } from '../types';
import { asArray, asRecord, defineAdapter, reqString, unsupported } from '../adapter-kit';
import type { HttpContext } from '../http';
import { UnibookingError } from '../errors';
import { assertValidRange, endFromDuration, parseOffsetMinutes } from '../time';

/**
 * Vagaro Enterprise Business API V2. Public docs, enterprise-gated access.
 *
 * Auth is an `accessToken` header (an apiKey scheme) — **not** `Authorization:
 * Bearer`. Mint one with
 * `POST /{region}/api/v2/merchants/generate-access-token` (clientId +
 * clientSecretKey + scope); tokens last one hour and there is no refresh token,
 * so use the function credential form to re-mint.
 *
 * `region` is the subdomain of the account's Vagaro URL (e.g. `us04`) and is not
 * derivable from credentials. `businessId` is required on every appointment call
 * and is discoverable via `POST /{region}/api/v2/locations`, but is required here
 * so no call has to guess it.
 *
 * Two asymmetries to know about:
 *  - **Reads are UTC, writes are business-local.** Responses carry
 *    `2024-10-10T21:15:00.000Z`; create/update `startTime` is documented as "in
 *    local time" with no offset. Round-tripping a fetched instant straight back
 *    into a write would shift the appointment by the location's offset, so we
 *    emit the wall-clock time as written in the caller's own offset.
 *  - **There is no date-range list.** `POST /appointments` requires
 *    `appointmentId` or `customerId`, so `listBookings` is only supported when a
 *    `customerId` is supplied — and since it returns that customer's whole
 *    history, `query.range` is applied client-side.
 */
export type VagaroCredentials = {
  /** Account subdomain, e.g. `us04`. */
  region: string;
  /** Required on every appointment call; see `POST /{region}/api/v2/locations`. */
  businessId: string;
  accessToken: string;
};

const BASE = 'https://api.vagaro.com/';

function enc(id: string): string {
  return encodeURIComponent(id);
}

/** Vagaro ids are opaque base64-ish strings containing `=`, `+`, `~` — they must
 *  be percent-encoded in path position. */
function apiPath(c: VagaroCredentials, sub: string): string {
  return `${enc(c.region)}/api/v2/${sub}`;
}

/** Wall-clock time as written in an offset-bearing RFC3339 string, with the
 *  offset dropped — Vagaro's write format ("in local time", no zone). */
function toVagaroLocal(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new UnibookingError({
      provider: 'vagaro',
      code: 'INVALID_INPUT',
      message: `not a parseable timestamp: ${iso}`,
    });
  }
  const offset = parseOffsetMinutes(iso) ?? 0;
  return new Date(ms + offset * 60_000).toISOString().slice(0, 19);
}

/** `yyyy-mm-dd` in the caller's own offset. */
function toVagaroDate(iso: string): string {
  return toVagaroLocal(iso).slice(0, 10);
}

/** `appointments/availability` answers for a single `appointmentDate`, so a
 *  multi-day range needs one call per day. Capped so an over-wide range cannot
 *  fan out unboundedly (see MAX_AVAILABILITY_DAYS). */
const MAX_AVAILABILITY_DAYS = 31;

/** The `yyyy-mm-dd` dates (in `range.start`'s offset) that a window overlaps. */
function datesInRange(startIso: string, endIso: string): string[] {
  const offset = /([+-]\d{2}:\d{2}|Z)$/i.exec(startIso)?.[1] ?? 'Z';
  const endMs = Date.parse(endIso);
  const dates: string[] = [];
  let dateStr = toVagaroDate(startIso);
  for (let i = 0; i < MAX_AVAILABILITY_DAYS; i++) {
    if (Date.parse(`${dateStr}T00:00:00${offset}`) >= endMs) break;
    dates.push(dateStr);
    const d = new Date(`${dateStr}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    dateStr = d.toISOString().slice(0, 10);
  }
  return dates.length > 0 ? dates : [toVagaroDate(startIso)];
}

function mapStatus(s: unknown): BookingStatus {
  switch (s) {
    case 'Confirmed':
    case 'Accepted':
    case 'Ready to Start':
    case 'Service In Progress':
      return 'confirmed';
    case 'Awaiting Confirmation':
    case 'Need Acceptance':
      return 'pending';
    case 'Denied':
      return 'declined';
    case 'Cancel':
    case 'Deleted':
      return 'cancelled';
    case 'No Show':
      return 'no_show';
    case 'Service Completed':
    case 'Show':
      return 'completed';
    default:
      return 'unknown';
  }
}

function parseVagaroError(_status: number, body: unknown): { providerCode?: string; message?: string } {
  const b = body as any;
  if (!b || typeof b !== 'object') return {};
  const message = typeof b.message === 'string' ? b.message : undefined;
  // `responseCode` is Vagaro's own code (1003 validation, 1034 expired token,
  // 1038 rate limit, 1051 invalid parameter). The previously-read `errorCode`
  // and `code` fields do not exist on any documented error body.
  const code = b.responseCode;
  return {
    ...(message ? { message } : {}),
    ...(typeof code === 'string' || typeof code === 'number' ? { providerCode: String(code) } : {}),
  };
}

function toBooking(raw: unknown): Booking {
  const a = asRecord(raw, 'vagaro', 'appointment');
  const start = reqString(a.startTime, 'vagaro', 'appointment.startTime');
  const end = reqString(a.endTime, 'vagaro', 'appointment.endTime');
  return {
    id: reqString(String(a.appointmentId ?? ''), 'vagaro', 'appointment.appointmentId'),
    provider: 'vagaro',
    title: typeof a.serviceTitle === 'string' && a.serviceTitle ? a.serviceTitle : 'Appointment',
    range: { start, end },
    ...(a.serviceProviderId ? { staffId: String(a.serviceProviderId) } : {}),
    ...(a.serviceId ? { serviceId: String(a.serviceId) } : {}),
    ...(a.customerId ? { customer: { id: String(a.customerId) } } : {}),
    status: mapStatus(a.bookingStatus),
    ...(typeof a.createdDate === 'string' ? { createdAt: a.createdDate } : {}),
    ...(typeof a.modifiedDate === 'string' ? { updatedAt: a.modifiedDate } : {}),
    raw: a,
  };
}

function requireField(value: string | undefined, hint: string): string {
  if (!value) {
    throw new UnibookingError({ provider: 'vagaro', code: 'INVALID_INPUT', message: `Vagaro requires ${hint}` });
  }
  return value;
}

/** Single-appointment fetch. Module-level rather than a `this` call, so the
 *  method stays correct when `defineAdapter` re-binds it onto the client and when
 *  `withRetry` proxies it. */
async function fetchAppointment(
  http: HttpContext<VagaroCredentials>,
  c: VagaroCredentials,
  id: string,
): Promise<Booking> {
  const res = await http.request(c, {
    method: 'POST',
    path: apiPath(c, 'appointments'),
    body: { businessId: c.businessId, appointmentId: id },
  });
  const rows = asArray((res as any)?.data, 'vagaro', 'appointments');
  if (rows.length === 0) {
    throw new UnibookingError({
      provider: 'vagaro',
      code: 'NOT_FOUND',
      message: `appointment ${id} not found`,
    });
  }
  return toBooking(rows[0]);
}

export const vagaro = defineAdapter<VagaroCredentials>({
  id: 'vagaro',
  capabilities: {
    availability: true,
    staff: true,
    services: true,
    webhooks: true,
    idempotency: false,
    // Vagaro exposes /customers CRUD, but this adapter does not model it yet.
    customers: false,
  },
  baseUrl: BASE,
  // apiKey scheme: a raw `accessToken` header, not `Authorization: Bearer`.
  auth: (c) => ({ headers: { accessToken: c.accessToken } }),
  parseError: parseVagaroError,
  build: (http) => ({
    async createBooking(input) {
      assertValidRange(input.range, 'vagaro');
      const c = await http.resolve();
      const serviceId = requireField(input.serviceId, 'a serviceId to book');
      const serviceProviderId = requireField(input.staffId, 'a staffId (serviceProviderId) to book');
      const customerId = requireField(input.customer?.id, 'a customer id to book');
      // The create endpoint takes a top-level array — it is a batch endpoint.
      const res = await http.request(c, {
        method: 'POST',
        path: apiPath(c, 'appointments/create'),
        body: [
          {
            businessId: c.businessId,
            serviceId,
            serviceProviderId,
            appointmentType: 'appointment',
            customerId,
            startTime: toVagaroLocal(input.range.start),
            ...(input.title ? { appointmentNote: input.title.slice(0, 500) } : {}),
            ...input.providerOptions,
          },
        ],
      });
      // Only the new id comes back; re-fetch for the canonical object.
      const created = asArray(asRecord(res, 'vagaro', 'response')?.data?.appointments, 'vagaro', 'appointments')[0];
      const id = reqString(String(created?.appointmentId ?? ''), 'vagaro', 'appointment.appointmentId');
      return fetchAppointment(http, c, id);
    },

    async getBooking(id) {
      const c = await http.resolve();
      return fetchAppointment(http, c, id);
    },

    async updateBooking(id, input) {
      if (input.range) assertValidRange(input.range, 'vagaro');
      // The PUT has no status field, and cancelBooking deletes rather than
      // transitions — so a status here would look applied and change nothing.
      if (input.status !== undefined) {
        throw new UnibookingError({
          provider: 'vagaro',
          code: 'INVALID_INPUT',
          message:
            input.status === 'cancelled'
              ? 'Vagaro appointment status is not writable; use cancelBooking() to cancel'
              : `Vagaro appointment status is not writable (cannot set "${input.status}")`,
        });
      }
      const c = await http.resolve();
      // Update is full-replace: serviceId, serviceProviderId, appointmentType and
      // startTime are all required on every call, so backfill from current state.
      // A missing backfill would be dropped by JSON.stringify and silently omit a
      // required field, so fail fast instead.
      const current = await fetchAppointment(http, c, id);
      const raw = asRecord(current.raw, 'vagaro', 'appointment');
      const startIso = input.range?.start ?? current.range.start;
      await http.request(c, {
        method: 'PUT',
        path: apiPath(c, `appointments/${enc(id)}`),
        body: {
          businessId: c.businessId,
          serviceId: requireField(
            input.serviceId ?? current.serviceId,
            'a serviceId to update — the current appointment carries none to fall back on',
          ),
          serviceProviderId: requireField(
            input.staffId ?? current.staffId,
            'a staffId (serviceProviderId) to update — the current appointment carries none to fall back on',
          ),
          appointmentType: typeof raw.eventType === 'string' && raw.eventType.toLowerCase() === 'class'
            ? 'class'
            : 'appointment',
          startTime: toVagaroLocal(startIso),
          // createBooking maps title to appointmentNote; update must not drop it.
          // (`notify` has no equivalent field and is ignored, as the canonical
          // type allows.)
          ...(input.title !== undefined ? { appointmentNote: input.title.slice(0, 500) } : {}),
          ...input.providerOptions,
        },
        // Update returns `data: ""` — nothing useful to parse.
        parse: 'none',
      });
      return fetchAppointment(http, c, id);
    },

    async cancelBooking(id, options) {
      const c = await http.resolve();
      // Vagaro deletes rather than cancels; there is no status-transition endpoint.
      // Note this is POST, not DELETE.
      await http.request(c, {
        method: 'POST',
        path: apiPath(c, `appointments/delete/${enc(id)}`),
        body: {
          businessId: c.businessId,
          ...(options?.reason ? { appointmentNote: options.reason } : {}),
        },
        parse: 'none',
      });
    },

    async listBookings(query) {
      assertValidRange(query.range, 'vagaro');
      if (!query.customerId) {
        return unsupported(
          'vagaro',
          'listBookings without a customerId (Vagaro has no date-range list; ' +
            'POST /appointments requires appointmentId or customerId)',
        );
      }
      const c = await http.resolve();
      const res = await http.request(c, {
        method: 'POST',
        path: apiPath(c, 'appointments'),
        query: {
          ...(query.limit !== undefined ? { pageSize: String(query.limit) } : {}),
          ...(query.pageToken ? { pageNumber: query.pageToken } : {}),
          orderBy: 'asc',
        },
        body: { businessId: c.businessId, customerId: query.customerId },
      });
      const rows = asArray((res as any)?.data, 'vagaro', 'appointments');
      // The endpoint takes no date window — it returns the customer's whole
      // history — so trim to the instants the caller actually asked for.
      const from = Date.parse(query.range.start);
      const to = Date.parse(query.range.end);
      const bookings = rows.map(toBooking).filter((b) => {
        const s = Date.parse(b.range.start);
        return s >= from && s < to;
      });
      // No pagination envelope exists — page numerically until a short page, and
      // only when a real page size was asked for. Falling back to `rows.length`
      // made `rows.length >= pageSize` true on every non-empty page, so a caller
      // looping to exhaustion never terminated.
      const page = Number(query.pageToken ?? '1');
      const hasMore = query.limit !== undefined && query.limit > 0 && rows.length >= query.limit;
      return {
        bookings,
        ...(hasMore ? { nextPageToken: String(page + 1) } : {}),
      };
    },

    async searchAvailability(query): Promise<AvailabilitySlot[]> {
      assertValidRange(query.range, 'vagaro');
      const serviceId = requireField(query.serviceId, 'a serviceId for availability');
      // One request per day, so bound the fan-out explicitly rather than letting
      // a year-wide range issue 365 calls.
      if (
        Date.parse(query.range.end) - Date.parse(query.range.start) >
        MAX_AVAILABILITY_DAYS * 24 * 60 * 60 * 1000
      ) {
        throw new UnibookingError({
          provider: 'vagaro',
          code: 'INVALID_INPUT',
          message: `Vagaro availability is queried one day at a time; ranges may not exceed ${MAX_AVAILABILITY_DAYS} days`,
        });
      }
      const c = await http.resolve();
      const windowStart = Date.parse(query.range.start);
      const windowEnd = Date.parse(query.range.end);
      const out: AvailabilitySlot[] = [];
      // `appointmentDate` is a single date, so page a call per day the window
      // overlaps and keep only slots that actually fall inside the range.
      for (const appointmentDate of datesInRange(query.range.start, query.range.end)) {
        const res = await http.request(c, {
          method: 'POST',
          path: apiPath(c, 'appointments/availability'),
          body: {
            businessId: c.businessId,
            appointmentDate,
            bookingItems: [
              {
                serviceId,
                ...(query.staffId ? { serviceProviderIds: [query.staffId] } : {}),
              },
            ],
            ...(query.providerOptions ?? {}),
          },
        });
        const days = asArray((res as any)?.data, 'vagaro', 'availability');
        for (const day of days) {
          const d = asRecord(day, 'vagaro', 'availability entry');
          const date = typeof d.appointmentDate === 'string' ? d.appointmentDate : undefined;
          if (!date) continue;
          const items = asArray(d.items ?? [], 'vagaro', 'availability.items');
          const first = items[0] as any;
          const duration =
            typeof first?.duration === 'number' && first.duration > 0
              ? first.duration
              : query.durationMinutes;
          if (typeof duration !== 'number' || duration <= 0) continue;
          // Slots are bare "HH:MM" wall-clock with no zone; the date is on the
          // sibling field. Anchor them in the caller's own offset.
          const offset = query.range.start.slice(-6);
          const suffix = /^[+-]\d{2}:\d{2}$/.test(offset) ? offset : 'Z';
          for (const t of asArray(d.timeSlot ?? [], 'vagaro', 'availability.timeSlot')) {
            const m = /^(\d{1,2}):(\d{2})$/.exec(String(t).trim());
            if (!m) continue;
            const start = `${date}T${m[1]!.padStart(2, '0')}:${m[2]}:00${suffix}`;
            // A day's slots cover the whole business day, so a partial-day window
            // would otherwise return times the caller excluded.
            const startMs = Date.parse(start);
            if (startMs < windowStart || startMs >= windowEnd) continue;
            out.push({
              start,
              end: endFromDuration(start, duration),
              ...(first?.serviceProviderId ? { staffId: String(first.serviceProviderId) } : {}),
              raw: { date, time: t, items },
            });
          }
        }
      }
      return out;
    },
  }),
});

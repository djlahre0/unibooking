import type {
  AvailabilitySlot,
  Booking,
  BookingStatus,
  CreateBookingInput,
  Customer,
  CustomerRecord,
  Service,
  Staff,
  TimeRange,
} from '../types';
import {
  asArray,
  asRecord,
  bookingsWithinRange,
  defineAdapter,
  probeConnection,
  reqString,
} from '../adapter-kit';
import type { HttpContext } from '../http';
import { UnibookingError } from '../errors';
import { assertValidRange, endFromDuration } from '../time';
import { slotsWithinRange } from '../availability';

/**
 * Zenoti (api.zenoti.com, /v1). Auth: `Authorization: apikey <key>`. `center_id`
 * scopes every call. Booking is multi-step (create booking -> get slots -> reserve
 * -> confirm); there is no single create. `updateBooking` reschedules in place by
 * running the same chain with the appointment's existing `invoice_id` /
 * `invoice_item_id`, so the id is kept and no cancellation fee fires. Times use
 * the *_utc fields (append `Z`).
 *
 * **Center-timezone caveat.** Booking *slots* are not *_utc: their `Time` is
 * center-local wall clock with no offset, and neither the API nor the canonical
 * model carries the center's zone. The adapter's single stated assumption is
 * therefore that **the caller expresses times in the center's own UTC offset**:
 * slot starts are anchored in `range.start`'s offset (`anchorSlotTime`) and
 * booking-time matching compares wall clocks (`matchesRequestedTime`). Pass
 * ranges in the center's offset, or slots will be anchored to the wrong instant.
 */
export type ZenotiCredentials = {
  apiKey: string;
  centerId: string;
};

const BASE = 'https://api.zenoti.com/v1/';

function enc(id: string): string {
  return encodeURIComponent(id);
}

/** Zenoti *_utc values are ISO-8601 without an offset; append `Z`. */
function utc(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  return v.endsWith('Z') ? v : `${v}Z`;
}

/** True when an ISO string already pins an absolute instant. */
function hasOffset(s: string): boolean {
  return s.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(s);
}

/** `yyyy-mm-dd` shifted by whole days. */
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The last wall-clock date a window touches. An end landing exactly on midnight
 *  touches nothing of its own date. */
function lastDateTouched(range: TimeRange): string {
  const endDate = range.end.slice(0, 10);
  const local = range.end.replace(/([+-]\d{2}:?\d{2}|Z)$/i, '');
  return /T00:00(:00(\.0+)?)?$/.test(local) ? addDays(endDate, -1) : endDate;
}

/** Anchor a slot `Time` as an absolute instant. Slot times are center-local wall
 *  clock with no offset, so: per the center-timezone caveat on this module:
 *  they are read in the offset of the caller's own range rather than fabricating
 *  a `Z`, which would claim a UTC instant the value is not. */
function anchorSlotTime(time: unknown, offsetSource: string): string | undefined {
  if (typeof time !== 'string' || !time) return undefined;
  if (hasOffset(time)) return time;
  const m = /([+-]\d{2}:\d{2}|Z)$/i.exec(offsetSource);
  return `${time.slice(0, 19)}${m ? m[1] : 'Z'}`;
}

function matchesRequestedTime(slotTime: unknown, requestedStart: string): boolean {
  if (typeof slotTime !== 'string') return false;
  // Absolute-instant match (when the slot carries an offset/Z).
  const withZ = hasOffset(slotTime) ? slotTime : `${slotTime}Z`;
  const ts = Date.parse(withZ);
  if (!Number.isNaN(ts) && ts === Date.parse(requestedStart)) return true;
  // Wall-clock match: Zenoti slot Time is center-local without an offset, so also match
  // the local components of requestedStart. Callers should express the booking time in
  // the center's local offset for this to line up.
  // TODO: verify against live API: full tz-awareness needs the center timezone, which
  // the canonical model doesn't carry.
  const reqLocal = requestedStart.replace(/([+-]\d{2}:?\d{2}|Z)$/, '');
  return slotTime.slice(0, 19) === reqLocal.slice(0, 19);
}

function mapStatus(s: unknown): BookingStatus {
  // Zenoti returns integer codes; some list endpoints return strings. Handle both.
  // The documented enum is NoShow=-2, Cancelled=-1, New=0, Closed=1, Checkin=2,
  // Confirm=4, Break=10, NotSpecified=11, Available=20, Voided=21: note that -2
  // and -1 are no-show and cancelled in that order, and that 3/5/6/99 do not exist.
  const n = typeof s === 'number' ? s : Number(s);
  if (!Number.isNaN(n)) {
    switch (n) {
      case -2:
        return 'no_show';
      case -1:
      case 21:
        return 'cancelled';
      case 0:
        return 'pending';
      case 1:
        return 'completed';
      case 2:
      case 4:
        return 'confirmed';
      // Break/NotSpecified/Available (10/11/20) are not appointment outcomes.
      default:
        return 'unknown';
    }
  }
  switch (String(s).toLowerCase()) {
    case 'cancelled':
    case 'canceled':
    case 'voided':
      return 'cancelled';
    case 'noshow':
    case 'no_show':
      return 'no_show';
    case 'closed':
    case 'completed':
      return 'completed';
    case 'confirmed':
    case 'checkedin':
      return 'confirmed';
    case 'open':
    case 'booked':
      return 'pending';
    default:
      return 'unknown';
  }
}

function customerOf(g: any): Booking['customer'] | undefined {
  if (!g) return undefined;
  const name = `${g.first_name ?? ''} ${g.last_name ?? ''}`.trim();
  // The appointment guest carries the phone under `mobile`; on real payloads
  // `number` is null and `display_number` holds the value ("+91 9885517727"), so
  // reading `number` alone usually drops the phone. `mobile_phone` is the
  // create-side spelling of the same object.
  const phone =
    g.mobile?.number ??
    g.mobile?.display_number ??
    g.mobile_phone?.number ??
    g.mobile_phone?.display_number ??
    (typeof g.phone === 'string' ? g.phone : undefined);
  if (!g.id && !name && !g.email && !phone) return undefined;
  return {
    ...(g.id ? { id: String(g.id) } : {}),
    ...(name ? { name } : {}),
    ...(g.email ? { email: g.email } : {}),
    ...(phone ? { phone: String(phone) } : {}),
  };
}

function toBooking(raw: unknown): Booking {
  const a = asRecord(raw, 'zenoti', 'appointment');
  const start = utc(a.start_time_utc) ?? utc(a.start_time);
  const end = utc(a.end_time_utc) ?? utc(a.end_time);
  if (start === undefined || end === undefined) {
    throw new UnibookingError({
      provider: 'zenoti',
      code: 'UPSTREAM',
      message: 'appointment is missing start/end time',
    });
  }
  const customer = customerOf(a.guest);
  const createdAt = utc(a.creation_date_utc);
  return {
    id: reqString(String(a.appointment_id ?? a.id ?? ''), 'zenoti', 'appointment.appointment_id'),
    provider: 'zenoti',
    title: a.service?.name ? String(a.service.name) : 'Appointment',
    range: { start, end },
    ...(a.therapist?.id ? { staffId: String(a.therapist.id) } : {}),
    ...(a.service?.id ? { serviceId: String(a.service.id) } : {}),
    ...(customer ? { customer } : {}),
    status: mapStatus(a.status),
    ...(createdAt ? { createdAt } : {}),
    raw: a,
  };
}

function parseZenotiError(
  _status: number,
  body: unknown,
): { providerCode?: string; message?: string } {
  const err = (body as any)?.error;
  if (!err || typeof err !== 'object') return {};
  return {
    ...(typeof err.message === 'string' ? { message: err.message } : {}),
    ...(err.code ? { providerCode: String(err.code) } : {}),
  };
}

function requireService(serviceId: string | undefined): string {
  if (!serviceId) {
    throw new UnibookingError({
      provider: 'zenoti',
      code: 'INVALID_INPUT',
      message: 'Zenoti requires a serviceId',
    });
  }
  return serviceId;
}

/** `providerOptions` keys this adapter consumes itself. They steer the guest
 *  resolution above and are meaningless to Zenoti, so they are stripped before
 *  the rest of `providerOptions` is merged into an outgoing body. */
const CONSUMED_OPTION_KEYS = ['guestId', 'countryCode'] as const;

function bookingExtras(
  providerOptions: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!providerOptions) return undefined;
  const rest = { ...providerOptions };
  for (const key of CONSUMED_OPTION_KEYS) delete rest[key];
  return rest;
}

async function findOrCreateGuest(
  http: HttpContext<ZenotiCredentials>,
  c: ZenotiCredentials,
  customer: Customer,
  providerOptions?: Record<string, unknown>,
): Promise<string> {
  if (customer.id) return customer.id;
  if (customer.email) {
    const res = await http.request(c, {
      path: 'guests/search',
      query: { center_id: c.centerId, email: customer.email },
    });
    const found = asArray(res?.guests, 'zenoti', 'guests.search')[0];
    if (found?.id) return String(found.id);
  }
  const [firstName, ...rest] = (customer.name ?? 'Guest').trim().split(/\s+/);
  // `mobile_phone` is `{country_code, number}`. The canonical Customer has no
  // country code and guessing one would misroute the number, so it is passed
  // through from providerOptions when the caller knows it and omitted otherwise.
  const countryCode = providerOptions?.countryCode;
  const created = await http.request(c, {
    method: 'POST',
    path: 'guests',
    body: {
      center_id: c.centerId,
      personal_info: {
        first_name: firstName ?? 'Guest',
        last_name: rest.join(' ') || 'Guest',
        ...(customer.email ? { email: customer.email } : {}),
        ...(customer.phone
          ? {
              mobile_phone: {
                number: customer.phone,
                ...(countryCode !== undefined ? { country_code: countryCode } : {}),
              },
            }
          : {}),
      },
    },
  });
  // The guest-create response is flat, with the new guest's `id` at the top level.
  return reqString(String(created?.id ?? ''), 'zenoti', 'guest.id');
}

/** A Zenoti guest -> a canonical client record. */
function toCustomerRecord(raw: unknown): CustomerRecord {
  const r = asRecord(raw, 'zenoti', 'guest');
  const p = r.personal_info ?? {};
  const name = [p.first_name, p.last_name]
    .filter((x: unknown) => typeof x === 'string' && x)
    .join(' ');
  const phone = p.mobile_phone?.number;
  return {
    id: reqString(String(r.id ?? ''), 'zenoti', 'guest.id'),
    ...(name ? { name } : {}),
    ...(typeof p.email === 'string' && p.email ? { email: p.email } : {}),
    ...(typeof phone === 'string' && phone ? { phone } : {}),
    ...(typeof r.created_date === 'string' ? { createdAt: r.created_date } : {}),
    raw: r,
  };
}

/** A 1-based Zenoti page and its size, from a canonical list query. The size
 *  is always sent, so a full page is recognisable as "maybe more". */
function pagingOf(query: { limit?: number; pageToken?: string } | undefined): {
  page: number;
  size: number;
} {
  const page = query?.pageToken ? Number(query.pageToken) : 1;
  if (!Number.isInteger(page) || page < 1) {
    throw new UnibookingError({
      provider: 'zenoti',
      code: 'INVALID_INPUT',
      message: 'pageToken must be a page number from a previous list',
    });
  }
  return { page, size: Math.min(query?.limit ?? 100, 100) };
}

/** Zenoti reports no reliable total, so a full page means there may be
 *  another. Without a token at all, everything past the first page was
 *  unreachable, including through `getService`/`getStaff`. */
function nextPageIf(count: number, paging: { page: number; size: number }): string | undefined {
  return count > 0 && count >= paging.size ? String(paging.page + 1) : undefined;
}

async function resolveGuestId(
  http: HttpContext<ZenotiCredentials>,
  c: ZenotiCredentials,
  input: CreateBookingInput,
): Promise<string> {
  const fromOpts = input.providerOptions?.guestId;
  if (typeof fromOpts === 'string') return fromOpts;
  if (input.customer) return findOrCreateGuest(http, c, input.customer, input.providerOptions);
  throw new UnibookingError({
    provider: 'zenoti',
    code: 'INVALID_INPUT',
    message: 'Zenoti requires a guest (customer or providerOptions.guestId) to book',
  });
}

/** Identifies an existing appointment to reschedule in place. When present,
 *  Zenoti moves that appointment to the new slot instead of creating a fresh
 *  booking, so no cancellation, no new id, and no cancellation fee. */
interface RescheduleTarget {
  invoiceId: string;
  invoiceItemId: string;
}

/** Create booking -> reserve the slot matching `start` -> confirm -> appointment_id. */
async function bookAndConfirm(
  http: HttpContext<ZenotiCredentials>,
  c: ZenotiCredentials,
  guestId: string,
  serviceId: string,
  start: string,
  staffId: string | undefined,
  extra: Record<string, unknown> | undefined,
  reschedule?: RescheduleTarget,
): Promise<string> {
  // Use the wall-clock date the caller expressed, NOT the UTC date: a late
  // center-local start (e.g. 10pm -05:00 = 03:00Z next day) must book on the
  // caller's day, or Zenoti returns slots for the wrong date and we spuriously
  // report CONFLICT. (listBookings already slices the literal date this way.)
  const date = start.slice(0, 10);
  const booking = await http.request(c, {
    method: 'POST',
    path: 'bookings',
    body: {
      center_id: c.centerId,
      date,
      guests: [
        {
          id: guestId,
          ...(reschedule ? { invoice_id: reschedule.invoiceId } : {}),
          items: [
            {
              item: { id: serviceId, item_type: 0 },
              ...(reschedule ? { invoice_item_id: reschedule.invoiceItemId } : {}),
              ...(staffId ? { therapist: { id: staffId } } : {}),
            },
          ],
        },
      ],
      ...extra,
    },
  });
  // Create-booking responds `{"id": "15b0cc65-…", "error": null}`: a top-level `id`.
  const bookingId = reqString(String(booking?.id ?? ''), 'zenoti', 'booking.id');
  const slotsRes = await http.request(c, { path: `bookings/${enc(bookingId)}/slots` });
  const slots = asArray(slotsRes?.slots, 'zenoti', 'booking.slots');
  const match = slots.find(
    (s: any) => s.Available !== false && matchesRequestedTime(s.Time, start),
  );
  if (!match) {
    throw new UnibookingError({
      provider: 'zenoti',
      code: 'CONFLICT',
      message: 'requested time is not available',
    });
  }
  await http.request(c, {
    method: 'POST',
    path: `bookings/${enc(bookingId)}/slots/reserve`,
    body: { slot_time: match.Time },
  });
  const confirm = await http.request(c, {
    method: 'POST',
    path: `bookings/${enc(bookingId)}/slots/confirm`,
    body: {},
  });
  const item = asArray(confirm?.invoice?.items, 'zenoti', 'confirm.invoice.items')[0];
  return reqString(String(item?.appointment_id ?? ''), 'zenoti', 'confirm.appointment_id');
}

async function getAppointment(
  http: HttpContext<ZenotiCredentials>,
  c: ZenotiCredentials,
  id: string,
): Promise<Booking> {
  const res = await http.request(c, { path: `appointments/${enc(id)}` });
  return toBooking(res);
}

export const zenoti = defineAdapter<ZenotiCredentials>({
  id: 'zenoti',
  capabilities: {
    availability: true,
    staff: true,
    services: true,
    webhooks: false,
    idempotency: false,
    customers: true,
    customerDirectory: true,
    customerWrite: true,
    customerDelete: false,
    serviceCatalog: true,
    staffDirectory: true,
    serviceCatalogWrite: false,
    staffDirectoryWrite: false,
    staffDeactivate: false,
    staffDelete: false,
    serviceDelete: false,
    calendarList: false,
    calendarWrite: false,
    staffServiceAssignment: false,
    staffServiceAssignmentWrite: false,
    serviceCategories: false,
    businessHours: false,
    classCatalog: false,
    classEnrollment: false,
    classWaitlist: false,
    changeFeed: false,
    changeNotifications: false,
    versionedWrites: false,
  },
  baseUrl: BASE,
  auth: (c) => ({ headers: { authorization: `apikey ${c.apiKey}` } }),
  parseError: parseZenotiError,
  build: (http) => ({
    async listServices(query) {
      const c = await http.resolve();
      const paging = pagingOf(query);
      const res = await http.request(c, {
        path: `centers/${enc(c.centerId)}/services`,
        query: { page: paging.page, size: paging.size },
      });
      const services = asArray(res?.services, 'zenoti', 'services').map((raw): Service => {
        const s = asRecord(raw, 'zenoti', 'service');
        const duration = Number(s.duration);
        // Zenoti nests the sale price under `price`, with the currency as a
        // separate numeric code we cannot map to ISO-4217, so price is left off
        // rather than paired with a guess.
        return {
          id: reqString(String(s.id ?? ''), 'zenoti', 'service.id'),
          name: reqString(String(s.name ?? ''), 'zenoti', 'service.name'),
          ...(s.description ? { description: String(s.description) } : {}),
          ...(Number.isFinite(duration) && duration > 0 ? { durationMinutes: duration } : {}),
          ...(s.category?.id ? { categoryId: String(s.category.id) } : {}),
          ...(s.category?.name ? { categoryName: String(s.category.name) } : {}),
          active: s.is_active !== false,
          raw: s,
        };
      });
      const next = nextPageIf(services.length, paging);
      return { services, ...(next ? { nextPageToken: next } : {}) };
    },

    async listStaff(query) {
      const c = await http.resolve();
      const paging = pagingOf(query);
      const res = await http.request(c, {
        path: `centers/${enc(c.centerId)}/therapists`,
        query: { page: paging.page, size: paging.size },
      });
      const staff = asArray(res?.therapists, 'zenoti', 'therapists').map((raw): Staff => {
        const t = asRecord(raw, 'zenoti', 'therapist');
        const info = asRecord(t.personal_info ?? {}, 'zenoti', 'therapist.personal_info');
        const name =
          [info.first_name, info.last_name].filter(Boolean).join(' ') || String(t.name ?? '');
        return {
          id: reqString(String(t.id ?? ''), 'zenoti', 'therapist.id'),
          name: reqString(name, 'zenoti', 'therapist.name'),
          ...(info.email ? { email: String(info.email) } : {}),
          ...(info.mobile_phone?.number ? { phone: String(info.mobile_phone.number) } : {}),
          active: t.active !== false,
          raw: t,
        };
      });
      const next = nextPageIf(staff.length, paging);
      return { staff, ...(next ? { nextPageToken: next } : {}) };
    },

    async checkConnection() {
      const c = await http.resolve();
      return probeConnection('zenoti', async () => {
        const res = await http.request(c, { path: 'centers' });
        const first = asArray(res?.centers, 'zenoti', 'centers')[0];
        return {
          ...(first
            ? {
                account: {
                  ...(first.id ? { id: String(first.id) } : {}),
                  ...(first.name ? { name: String(first.name) } : {}),
                },
              }
            : {}),
          raw: res,
        };
      });
    },
    async createBooking(input) {
      assertValidRange(input.range, 'zenoti');
      const c = await http.resolve();
      const serviceId = requireService(input.serviceId);
      const guestId = await resolveGuestId(http, c, input);
      const apptId = await bookAndConfirm(
        http,
        c,
        guestId,
        serviceId,
        input.range.start,
        input.staffId,
        bookingExtras(input.providerOptions),
      );
      return getAppointment(http, c, apptId);
    },

    getBooking(id) {
      return http.resolve().then((c) => getAppointment(http, c, id));
    },

    async updateBooking(id, input) {
      const c = await http.resolve();
      if (!input.range) {
        throw new UnibookingError({
          provider: 'zenoti',
          code: 'UNSUPPORTED',
          message: 'Zenoti only supports rescheduling (pass input.range)',
        });
      }
      assertValidRange(input.range, 'zenoti');
      // Zenoti has a first-class reschedule: the same create -> slots -> reserve
      // -> confirm chain, but carrying the existing invoice_id and
      // invoice_item_id moves the appointment instead of creating a new one.
      // The previous book-fresh-then-cancel-old approach changed the booking id,
      // left a cancelled invoice behind, and could fire cancellation fees.
      const current = await http.request(c, { path: `appointments/${enc(id)}` });
      const a = asRecord(current, 'zenoti', 'appointment');
      const serviceId =
        input.serviceId ??
        reqString(String(a.service?.id ?? ''), 'zenoti', 'appointment.service.id');
      const guestId = reqString(String(a.guest?.id ?? ''), 'zenoti', 'appointment.guest.id');
      const invoiceId = reqString(String(a.invoice_id ?? ''), 'zenoti', 'appointment.invoice_id');
      const invoiceItemId = reqString(
        String(a.invoice_item_id ?? a.invoice_item?.id ?? ''),
        'zenoti',
        'appointment.invoice_item_id',
      );
      const staffId = input.staffId ?? (a.therapist?.id ? String(a.therapist.id) : undefined);
      const apptId = await bookAndConfirm(
        http,
        c,
        guestId,
        serviceId,
        input.range.start,
        staffId,
        bookingExtras(input.providerOptions),
        { invoiceId, invoiceItemId },
      );
      return getAppointment(http, c, apptId);
    },

    async cancelBooking(id, options) {
      const c = await http.resolve();
      const current = await http.request(c, { path: `appointments/${enc(id)}` });
      const invoiceId = reqString(
        String(asRecord(current, 'zenoti', 'appointment').invoice_id ?? ''),
        'zenoti',
        'appointment.invoice_id',
      );
      await http.request(c, {
        method: 'PUT',
        path: `invoices/${enc(invoiceId)}/cancel`,
        query: { ...(options?.reason ? { comments: options.reason } : {}) },
        parse: 'none',
      });
    },

    async listBookings(query) {
      assertValidRange(query.range, 'zenoti');
      // Zenoti caps the appointment list at a 7-day window.
      const spanMs = Date.parse(query.range.end) - Date.parse(query.range.start);
      if (spanMs > 7 * 24 * 60 * 60 * 1000) {
        throw new UnibookingError({
          provider: 'zenoti',
          code: 'INVALID_INPUT',
          message: 'Zenoti listBookings supports a maximum 7-day range',
        });
      }
      if (query.pageToken !== undefined) {
        throw new UnibookingError({
          provider: 'zenoti',
          code: 'UNSUPPORTED',
          message:
            'Zenoti appointments exposes no pagination cursor; narrow range/limit instead of paging',
        });
      }
      const c = await http.resolve();
      // `start_date` and `end_date` are whole dates, must differ, and `end_date`
      // is EXCLUSIVE, so a same-day window (09:00 → 17:00) collapses to nothing.
      // Ask for every date the window touches, plus one, then trim below.
      const startDate = query.range.start.slice(0, 10);
      const lastDate = lastDateTouched(query.range);
      const res = await http.request(c, {
        path: 'appointments',
        query: {
          center_id: c.centerId,
          start_date: startDate,
          end_date: addDays(lastDate > startDate ? lastDate : startDate, 1),
          therapist_id: query.staffId,
          // Cancelled and no-show appointments are omitted unless this is set,
          // so `status: 'cancelled'` could otherwise never match anything.
          ...(query.status === 'cancelled' || query.status === 'no_show'
            ? { include_no_show_cancel: true }
            : {}),
        },
      });
      // Whole-date fetching overshoots the caller's instants at both ends.
      const bookings = bookingsWithinRange(
        asArray(res?.appointments, 'zenoti', 'appointments').map(toBooking),
        query.range,
      ).filter((b) => query.status === undefined || b.status === query.status);
      // The endpoint returns no cursor, so `limit` is applied client-side and no
      // nextPageToken is fabricated.
      return { bookings: query.limit !== undefined ? bookings.slice(0, query.limit) : bookings };
    },

    async searchAvailability(query): Promise<AvailabilitySlot[]> {
      assertValidRange(query.range, 'zenoti');
      const c = await http.resolve();
      const serviceId = requireService(query.serviceId);
      const guestId = query.providerOptions?.guestId;
      if (typeof guestId !== 'string') {
        throw new UnibookingError({
          provider: 'zenoti',
          code: 'INVALID_INPUT',
          message: 'Zenoti availability needs providerOptions.guestId (slots are booking-scoped)',
        });
      }
      // Slots are start times only; Zenoti doesn't return a duration, so require
      // one from the caller rather than emitting zero-length slots.
      if (typeof query.durationMinutes !== 'number' || query.durationMinutes <= 0) {
        throw new UnibookingError({
          provider: 'zenoti',
          code: 'INVALID_INPUT',
          message: 'Zenoti availability needs a positive durationMinutes to size each slot',
        });
      }
      const durationMinutes = query.durationMinutes;
      // A booking, and therefore its slot list, is scoped to one date. Fanning
      // out over a range would create one throwaway booking per day upstream, so
      // reject a multi-day window rather than silently answering for day one.
      const date = query.range.start.slice(0, 10);
      if (lastDateTouched(query.range) !== date) {
        throw new UnibookingError({
          provider: 'zenoti',
          code: 'INVALID_INPUT',
          message: `Zenoti availability covers a single center-local date; ${date} and ${lastDateTouched(query.range)} span more than one`,
        });
      }
      // Zenoti has no stateless availability endpoint: create a transient booking
      // and read its slots. The booking is unconfirmed and Zenoti expires it.
      const booking = await http.request(c, {
        method: 'POST',
        path: 'bookings',
        body: {
          center_id: c.centerId,
          date,
          guests: [
            {
              id: guestId,
              items: [
                {
                  item: { id: serviceId, item_type: 0 },
                  ...(query.staffId ? { therapist: { id: query.staffId } } : {}),
                },
              ],
            },
          ],
          // Same escape hatch createBooking honors: availability must be
          // requested under the same provider-specific fields it will be booked with.
          ...bookingExtras(query.providerOptions),
        },
      });
      // Create-booking responds `{"id": "15b0cc65-…", "error": null}`: a top-level `id`.
      const bookingId = reqString(String(booking?.id ?? ''), 'zenoti', 'booking.id');
      const slotsRes = await http.request(c, { path: `bookings/${enc(bookingId)}/slots` });
      const slots = asArray(slotsRes?.slots, 'zenoti', 'booking.slots');
      const out = slots.flatMap((s: any) => {
        const start = anchorSlotTime(s.Time, query.range.start);
        if (start === undefined) return [];
        // Each slot carries an Available flag; an unavailable slot is not
        // bookable, so emitting it as a candidate misleads the caller.
        if (s.Available === false) return [];
        return [
          {
            start,
            end: endFromDuration(start, durationMinutes),
            ...(query.staffId ? { staffId: query.staffId } : {}),
            raw: s,
          },
        ];
      });
      // The transient booking is scoped to a DATE, so its slot list covers the
      // whole center-local day; narrow it to the window the caller asked for.
      return slotsWithinRange(out, query.range);
    },

    customers: {
      findOrCreate: async (customer) => {
        const c = await http.resolve();
        return findOrCreateGuest(http, c, customer);
      },

      // Guests of the configured center, 1-based pages of <= 100. An email
      // filter uses guests/search (server-side); phone filters each page.
      list: async (query) => {
        const c = await http.resolve();
        const page = query?.pageToken ? Number(query.pageToken) : 1;
        if (!Number.isInteger(page) || page < 1) {
          throw new UnibookingError({
            provider: 'zenoti',
            code: 'INVALID_INPUT',
            message: 'pageToken must be a page number from a previous list',
          });
        }
        const size = Math.min(query?.limit ?? 100, 100);
        const res = query?.email
          ? await http.request(c, {
              path: 'guests/search',
              query: { center_id: c.centerId, email: query.email, page, size },
            })
          : await http.request(c, {
              path: 'guests',
              query: { center_id: c.centerId, page, size },
            });
        const raw = asArray(res?.guests ?? [], 'zenoti', 'guests');
        let customers = raw.map(toCustomerRecord);
        if (query?.phone) customers = customers.filter((x) => x.phone === query.phone);
        // page_info is not documented field-by-field; a full page means there
        // may be another.
        return {
          customers,
          ...(raw.length === size ? { nextPageToken: String(page + 1) } : {}),
        };
      },

      get: async (id) => {
        const c = await http.resolve();
        return toCustomerRecord(await http.request(c, { path: `guests/${enc(id)}` }));
      },

      create: async (input) => {
        if (!input.name?.trim() && !input.email && !input.phone) {
          throw new UnibookingError({
            provider: 'zenoti',
            code: 'INVALID_INPUT',
            message: 'A customer needs at least a name, email or phone',
          });
        }
        const c = await http.resolve();
        // Always a new guest (no search first), in findOrCreate's body shape.
        const [firstName, ...rest] = (input.name?.trim() || 'Guest').split(/\s+/);
        const countryCode = input.providerOptions?.countryCode;
        const created = await http.request(c, {
          method: 'POST',
          path: 'guests',
          body: {
            center_id: c.centerId,
            personal_info: {
              first_name: firstName ?? 'Guest',
              last_name: rest.join(' ') || 'Guest',
              ...(input.email ? { email: input.email } : {}),
              ...(input.phone
                ? {
                    mobile_phone: {
                      number: input.phone,
                      ...(countryCode !== undefined ? { country_code: countryCode } : {}),
                    },
                  }
                : {}),
            },
          },
        });
        // The create response is flat with the new id; read the full guest.
        const id = reqString(String(created?.id ?? ''), 'zenoti', 'guest.id');
        return toCustomerRecord(await http.request(c, { path: `guests/${enc(id)}` }));
      },

      // PUT replaces the whole guest ("send all the fields obtained from
      // Retrieve guest details"), so read it and change only personal_info.
      update: async (id, input) => {
        const c = await http.resolve();
        const path = `guests/${enc(id)}`;
        const current = asRecord(await http.request(c, { path }), 'zenoti', 'guest');
        const info = { ...(current.personal_info ?? {}) };
        if (input.name?.trim()) {
          const [first, ...rest] = input.name.trim().split(/\s+/);
          info.first_name = first;
          info.last_name = rest.join(' ') || info.last_name || 'Guest';
        }
        if (input.email !== undefined) info.email = input.email;
        if (input.phone !== undefined) {
          info.mobile_phone = { ...(info.mobile_phone ?? {}), number: input.phone };
        }
        const res = await http.request(c, {
          method: 'PUT',
          path,
          body: { ...current, personal_info: info, ...input.providerOptions },
        });
        return toCustomerRecord(res?.id ? res : { ...current, personal_info: info });
      },
    },
  }),
});

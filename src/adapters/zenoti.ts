import type {
  AvailabilitySlot,
  Booking,
  BookingStatus,
  Customer,
  CreateBookingInput,
  TimeRange,
} from '../types';
import { asArray, asRecord, defineAdapter, reqString } from '../adapter-kit';
import type { HttpContext } from '../http';
import { UnibookingError } from '../errors';
import { assertValidRange, endFromDuration } from '../time';

/**
 * Zenoti (api.zenoti.com, /v1). Auth: `Authorization: apikey <key>`. `center_id`
 * scopes every call. Booking is multi-step (create booking -> get slots -> reserve
 * -> confirm); there is no single create and no clean reschedule, so updateBooking
 * re-books and cancels the old invoice. Times use the *_utc fields (append `Z`).
 *
 * **Center-timezone caveat.** Booking *slots* are not *_utc: their `Time` is
 * center-local wall clock with no offset, and neither the API nor the canonical
 * model carries the center's zone. The adapter's single stated assumption is
 * therefore that **the caller expresses times in the center's own UTC offset** —
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
 *  clock with no offset, so — per the center-timezone caveat on this module —
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
  // TODO: verify against live API — full tz-awareness needs the center timezone, which
  // the canonical model doesn't carry.
  const reqLocal = requestedStart.replace(/([+-]\d{2}:?\d{2}|Z)$/, '');
  return slotTime.slice(0, 19) === reqLocal.slice(0, 19);
}

function mapStatus(s: unknown): BookingStatus {
  // Zenoti returns integer codes; some list endpoints return strings. Handle both.
  // The documented enum is NoShow=-2, Cancelled=-1, New=0, Closed=1, Checkin=2,
  // Confirm=4, Break=10, NotSpecified=11, Available=20, Voided=21 — note that -2
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

function parseZenotiError(_status: number, body: unknown): { providerCode?: string; message?: string } {
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
 *  booking — so no cancellation, no new id, and no cancellation fee. */
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
  // Use the wall-clock date the caller expressed, NOT the UTC date — a late
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
  // Create-booking responds `{"id": "15b0cc65-…", "error": null}` — a top-level `id`.
  const bookingId = reqString(String(booking?.id ?? ''), 'zenoti', 'booking.id');
  const slotsRes = await http.request(c, { path: `bookings/${enc(bookingId)}/slots` });
  const slots = asArray(slotsRes?.slots, 'zenoti', 'booking.slots');
  const match = slots.find((s: any) => s.Available !== false && matchesRequestedTime(s.Time, start));
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
  },
  baseUrl: BASE,
  auth: (c) => ({ headers: { authorization: `apikey ${c.apiKey}` } }),
  parseError: parseZenotiError,
  build: (http) => ({
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
          message: 'Zenoti only supports rescheduling (pass input.range) via re-book',
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
        input.serviceId ?? reqString(String(a.service?.id ?? ''), 'zenoti', 'appointment.service.id');
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
      // is EXCLUSIVE — so a same-day window (09:00 → 17:00) collapses to nothing.
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
      const from = Date.parse(query.range.start);
      const to = Date.parse(query.range.end);
      const bookings = asArray(res?.appointments, 'zenoti', 'appointments')
        .map(toBooking)
        // Whole-date fetching overshoots the caller's instants at both ends.
        .filter((b) => {
          const s = Date.parse(b.range.start);
          return s >= from && s < to;
        })
        .filter((b) => query.status === undefined || b.status === query.status);
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
      // A booking — and therefore its slot list — is scoped to one date. Fanning
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
      // Zenoti has no stateless availability endpoint — create a transient booking
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
              items: [{ item: { id: serviceId, item_type: 0 }, ...(query.staffId ? { therapist: { id: query.staffId } } : {}) }],
            },
          ],
          // Same escape hatch createBooking honors — availability must be
          // requested under the same provider-specific fields it will be booked with.
          ...bookingExtras(query.providerOptions),
        },
      });
      // Create-booking responds `{"id": "15b0cc65-…", "error": null}` — a top-level `id`.
      const bookingId = reqString(String(booking?.id ?? ''), 'zenoti', 'booking.id');
      const slotsRes = await http.request(c, { path: `bookings/${enc(bookingId)}/slots` });
      const slots = asArray(slotsRes?.slots, 'zenoti', 'booking.slots');
      return slots.flatMap((s: any) => {
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
    },

    customers: {
      findOrCreate: async (customer) => {
        const c = await http.resolve();
        return findOrCreateGuest(http, c, customer);
      },
    },
  }),
});

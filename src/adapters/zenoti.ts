import type { AvailabilitySlot, Booking, BookingStatus, Customer, CreateBookingInput } from '../types';
import { asArray, asRecord, defineAdapter, reqString } from '../adapter-kit';
import type { HttpContext } from '../http';
import { UnibookingError } from '../errors';
import { assertValidRange, endFromDuration } from '../time';

/**
 * Zenoti (api.zenoti.com, /v1). Auth: `Authorization: apikey <key>`. `center_id`
 * scopes every call. Booking is multi-step (create booking -> get slots -> reserve
 * -> confirm); there is no single create and no clean reschedule, so updateBooking
 * re-books and cancels the old invoice. Times use the *_utc fields (append `Z`).
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

function matchesRequestedTime(slotTime: unknown, requestedStart: string): boolean {
  if (typeof slotTime !== 'string') return false;
  // Absolute-instant match (when the slot carries an offset/Z).
  const withZ =
    slotTime.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(slotTime) ? slotTime : `${slotTime}Z`;
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
  const n = typeof s === 'number' ? s : Number(s);
  if (!Number.isNaN(n)) {
    switch (n) {
      case -2:
      case 99:
        return 'cancelled';
      case -1:
        return 'no_show';
      case 0:
      case 1:
      case 2:
      case 3:
        return 'pending';
      case 4:
        return 'completed';
      case 5:
      case 6:
        return 'confirmed';
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
  // TODO: verify against live API — appointment guest may expose the phone as
  // `mobile.number` (docs) or `mobile_phone.number` (create side).
  const phone =
    g.mobile?.number ?? g.mobile_phone?.number ?? (typeof g.phone === 'string' ? g.phone : undefined);
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

async function findOrCreateGuest(
  http: HttpContext<ZenotiCredentials>,
  c: ZenotiCredentials,
  customer: Customer,
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
  const created = await http.request(c, {
    method: 'POST',
    path: 'guests',
    body: {
      center_id: c.centerId,
      personal_info: {
        first_name: firstName ?? 'Guest',
        last_name: rest.join(' ') || 'Guest',
        ...(customer.email ? { email: customer.email } : {}),
        ...(customer.phone ? { mobile_phone: { number: customer.phone } } : {}),
      },
    },
  });
  // TODO: verify against live API — guest-create response id field name unconfirmed (id vs guest.id)
  return reqString(String(created?.id ?? created?.guest?.id ?? ''), 'zenoti', 'guest.id');
}

async function resolveGuestId(
  http: HttpContext<ZenotiCredentials>,
  c: ZenotiCredentials,
  input: CreateBookingInput,
): Promise<string> {
  const fromOpts = input.providerOptions?.guestId;
  if (typeof fromOpts === 'string') return fromOpts;
  if (input.customer) return findOrCreateGuest(http, c, input.customer);
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
  // TODO: verify against live API — create-booking response id field name unconfirmed (id vs booking_id)
  const bookingId = reqString(String(booking?.id ?? booking?.booking_id ?? ''), 'zenoti', 'booking.id');
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
        input.providerOptions,
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
        input.providerOptions,
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
      const c = await http.resolve();
      const res = await http.request(c, {
        path: 'appointments',
        query: {
          center_id: c.centerId,
          start_date: query.range.start.slice(0, 10),
          end_date: query.range.end.slice(0, 10),
          therapist_id: query.staffId,
        },
      });
      const bookings = asArray(res?.appointments, 'zenoti', 'appointments').map(toBooking);
      return { bookings };
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
      // Zenoti has no stateless availability endpoint — create a transient booking
      // and read its slots. The booking is unconfirmed and Zenoti expires it.
      const date = query.range.start.slice(0, 10);
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
        },
      });
      // TODO: verify against live API — create-booking response id field name unconfirmed (id vs booking_id)
      const bookingId = reqString(String(booking?.id ?? booking?.booking_id ?? ''), 'zenoti', 'booking.id');
      const slotsRes = await http.request(c, { path: `bookings/${enc(bookingId)}/slots` });
      const slots = asArray(slotsRes?.slots, 'zenoti', 'booking.slots');
      return slots.flatMap((s: any) => {
        const start = utc(s.Time) ?? (typeof s.Time === 'string' ? s.Time : undefined);
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

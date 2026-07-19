import type { AvailabilitySlot, Booking, Customer } from '../types';
import { asArray, asRecord, defineAdapter, reqString, unsupported } from '../adapter-kit';
import type { HttpContext } from '../http';
import { UnibookingError } from '../errors';
import { assertValidRange, endFromDuration, isInstant, parseOffsetMinutes } from '../time';
import { localToInstant } from '../tz';

/**
 * Setmore (Booking API). Gated beta: a paid Setmore Pro account plus manual
 * access approval (email api@setmore.com). Bring your own bearer access token —
 * exchange your long-lived refresh token for one yourself via
 * `GET api/v1/o/oauth2/token?refreshToken=…` (access tokens last ~7 days).
 *
 * The API surface is genuinely small — 11 endpoints total. Notably there is
 * **no** fetch-by-id, **no** cancel/delete, and **no** reschedule: the only
 * mutation on an existing appointment is a label change. `getBooking` and
 * `cancelBooking` therefore throw UNSUPPORTED rather than calling endpoints that
 * do not exist. Verified against the official Apiary blueprint (2025-09-03).
 *
 * Three different day-first date encodings are in play — `dd-mm-yyyy` when
 * listing, `DD/MM/YYYY` for slots, and `yyyy-MM-ddTHH:mm` on create. They are not
 * interchangeable.
 */
export type SetmoreCredentials = {
  accessToken: string;
};

const BASE = 'https://developer.setmore.com/';

/** Setmore caps a list page at 150 appointments and a staff page at 50. */
const MAX_APPOINTMENTS_PER_PAGE = 150;

function enc(id: string): string {
  return encodeURIComponent(id);
}

/** Setmore wraps every payload as `{ response, data, msg }` and signals failure
 *  with `response: false` — sometimes alongside a 2xx status, so the HTTP layer
 *  alone can't be trusted to surface it. */
function assertOk(res: unknown): unknown {
  const envelope = res as any;
  if (envelope && typeof envelope === 'object' && envelope.response === false) {
    throw new UnibookingError({
      provider: 'setmore',
      code: 'UPSTREAM',
      message: typeof envelope.msg === 'string' ? envelope.msg : 'Setmore reported a failure',
      ...(typeof envelope.error === 'string' ? { providerCode: envelope.error } : {}),
    });
  }
  return envelope?.data;
}

function dataOf(res: unknown): Record<string, any> {
  return asRecord(assertOk(res), 'setmore', 'response.data');
}

/** `data` unwrapped without asserting object-ness — the slots endpoint may
 *  legitimately return a bare array (see `slotValues`). */
function rawDataOf(res: unknown): unknown {
  return assertOk(res);
}

/** Wall-clock Y/M/D as written in an offset-bearing RFC3339 string. Using UTC
 *  here would roll the date over for late-evening negative-offset ranges. */
function localParts(iso: string): { y: number; m: number; d: number } {
  const offset = parseOffsetMinutes(iso) ?? 0;
  const shifted = new Date(Date.parse(iso) + offset * 60_000);
  return { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth() + 1, d: shifted.getUTCDate() };
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** `dd-mm-yyyy` — the list endpoint's format. */
function toDashDate(iso: string): string {
  const { y, m, d } = localParts(iso);
  return `${pad(d)}-${pad(m)}-${y}`;
}

/** `DD/MM/YYYY` — the slots endpoint's format. Same ordering, different separator. */
function toSlashDate(y: number, m: number, d: number): string {
  return `${pad(d)}/${pad(m)}/${y}`;
}

/** `yyyy-MM-ddTHH:mmZ` — create/response format. Setmore documents no seconds. */
function toSetmoreInstant(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new UnibookingError({
      provider: 'setmore',
      code: 'INVALID_INPUT',
      message: `not a parseable timestamp: ${iso}`,
    });
  }
  return `${new Date(ms).toISOString().slice(0, 16)}Z`;
}

/** Each calendar day touched by the range, in the range's own offset. The slots
 *  endpoint is single-date, so a multi-day query has to fan out. */
function datesInRange(startIso: string, endIso: string): Array<{ y: number; m: number; d: number }> {
  const offset = parseOffsetMinutes(startIso) ?? 0;
  const startMs = Date.parse(startIso) + offset * 60_000;
  const endMs = Date.parse(endIso) + offset * 60_000;
  const out: Array<{ y: number; m: number; d: number }> = [];
  const cursor = new Date(Date.UTC(
    new Date(startMs).getUTCFullYear(),
    new Date(startMs).getUTCMonth(),
    new Date(startMs).getUTCDate(),
  ));
  // Guard against a pathological range producing an unbounded fan-out.
  for (let i = 0; i < 62 && cursor.getTime() <= endMs; i++) {
    out.push({ y: cursor.getUTCFullYear(), m: cursor.getUTCMonth() + 1, d: cursor.getUTCDate() });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/** The docs' slots response sample is not valid JSON — a bare array sits inside
 *  an object with no key, so it's genuinely ambiguous whether the wire format is
 *  `data: [...]` or `data: { slots: [...] }`. Accept either. */
function slotValues(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    for (const value of Object.values(data as Record<string, unknown>)) {
      if (Array.isArray(value)) return value;
    }
  }
  return [];
}

/** Setmore returns slot times dot-separated (`"05.30"`), with no date and no
 *  offset. Tolerate a colon too, in case the sample is stylistic. */
function parseSlotClock(raw: unknown): { hh: string; mm: string } | undefined {
  const m = /^(\d{1,2})[.:](\d{2})$/.exec(String(raw).trim());
  if (!m) return undefined;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return undefined;
  return { hh: pad(hh), mm: pad(mm) };
}

/** Setmore documents `yyyy-MM-ddTHH:mm` but every sample carries a `Z`. Accept
 *  either, and anchor an offset-less value as UTC so the canonical `Booking`
 *  never carries an ambiguous local time. */
function toSetmoreBookingTime(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.trim() === '') return undefined;
  const s = v.trim();
  if (isInstant(s)) return s;
  const anchored = `${s}Z`;
  return isInstant(anchored) ? anchored : undefined;
}

function toBooking(raw: unknown): Booking {
  const a = asRecord(raw, 'setmore', 'appointment');
  const start = toSetmoreBookingTime(a.start_time);
  const end = toSetmoreBookingTime(a.end_time);
  if (start === undefined || end === undefined) {
    throw new UnibookingError({
      provider: 'setmore',
      code: 'UPSTREAM',
      message: 'appointment is missing a usable start_time/end_time',
    });
  }
  const customer = asRecord(a.customer ?? {}, 'setmore', 'appointment.customer');
  return {
    id: reqString(String(a.key ?? ''), 'setmore', 'appointment.key'),
    provider: 'setmore',
    title: typeof a.label === 'string' && a.label && a.label !== 'No Label' ? a.label : 'Appointment',
    range: { start, end },
    ...(a.staff_key ? { staffId: String(a.staff_key) } : {}),
    ...(a.service_key ? { serviceId: String(a.service_key) } : {}),
    ...(a.customer_key || customer.key
      ? {
          customer: {
            id: String(a.customer_key ?? customer.key),
            ...(customer.first_name
              ? { name: [customer.first_name, customer.last_name].filter(Boolean).join(' ') }
              : {}),
            ...(customer.email_id ? { email: String(customer.email_id) } : {}),
            ...(customer.cell_phone ? { phone: String(customer.cell_phone) } : {}),
          },
        }
      : {}),
    // Setmore returns no status field on any documented appointment shape —
    // every appointment it hands back is implicitly active.
    status: 'confirmed',
    raw: a,
  };
}

function parseSetmoreError(_status: number, body: unknown): { providerCode?: string; message?: string } {
  const b = body as any;
  if (!b || typeof b !== 'object') return {};
  const message = b.msg ?? b.message;
  return {
    ...(typeof message === 'string' ? { message } : {}),
    ...(typeof b.error === 'string' ? { providerCode: b.error } : {}),
  };
}

function requireField(value: string | undefined, hint: string): string {
  if (!value) {
    throw new UnibookingError({ provider: 'setmore', code: 'INVALID_INPUT', message: `Setmore requires ${hint}` });
  }
  return value;
}

async function findOrCreateCustomer(
  http: HttpContext<SetmoreCredentials>,
  c: SetmoreCredentials,
  customer: Customer,
): Promise<string> {
  if (customer.id) return customer.id;
  const [first, ...rest] = (customer.name ?? '').trim().split(/\s+/).filter(Boolean);
  // Lookup requires `firstname` — Setmore offers no email-only search, so a
  // nameless customer can only ever be created, never matched.
  if (first) {
    const res = await http.request(c, {
      path: 'api/v1/bookingapi/customer',
      query: {
        firstname: first,
        ...(customer.email ? { email: customer.email } : {}),
        ...(customer.phone ? { phone: customer.phone } : {}),
      },
    });
    const found = asArray(dataOf(res)?.customer, 'setmore', 'customer')[0];
    if (found?.key) return String(found.key);
  }
  const created = await http.request(c, {
    method: 'POST',
    path: 'api/v1/bookingapi/customer/create',
    body: {
      first_name: first ?? 'Guest',
      ...(rest.length ? { last_name: rest.join(' ') } : {}),
      ...(customer.email ? { email_id: customer.email } : {}),
      ...(customer.phone ? { cell_phone: customer.phone } : {}),
    },
  });
  return reqString(String(dataOf(created)?.customer?.key ?? ''), 'setmore', 'customer.key');
}

export const setmore = defineAdapter<SetmoreCredentials>({
  id: 'setmore',
  capabilities: {
    availability: true,
    staff: true,
    services: true,
    // No webhook or callback mechanism exists in the Booking API.
    webhooks: false,
    idempotency: false,
    customers: true,
  },
  baseUrl: BASE,
  auth: (c) => ({ headers: { authorization: `Bearer ${c.accessToken}` } }),
  parseError: parseSetmoreError,
  build: (http) => ({
    async createBooking(input) {
      assertValidRange(input.range, 'setmore');
      const c = await http.resolve();
      const staffKey = requireField(input.staffId, 'a staffId (staff_key) to book');
      const serviceKey = requireField(input.serviceId, 'a serviceId (service_key) to book');
      let customerKey = input.customer?.id;
      if (customerKey === undefined && input.customer) {
        customerKey = await findOrCreateCustomer(http, c, input.customer);
      }
      // customer_key is required by the API, not optional as previously assumed.
      requireField(customerKey, 'a customer (customer_key) to book');
      const res = await http.request(c, {
        method: 'POST',
        path: 'api/v1/bookingapi/appointment/create',
        body: {
          staff_key: staffKey,
          service_key: serviceKey,
          customer_key: customerKey,
          start_time: toSetmoreInstant(input.range.start),
          end_time: toSetmoreInstant(input.range.end),
          ...(input.title !== undefined ? { label: input.title } : {}),
          ...input.providerOptions,
        },
      });
      return toBooking(dataOf(res)?.appointment);
    },

    getBooking: async () =>
      unsupported(
        'setmore',
        'getBooking (the Booking API has no fetch-by-id endpoint; use listBookings over a date range)',
      ),

    async updateBooking(id, input) {
      if (input.range || input.staffId || input.serviceId) {
        return unsupported(
          'setmore',
          'updateBooking of time/staff/service (the only mutation Setmore exposes is a label change)',
        );
      }
      const label = requireField(input.title, 'a title (label) — the only updatable field');
      const c = await http.resolve();
      const res = await http.request(c, {
        method: 'PUT',
        path: `api/v1/bookingapi/appointments/${enc(id)}/label`,
        query: { label },
      });
      return toBooking(dataOf(res)?.appointment);
    },

    cancelBooking: async () =>
      unsupported('setmore', 'cancelBooking (the Booking API has no cancel or delete endpoint)'),

    async listBookings(query) {
      assertValidRange(query.range, 'setmore');
      const c = await http.resolve();
      const res = await http.request(c, {
        path: 'api/v1/bookingapi/appointments',
        query: {
          startDate: toDashDate(query.range.start),
          endDate: toDashDate(query.range.end),
          customerDetails: 'true',
          ...(query.staffId ? { staff_key: query.staffId } : {}),
          ...(query.pageToken ? { cursor: query.pageToken } : {}),
        },
      });
      const data = dataOf(res);
      const bookings = asArray(data?.appointments, 'setmore', 'appointments').map(toBooking);
      const cursor = data?.cursor;
      // Docs never specify how the final page is signalled; treat an absent,
      // empty, or unchanged cursor as terminal.
      const isTerminal = typeof cursor !== 'string' || cursor === '' || cursor === query.pageToken;
      return {
        bookings,
        ...(isTerminal ? {} : { nextPageToken: cursor }),
      };
    },

    async searchAvailability(query): Promise<AvailabilitySlot[]> {
      assertValidRange(query.range, 'setmore');
      const serviceKey = requireField(query.serviceId, 'a serviceId (service_key) for availability');
      const staffKey = requireField(query.staffId, 'a staffId (staff_key) for availability');
      if (typeof query.durationMinutes !== 'number' || query.durationMinutes <= 0) {
        throw new UnibookingError({
          provider: 'setmore',
          code: 'INVALID_INPUT',
          message: 'Setmore slots are start-only; pass a positive durationMinutes to size each slot',
        });
      }
      // Slots come back as bare wall-clock times with no date and no offset, so
      // they can only be anchored against a known zone. Inferring one from the
      // caller's range offset would silently misplace every slot across DST.
      const timezone = requireField(
        query.range.timezone,
        'range.timezone (IANA) for availability — slot times carry no offset',
      );
      const durationMinutes = query.durationMinutes;
      const c = await http.resolve();
      const out: AvailabilitySlot[] = [];
      for (const day of datesInRange(query.range.start, query.range.end)) {
        const res = await http.request(c, {
          method: 'POST',
          path: 'api/v1/bookingapi/slots',
          body: {
            staff_key: staffKey,
            service_key: serviceKey,
            selected_date: toSlashDate(day.y, day.m, day.d),
            timezone,
            ...(query.providerOptions ?? {}),
          },
        });
        const localDate = `${day.y}-${pad(day.m)}-${pad(day.d)}`;
        for (const raw of slotValues(rawDataOf(res))) {
          const clock = parseSlotClock(raw);
          if (!clock) continue;
          const start = localToInstant(
            `${localDate}T${clock.hh}:${clock.mm}:00`,
            timezone,
            (ms) => new Date(ms).toISOString(),
          );
          if (!start) continue;
          out.push({
            start,
            end: endFromDuration(start, durationMinutes),
            staffId: staffKey,
            raw,
          });
        }
      }
      return out;
    },

    customers: {
      findOrCreate: async (customer) => {
        const c = await http.resolve();
        return findOrCreateCustomer(http, c, customer);
      },
    },
  }),
});

export { MAX_APPOINTMENTS_PER_PAGE as SETMORE_MAX_PAGE_SIZE };

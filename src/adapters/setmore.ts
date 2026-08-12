import type { AvailabilitySlot, Booking, Customer, Service, Staff } from '../types';
import {
  asArray,
  asRecord,
  bookingsWithinRange,
  decimalToMinorUnits,
  defineAdapter,
  probeConnection,
  reqString,
  unsupported,
} from '../adapter-kit';
import type { HttpContext } from '../http';
import { UnibookingError } from '../errors';
import { assertValidRange, endFromDuration, isInstant, parseOffsetMinutes } from '../time';
import { slotsWithinRange } from '../availability';
import { localToInstant } from '../tz';

/**
 * Setmore (Booking API). Gated beta: a paid Setmore Pro account plus manual
 * access approval (email api@setmore.com). Bring your own bearer access token —
 * exchange your long-lived refresh token for one yourself via
 * `GET api/v1/o/oauth2/token?refreshToken=…` (access tokens last 7200 seconds —
 * two hours — so a long-lived process must refresh, not cache).
 *
 * ## Two API generations, and you need both
 *
 * Setmore serves `api/v1/bookingapi` and `api/v2/bookingapi` side by side on the
 * same host, and they are **not** interchangeable — neither is a superset of the
 * other, so this adapter pins each operation to the generation that actually
 * routes it:
 *
 * | operation                     | v1    | v2    | used |
 * | ----------------------------- | ----- | ----- | ---- |
 * | `POST /slots`                 | ✅    | 404   | v1   |
 * | `GET /appointments` (list)    | ✅    | ✅    | v1   |
 * | `POST /appointment/create`    | ✅    | ✅    | v1   |
 * | `PUT /appointments/{id}/label`| ✅    | ✅    | v1   |
 * | `PUT /appointments/{id}`      | 405   | ✅    | v2   |
 * | `DELETE /appointments/{id}`   | ✅    | ✅    | v2   |
 * | `GET /appointments/{id}`      | 405   | 405   | —    |
 *
 * Availability is the reason the whole adapter can't simply move to v2: `slots`
 * exists only on v1. Reschedule is the reason it can't stay on v1: `PUT` on the
 * appointment resource answers 405 there. Cancel/delete routes on *both*, so
 * routing alone can't settle it; it is pinned to v2 to sit on the same
 * generation as reschedule (and because that is the generation reported to work
 * in practice), overridable per call with `providerOptions: { apiVersion: 'v1' }`.
 * Nothing "documents" v2 — see below.
 *
 * The published OpenAPI spec (developers.setmore.com) describes only the ten v1
 * routes and omits the v2 generation entirely, so `PUT`/`DELETE` on the
 * appointment resource are **verified to route** (401 with no token vs 404 for
 * an unrouted path) but their request/response bodies are inferred from the
 * create endpoint's shape. There is no sandbox — confirm against a throwaway
 * account before relying on them.
 *
 * `getBooking` remains genuinely absent: `GET /appointments/{id}` answers 405 on
 * both generations, so it still throws UNSUPPORTED.
 *
 * Three different day-first date encodings are in play — `dd-mm-yyyy` when
 * listing, `DD/MM/YYYY` for slots, and `yyyy-MM-ddTHH:mm` on create. They are not
 * interchangeable.
 */
export type SetmoreCredentials = {
  accessToken: string;
  /** ISO-4217 code for the account's currency, e.g. `'USD'`.
   *
   *  Setmore returns a bare `cost` on services with no currency alongside it,
   *  and a `Money` without a currency is not usable. Supply this and
   *  `listServices` fills in `Service.price`; omit it and `price` is left
   *  undefined rather than guessed, with the raw `cost` still in `raw`. */
  currency?: string;
};

const BASE = 'https://developer.setmore.com/';

/** The two generations. Every path below is written against one of these
 *  explicitly — there is no "current version" default, because picking one
 *  wrongly is exactly the bug this split exists to prevent. */
const V1 = 'api/v1/bookingapi';
const V2 = 'api/v2/bookingapi';

type SetmoreApiVersion = 'v1' | 'v2';

const VERSION_PREFIX: Record<SetmoreApiVersion, string> = { v1: V1, v2: V2 };

/** Pull the `apiVersion` routing hint out of `providerOptions` so it selects a
 *  path prefix instead of being shallow-merged into the request body as a bogus
 *  field. Returns the remaining options untouched. */
function takeApiVersion(
  options: Record<string, unknown> | undefined,
  fallback: SetmoreApiVersion,
): { prefix: string; rest: Record<string, unknown> } {
  const { apiVersion, ...rest } = options ?? {};
  if (apiVersion !== undefined && apiVersion !== 'v1' && apiVersion !== 'v2') {
    throw new UnibookingError({
      provider: 'setmore',
      code: 'INVALID_INPUT',
      message: `providerOptions.apiVersion must be 'v1' or 'v2', got ${String(apiVersion)}`,
    });
  }
  return {
    prefix: VERSION_PREFIX[(apiVersion as SetmoreApiVersion | undefined) ?? fallback],
    rest,
  };
}

/** The slots endpoint is single-date, so a multi-day availability query fans out
 *  one request per day. Cap the fan-out so a pathological range can't issue
 *  hundreds of calls. */
const MAX_AVAILABILITY_DAYS = 62;

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

/** `yyyy-MM-ddTHH:mmZ` — create/response format. Setmore documents no seconds,
 *  so this conversion is lossy by design: `09:00:45Z` goes out as `09:00Z`. It
 *  truncates rather than rounds, which can only move a bound earlier — never
 *  past an instant the caller excluded. */
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

/** Each calendar day the range touches, each endpoint read in its OWN offset —
 *  RFC3339 lets `end` carry a different one (e.g. across a DST change), and
 *  reusing the start's offset shifts the last day. */
function datesInRange(
  startIso: string,
  endIso: string,
): Array<{ y: number; m: number; d: number }> {
  const startMs = Date.parse(startIso) + (parseOffsetMinutes(startIso) ?? 0) * 60_000;
  const endMs = Date.parse(endIso) + (parseOffsetMinutes(endIso) ?? 0) * 60_000;
  const out: Array<{ y: number; m: number; d: number }> = [];
  const cursor = new Date(
    Date.UTC(
      new Date(startMs).getUTCFullYear(),
      new Date(startMs).getUTCMonth(),
      new Date(startMs).getUTCDate(),
    ),
  );
  // `range.end` is exclusive, so a day that begins exactly at it is not touched
  // by the range — `<=` here spent a request on the day after a whole-day query
  // and returned that day's slots as if they were in range.
  while (cursor.getTime() < endMs) {
    // An over-wide range is a caller error, not something to quietly truncate.
    if (out.length >= MAX_AVAILABILITY_DAYS) {
      throw new UnibookingError({
        provider: 'setmore',
        code: 'INVALID_INPUT',
        message: `Setmore availability ranges may not exceed ${MAX_AVAILABILITY_DAYS} days (the slots endpoint is one request per day)`,
      });
    }
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
    title:
      typeof a.label === 'string' && a.label && a.label !== 'No Label' ? a.label : 'Appointment',
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

function parseSetmoreError(
  _status: number,
  body: unknown,
): { providerCode?: string; message?: string } {
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
    throw new UnibookingError({
      provider: 'setmore',
      code: 'INVALID_INPUT',
      message: `Setmore requires ${hint}`,
    });
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
      path: `${V1}/customer`,
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
    path: `${V1}/customer/create`,
    body: {
      first_name: first ?? 'Guest',
      ...(rest.length ? { last_name: rest.join(' ') } : {}),
      ...(customer.email ? { email_id: customer.email } : {}),
      ...(customer.phone ? { cell_phone: customer.phone } : {}),
    },
  });
  return reqString(String(dataOf(created)?.customer?.key ?? ''), 'setmore', 'customer.key');
}

function toService(raw: unknown, categories: Map<string, string>, currency?: string): Service {
  const s = asRecord(raw, 'setmore', 'service');
  const amount = decimalToMinorUnits(s.cost);
  const duration = Number(s.duration);
  const categoryKey = s.category_key ? String(s.category_key) : undefined;
  const categoryName = categoryKey ? categories.get(categoryKey) : undefined;
  return {
    id: reqString(String(s.key ?? ''), 'setmore', 'service.key'),
    name: reqString(String(s.service_name ?? ''), 'setmore', 'service.service_name'),
    ...(s.service_description ? { description: String(s.service_description) } : {}),
    ...(Number.isFinite(duration) && duration > 0 ? { durationMinutes: duration } : {}),
    ...(amount !== undefined && currency ? { price: { amount, currency } } : {}),
    ...(categoryKey ? { categoryId: categoryKey } : {}),
    ...(categoryName ? { categoryName } : {}),
    // Setmore's service payload carries no active/inactive flag — everything it
    // returns is bookable.
    active: true,
    raw: s,
  };
}

function toStaff(raw: unknown): Staff {
  const s = asRecord(raw, 'setmore', 'staff');
  return {
    id: reqString(String(s.key ?? ''), 'setmore', 'staff.key'),
    name: reqString(String(s.staff_name ?? ''), 'setmore', 'staff.staff_name'),
    ...(s.email_id ? { email: String(s.email_id) } : {}),
    ...(s.cell_phone ? { phone: String(s.cell_phone) } : {}),
    // No active/inactive concept in the staffs payload.
    active: true,
    raw: s,
  };
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
    serviceCatalog: true,
    staffDirectory: true,
    serviceCatalogWrite: false,
    staffDirectoryWrite: false,
  },
  baseUrl: BASE,
  auth: (c) => ({ headers: { authorization: `Bearer ${c.accessToken}` } }),
  parseError: parseSetmoreError,
  build: (http) => ({
    async checkConnection() {
      const c = await http.resolve();
      return probeConnection('setmore', async () => {
        // Setmore exposes no account or profile endpoint, so its cheapest
        // authenticated read doubles as the probe. It surfaces no identity.
        const res = await http.request(c, { path: `${V1}/services` });
        assertOk(res);
        return { raw: res };
      });
    },
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
        path: `${V1}/appointment/create`,
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
        'getBooking (neither API generation exposes a fetch-by-id — GET on the appointment resource is 405 on both; use listBookings over a date range)',
      ),

    async updateBooking(id, input) {
      // An appointment carries no status field, so a status change can't be
      // expressed as an edit. Reject it here — otherwise it falls through to the
      // label path and surfaces as a bogus "requires a title".
      if (input.status !== undefined) {
        return unsupported(
          'setmore',
          'updateBooking of status (an appointment carries no status field — use cancelBooking to cancel one)',
        );
      }

      const reschedules =
        input.range !== undefined || input.staffId !== undefined || input.serviceId !== undefined;

      // A title-only edit stays on the documented v1 label sub-resource: it is
      // the narrower call, and it can't disturb the booking's time or staffing.
      // `/label` routes on both generations, so `apiVersion` is honored here too
      // — otherwise the same option would work on one branch of this method and
      // be silently ignored on the other.
      if (!reschedules) {
        const label = requireField(
          input.title,
          'at least one of title, range, staffId or serviceId to update',
        );
        const { prefix } = takeApiVersion(input.providerOptions, 'v1');
        const c = await http.resolve();
        const res = await http.request(c, {
          method: 'PUT',
          path: `${prefix}/appointments/${enc(id)}/label`,
          query: { label },
        });
        return toBooking(dataOf(res)?.appointment);
      }

      if (input.range) assertValidRange(input.range, 'setmore');
      // v2 only — v1 answers 405 on PUT against the appointment resource.
      const { prefix, rest } = takeApiVersion(input.providerOptions, 'v2');
      const c = await http.resolve();
      const res = await http.request(c, {
        method: 'PUT',
        path: `${prefix}/appointments/${enc(id)}`,
        body: {
          ...(input.range
            ? {
                start_time: toSetmoreInstant(input.range.start),
                end_time: toSetmoreInstant(input.range.end),
              }
            : {}),
          ...(input.staffId !== undefined ? { staff_key: input.staffId } : {}),
          ...(input.serviceId !== undefined ? { service_key: input.serviceId } : {}),
          ...(input.title !== undefined ? { label: input.title } : {}),
          ...rest,
        },
      });
      return toBooking(dataOf(res)?.appointment);
    },

    async cancelBooking(id, options) {
      // Setmore deletes rather than cancels — there is no status to move an
      // appointment into, so the appointment is removed outright. The endpoint
      // takes no documented reason or notify field, so `options.reason` and
      // `options.notify` are ignored.
      const { prefix, rest } = takeApiVersion(options?.providerOptions, 'v2');
      const c = await http.resolve();
      // `response: false` can ride along with a 200, so the envelope still has
      // to be asserted even though the body is otherwise discarded.
      assertOk(
        await http.request(c, {
          method: 'DELETE',
          path: `${prefix}/appointments/${enc(id)}`,
          // `CancelOptions.providerOptions` is contractually shallow-merged into
          // the body, so anything left after `apiVersion` is forwarded rather
          // than dropped. Omit the body entirely when there is nothing to send —
          // a bare `{}` on a DELETE is a needless deviation from the plain call.
          ...(Object.keys(rest).length > 0 ? { body: rest } : {}),
        }),
      );
    },

    async listBookings(query) {
      assertValidRange(query.range, 'setmore');
      const c = await http.resolve();
      const res = await http.request(c, {
        path: `${V1}/appointments`,
        query: {
          startDate: toDashDate(query.range.start),
          endDate: toDashDate(query.range.end),
          customerDetails: 'true',
          ...(query.staffId ? { staff_key: query.staffId } : {}),
          ...(query.pageToken ? { cursor: query.pageToken } : {}),
        },
      });
      const data = dataOf(res);
      // startDate/endDate are whole dates (dd-mm-yyyy), so Setmore returns both
      // entire end days regardless of the times asked for. Trim to the instants,
      // then apply `limit` — the endpoint takes no page-size parameter, so
      // ignoring it silently returned the whole day to a caller who asked for
      // three bookings.
      let bookings = bookingsWithinRange(
        asArray(data?.appointments, 'setmore', 'appointments').map(toBooking),
        query.range,
      );
      if (query.limit !== undefined && query.limit >= 0) bookings = bookings.slice(0, query.limit);
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
      const serviceKey = requireField(
        query.serviceId,
        'a serviceId (service_key) for availability',
      );
      const staffKey = requireField(query.staffId, 'a staffId (staff_key) for availability');
      if (typeof query.durationMinutes !== 'number' || query.durationMinutes <= 0) {
        throw new UnibookingError({
          provider: 'setmore',
          code: 'INVALID_INPUT',
          message:
            'Setmore slots are start-only; pass a positive durationMinutes to size each slot',
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
          path: `${V1}/slots`,
          body: {
            staff_key: staffKey,
            service_key: serviceKey,
            selected_date: toSlashDate(day.y, day.m, day.d),
            timezone,
            // `slot_limit` caps how many slots the day returns and defaults to 30
            // upstream, so a full day of short slots is truncated server-side.
            // It is deliberately not defaulted here (the account's own default is
            // the honest one); raise it via providerOptions when you need more.
            ...(query.providerOptions ?? {}),
          },
        });
        const localDate = `${day.y}-${pad(day.m)}-${pad(day.d)}`;
        for (const raw of slotValues(rawDataOf(res))) {
          const clock = parseSlotClock(raw);
          if (!clock) continue;
          const start = localToInstant(`${localDate}T${clock.hh}:${clock.mm}:00`, timezone, (ms) =>
            new Date(ms).toISOString(),
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
      // `selected_date` is date-granular, so each request answers with the whole
      // business day; narrow to the hours the caller actually asked for.
      return slotsWithinRange(out, query.range);
    },

    async listServices() {
      const c = await http.resolve();
      // Categories arrive as a separate flat list keyed by `category_key`. One
      // extra request for the whole set — never one per service.
      const [servicesRes, categoriesRes] = await Promise.all([
        http.request(c, { path: `${V1}/services` }),
        // `categoryName` is decorative. A categories failure (a narrower token,
        // an outage on that route) must not sink the whole catalog read — the
        // services still carry `categoryId`, and the raw payload is intact.
        http.request(c, { path: `${V1}/services/categories` }).catch(() => undefined),
      ]);
      const categories = new Map<string, string>();
      if (categoriesRes !== undefined) {
        for (const raw of asArray(dataOf(categoriesRes)?.categories, 'setmore', 'categories')) {
          const cat = asRecord(raw, 'setmore', 'category');
          if (cat.key && cat.category_name) {
            categories.set(String(cat.key), String(cat.category_name));
          }
        }
      }
      const services = asArray(dataOf(servicesRes)?.services, 'setmore', 'services').map((s) =>
        toService(s, categories, c.currency),
      );
      // The endpoint takes no paging parameters and returns everything.
      return { services };
    },

    async listStaff() {
      const c = await http.resolve();
      const res = await http.request(c, { path: `${V1}/staffs` });
      return { staff: asArray(dataOf(res)?.staffs, 'setmore', 'staffs').map(toStaff) };
    },

    customers: {
      findOrCreate: async (customer) => {
        const c = await http.resolve();
        return findOrCreateCustomer(http, c, customer);
      },
    },
  }),
});

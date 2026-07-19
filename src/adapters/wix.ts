import type { AvailabilitySlot, Booking, BookingStatus, Customer } from '../types';
import { asArray, asRecord, defineAdapter, reqString, unsupported } from '../adapter-kit';
import type { HttpContext } from '../http';
import { UnibookingError } from '../errors';
import { assertValidRange, endFromDuration, formatWithOffset, isInstant } from '../time';
import { localToInstant, zoneOffsetMinutes } from '../tz';

/**
 * Wix Bookings (headless REST). Bookings Writer V2 for create/reschedule/cancel,
 * Reader V2 for get/query, Time Slots V2 for availability, and CRM Contacts v4
 * for customer resolution.
 *
 * Auth: bring your own OAuth access token (Wix app instance / member / user
 * token). It is sent verbatim in the `Authorization` header — no `Bearer`
 * prefix, which is how Wix expects app tokens.
 *
 * NOTE: shapes here are docs-derived, not verified against a live Wix tenant.
 * Fields marked `TODO: verify against live API` are the ones most likely to need
 * a tweak once run against a real site.
 */
export type WixCredentials = {
  accessToken: string;
};

const BASE = 'https://www.wixapis.com/';

function enc(id: string): string {
  return encodeURIComponent(id);
}

/** A canonical instant → the offset-less wall-clock time in `tz` (what Wix Time
 *  Slots V2 wants for `fromLocalDate`/`toLocalDate`). */
function toLocalWallClock(instant: string, tz: string): string {
  const epoch = Date.parse(instant);
  const offsetMin = zoneOffsetMinutes(tz, new Date(epoch)) ?? 0;
  return formatWithOffset(epoch, offsetMin).replace(/(Z|[+-]\d{2}:\d{2})$/, '');
}

function mapStatus(s: unknown): BookingStatus {
  switch (String(s).toUpperCase()) {
    case 'CONFIRMED':
    case 'CREATED': // a created booking is an active reservation
      return 'confirmed';
    case 'PENDING':
    case 'WAITING_LIST':
      return 'pending';
    case 'CANCELED':
    case 'CANCELLED':
      return 'cancelled';
    case 'DECLINED':
      return 'declined';
    default:
      return 'unknown';
  }
}

/** The bookable slot lives under `bookedEntity.slot` (single session) — Wix also
 *  supports `bookedEntity.schedule` for classes, which we surface via `raw`. */
function slotOf(b: Record<string, any>): Record<string, any> | undefined {
  const entity = b.bookedEntity;
  if (entity && typeof entity === 'object') {
    if (entity.slot && typeof entity.slot === 'object') return entity.slot;
    if (entity.schedule && typeof entity.schedule === 'object') return entity.schedule;
  }
  return undefined;
}

function customerOf(b: Record<string, any>): Customer | undefined {
  const cd = b.contactDetails;
  if (!cd || typeof cd !== 'object') return undefined;
  const name = `${cd.firstName ?? ''} ${cd.lastName ?? ''}`.trim();
  const id = cd.contactId;
  if (!id && !name && !cd.email && !cd.phone) return undefined;
  return {
    ...(id ? { id: String(id) } : {}),
    ...(name ? { name } : {}),
    ...(cd.email ? { email: String(cd.email) } : {}),
    ...(cd.phone ? { phone: String(cd.phone) } : {}),
  };
}

function toBooking(raw: unknown): Booking {
  const b = asRecord(raw, 'wix', 'booking');
  const slot = slotOf(b);
  const start = slot?.startDate;
  const end = slot?.endDate;
  if (typeof start !== 'string' || typeof end !== 'string') {
    throw new UnibookingError({
      provider: 'wix',
      code: 'UPSTREAM',
      message: 'booking is missing bookedEntity.slot start/end dates',
    });
  }
  const entity = b.bookedEntity ?? {};
  const customer = customerOf(b);
  return {
    id: reqString(String(b.id ?? ''), 'wix', 'booking.id'),
    provider: 'wix',
    title: typeof entity.title === 'string' && entity.title ? entity.title : 'Appointment',
    range: { start, end },
    ...(slot?.resource?.id ? { staffId: String(slot.resource.id) } : {}),
    ...(slot?.serviceId ? { serviceId: String(slot.serviceId) } : {}),
    ...(customer ? { customer } : {}),
    status: mapStatus(b.status),
    ...(typeof b.createdDate === 'string' ? { createdAt: b.createdDate } : {}),
    ...(typeof b.updatedDate === 'string' ? { updatedAt: b.updatedDate } : {}),
    raw: b,
  };
}

function parseWixError(_status: number, body: unknown): { providerCode?: string; message?: string } {
  const b = body as any;
  const message = b?.message ?? b?.details?.applicationError?.description;
  const code = b?.details?.applicationError?.code ?? b?.code;
  return {
    ...(typeof message === 'string' ? { message } : {}),
    ...(code ? { providerCode: String(code) } : {}),
  };
}

function splitName(name: string): { firstName: string; lastName?: string } {
  const [first, ...rest] = name.trim().split(/\s+/);
  return { firstName: first ?? name, ...(rest.length ? { lastName: rest.join(' ') } : {}) };
}

/** CRM Contacts v4 `info.name` shape ({ first, last }) — distinct from the
 *  booking `contactDetails` shape ({ firstName, lastName }). */
function contactName(name: string): { first: string; last?: string } {
  const [first, ...rest] = name.trim().split(/\s+/);
  return { first: first ?? name, ...(rest.length ? { last: rest.join(' ') } : {}) };
}

/** Resolve a canonical customer to a Wix CRM contact id, creating one if needed. */
async function findOrCreateContact(
  http: HttpContext<WixCredentials>,
  c: WixCredentials,
  customer: Customer,
): Promise<string> {
  if (customer.id) return customer.id;
  // TODO: verify against live API — Contacts v4 query filter uses `info.emails.email`.
  if (customer.email) {
    const search = await http.request(c, {
      method: 'POST',
      path: 'contacts/v4/contacts/query',
      body: { query: { filter: { 'info.emails.email': customer.email } } },
    });
    const found = asArray(search?.contacts, 'wix', 'contacts.query')[0];
    if (found?.id) return String(found.id);
  }
  const info = {
    // CRM Contacts v4 `info.name` is { first, last } — NOT { firstName, lastName }
    // (that shape is right for booking.contactDetails, but wrong here, so the
    // contact's name was being silently dropped).
    ...(customer.name ? { name: contactName(customer.name) } : {}),
    ...(customer.email ? { emails: { items: [{ email: customer.email }] } } : {}),
    ...(customer.phone ? { phones: { items: [{ phone: customer.phone }] } } : {}),
  };
  const created = await http.request(c, {
    method: 'POST',
    path: 'contacts/v4/contacts',
    body: { info },
  });
  return reqString(String(created?.contact?.id ?? ''), 'wix', 'contact.id');
}

/** Reader V2 has NO GET-by-id — you query `extended-bookings` with a filter. Each
 *  result is an ExtendedBooking wrapper whose `.booking` holds the real booking.
 *  Returns the raw booking objects plus the next cursor. */
async function queryExtendedBookings(
  http: HttpContext<WixCredentials>,
  c: WixCredentials,
  filter: Record<string, unknown>,
  cursorPaging?: { limit?: number; cursor?: string },
): Promise<{ raw: Record<string, any>[]; next?: string }> {
  const res = await http.request(c, {
    method: 'POST',
    path: 'bookings/reader/v2/extended-bookings/query',
    body: { query: { filter, ...(cursorPaging ? { cursorPaging } : {}) } },
  });
  const items = asArray(res?.extendedBookings, 'wix', 'extendedBookings');
  const bookings = items.map((e) => (e && typeof e.booking === 'object' ? e.booking : e));
  const next = res?.pagingMetadata?.cursors?.next;
  return { raw: bookings, ...(typeof next === 'string' && next ? { next } : {}) };
}

async function getBooking(
  http: HttpContext<WixCredentials>,
  c: WixCredentials,
  id: string,
): Promise<Booking> {
  const { raw } = await queryExtendedBookings(http, c, { id });
  if (!raw[0]) {
    throw new UnibookingError({ provider: 'wix', code: 'NOT_FOUND', message: `booking ${id} not found` });
  }
  return toBooking(raw[0]);
}

/** Reschedule and cancel both need the booking's current `revision` (optimistic
 *  concurrency). Read it via the query unless the caller supplied one. */
async function currentRevision(
  http: HttpContext<WixCredentials>,
  c: WixCredentials,
  id: string,
): Promise<string | number | undefined> {
  const { raw } = await queryExtendedBookings(http, c, { id });
  return raw[0]?.revision;
}

export const wix = defineAdapter<WixCredentials>({
  id: 'wix',
  capabilities: {
    availability: true,
    staff: true,
    services: true,
    webhooks: true,
    idempotency: false,
    customers: true,
  },
  baseUrl: BASE,
  auth: (c) => ({ headers: { authorization: c.accessToken } }),
  parseError: parseWixError,
  build: (http) => ({
    async createBooking(input) {
      assertValidRange(input.range, 'wix');
      const c = await http.resolve();
      let contactId = input.customer?.id;
      if (contactId === undefined && input.customer && (input.customer.email || input.customer.phone)) {
        contactId = await findOrCreateContact(http, c, input.customer);
      }
      const cust = input.customer;
      // Wix create requires a participant count — either `totalParticipants` or
      // `participantsChoices`. Default to 1 unless the caller supplies either.
      const hasParticipants =
        input.providerOptions?.totalParticipants !== undefined ||
        input.providerOptions?.participantsChoices !== undefined;
      const res = await http.request(c, {
        method: 'POST',
        path: 'bookings/v2/bookings',
        body: {
          booking: {
            bookedEntity: {
              title: input.title,
              slot: {
                ...(input.serviceId ? { serviceId: input.serviceId } : {}),
                startDate: input.range.start,
                endDate: input.range.end,
                ...(input.staffId ? { resource: { id: input.staffId } } : {}),
              },
            },
            ...(cust
              ? {
                  contactDetails: {
                    ...(contactId ? { contactId } : {}),
                    ...(cust.name ? splitName(cust.name) : {}),
                    ...(cust.email ? { email: cust.email } : {}),
                    ...(cust.phone ? { phone: cust.phone } : {}),
                  },
                }
              : {}),
            ...(hasParticipants ? {} : { totalParticipants: 1 }),
            ...input.providerOptions,
          },
        },
      });
      return toBooking(res?.booking);
    },

    getBooking(id) {
      return http.resolve().then((c) => getBooking(http, c, id));
    },

    async updateBooking(id, input) {
      const c = await http.resolve();
      // Wix reschedules by posting a new slot; other field edits aren't a
      // reschedule. Cancellation routes to the cancel endpoint.
      if (input.range) {
        assertValidRange(input.range, 'wix');
        // `revision` is REQUIRED on reschedule (optimistic concurrency).
        const { revision: optRevision, ...rest } = input.providerOptions ?? {};
        const revision = optRevision ?? (await currentRevision(http, c, id));
        const res = await http.request(c, {
          method: 'POST',
          path: `bookings/v2/bookings/${enc(id)}/reschedule`,
          body: {
            ...(revision !== undefined ? { revision } : {}),
            slot: {
              startDate: input.range.start,
              endDate: input.range.end,
              ...(input.staffId ? { resource: { id: input.staffId } } : {}),
              ...(input.serviceId ? { serviceId: input.serviceId } : {}),
            },
            ...rest,
          },
        });
        return toBooking(res?.booking);
      }
      if (input.status === 'cancelled') {
        // Wix's cancel endpoint returns the updated booking, so map it directly
        // rather than making a second round-trip. `revision` is REQUIRED.
        const revision = input.providerOptions?.revision ?? (await currentRevision(http, c, id));
        const res = await http.request(c, {
          method: 'POST',
          path: `bookings/v2/bookings/${enc(id)}/cancel`,
          body: { ...(revision !== undefined ? { revision } : {}) },
        });
        return toBooking(res?.booking);
      }
      return unsupported(
        'wix',
        'updateBooking without a range (Wix supports reschedule or cancel, not arbitrary field edits)',
      );
    },

    async cancelBooking(id, options) {
      const c = await http.resolve();
      // `revision` is REQUIRED on cancel; `participantNotification` controls emails.
      const revision = await currentRevision(http, c, id);
      await http.request(c, {
        method: 'POST',
        path: `bookings/v2/bookings/${enc(id)}/cancel`,
        body: {
          ...(revision !== undefined ? { revision } : {}),
          ...(options?.notify !== undefined
            ? { participantNotification: { notifyParticipants: options.notify } }
            : {}),
        },
        parse: 'none',
      });
    },

    async listBookings(query) {
      assertValidRange(query.range, 'wix');
      const c = await http.resolve();
      // Reader V2's only list method is Query Extended Bookings.
      // TODO: verify against live API — the exact filterable field name for the
      // date window (`startDate` here) isn't published; confirm on a live tenant.
      const { raw, next } = await queryExtendedBookings(
        http,
        c,
        {
          startDate: { $gte: query.range.start, $lte: query.range.end },
          ...(query.staffId ? { 'bookedEntity.slot.resource.id': query.staffId } : {}),
        },
        { limit: query.limit ?? 50, ...(query.pageToken ? { cursor: query.pageToken } : {}) },
      );
      const bookings = raw.map(toBooking);
      return { bookings, ...(next !== undefined ? { nextPageToken: next } : {}) };
    },

    async searchAvailability(query): Promise<AvailabilitySlot[]> {
      assertValidRange(query.range, 'wix');
      // Time Slots V2 works in LOCAL time: it takes `fromLocalDate`/`toLocalDate`
      // (no offset) plus an IANA `timeZone`, and returns `localStartDate`/
      // `localEndDate` (also offset-less). Convert those back to canonical instants
      // using the same zone, so a query without a timezone can't produce ambiguous
      // times.
      const tz = query.range.timezone;
      if (!tz) {
        throw new UnibookingError({
          provider: 'wix',
          code: 'INVALID_INPUT',
          message: 'Wix availability (Time Slots V2) is local-time — pass range.timezone (an IANA zone)',
        });
      }
      const c = await http.resolve();
      // TODO: verify against live API — Time Slots V2 public path + resource-filter shape.
      const res = await http.request(c, {
        method: 'POST',
        path: '_api/service-availability/v2/time-slots',
        body: {
          ...(query.serviceId ? { serviceId: query.serviceId } : {}),
          fromLocalDate: toLocalWallClock(query.range.start, tz),
          toLocalDate: toLocalWallClock(query.range.end, tz),
          timeZone: tz,
          ...(query.staffId ? { resourceTypes: [{ resourceIds: [query.staffId] }] } : {}),
        },
      });
      const slots = asArray(res?.timeSlots ?? res?.availabilityTimeSlots, 'wix', 'timeSlots');
      const toInstant = (local: unknown): string | undefined =>
        typeof local === 'string' && local
          ? localToInstant(local, tz, (ms) => formatWithOffset(ms, 0))
          : undefined;
      return slots.flatMap((s: any): AvailabilitySlot[] => {
        const start = toInstant(s.localStartDate) ?? (isInstant(s.startDate) ? s.startDate : undefined);
        if (start === undefined) return [];
        const end =
          toInstant(s.localEndDate) ??
          (isInstant(s.endDate) ? s.endDate : undefined) ??
          (query.durationMinutes ? endFromDuration(start, query.durationMinutes) : undefined);
        if (end === undefined) return [];
        const staffId =
          s.availableResources?.[0]?.resources?.[0]?.id ?? s.resource?.id ?? query.staffId;
        return [{ start, end, ...(staffId ? { staffId: String(staffId) } : {}), raw: s }];
      });
    },

    customers: {
      findOrCreate: async (customer) => {
        const c = await http.resolve();
        return findOrCreateContact(http, c, customer);
      },
    },
  }),
});

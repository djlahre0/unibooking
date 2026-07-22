import type { AvailabilitySlot, Booking, BookingStatus, Customer } from '../types';
import { asArray, asRecord, defineAdapter, reqString, unsupported } from '../adapter-kit';
import type { HttpContext } from '../http';
import { UnibookingError } from '../errors';
import { assertValidRange, formatWithOffset } from '../time';
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
 * NOTE: the paths and payload shapes here match the published reference. The one
 * thing still unverified is which fields Query Extended Bookings accepts in its
 * `filter` — Wix publishes no exhaustive list — so `listBookings`' date-window
 * filter carries a TODO.
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

/** Canonical status → the Wix `status` filter value(s) covering it. Wix's enum is
 *  CREATED/CONFIRMED/CANCELED/PENDING/DECLINED/WAITING_LIST and `mapStatus` folds
 *  several of those into one canonical status, so the inverse of a canonical
 *  status can be a set. Undefined for statuses Wix has no equivalent of
 *  (no_show/completed), so the filter is left off rather than sending a wrong one. */
function wixStatusFilter(s: BookingStatus | undefined): string | { $in: string[] } | undefined {
  const values =
    s === 'confirmed'
      ? ['CONFIRMED', 'CREATED']
      : s === 'pending'
        ? ['PENDING', 'WAITING_LIST']
        : s === 'cancelled'
          ? ['CANCELED']
          : s === 'declined'
            ? ['DECLINED']
            : undefined;
  if (!values) return undefined;
  return values.length === 1 ? values[0]! : { $in: values };
}

function requireService(serviceId: string | undefined): string {
  if (!serviceId) {
    throw new UnibookingError({
      provider: 'wix',
      code: 'INVALID_INPUT',
      message:
        'Wix availability (Time Slots V2) requires a serviceId — it is mandatory except when paging by cursor',
    });
  }
  return serviceId;
}

/** Reschedule and cancel both mark `revision` REQUIRED. When none can be resolved
 *  the request is guaranteed to be rejected, so fail here instead of sending it. */
function requireRevision(revision: unknown, id: string): string | number {
  if (revision === undefined || revision === null || revision === '') {
    throw new UnibookingError({
      provider: 'wix',
      code: 'UPSTREAM',
      message: `could not resolve the current revision of booking ${id} (Wix requires it to reschedule/cancel)`,
    });
  }
  return revision as string | number;
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
  // Contacts v4 queries emails through the `info.emails.email` path.
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
    path: 'bookings/bookings-reader/v2/extended-bookings/query',
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
      // Create Booking takes several params BESIDE `booking`. Pull those out so
      // they land at the top level of the request body; everything else still
      // merges into `booking`, which is where providerOptions always went.
      const {
        participantNotification: notificationOption,
        flowControlSettings,
        sendSmsReminder,
        formSubmission,
        ...bookingOptions
      } = input.providerOptions ?? {};
      // Canonical `notify` is Wix's `participantNotification.notifyParticipants`;
      // an explicit providerOptions.participantNotification still wins.
      const participantNotification = {
        ...(input.notify !== undefined ? { notifyParticipants: input.notify } : {}),
        ...(notificationOption && typeof notificationOption === 'object' ? notificationOption : {}),
      };
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
            ...bookingOptions,
          },
          ...(Object.keys(participantNotification).length ? { participantNotification } : {}),
          ...(flowControlSettings !== undefined ? { flowControlSettings } : {}),
          ...(sendSmsReminder !== undefined ? { sendSmsReminder } : {}),
          ...(formSubmission !== undefined ? { formSubmission } : {}),
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
        // `revision` is REQUIRED on reschedule (optimistic concurrency). The slot
        // identifiers have no canonical field, so they come through
        // providerOptions — echo back the full slot you got from
        // `searchAvailability` (its `raw`) rather than assembling one by hand.
        const {
          revision: optRevision,
          scheduleId,
          sessionId,
          timezone,
          ...rest
        } = input.providerOptions ?? {};
        const revision = requireRevision(optRevision ?? (await currentRevision(http, c, id)), id);
        const res = await http.request(c, {
          method: 'POST',
          path: `bookings/v2/bookings/${enc(id)}/reschedule`,
          body: {
            revision,
            slot: {
              startDate: input.range.start,
              endDate: input.range.end,
              ...(input.staffId ? { resource: { id: input.staffId } } : {}),
              ...(input.serviceId ? { serviceId: input.serviceId } : {}),
              ...(scheduleId !== undefined ? { scheduleId } : {}),
              ...(sessionId !== undefined ? { sessionId } : {}),
              ...(timezone ?? input.range.timezone
                ? { timezone: timezone ?? input.range.timezone }
                : {}),
            },
            ...rest,
          },
        });
        return toBooking(res?.booking);
      }
      if (input.status === 'cancelled') {
        // Wix's cancel endpoint returns the updated booking, so map it directly
        // rather than making a second round-trip. `revision` is REQUIRED; the
        // remaining providerOptions (flowControlSettings, participantNotification)
        // are forwarded, same as on the reschedule branch.
        const { revision: optRevision, ...rest } = input.providerOptions ?? {};
        const revision = requireRevision(optRevision ?? (await currentRevision(http, c, id)), id);
        const res = await http.request(c, {
          method: 'POST',
          path: `bookings/v2/bookings/${enc(id)}/cancel`,
          body: { revision, ...rest },
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
      // `revision` is REQUIRED on cancel. `CancelOptions` has no field to carry
      // one, so it is always read back first — and if it can't be resolved we
      // fail here rather than sending a request Wix is certain to reject.
      // (`updateBooking({ status: 'cancelled' })` accepts one via providerOptions.)
      const revision = requireRevision(await currentRevision(http, c, id), id);
      // Wix only delivers `message` when `notifyParticipants` is true.
      const participantNotification = {
        ...(options?.notify !== undefined ? { notifyParticipants: options.notify } : {}),
        ...(options?.reason ? { message: options.reason } : {}),
      };
      await http.request(c, {
        method: 'POST',
        path: `bookings/v2/bookings/${enc(id)}/cancel`,
        body: {
          revision,
          ...(Object.keys(participantNotification).length ? { participantNotification } : {}),
        },
        parse: 'none',
      });
    },

    async listBookings(query) {
      assertValidRange(query.range, 'wix');
      if (query.staffId) {
        // The documented filterable set is id / status / paymentStatus /
        // contactDetails.* / the date fields / the slot fields under
        // `bookedEntity.item.slot.*` — none of which is a staff or resource. A
        // guessed field name would either 400 or be silently ignored (returning
        // every staff member's bookings as if they matched), so refuse instead.
        // TODO: revisit if Wix ever documents a staff/resource filter here.
        return unsupported(
          'wix',
          "filtering bookings by staffId — Query Extended Bookings exposes no staff/resource filter, so list the window and filter on the result's staffId client-side",
        );
      }
      const c = await http.resolve();
      const status = wixStatusFilter(query.status);
      // Reader V2's only list method is Query Extended Bookings.
      // TODO: verify against live API — Wix publishes no exhaustive list of
      // filterable fields, so the date-window field name (`startDate` here) is
      // still unconfirmed; check it on a live tenant.
      const { raw, next } = await queryExtendedBookings(
        http,
        c,
        {
          startDate: { $gte: query.range.start, $lte: query.range.end },
          ...(status !== undefined ? { status } : {}),
          ...(query.customerId ? { 'contactDetails.contactId': query.customerId } : {}),
        },
        {
          // Documented max is 100; clamp rather than let an upstream 400 through.
          limit: Math.min(query.limit ?? 50, 100),
          ...(query.pageToken ? { cursor: query.pageToken } : {}),
        },
      );
      const bookings = raw.map(toBooking);
      return { bookings, ...(next !== undefined ? { nextPageToken: next } : {}) };
    },

    async searchAvailability(query): Promise<AvailabilitySlot[]> {
      assertValidRange(query.range, 'wix');
      // `serviceId` is required unless the request pages by cursor (which this
      // adapter never does), so demand it here rather than take the 400.
      const serviceId = requireService(query.serviceId);
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
      // List Availability Time Slots covers appointment-based services only —
      // class and course sessions come from List Event Time Slots instead.
      const res = await http.request(c, {
        method: 'POST',
        path: '_api/service-availability/v2/time-slots',
        body: {
          serviceId,
          fromLocalDate: toLocalWallClock(query.range.start, tz),
          toLocalDate: toLocalWallClock(query.range.end, tz),
          timeZone: tz,
          // The default returns bookable AND un-bookable slots; availability
          // means the bookable ones.
          bookable: true,
          // `availableResources` comes back empty unless the request asks for
          // resources — either this staff filter or a caller-supplied
          // `includeResourceTypeIds` (passed through providerOptions below).
          ...(query.staffId ? { resourceTypes: [{ resourceIds: [query.staffId] }] } : {}),
          ...query.providerOptions,
        },
      });
      const slots = asArray(res?.timeSlots, 'wix', 'timeSlots');
      const toInstant = (local: unknown): string | undefined =>
        typeof local === 'string' && local
          ? localToInstant(local, tz, (ms) => formatWithOffset(ms, 0))
          : undefined;
      return slots.flatMap((s: any): AvailabilitySlot[] => {
        // A TimeSlot carries only localStartDate/localEndDate — there is no
        // offset-bearing pair and no duration to derive an end from.
        const start = toInstant(s.localStartDate);
        const end = toInstant(s.localEndDate);
        if (start === undefined || end === undefined) return [];
        const staffId = s.availableResources?.[0]?.resources?.[0]?.id ?? query.staffId;
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

import type { Booking, BookingStatus, Customer, Service, Staff } from '../types';
import { asArray, asRecord, defineAdapter, probeConnection, reqString } from '../adapter-kit';
import { sha256Hex } from '../crypto';
import { UnibookingError, type ErrorCode } from '../errors';
import type { HttpContext } from '../http';
import { assertValidRange, endFromDuration } from '../time';

/**
 * Square Appointments (Bookings API). Supports availability, staff, services,
 * idempotent creates, and customer resolution.
 */
export type SquareCredentials = {
  accessToken: string;
  locationId: string;
};

const BASE = 'https://connect.squareup.com/v2/';
const SQUARE_VERSION = '2026-07-15';

function enc(id: string): string {
  return encodeURIComponent(id);
}

function segmentsDuration(segments: any[]): number {
  return segments.reduce(
    (sum, s) => sum + (typeof s?.duration_minutes === 'number' ? s.duration_minutes : 0),
    0,
  );
}

/** End instant from a start + the summed segment durations. Throws UPSTREAM when
 *  there is no positive duration to derive from (Square returns per-segment
 *  durations, so a zero total means the response is unusable — better than
 *  silently emitting a zero-length range that violates `end > start`). */
function deriveEnd(start: string, segments: any[], ctx: string): string {
  const mins = segmentsDuration(segments);
  if (mins <= 0) {
    throw new UnibookingError({
      provider: 'square',
      code: 'UPSTREAM',
      message: `${ctx}: cannot derive an end (no positive segment duration)`,
    });
  }
  return endFromDuration(start, mins);
}

function requireService(serviceId: string | undefined): string {
  if (!serviceId) {
    throw new UnibookingError({
      provider: 'square',
      code: 'INVALID_INPUT',
      message: 'Square availability search requires a serviceId (service_variation_id)',
    });
  }
  return serviceId;
}

/** Reject client-side what Square would reject with an opaque 400. */
function requireCreateField(value: unknown, message: string): void {
  if (value === undefined || value === null || value === '') {
    throw new UnibookingError({ provider: 'square', code: 'INVALID_INPUT', message });
  }
}

function mapStatus(s: unknown): BookingStatus {
  switch (s) {
    case 'ACCEPTED':
      return 'confirmed';
    case 'PENDING':
      return 'pending';
    case 'CANCELLED_BY_CUSTOMER':
    case 'CANCELLED_BY_SELLER':
      return 'cancelled';
    case 'DECLINED':
      return 'declined';
    case 'NO_SHOW':
      return 'no_show';
    default:
      return 'unknown';
  }
}

function toBooking(raw: unknown): Booking {
  const b = asRecord(raw, 'square', 'booking');
  const start = reqString(b.start_at, 'square', 'booking.start_at');
  const segments = Array.isArray(b.appointment_segments) ? b.appointment_segments : [];
  const first = segments[0];
  // Square returns a duration per segment; the reference bug copied start as
  // end (zero duration). Derive the real end from the summed durations.
  const end = deriveEnd(start, segments, 'booking');
  return {
    id: reqString(b.id, 'square', 'booking.id'),
    provider: 'square',
    title: typeof b.customer_note === 'string' && b.customer_note ? b.customer_note : 'Appointment',
    range: { start, end },
    ...(first?.team_member_id ? { staffId: first.team_member_id } : {}),
    ...(first?.service_variation_id ? { serviceId: first.service_variation_id } : {}),
    ...(b.customer_id ? { customer: { id: b.customer_id } } : {}),
    status: mapStatus(b.status),
    ...(typeof b.created_at === 'string' ? { createdAt: b.created_at } : {}),
    ...(typeof b.updated_at === 'string' ? { updatedAt: b.updated_at } : {}),
    raw: b,
  };
}

/**
 * Two Square failures are about the seller's **Appointments plan**, not their
 * credentials — both observed live:
 *
 * - `401 UNAUTHORIZED — "Merchant not onboarded to Appointments"` on every
 *   Bookings call, when the seller has no Appointments subscription at all.
 * - `403 FORBIDDEN — "Merchant subscription does not support write operations."`
 *   on createBooking/updateBooking/cancelBooking, when the seller is on the
 *   **Free** plan. Reads (availability search, listBookings) still succeed;
 *   Square gates only booking writes behind a paid plan.
 *
 * In both cases the token is perfectly valid — the catalog, team and customer
 * endpoints keep working on the very same credentials, and on the Free plan even
 * the booking *reads* do.
 *
 * Taken at face value those become `AUTH` and `FORBIDDEN`, which are two of the
 * three codes this library defines as "these credentials no longer work" (see
 * `probeConnection`). A consumer watching for them would tear down a healthy
 * integration and force a re-auth that cannot possibly fix it, because nothing
 * was ever wrong with the grant. The remedy is a plan change by the merchant.
 *
 * `UNSUPPORTED` is what these actually are: the account cannot do this
 * operation. It is also excluded from the dead-connection codes, so it can't be
 * mistaken for a revoked grant.
 */
function planLimitation(status: number, errors: any[]): { remedy: string } | undefined {
  const detail = (e: any) => String(e?.detail ?? '');
  if (
    status === 401 &&
    errors.some(
      (e) => e?.code === 'UNAUTHORIZED' && /not onboarded to appointments/i.test(detail(e)),
    )
  ) {
    return {
      remedy:
        'this Square account has no Appointments subscription, so the Bookings API is unavailable to it. The credentials themselves are valid (catalog, team and customer calls still work). Enable Square Appointments for the merchant at squareup.com/appointments.',
    };
  }
  if (
    status === 403 &&
    errors.some((e) => /subscription does not support write operations/i.test(detail(e)))
  ) {
    return {
      remedy:
        "this Square account's Appointments plan is read-only for the Bookings API — the free plan allows availability and booking reads but not creates, updates or cancels. The credentials are valid; the merchant needs a paid Appointments plan (Plus or Premium) to write bookings.",
    };
  }
  return undefined;
}

function parseSquareError(
  status: number,
  body: unknown,
): { providerCode?: string; message?: string; code?: ErrorCode } {
  const errors = (body as any)?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return {};
  const message = errors
    .map((e: any) => e.detail ?? e.code)
    .filter(Boolean)
    .join('; ');
  const plan = planLimitation(status, errors);
  return {
    ...(message ? { message: plan ? `${message} — ${plan.remedy}` : message } : {}),
    ...(errors[0]?.code ? { providerCode: errors[0].code } : {}),
    // Narrow on purpose: if Square ever reworded these, the match fails and the
    // status-derived AUTH/FORBIDDEN stands, which is exactly today's behaviour.
    ...(plan ? { code: 'UNSUPPORTED' as ErrorCode } : {}),
  };
}

function splitName(name: string): { given_name: string; family_name?: string } {
  const [given, ...rest] = name.trim().split(/\s+/);
  return { given_name: given ?? name, ...(rest.length ? { family_name: rest.join(' ') } : {}) };
}

/**
 * The identity a customer is deduped on, as both a search filter and a stable
 * key. Deriving both from one expression keeps them provably in step — they are
 * two halves of the same dedup decision.
 *
 * Email wins over phone so a customer who supplies both is matched on the
 * stronger identifier; a customer with neither cannot be deduped at all.
 */
function customerDedupe(
  customer: Customer,
): { key: string; filter: Record<string, unknown> } | undefined {
  if (customer.email) {
    const email = customer.email.trim().toLowerCase();
    return { key: `email:${email}`, filter: { email_address: { exact: customer.email } } };
  }
  if (customer.phone) {
    const phone = customer.phone.trim();
    return { key: `phone:${phone}`, filter: { phone_number: { exact: customer.phone } } };
  }
  return undefined;
}

/**
 * A CreateCustomer idempotency key derived from the customer's identity.
 *
 * Square's customer search index is **eventually consistent** — a record
 * created now is not findable by `customers/search` for a second or two
 * (measured: a miss at 0.9s, a hit at 2.3s against live Square). So the
 * search-then-create below has a real race: two calls for the same person close
 * together both miss the index and both create, leaving duplicate customers
 * attached to different bookings.
 *
 * A key derived from the identity closes it. Square collapses a repeat create
 * carrying a key it has already seen and returns the original customer, so the
 * duplicate is prevented server-side, where the race actually lives, rather
 * than by a client-side re-check that would still be racing.
 *
 * These keys expire upstream after 24 hours — by which time the search index
 * has long since caught up and the lookup path handles the dedup instead. The
 * two mechanisms cover each other's window.
 *
 * Only used when there IS an identity to key on. A name-only customer keeps a
 * random key: "John Smith" is not an identity, and collapsing two distinct
 * walk-ins of that name into one record would attach a booking to the wrong
 * person — a worse failure than the duplicate this avoids.
 */
async function customerCreateKey(dedupeKey: string | undefined): Promise<string> {
  if (dedupeKey === undefined) return globalThis.crypto.randomUUID();
  // Hashed to bound the length (Square rejects keys over 126 chars) and to keep
  // a raw email out of the request's idempotency field.
  return `ub-cust-${(await sha256Hex(dedupeKey)).slice(0, 32)}`;
}

/** Resolve a canonical customer to a Square customer id, creating one if needed. */
async function findOrCreateCustomer(
  http: HttpContext<SquareCredentials>,
  c: SquareCredentials,
  customer: Customer,
): Promise<string> {
  if (customer.id) return customer.id;
  const dedupe = customerDedupe(customer);
  if (dedupe) {
    const search = await http.request(c, {
      method: 'POST',
      path: 'customers/search',
      body: { query: { filter: dedupe.filter }, limit: 1 },
    });
    const found = Array.isArray(search?.customers) ? search.customers[0] : undefined;
    if (found?.id) return found.id;
  }
  const created = await http.request(c, {
    method: 'POST',
    path: 'customers',
    body: {
      idempotency_key: await customerCreateKey(dedupe?.key),
      ...(customer.name ? splitName(customer.name) : {}),
      ...(customer.email ? { email_address: customer.email } : {}),
      ...(customer.phone ? { phone_number: customer.phone } : {}),
    },
  });
  return reqString(created?.customer?.id, 'square', 'customer.id');
}

/** Square's `service_duration` is milliseconds. */
function durationFromMs(ms: unknown): number | undefined {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n / 60_000;
}

/**
 * Read the ITEM that owns a service variation, so a write can be applied as a
 * read-modify-write against the current version.
 *
 * `Service.id` is a variation id, but a variation's name and description live on
 * the parent ITEM, and Square's upsert needs the object's `version` for
 * optimistic concurrency. So an update costs two reads: the variation (to learn
 * `item_id`) and the item itself.
 */
async function readServiceItem(
  http: HttpContext<SquareCredentials>,
  c: SquareCredentials,
  variationId: string,
): Promise<{ item: Record<string, any>; variation: Record<string, any> }> {
  const varRes = await http.request(c, { path: `catalog/object/${enc(variationId)}` });
  const variation = asRecord(varRes?.object, 'square', 'catalog.object');
  const itemId = variation.item_variation_data?.item_id;
  if (typeof itemId !== 'string' || !itemId) {
    throw new UnibookingError({
      provider: 'square',
      code: 'UPSTREAM',
      message: `catalog object ${variationId} is not a service variation (no item_variation_data.item_id)`,
    });
  }
  const itemRes = await http.request(c, { path: `catalog/object/${enc(itemId)}` });
  return { item: asRecord(itemRes?.object, 'square', 'catalog.object'), variation };
}

/** Locate a variation inside its parent item's `variations` array. */
function findVariation(item: Record<string, any>, variationId: string): Record<string, any> {
  const list = Array.isArray(item.item_data?.variations) ? item.item_data.variations : [];
  const found = list.find((v: any) => v?.id === variationId);
  if (!found) {
    throw new UnibookingError({
      provider: 'square',
      code: 'UPSTREAM',
      message: `variation ${variationId} is missing from its own parent item`,
    });
  }
  return found;
}

/** Upsert an ITEM and map the named variation back to a canonical Service.
 *
 * The reply envelope is `catalog_object`, NOT the `object` that
 * RetrieveCatalogObject answers with. Reading `object` here made every catalog
 * write fail against live Square with "expected an object, got undefined", even
 * though the write itself had already succeeded upstream — so the caller both
 * saw an error and had no id for the service Square had just created.
 */
async function upsertItem(
  http: HttpContext<SquareCredentials>,
  c: SquareCredentials,
  item: Record<string, any>,
  variationId: string | undefined,
): Promise<Service> {
  const res = await http.request(c, {
    method: 'POST',
    path: 'catalog/object',
    body: { idempotency_key: globalThis.crypto.randomUUID(), object: item },
  });
  const saved = asRecord(res?.catalog_object, 'square', 'catalog.catalog_object');
  const services = itemToServices(saved);
  // On a create the caller has no variation id yet — the '#variation'
  // placeholder they sent is not what comes back — so fall through to the sole
  // variation of the item just written.
  const match = variationId ? services.find((s) => s.id === variationId) : services[0];
  if (!match) {
    throw new UnibookingError({
      provider: 'square',
      code: 'UPSTREAM',
      message: 'upsert returned an item with no usable service variation',
    });
  }
  return match;
}

/**
 * Flatten one catalog ITEM into one `Service` per ITEM_VARIATION.
 *
 * This is the round-trip invariant in action: Square's booking API takes the
 * **variation** id as `service_variation_id`, so `Service.id` must be the
 * variation id, not the item id. Returning the item id would enumerate fine and
 * then fail at booking time with an opaque rejection.
 */
function itemToServices(raw: unknown): Service[] {
  const obj = asRecord(raw, 'square', 'catalog.item');
  const data = asRecord(obj.item_data ?? {}, 'square', 'catalog.item_data');
  const itemName = typeof data.name === 'string' ? data.name : '';
  const deleted = obj.is_deleted === true;
  return asArray(data.variations, 'square', 'catalog.item_data.variations').flatMap(
    (v: any): Service[] => {
      const variation = asRecord(v, 'square', 'catalog.variation');
      const vd = asRecord(
        variation.item_variation_data ?? {},
        'square',
        'catalog.item_variation_data',
      );
      const id = typeof variation.id === 'string' ? variation.id : '';
      if (!id) return [];
      const vName = typeof vd.name === 'string' ? vd.name : '';
      // Per the integration doc: append the variation name unless it is the
      // default "Regular", which would read as "Gel Nails - Regular".
      const name = vName && vName !== 'Regular' ? `${itemName} - ${vName}` : itemName;
      const duration = durationFromMs(vd.service_duration);
      const money = vd.price_money;
      const amount = Number(money?.amount);
      const currency = typeof money?.currency === 'string' ? money.currency : undefined;
      return [
        {
          id,
          name: name || id,
          ...(typeof data.description === 'string' && data.description
            ? { description: data.description }
            : {}),
          ...(duration !== undefined ? { durationMinutes: duration } : {}),
          ...(Number.isFinite(amount) && currency ? { price: { amount, currency } } : {}),
          ...(typeof data.category_id === 'string' ? { categoryId: data.category_id } : {}),
          // `available_for_booking` has to count here: it is the exact field
          // `setServiceActive` writes, so leaving it out made that method
          // contradict itself -- `setServiceActive(id, false)` came back
          // reporting `active: true`, and `listServices` showed unbookable
          // services as active. Compared against `false` rather than truth-
          // tested so a variation that simply omits the flag is unaffected.
          active: !deleted && variation.is_deleted !== true && vd.available_for_booking !== false,
          // The owning item stays reachable for consumers that need to regroup.
          raw: { item: obj, variation },
        },
      ];
    },
  );
}

function toStaff(raw: unknown): Staff {
  const t = asRecord(raw, 'square', 'team_member');
  const name = [t.given_name, t.family_name].filter(Boolean).join(' ');
  return {
    id: reqString(t.id, 'square', 'team_member.id'),
    name: name || String(t.id),
    ...(t.email_address ? { email: String(t.email_address) } : {}),
    ...(t.phone_number ? { phone: String(t.phone_number) } : {}),
    active: t.status === 'ACTIVE',
    raw: t,
  };
}

export const square = defineAdapter<SquareCredentials>({
  id: 'square',
  capabilities: {
    availability: true,
    staff: true,
    services: true,
    webhooks: true,
    idempotency: true,
    customers: true,
    serviceCatalog: true,
    staffDirectory: true,
    serviceCatalogWrite: true,
    staffDirectoryWrite: true,
  },
  baseUrl: BASE,
  auth: (c) => ({
    headers: { authorization: `Bearer ${c.accessToken}`, 'Square-Version': SQUARE_VERSION },
  }),
  parseError: parseSquareError,
  build: (http) => ({
    async checkConnection() {
      const c = await http.resolve();
      return probeConnection('square', async () => {
        const res = await http.request(c, { path: 'locations' });
        const locations = asArray(res?.locations, 'square', 'locations');
        // Report the location the credentials are actually bound to. A token
        // valid for the merchant but not for this location is a real failure
        // mode, and naming some other location would hide it.
        const mine = locations.find((l: any) => l?.id === c.locationId) ?? locations[0];
        return {
          ...(mine
            ? {
                account: {
                  ...(mine.id ? { id: String(mine.id) } : {}),
                  ...(mine.name ? { name: String(mine.name) } : {}),
                },
              }
            : {}),
          raw: res,
        };
      });
    },
    async createBooking(input) {
      assertValidRange(input.range, 'square');
      const c = await http.resolve();
      let customerId = input.customer?.id;
      // Resolve/attach a customer whenever we have anything to identify them by —
      // name, email, or phone. `findOrCreateCustomer` handles the name-only case
      // (no dedup filter, straight create), so gating on email/phone alone
      // silently dropped a name-only customer.
      if (
        customerId === undefined &&
        input.customer &&
        (input.customer.name || input.customer.email || input.customer.phone)
      ) {
        customerId = await findOrCreateCustomer(http, c, input.customer);
      }
      // Square appointment bookings require a `service_variation_version` on the
      // segment (pins the catalog version). It has no canonical field, so pull it
      // out of providerOptions and put it in the SEGMENT rather than the booking
      // body. The rest of providerOptions still merges onto the booking (a caller
      // can also override `appointment_segments` wholesale that way).
      const { service_variation_version, ...bookingOptions } = input.providerOptions ?? {};
      // Square requires location_id, start_at, and segment team_member_id +
      // service_variation_id + service_variation_version. Catching the omission
      // here turns an opaque upstream MISSING_REQUIRED_PARAMETER into an error
      // that names the field.
      //
      // A caller supplying `appointment_segments` has replaced the segment
      // wholesale — a documented escape hatch — so validating the fields they
      // deliberately overrode would break working code.
      if (bookingOptions.appointment_segments === undefined) {
        requireCreateField(
          input.serviceId,
          'Square createBooking requires a serviceId (service_variation_id)',
        );
        requireCreateField(
          input.staffId,
          'Square createBooking requires a staffId (team_member_id)',
        );
        requireCreateField(
          service_variation_version,
          'Square createBooking requires providerOptions.service_variation_version — ' +
            "read it from a searchAvailability slot's raw.appointment_segments[0].service_variation_version",
        );
      }
      const res = await http.request(c, {
        method: 'POST',
        path: 'bookings',
        body: {
          // Square requires an idempotency key on create. A caller-supplied
          // input.idempotencyKey makes retries safe; the generated fallback only
          // satisfies the API (it does NOT protect a cross-call retry).
          idempotency_key: input.idempotencyKey ?? globalThis.crypto.randomUUID(),
          booking: {
            location_id: c.locationId,
            start_at: input.range.start,
            // Square has no title field; `customer_note` is what `toBooking`
            // reads back as the title, so write the caller's there too.
            ...(input.title ? { customer_note: input.title } : {}),
            ...(customerId ? { customer_id: customerId } : {}),
            appointment_segments: [
              {
                ...(input.staffId ? { team_member_id: input.staffId } : {}),
                ...(input.serviceId ? { service_variation_id: input.serviceId } : {}),
                ...(service_variation_version !== undefined ? { service_variation_version } : {}),
              },
            ],
            ...bookingOptions,
          },
        },
      });
      return toBooking(res.booking);
    },

    async getBooking(id) {
      const c = await http.resolve();
      const res = await http.request(c, { path: `bookings/${enc(id)}` });
      return toBooking(res.booking);
    },

    async updateBooking(id, input) {
      if (input.range) assertValidRange(input.range, 'square');
      // `status` is read-only on Square's Booking; a PUT carrying it would look
      // like it worked and change nothing.
      if (input.status !== undefined) {
        throw new UnibookingError({
          provider: 'square',
          code: 'INVALID_INPUT',
          message:
            input.status === 'cancelled'
              ? 'Square booking status is read-only; use cancelBooking() to cancel'
              : `Square booking status is read-only (cannot set "${input.status}")`,
        });
      }
      const c = await http.resolve();
      // Square PUT requires the current version for optimistic concurrency, and
      // replaces appointment_segments wholesale — so to change staff/service we
      // must merge onto the current segment.
      const needSegment = input.staffId !== undefined || input.serviceId !== undefined;
      let version = input.providerOptions?.version;
      let curSeg: any;
      if (version === undefined || needSegment) {
        const current = asRecord(
          (await http.request(c, { path: `bookings/${enc(id)}` }))?.booking,
          'square',
          'booking',
        );
        if (version === undefined) version = current.version;
        const segs = Array.isArray(current.appointment_segments)
          ? current.appointment_segments
          : [];
        curSeg = segs[0];
      }
      const segment = needSegment
        ? {
            ...(curSeg ?? {}),
            ...(input.staffId ? { team_member_id: input.staffId } : {}),
            ...(input.serviceId ? { service_variation_id: input.serviceId } : {}),
          }
        : undefined;
      const res = await http.request(c, {
        method: 'PUT',
        path: `bookings/${enc(id)}`,
        body: {
          idempotency_key: globalThis.crypto.randomUUID(),
          booking: {
            version,
            ...(input.range ? { start_at: input.range.start } : {}),
            ...(segment ? { appointment_segments: [segment] } : {}),
            ...(input.title !== undefined ? { customer_note: input.title } : {}),
            ...input.providerOptions,
          },
        },
      });
      return toBooking(res.booking);
    },

    async cancelBooking(id, options) {
      const c = await http.resolve();
      // Square's CancelBooking body is { idempotency_key, booking_version }. There
      // is no field for a cancellation reason (seller_note is not a CancelBooking
      // field — to set one you'd UpdateBooking first) and `notify` isn't
      // controllable here. `booking_version` gives optimistic concurrency (cancel
      // only if the version you saw is still current); pass it via
      // `providerOptions: { booking_version }`.
      await http.request(c, {
        method: 'POST',
        path: `bookings/${enc(id)}/cancel`,
        body: {
          idempotency_key: globalThis.crypto.randomUUID(),
          ...options?.providerOptions,
        },
        parse: 'none',
      });
    },

    async listBookings(query) {
      assertValidRange(query.range, 'square');
      const c = await http.resolve();
      const res = await http.request(c, {
        path: 'bookings',
        query: {
          location_id: c.locationId,
          start_at_min: query.range.start,
          start_at_max: query.range.end,
          limit: query.limit ?? 50,
          cursor: query.pageToken,
          // Forward the staff + customer filters Square supports (the reference dropped them).
          team_member_id: query.staffId,
          customer_id: query.customerId,
        },
      });
      const bookings = asArray(res?.bookings, 'square', 'bookings').map(toBooking);
      return {
        bookings,
        ...(typeof res?.cursor === 'string' && res.cursor ? { nextPageToken: res.cursor } : {}),
      };
    },

    async searchAvailability(query) {
      assertValidRange(query.range, 'square');
      // Square's SearchAvailability rejects a request without segment_filters, so
      // require a serviceId up front with a clear client-side error.
      const serviceId = requireService(query.serviceId);
      const c = await http.resolve();
      const res = await http.request(c, {
        method: 'POST',
        path: 'bookings/availability/search',
        body: {
          query: {
            filter: {
              location_id: c.locationId,
              start_at_range: { start_at: query.range.start, end_at: query.range.end },
              segment_filters: [
                {
                  service_variation_id: serviceId,
                  ...(query.staffId ? { team_member_id_filter: { any: [query.staffId] } } : {}),
                },
              ],
              ...query.providerOptions,
            },
          },
        },
      });
      const availabilities = asArray(res?.availabilities, 'square', 'availabilities');
      return availabilities.map((a: any) => {
        const start = reqString(a.start_at, 'square', 'availability.start_at');
        const segs = Array.isArray(a.appointment_segments) ? a.appointment_segments : [];
        return {
          start,
          end: deriveEnd(start, segs, 'availability'),
          ...(segs[0]?.team_member_id ? { staffId: segs[0].team_member_id } : {}),
          raw: a,
        };
      });
    },

    async listServices(query) {
      const c = await http.resolve();
      const res = await http.request(c, {
        method: 'POST',
        path: 'catalog/search-catalog-items',
        body: {
          enabled_location_ids: [c.locationId],
          // Only appointment services are bookable; the rest of the catalog
          // (retail items, gift cards) cannot be attached to a booking.
          product_types: ['APPOINTMENTS_SERVICE'],
          ...(query?.limit !== undefined ? { limit: query.limit } : {}),
          ...(query?.pageToken ? { cursor: query.pageToken } : {}),
        },
      });
      const services = asArray(res?.items, 'square', 'catalog.items').flatMap(itemToServices);
      return {
        services,
        ...(typeof res?.cursor === 'string' && res.cursor ? { nextPageToken: res.cursor } : {}),
      };
    },

    async listStaff(query) {
      const c = await http.resolve();
      const res = await http.request(c, {
        method: 'POST',
        path: 'team-members/search',
        body: {
          // Deliberately unfiltered by status: filtering to ACTIVE would make
          // `Staff.active` always true and hide deactivated members a consumer
          // still needs in order to reconcile past bookings.
          query: { filter: { location_ids: [c.locationId] } },
          ...(query?.limit !== undefined ? { limit: query.limit } : {}),
          ...(query?.pageToken ? { cursor: query.pageToken } : {}),
        },
      });
      const staff = asArray(res?.team_members, 'square', 'team_members').map(toStaff);
      return {
        staff,
        ...(typeof res?.cursor === 'string' && res.cursor ? { nextPageToken: res.cursor } : {}),
      };
    },

    async createService(input) {
      const c = await http.resolve();
      // `team_member_ids` lists the staff who perform a service, and it lives on
      // the VARIATION while the rest of providerOptions merges onto the ITEM. So
      // it is pulled out and routed separately -- exactly as
      // `service_variation_version` is in createBooking.
      //
      // It matters more than it looks: a service with nobody assigned is
      // accepted by the catalog and then rejected by every availability search
      // with "did not find a team member who performs the selected service
      // variation", so the service exists but can never be booked. Square's own
      // onboarding assigns staff to every seeded service for this reason.
      const { team_member_ids, ...itemOptions } = input.providerOptions ?? {};
      // A bookable Square service is an ITEM whose product_type is
      // APPOINTMENTS_SERVICE, carrying at least one variation. Both objects need
      // client-side placeholder ids prefixed with '#'; Square swaps them for
      // real ids in the response.
      const item = {
        type: 'ITEM',
        id: '#service',
        item_data: {
          name: input.name,
          product_type: 'APPOINTMENTS_SERVICE',
          ...(input.description ? { description: input.description } : {}),
          variations: [
            {
              type: 'ITEM_VARIATION',
              id: '#variation',
              item_variation_data: {
                // "Regular" is Square's default variation name, and
                // `itemToServices` deliberately does not append it to the
                // service name — so a single-variation service reads cleanly.
                name: 'Regular',
                pricing_type: input.price ? 'FIXED_PRICING' : 'VARIABLE_PRICING',
                available_for_booking: true,
                ...(input.price
                  ? {
                      price_money: {
                        amount: input.price.amount,
                        currency: input.price.currency,
                      },
                    }
                  : {}),
                ...(input.durationMinutes !== undefined
                  ? { service_duration: input.durationMinutes * 60_000 }
                  : {}),
                ...(team_member_ids !== undefined ? { team_member_ids } : {}),
              },
            },
          ],
        },
        ...itemOptions,
      };
      return upsertItem(http, c, item, undefined);
    },

    async updateService(id, input) {
      const c = await http.resolve();
      const { item } = await readServiceItem(http, c, id);
      const variation = findVariation(item, id);
      const vd = variation.item_variation_data ?? {};
      // Assert rather than assume: a malformed item would otherwise blow up as a
      // raw TypeError, breaking the contract that adapters only throw
      // UnibookingError.
      const itemData = asRecord(item.item_data, 'square', 'catalog.item_data');

      // Partial update: only touch what the caller named. Square's upsert
      // REPLACES the object, so anything dropped here is genuinely erased --
      // which is why this is a read-modify-write rather than a bare PUT.
      if (input.name !== undefined) itemData.name = input.name;
      if (input.description !== undefined) itemData.description = input.description;
      if (input.durationMinutes !== undefined) {
        vd.service_duration = input.durationMinutes * 60_000;
      }
      if (input.price !== undefined) {
        vd.pricing_type = 'FIXED_PRICING';
        vd.price_money = { amount: input.price.amount, currency: input.price.currency };
      }
      // Reassigning staff has to reach the variation, not the item -- same
      // routing as createService.
      const { team_member_ids, ...itemOptions } = input.providerOptions ?? {};
      if (team_member_ids !== undefined) vd.team_member_ids = team_member_ids;
      variation.item_variation_data = vd;
      Object.assign(item, itemOptions);
      return upsertItem(http, c, item, id);
    },

    async setServiceActive(id, active) {
      const c = await http.resolve();
      const { item } = await readServiceItem(http, c, id);
      const variation = findVariation(item, id);
      // `available_for_booking` is the honest lever: it makes the variation
      // unbookable while leaving it, its history and its past bookings intact.
      // Square's actual delete cascades from the item down through every
      // variation, which is why no `deleteService` exists.
      variation.item_variation_data = {
        ...(variation.item_variation_data ?? {}),
        available_for_booking: active,
      };
      return upsertItem(http, c, item, id);
    },

    async createStaff(input) {
      const c = await http.resolve();
      const res = await http.request(c, {
        method: 'POST',
        path: 'team-members',
        body: {
          idempotency_key: globalThis.crypto.randomUUID(),
          team_member: {
            status: 'ACTIVE',
            ...splitName(input.name),
            ...(input.email ? { email_address: input.email } : {}),
            ...(input.phone ? { phone_number: input.phone } : {}),
            // Without an explicit assignment the member is bookable nowhere,
            // which would make them invisible to listStaff's location filter.
            assigned_locations: {
              assignment_type: 'EXPLICIT_LOCATIONS',
              location_ids: [c.locationId],
            },
            ...input.providerOptions,
          },
        },
      });
      return toStaff(asRecord(res?.team_member, 'square', 'team_member'));
    },

    async updateStaff(id, input) {
      const c = await http.resolve();
      const res = await http.request(c, {
        method: 'PUT',
        path: `team-members/${enc(id)}`,
        body: {
          team_member: {
            ...(input.name ? splitName(input.name) : {}),
            ...(input.email ? { email_address: input.email } : {}),
            ...(input.phone ? { phone_number: input.phone } : {}),
            ...input.providerOptions,
          },
        },
      });
      return toStaff(asRecord(res?.team_member, 'square', 'team_member'));
    },

    async setStaffActive(id, active) {
      const c = await http.resolve();
      // Square has NO team-member delete. Deactivation is the only removal it
      // offers, which is exactly why the canonical surface is setStaffActive
      // rather than a delete that would be a lie here.
      const res = await http.request(c, {
        method: 'PUT',
        path: `team-members/${enc(id)}`,
        body: { team_member: { status: active ? 'ACTIVE' : 'INACTIVE' } },
      });
      return toStaff(asRecord(res?.team_member, 'square', 'team_member'));
    },

    customers: {
      findOrCreate: async (customer) => {
        const c = await http.resolve();
        return findOrCreateCustomer(http, c, customer);
      },
    },
  }),
});

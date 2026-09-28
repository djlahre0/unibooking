import type { AvailabilitySlot, Booking, CustomerRecord, Service, Staff } from '../types';
import {
  asArray,
  asRecord,
  defineAdapter,
  minutesFromIso8601Duration,
  probeConnection,
  reqString,
} from '../adapter-kit';
import { UnibookingError } from '../errors';
import { assertValidRange } from '../time';
import { graphDateTime, graphToInstant, nextLinkFrom, parseGraphError, PREFER_UTC } from '../graph';

/**
 * Microsoft Bookings (via Microsoft Graph). Has real staff and services.
 * Scope: `Bookings.ReadWrite.All`.
 *
 * NOTE on availability: `getStaffAvailability` is GA in v1.0, but Graph documents
 * it as **application-permission only**: delegated user tokens are not
 * supported for that action, unlike every other call here. If your token is
 * delegated, `searchAvailability` will fail even though the rest works.
 */
export type MicrosoftBookingsCredentials = {
  accessToken: string;
  /** The booking business id (e.g. `contoso@contoso.onmicrosoft.com`). */
  businessId: string;
};

const BASE = 'https://graph.microsoft.com/v1.0/';

function base(c: MicrosoftBookingsCredentials): string {
  return `solutions/bookingBusinesses/${encodeURIComponent(c.businessId)}`;
}

/** A pageToken is the full @odata.nextLink from a previous page. Anything else
 *  is refused: forwarding a hand-built `$skiptoken` returned page 1 forever,
 *  because Graph ignores unrecognized query params silently and its paging docs
 *  say a token must never be extracted and reused. (The link's host is checked
 *  by the HTTP layer, which refuses to send the token anywhere but Graph.) */
function followLink(pageToken: string): string {
  if (/^https?:\/\//i.test(pageToken)) return pageToken;
  throw new UnibookingError({
    provider: 'microsoft_bookings',
    code: 'INVALID_INPUT',
    message:
      'pageToken must be the full @odata.nextLink URL from a previous page; ' +
      'Graph paging tokens cannot be reconstructed',
  });
}

function toBooking(raw: unknown): Booking {
  const a = asRecord(raw, 'microsoft_bookings', 'appointment');
  // Graph's bookingAppointment exposes the times as `start`/`end` (each a
  // dateTimeTimeZone), NOT `startDateTime`/`endDateTime`. Reading the wrong
  // names made every read throw "missing start/end times".
  const start = graphToInstant(a.start);
  const end = graphToInstant(a.end);
  if (start === undefined || end === undefined) {
    throw new UnibookingError({
      provider: 'microsoft_bookings',
      code: 'UPSTREAM',
      message: 'appointment is missing start/end times',
    });
  }
  const cust = Array.isArray(a.customers) ? a.customers[0] : undefined;
  const customer =
    cust && (cust.emailAddress || cust.name)
      ? {
          ...(cust.emailAddress ? { email: cust.emailAddress } : {}),
          ...(cust.name ? { name: cust.name } : {}),
        }
      : undefined;
  const staffId = Array.isArray(a.staffMemberIds) ? a.staffMemberIds[0] : undefined;
  return {
    id: reqString(a.id, 'microsoft_bookings', 'appointment.id'),
    provider: 'microsoft_bookings',
    title: typeof a.serviceName === 'string' && a.serviceName ? a.serviceName : 'Appointment',
    range: { start, end },
    ...(staffId ? { staffId } : {}),
    ...(typeof a.serviceId === 'string' ? { serviceId: a.serviceId } : {}),
    ...(customer ? { customer } : {}),
    // The Graph bookingAppointment resource exposes no status/cancellation field,
    // so a returned appointment is always a live booking. (A cancelled one is
    // removed, not flagged.) Anything richer would be fabricated.
    status: 'confirmed',
    raw: a,
  };
}

function customerInfo(input: { customer?: { name?: string; email?: string; phone?: string } }) {
  const cu = input.customer;
  if (!cu) return [];
  return [
    {
      '@odata.type': '#microsoft.graph.bookingCustomerInformation',
      ...(cu.name ? { name: cu.name } : {}),
      ...(cu.email ? { emailAddress: cu.email } : {}),
      ...(cu.phone ? { phone: cu.phone } : {}),
    },
  ];
}

function toService(raw: unknown, currency: string | undefined): Service {
  const s = asRecord(raw, 'microsoft_bookings', 'service');
  const duration = minutesFromIso8601Duration(s.defaultDuration);
  const price = Number(s.defaultPrice);
  return {
    id: reqString(s.id, 'microsoft_bookings', 'service.id'),
    name: reqString(s.displayName, 'microsoft_bookings', 'service.displayName'),
    ...(typeof s.description === 'string' && s.description ? { description: s.description } : {}),
    ...(duration !== undefined ? { durationMinutes: duration } : {}),
    // `defaultPrice` is a decimal amount; Graph puts the currency on the
    // business, not the service, so it is resolved once by the caller.
    ...(Number.isFinite(price) && price > 0 && currency
      ? { price: { amount: Math.round(price * 100), currency } }
      : {}),
    // `isHiddenFromCustomers` is Graph's only off switch for a service: hidden
    // services cannot be booked from the booking page. It is what
    // setServiceActive writes, so it is what `active` reads.
    active: s.isHiddenFromCustomers !== true,
    // Graph carries the assignment on the service; undefined when omitted.
    ...(Array.isArray(s.staffMemberIds)
      ? {
          staffIds: s.staffMemberIds.filter((t: unknown): t is string => typeof t === 'string'),
        }
      : {}),
    raw: s,
  };
}

/** Whole minutes as an ISO-8601 duration, the form Graph's `defaultDuration`
 *  takes (`PT30M`, `PT1H30M`). */
function isoDuration(minutes: number): string {
  // Round first: rounding only the remainder turned 119.6 into `PT1H60M`.
  const total = Math.max(0, Math.round(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `PT${h ? `${h}H` : ''}${m || !h ? `${m}M` : ''}`;
}

/** Canonical service fields → a bookingService body. */
function serviceBody(input: {
  name?: string;
  description?: string;
  durationMinutes?: number;
  price?: { amount: number; currency: string };
}): Record<string, unknown> {
  return {
    ...(input.name !== undefined ? { displayName: input.name } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.durationMinutes !== undefined
      ? { defaultDuration: isoDuration(input.durationMinutes) }
      : {}),
    // Graph prices are decimal amounts in the BUSINESS currency; the service
    // itself carries none, so a price's currency is not sent.
    ...(input.price !== undefined
      ? { defaultPrice: input.price.amount / 100, defaultPriceType: 'fixedPrice' }
      : {}),
  };
}

/** A bookingCustomer -> a canonical client record. */
function toCustomerRecord(raw: unknown): CustomerRecord {
  const r = asRecord(raw, 'microsoft_bookings', 'bookingCustomer');
  const phone = Array.isArray(r.phones)
    ? r.phones.find((p: any) => typeof p?.number === 'string' && p.number)?.number
    : undefined;
  return {
    id: reqString(r.id, 'microsoft_bookings', 'customer.id'),
    ...(typeof r.displayName === 'string' && r.displayName ? { name: r.displayName } : {}),
    ...(typeof r.emailAddress === 'string' && r.emailAddress ? { email: r.emailAddress } : {}),
    ...(phone ? { phone } : {}),
    ...(typeof r.createdDateTime === 'string' ? { createdAt: r.createdDateTime } : {}),
    ...(typeof r.lastUpdatedDateTime === 'string' ? { updatedAt: r.lastUpdatedDateTime } : {}),
    raw: r,
  };
}

/** Canonical client fields -> a bookingCustomer body. Graph has no note field
 *  on a customer, so `note` has nowhere to go. */
function customerBody(input: { name?: string; email?: string; phone?: string }) {
  return {
    ...(input.name !== undefined ? { displayName: input.name } : {}),
    ...(input.email !== undefined ? { emailAddress: input.email } : {}),
    ...(input.phone !== undefined ? { phones: [{ number: input.phone, type: 'mobile' }] } : {}),
  };
}

function toStaff(raw: unknown): Staff {
  const s = asRecord(raw, 'microsoft_bookings', 'staffMember');
  return {
    id: reqString(s.id, 'microsoft_bookings', 'staffMember.id'),
    name: reqString(s.displayName, 'microsoft_bookings', 'staffMember.displayName'),
    ...(s.emailAddress ? { email: String(s.emailAddress) } : {}),
    // `isEmailNotificationEnabled` and `role` exist, but neither means
    // "deactivated": Graph deletes staff rather than disabling them.
    active: true,
    raw: s,
  };
}

export const microsoftBookings = defineAdapter<MicrosoftBookingsCredentials>({
  id: 'microsoft_bookings',
  capabilities: {
    availability: true,
    staff: true,
    services: true,
    webhooks: false,
    idempotency: false,
    customers: true,
    customerDirectory: true,
    customerWrite: true,
    customerDelete: true,
    serviceCatalog: true,
    staffDirectory: true,
    serviceCatalogWrite: true,
    staffDirectoryWrite: true,
    staffDeactivate: false,
    staffDelete: true,
    serviceDelete: true,
    calendarList: false,
    calendarWrite: false,
    staffServiceAssignment: true,
    staffServiceAssignmentWrite: true,
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
  auth: (c) => ({ headers: { authorization: `Bearer ${c.accessToken}` } }),
  requestIdHeader: 'request-id',
  parseError: parseGraphError,
  build: (http) => {
    /** Graph puts the currency on the business, not the service. Best effort:
     *  an unavailable currency simply omits the price. */
    const businessCurrency = async (c: MicrosoftBookingsCredentials) => {
      const business = await http.request(c, { path: base(c) }).catch(() => undefined);
      return typeof business?.defaultCurrencyIso === 'string'
        ? business.defaultCurrencyIso
        : undefined;
    };
    /** PATCH a service (Graph answers 204), then re-read it. */
    const patchService = async (id: string, body: Record<string, unknown>) => {
      const c = await http.resolve();
      const path = `${base(c)}/services/${encodeURIComponent(id)}`;
      if (Object.keys(body).length > 0) {
        await http.request(c, {
          method: 'PATCH',
          path,
          body: { '@odata.type': '#microsoft.graph.bookingService', ...body },
          parse: 'none',
        });
      }
      const [res, currency] = await Promise.all([http.request(c, { path }), businessCurrency(c)]);
      return toService(res, currency);
    };
    /** One page of a collection. The pageToken handed out is the full
     *  @odata.nextLink, so it is followed verbatim: sending it back as
     *  `$skiptoken` made Graph ignore it and return page 1 forever, so a
     *  token that is not such a link is refused rather than looped on. */
    const listPage = (
      c: MicrosoftBookingsCredentials,
      collection: string,
      query: { limit?: number; pageToken?: string } | undefined,
    ) =>
      query?.pageToken
        ? http.request(c, { path: followLink(query.pageToken) })
        : http.request(c, {
            path: `${base(c)}/${collection}`,
            query: { ...(query?.limit !== undefined ? { $top: query.limit } : {}) },
          });
    const currentStaffIds = async (serviceId: string): Promise<string[]> => {
      const c = await http.resolve();
      const res = await http.request(c, {
        path: `${base(c)}/services/${encodeURIComponent(serviceId)}`,
      });
      return Array.isArray(res?.staffMemberIds)
        ? res.staffMemberIds.filter((t: unknown): t is string => typeof t === 'string')
        : [];
    };

    return {
      async checkConnection() {
        const c = await http.resolve();
        return probeConnection('microsoft_bookings', async () => {
          const res = await http.request(c, { path: base(c) });
          return {
            account: {
              ...(res?.id ? { id: String(res.id) } : {}),
              ...(res?.displayName ? { name: String(res.displayName) } : {}),
              ...(res?.email ? { email: String(res.email) } : {}),
            },
            raw: res,
          };
        });
      },
      async createBooking(input) {
        assertValidRange(input.range, 'microsoft_bookings');
        const c = await http.resolve();
        const res = await http.request(c, {
          method: 'POST',
          path: `${base(c)}/appointments`,
          headers: PREFER_UTC,
          body: {
            '@odata.type': '#microsoft.graph.bookingAppointment',
            start: graphDateTime(input.range.start),
            end: graphDateTime(input.range.end),
            // serviceName is optional (computed from the service when omitted),
            // but the caller's title is the closest canonical fit: don't drop it.
            ...(input.title ? { serviceName: input.title } : {}),
            ...(input.serviceId ? { serviceId: input.serviceId } : {}),
            ...(input.staffId ? { staffMemberIds: [input.staffId] } : {}),
            customers: customerInfo(input),
            ...input.providerOptions,
          },
        });
        return toBooking(res);
      },

      async getBooking(id) {
        const c = await http.resolve();
        const res = await http.request(c, {
          path: `${base(c)}/appointments/${encodeURIComponent(id)}`,
          headers: PREFER_UTC,
        });
        return toBooking(res);
      },

      async updateBooking(id, input) {
        if (input.range) assertValidRange(input.range, 'microsoft_bookings');
        // bookingAppointment has no writable status; silently PATCHing nothing and
        // returning a live booking would report a status change as "done" when it
        // wasn't, for a cancel, and just as much for `confirmed` or `no_show`.
        if (input.status !== undefined) {
          throw new UnibookingError({
            provider: 'microsoft_bookings',
            code: 'INVALID_INPUT',
            message:
              input.status === 'cancelled'
                ? 'Bookings has no writable status; use cancelBooking() to cancel'
                : `Bookings has no writable status (cannot set "${input.status}")`,
          });
        }
        const c = await http.resolve();
        const path = `${base(c)}/appointments/${encodeURIComponent(id)}`;
        // Graph's appointment PATCH returns 204 No Content, so there is no body to
        // map: issue the update, then re-GET to return the current appointment.
        await http.request(c, {
          method: 'PATCH',
          path,
          headers: PREFER_UTC,
          body: {
            // Graph's documented appointment PATCH examples all carry the type
            // annotation (as create does); omitting it is known to fail requests.
            '@odata.type': '#microsoft.graph.bookingAppointment',
            ...(input.range
              ? { start: graphDateTime(input.range.start), end: graphDateTime(input.range.end) }
              : {}),
            ...(input.title ? { serviceName: input.title } : {}),
            ...(input.staffId ? { staffMemberIds: [input.staffId] } : {}),
            ...(input.serviceId ? { serviceId: input.serviceId } : {}),
            ...input.providerOptions,
          },
          parse: 'none',
        });
        const res = await http.request(c, { path, headers: PREFER_UTC });
        return toBooking(res);
      },

      async cancelBooking(id, options) {
        const c = await http.resolve();
        await http.request(c, {
          method: 'POST',
          path: `${base(c)}/appointments/${encodeURIComponent(id)}/cancel`,
          body: { cancellationMessage: options?.reason ?? 'Cancelled' },
          parse: 'none',
        });
      },

      async listBookings(query) {
        assertValidRange(query.range, 'microsoft_bookings');
        const c = await http.resolve();
        // A pageToken is the full @odata.nextLink; follow it verbatim so any Graph
        // paging param ($skiptoken or $skip) is preserved.
        const follow = query.pageToken !== undefined ? followLink(query.pageToken) : undefined;
        const res = follow
          ? await http.request(c, { path: follow, headers: PREFER_UTC })
          : await http.request(c, {
              path: `${base(c)}/calendarView`,
              headers: PREFER_UTC,
              query: {
                start: query.range.start,
                end: query.range.end,
                $top: query.limit ?? 50,
              },
            });
        const bookings = asArray(res?.value, 'microsoft_bookings', 'calendarView.value').map(
          toBooking,
        );
        const next = nextLinkFrom(res);
        return { bookings, ...(next !== undefined ? { nextPageToken: next } : {}) };
      },

      async searchAvailability(query): Promise<AvailabilitySlot[]> {
        assertValidRange(query.range, 'microsoft_bookings');
        const c = await http.resolve();
        let staffIds: string[];
        if (query.staffId) {
          staffIds = [query.staffId];
        } else {
          // Enumerate all staff, following @odata.nextLink so businesses with more
          // than one page of staff members aren't silently truncated.
          staffIds = [];
          let page = await http.request(c, {
            path: `${base(c)}/staffMembers`,
            query: { $top: 200 },
          });
          // Bounded like `listAll`, so a misbehaving nextLink can't loop forever.
          for (let i = 0; i < 50; i++) {
            for (const s of asArray(page?.value, 'microsoft_bookings', 'staffMembers.value')) {
              if (typeof s?.id === 'string') staffIds.push(s.id);
            }
            const next = nextLinkFrom(page);
            if (next === undefined) break;
            page = await http.request(c, { path: next });
          }
        }
        if (staffIds.length === 0) return [];
        const res = await http.request(c, {
          method: 'POST',
          path: `${base(c)}/getStaffAvailability`,
          body: {
            staffIds,
            startDateTime: graphDateTime(query.range.start),
            endDateTime: graphDateTime(query.range.end),
          },
        });
        const out: AvailabilitySlot[] = [];
        // The documented response wraps the collection as `staffAvailabilityItem`
        // (not the usual OData `value`); read both defensively.
        const entries = (res as any)?.staffAvailabilityItem ?? (res as any)?.value;
        for (const entry of asArray(entries, 'microsoft_bookings', 'staffAvailability')) {
          const e = asRecord(entry, 'microsoft_bookings', 'staffAvailabilityItem');
          const staffId = typeof e.staffId === 'string' ? e.staffId : undefined;
          for (const item of asArray(
            e.availabilityItems ?? [],
            'microsoft_bookings',
            'availabilityItems',
          )) {
            const slot = asRecord(item, 'microsoft_bookings', 'availabilityItem');
            // `available` windows are bookable; so are `slotsAvailable` ones (1:n
            // group services with remaining capacity). busy/out-of-office are not.
            const status = String(slot.status).toLowerCase();
            if (status !== 'available' && status !== 'slotsavailable') continue;
            const start = graphToInstant(slot.startDateTime);
            const end = graphToInstant(slot.endDateTime);
            if (start === undefined || end === undefined) continue;
            out.push({ start, end, ...(staffId ? { staffId } : {}), raw: slot });
          }
        }
        return out;
      },

      async listServices(query) {
        const c = await http.resolve();
        // Graph puts the currency on the business, not the service. One extra
        // request for the whole list, never one per service. A failure here must
        // not sink the whole call, so an unavailable currency simply omits price.
        const [res, business] = await Promise.all([
          listPage(c, 'services', query),
          http.request(c, { path: base(c) }).catch(() => undefined),
        ]);
        const currency =
          typeof business?.defaultCurrencyIso === 'string'
            ? business.defaultCurrencyIso
            : undefined;
        let services = asArray(res?.value, 'microsoft_bookings', 'services').map((s) =>
          toService(s, currency),
        );
        if (query?.staffId) {
          const want = query.staffId;
          services = services.filter((sv) => sv.staffIds?.includes(want) ?? false);
        }
        const next = nextLinkFrom(res);
        return { services, ...(next ? { nextPageToken: next } : {}) };
      },

      async listStaff(query) {
        const c = await http.resolve();
        const res = await listPage(c, 'staffMembers', query);
        let staff = asArray(res?.value, 'microsoft_bookings', 'staffMembers').map(toStaff);
        if (query?.serviceId) {
          // The link lives on the service, so "who performs it" reads from there.
          const ids = await currentStaffIds(query.serviceId);
          staff = staff.filter((m) => ids.includes(m.id));
        }
        const next = nextLinkFrom(res);
        return { staff, ...(next ? { nextPageToken: next } : {}) };
      },

      async getService(id) {
        const c = await http.resolve();
        const [res, currency] = await Promise.all([
          http.request(c, { path: `${base(c)}/services/${encodeURIComponent(id)}` }),
          businessCurrency(c),
        ]);
        return toService(res, currency);
      },

      async getStaff(id) {
        const c = await http.resolve();
        const res = await http.request(c, {
          path: `${base(c)}/staffMembers/${encodeURIComponent(id)}`,
        });
        return toStaff(res);
      },

      async createService(input) {
        const c = await http.resolve();
        const res = await http.request(c, {
          method: 'POST',
          path: `${base(c)}/services`,
          body: {
            '@odata.type': '#microsoft.graph.bookingService',
            ...serviceBody(input),
            ...input.providerOptions,
          },
        });
        return toService(res, await businessCurrency(c));
      },

      async updateService(id, input) {
        return patchService(id, { ...serviceBody(input), ...input.providerOptions });
      },

      async setServiceActive(id, active) {
        return patchService(id, { isHiddenFromCustomers: !active });
      },

      async deleteService(id) {
        const c = await http.resolve();
        await http.request(c, {
          method: 'DELETE',
          path: `${base(c)}/services/${encodeURIComponent(id)}`,
          parse: 'none',
        });
      },

      async assignStaffToService(serviceId, staffId) {
        const current = await currentStaffIds(serviceId);
        if (current.includes(staffId)) return patchService(serviceId, {});
        return patchService(serviceId, { staffMemberIds: [...current, staffId] });
      },

      async unassignStaffFromService(serviceId, staffId) {
        const current = await currentStaffIds(serviceId);
        return patchService(serviceId, { staffMemberIds: current.filter((t) => t !== staffId) });
      },

      async createStaff(input) {
        // Graph requires an email and a role for every staff member. There is no
        // phone field on bookingStaffMember, so `phone` has nowhere to go.
        if (!input.email) {
          throw new UnibookingError({
            provider: 'microsoft_bookings',
            code: 'INVALID_INPUT',
            message: 'Microsoft Bookings createStaff requires an email',
          });
        }
        const c = await http.resolve();
        const res = await http.request(c, {
          method: 'POST',
          path: `${base(c)}/staffMembers`,
          body: {
            '@odata.type': '#microsoft.graph.bookingStaffMember',
            displayName: input.name,
            emailAddress: input.email,
            // `externalGuest` needs no Microsoft 365 account; pass
            // providerOptions.role for an existing member of the tenant.
            role: 'externalGuest',
            ...input.providerOptions,
          },
        });
        return toStaff(res);
      },

      async updateStaff(id, input) {
        const c = await http.resolve();
        const path = `${base(c)}/staffMembers/${encodeURIComponent(id)}`;
        await http.request(c, {
          method: 'PATCH',
          path,
          body: {
            '@odata.type': '#microsoft.graph.bookingStaffMember',
            ...(input.name !== undefined ? { displayName: input.name } : {}),
            ...(input.email !== undefined ? { emailAddress: input.email } : {}),
            ...input.providerOptions,
          },
          parse: 'none',
        });
        return toStaff(await http.request(c, { path }));
      },

      async deleteStaff(id) {
        const c = await http.resolve();
        await http.request(c, {
          method: 'DELETE',
          path: `${base(c)}/staffMembers/${encodeURIComponent(id)}`,
          parse: 'none',
        });
      },

      customers: {
        // Graph has no email/phone query on bookingCustomer, so those filters
        // apply to each page after it is read (documented on the query type).
        list: async (query) => {
          const c = await http.resolve();
          const res = await listPage(c, 'customers', query);
          let customers = asArray(res?.value, 'microsoft_bookings', 'customers').map(
            toCustomerRecord,
          );
          if (query?.email) {
            const want = query.email.toLowerCase();
            customers = customers.filter((x) => x.email?.toLowerCase() === want);
          }
          if (query?.phone) customers = customers.filter((x) => x.phone === query.phone);
          const next = nextLinkFrom(res);
          return { customers, ...(next ? { nextPageToken: next } : {}) };
        },

        get: async (id) => {
          const c = await http.resolve();
          const res = await http.request(c, {
            path: `${base(c)}/customers/${encodeURIComponent(id)}`,
          });
          return toCustomerRecord(res);
        },

        create: async (input) => {
          const displayName = input.name?.trim() || input.email || input.phone;
          if (!displayName) {
            throw new UnibookingError({
              provider: 'microsoft_bookings',
              code: 'INVALID_INPUT',
              message: 'A customer needs at least a name, email or phone',
            });
          }
          const c = await http.resolve();
          const res = await http.request(c, {
            method: 'POST',
            path: `${base(c)}/customers`,
            body: {
              '@odata.type': '#microsoft.graph.bookingCustomer',
              ...customerBody({ ...input, name: displayName }),
              ...input.providerOptions,
            },
          });
          return toCustomerRecord(res);
        },

        // PATCH answers 204, so re-read, as updateStaff does.
        update: async (id, input) => {
          const c = await http.resolve();
          const path = `${base(c)}/customers/${encodeURIComponent(id)}`;
          await http.request(c, {
            method: 'PATCH',
            path,
            body: {
              '@odata.type': '#microsoft.graph.bookingCustomer',
              ...customerBody(input),
              ...input.providerOptions,
            },
            parse: 'none',
          });
          return toCustomerRecord(await http.request(c, { path }));
        },

        delete: async (id) => {
          const c = await http.resolve();
          await http.request(c, {
            method: 'DELETE',
            path: `${base(c)}/customers/${encodeURIComponent(id)}`,
            parse: 'none',
          });
        },

        findOrCreate: async (customer) => {
          if (customer.id) return customer.id;
          const c = await http.resolve();
          const email = customer.email;
          if (email) {
            // Match an existing bookingCustomer by email, following @odata.nextLink
            // so a business with many customers still resolves. Bounded like the
            // other paged reads here, so a misbehaving nextLink can't loop forever.
            const wanted = email.toLowerCase();
            let page = await http.request(c, {
              path: `${base(c)}/customers`,
              query: { $top: 200 },
            });
            for (let i = 0; i < 50; i++) {
              for (const cust of asArray(page?.value, 'microsoft_bookings', 'customers.value')) {
                if (
                  typeof cust?.emailAddress === 'string' &&
                  cust.emailAddress.toLowerCase() === wanted
                ) {
                  return reqString(cust.id, 'microsoft_bookings', 'customer.id');
                }
              }
              const next = nextLinkFrom(page);
              if (next === undefined) break;
              page = await http.request(c, { path: next });
            }
          }
          const created = await http.request(c, {
            method: 'POST',
            path: `${base(c)}/customers`,
            body: {
              '@odata.type': '#microsoft.graph.bookingCustomer',
              displayName: customer.name ?? customer.email ?? 'Guest',
              ...(customer.email ? { emailAddress: customer.email } : {}),
            },
          });
          return reqString(created?.id, 'microsoft_bookings', 'customer.id');
        },
      },
    };
  },
});

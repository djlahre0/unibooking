import {
  assertValidRange,
  endFromDuration,
  instantToZoned,
  zonedToInstant,
  UnibookingError,
  type AvailabilitySlot,
  type Booking,
  type BookingClient,
  type Capabilities,
  type CustomerRecord,
  type ErrorCode,
  type Service,
  type Staff,
} from 'unibooking';
import { loadSample, saveSample } from './store';
import { takeArmedFailure } from './failure';
import { SAMPLE_ID, type SampleCustomer, type SampleData } from './types';
import { shiftDate } from '../calendar/agenda';
import { BUSINESS_HOURS, addClockMinutes, weekdayOf } from './seed';

export interface SampleClientOptions {
  /** Injected in tests; defaults to localStorage. */
  storage?: Storage;
  /** Visible loading states in the UI; tests pass 0. */
  latencyMs?: number;
}

/** Honest flags. `webhooks` is false because no verifier exists for this
 *  provider, and `calendarList` is false because a booking platform has one
 *  schedule -- so `listCalendars` is absent, matching the flag. */
export const CAPABILITIES: Capabilities = {
  availability: true,
  staff: true,
  services: true,
  webhooks: false,
  idempotency: true,
  customers: true,
  customerDirectory: true,
  customerWrite: true,
  customerDelete: true,
  serviceCatalog: true,
  staffDirectory: true,
  serviceCatalogWrite: true,
  staffDirectoryWrite: true,
  // A local store can do all of it, so the sample shows every staff/service
  // operation without an account: retire or delete, and who performs what.
  staffDeactivate: true,
  staffDelete: true,
  serviceDelete: true,
  calendarList: false,
  calendarWrite: false,
  // The sample dataset models one-to-one appointments only; adding a fake class
  // catalog here would let the demo show a capability no real adapter in this
  // list has, which is exactly the drift the capability flags exist to prevent.
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
};

const fail = (code: ErrorCode, message: string) =>
  new UnibookingError({ code, message, provider: SAMPLE_ID });

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/** A stored sample customer as the library's client record. */
function asRecord(c: SampleCustomer): CustomerRecord {
  return { ...c, raw: { source: 'sample' } };
}

export function sampleClient(options: SampleClientOptions = {}): BookingClient {
  const { storage, latencyMs = 150 } = options;
  const read = (): SampleData => loadSample(storage);
  const write = (data: SampleData) => saveSample(data, storage);

  /** Every op passes through here: latency first, then the one-shot failure. */
  async function begin(): Promise<void> {
    await sleep(latencyMs);
    const armed = takeArmedFailure();
    if (armed) {
      throw new UnibookingError({
        code: armed,
        message: `Injected ${armed} from the sample provider's failure switch.`,
        provider: SAMPLE_ID,
      });
    }
  }

  /** The library's own validator: it throws INVALID_INPUT for an unparseable
   *  endpoint, for `end <= start`, and for an offset-less string, which the
   *  canonical contract forbids. Reusing it is what keeps this provider's
   *  validation identical to every real adapter's. */
  const assertRange = (range: Parameters<typeof assertValidRange>[0]) =>
    assertValidRange(range, SAMPLE_ID);

  function find(data: SampleData, id: string): Booking {
    const booking = data.bookings.find((b) => b.id === id);
    if (!booking) throw fail('NOT_FOUND', `No booking with id "${id}".`);
    return booking;
  }

  function assertRefs(data: SampleData, staffId?: string, serviceId?: string): void {
    if (staffId && !data.staff.some((s) => s.id === staffId)) {
      throw fail('NOT_FOUND', `No staff member with id "${staffId}".`);
    }
    if (serviceId && !data.services.some((s) => s.id === serviceId)) {
      throw fail('NOT_FOUND', `No service with id "${serviceId}".`);
    }
  }

  function assertFree(data: SampleData, range: Booking['range'], staffId?: string, skip?: string) {
    if (!staffId) return;
    const start = Date.parse(range.start);
    const end = Date.parse(range.end);
    const clash = data.bookings.find(
      (b) =>
        b.id !== skip &&
        b.staffId === staffId &&
        b.status !== 'cancelled' &&
        Date.parse(b.range.start) < end &&
        start < Date.parse(b.range.end),
    );
    if (clash) {
      throw fail('CONFLICT', `That staff member already has a booking at ${clash.range.start}.`);
    }
  }

  /** Opaque to callers, exactly like a real provider's cursor. btoa/atob exist in
   *  both the browser and Node 18+, so this works in the app and in the tests. */
  function encodeCursor(index: number): string {
    return btoa(`sample:${index}`);
  }

  function decodeCursor(token: string | undefined, failWith: (m: string) => Error): number {
    if (!token) return 0;
    try {
      const decoded = atob(token);
      const [prefix, index] = decoded.split(':');
      // Number('') is 0 and looks like a valid integer, so an index that
      // isn't all digits (including the empty string from a token this
      // provider never issued, e.g. btoa('sample:')) must be rejected
      // explicitly rather than silently accepted as page 0.
      if (prefix !== 'sample' || !index || !/^\d+$/.test(index)) throw new Error('bad cursor');
      return Number(index);
    } catch {
      throw failWith(`"${token}" is not a page token this provider issued.`);
    }
  }

  /** Shared by bookings, services and staff so the three page identically. */
  function page<T>(
    items: T[],
    limit: number | undefined,
    token: string | undefined,
    failWith: (m: string) => Error,
  ) {
    const from = decodeCursor(token, failWith);
    // Matches capPage's contract (src/adapter-kit.ts): only undefined/negative
    // means "no cap". `limit: 0` is a real limit yielding an empty page, not a
    // falsy no-op -- the sample provider must not diverge from real adapters.
    const size = limit === undefined || limit < 0 ? items.length : limit;
    const slice = items.slice(from, from + size);
    // size === 0 can never advance `from`, so a token pointing back at the same
    // offset would let a naive caller loop forever; only emit one when the
    // page actually made progress.
    const next = size > 0 && from + size < items.length ? encodeCursor(from + size) : undefined;
    return { slice, ...(next ? { nextPageToken: next } : {}) };
  }

  return {
    id: SAMPLE_ID,
    capabilities: CAPABILITIES,

    async createBooking(input) {
      // Validate everything before the dataset is touched.
      if (!input.title?.trim()) throw fail('INVALID_INPUT', 'title is required.');
      assertRange(input.range);
      await begin();
      const data = read();
      assertRefs(data, input.staffId, input.serviceId);

      if (input.idempotencyKey) {
        const seen = data.bookings.find(
          (b) => (b.raw as { idempotencyKey?: string })?.idempotencyKey === input.idempotencyKey,
        );
        if (seen) return seen;
      }
      assertFree(data, input.range, input.staffId);

      const now = new Date().toISOString();
      const booking: Booking = {
        id: `bkg_${data.nextId}`,
        provider: SAMPLE_ID,
        title: input.title,
        range: input.range,
        status: 'confirmed',
        createdAt: now,
        updatedAt: now,
        ...(input.customer ? { customer: input.customer } : {}),
        ...(input.staffId ? { staffId: input.staffId } : {}),
        ...(input.serviceId ? { serviceId: input.serviceId } : {}),
        ...(input.description ? { description: input.description } : {}),
        ...(input.location ? { location: input.location } : {}),
        raw: {
          source: 'sample',
          seeded: false,
          internalId: data.nextId,
          ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        },
      };
      data.bookings.push(booking);
      data.nextId += 1;
      write(data);
      return booking;
    },

    async getBooking(id) {
      await begin();
      return find(read(), id);
    },

    async updateBooking(id, input) {
      if (input.range) assertRange(input.range);
      await begin();
      const data = read();
      const booking = find(data, id);
      assertRefs(data, input.staffId, input.serviceId);
      // Only re-check availability when the schedule actually changed. A
      // title/description-only patch supplies neither field, so `range` and
      // `staffId` here would just equal what's already stored -- and
      // re-validating a schedule nothing is moving can only ever fail
      // against pre-existing (possibly overlapping, e.g. seeded) data; it
      // never protects anything, since nothing about the booking's time or
      // staff assignment is actually being changed.
      const rangeChanged =
        input.range !== undefined &&
        (input.range.start !== booking.range.start || input.range.end !== booking.range.end);
      const staffChanged = input.staffId !== undefined && input.staffId !== booking.staffId;
      if (rangeChanged || staffChanged) {
        assertFree(data, input.range ?? booking.range, input.staffId ?? booking.staffId, id);
      }

      Object.assign(booking, {
        ...(input.title ? { title: input.title } : {}),
        ...(input.range ? { range: input.range } : {}),
        ...(input.staffId ? { staffId: input.staffId } : {}),
        ...(input.serviceId ? { serviceId: input.serviceId } : {}),
        // Unlike title, the contract documents that an empty string clears
        // description/location (see UpdateBookingInput in src/types.ts), so a
        // truthy check would silently drop a clearing update.
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.location !== undefined ? { location: input.location } : {}),
        ...(input.status ? { status: input.status } : {}),
        updatedAt: new Date().toISOString(),
      });
      write(data);
      return booking;
    },

    async cancelBooking(id) {
      await begin();
      const data = read();
      const booking = find(data, id);
      booking.status = 'cancelled';
      booking.updatedAt = new Date().toISOString();
      write(data);
    },

    async listBookings(query) {
      assertRange(query.range);
      await begin();
      const data = read();
      const from = Date.parse(query.range.start);
      const to = Date.parse(query.range.end);
      const matching = data.bookings
        .filter((b) => Date.parse(b.range.start) < to && from < Date.parse(b.range.end))
        .filter((b) => !query.staffId || b.staffId === query.staffId)
        .filter((b) => !query.customerId || b.customer?.id === query.customerId)
        .filter((b) => !query.status || b.status === query.status)
        .sort((a, b) => Date.parse(a.range.start) - Date.parse(b.range.start));
      const { slice, nextPageToken } = page(matching, query.limit, query.pageToken, (m) =>
        fail('INVALID_INPUT', m),
      );
      return { bookings: slice, ...(nextPageToken ? { nextPageToken } : {}) };
    },

    async searchAvailability(query) {
      assertRange(query.range);
      await begin();
      const data = read();
      if (query.serviceId) assertRefs(data, undefined, query.serviceId);
      if (query.staffId) assertRefs(data, query.staffId, undefined);

      const service = data.services.find((s) => s.id === query.serviceId);
      const duration = query.durationMinutes ?? service?.durationMinutes ?? 30;
      const candidates = query.staffId
        ? data.staff.filter((s) => s.id === query.staffId)
        : data.staff.filter((s) => s.active);

      const from = Date.parse(query.range.start);
      const to = Date.parse(query.range.end);
      const tz = data.timezone;
      const slots: AvailabilitySlot[] = [];

      // Walk calendar days in the dataset's zone, not UTC, so "Monday" means
      // Monday where the business trades.
      let day = instantToZoned(query.range.start, tz).date;
      const lastDay = instantToZoned(query.range.end, tz).date;
      let guard = 0;
      while (day <= lastDay && guard < 400) {
        const hours = BUSINESS_HOURS[weekdayOf(day)];
        if (hours) {
          for (
            let time = hours.open;
            addClockMinutes(time, duration) <= hours.close;
            time = addClockMinutes(time, 15)
          ) {
            const start = zonedToInstant(`${day}T${time}`, tz);
            const end = endFromDuration(start, duration);
            const startMs = Date.parse(start);
            const endMs = Date.parse(end);
            if (startMs < from || endMs > to) continue;

            const free = candidates.find(
              (member) =>
                !data.bookings.some(
                  (b) =>
                    b.staffId === member.id &&
                    b.status !== 'cancelled' &&
                    Date.parse(b.range.start) < endMs &&
                    startMs < Date.parse(b.range.end),
                ),
            );
            if (free) {
              slots.push({ start, end, staffId: free.id, raw: { source: 'sample' } });
            }
          }
        }
        day = shiftDate(day, 1);
        guard += 1;
      }
      return slots;
    },

    async checkConnection() {
      await sleep(latencyMs);
      const armed = takeArmedFailure();
      if (armed === 'AUTH' || armed === 'FORBIDDEN' || armed === 'NOT_FOUND') {
        return {
          ok: false,
          reason: armed,
          message: 'Injected by the sample failure switch.',
          raw: { source: 'sample' },
        };
      }
      if (armed) {
        // A blip or a 5xx is a fault, not a dead integration -- throw, so a
        // transient failure is never mistaken for a revoked credential.
        throw fail(armed, `Injected ${armed} from the sample provider's failure switch.`);
      }
      const data = read();
      return {
        ok: true,
        account: { id: 'sample-business', name: 'Sample Salon' },
        message: `${data.bookings.length} sample bookings in ${data.timezone}.`,
        raw: { source: 'sample' },
      };
    },

    async listServices(query) {
      await begin();
      const data = read();
      const want = query?.staffId;
      const services = want
        ? data.services.filter((sv) => sv.staffIds?.includes(want) ?? false)
        : data.services;
      const { slice, nextPageToken } = page(services, query?.limit, query?.pageToken, (m) =>
        fail('INVALID_INPUT', m),
      );
      return { services: slice, ...(nextPageToken ? { nextPageToken } : {}) };
    },

    async listStaff(query) {
      await begin();
      const data = read();
      let staff = data.staff;
      if (query?.serviceId) {
        const sv = data.services.find((x) => x.id === query.serviceId);
        if (!sv) throw fail('NOT_FOUND', `No service with id "${query.serviceId}".`);
        staff = staff.filter((m) => sv.staffIds?.includes(m.id) ?? false);
      }
      const { slice, nextPageToken } = page(staff, query?.limit, query?.pageToken, (m) =>
        fail('INVALID_INPUT', m),
      );
      return { staff: slice, ...(nextPageToken ? { nextPageToken } : {}) };
    },

    async createService(input) {
      if (!input.name?.trim()) throw fail('INVALID_INPUT', 'name is required.');
      await begin();
      const data = read();
      const service: Service = {
        id: `svc_${data.nextId}`,
        name: input.name,
        active: true,
        ...(input.description ? { description: input.description } : {}),
        ...(input.durationMinutes ? { durationMinutes: input.durationMinutes } : {}),
        ...(input.price ? { price: input.price } : {}),
        raw: { source: 'sample', seeded: false },
      };
      data.services.push(service);
      data.nextId += 1;
      write(data);
      return service;
    },

    async updateService(id, input) {
      // Real adapters can leave this to the provider -- Square rejects an
      // empty item name with a 400 that maps to INVALID_INPUT -- but this
      // client has no provider behind it, so it must validate for itself.
      if (input.name !== undefined && !input.name.trim()) {
        throw fail('INVALID_INPUT', 'name cannot be empty.');
      }
      await begin();
      const data = read();
      const service = data.services.find((s) => s.id === id);
      if (!service) throw fail('NOT_FOUND', `No service with id "${id}".`);
      // !== undefined, not truthy: an explicit '' or 0 must actually apply
      // rather than silently no-op, matching updateBooking's rule for
      // description/location and square.ts's own updateService.
      Object.assign(service, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.durationMinutes !== undefined ? { durationMinutes: input.durationMinutes } : {}),
        ...(input.price !== undefined ? { price: input.price } : {}),
        // Status in the same call, as defineAdapter gives every real adapter.
        ...(input.active !== undefined ? { active: input.active } : {}),
      });
      write(data);
      return service;
    },

    async setServiceActive(id, active) {
      await begin();
      const data = read();
      const service = data.services.find((s) => s.id === id);
      if (!service) throw fail('NOT_FOUND', `No service with id "${id}".`);
      service.active = active;
      write(data);
      return service;
    },

    async createStaff(input) {
      if (!input.name?.trim()) throw fail('INVALID_INPUT', 'name is required.');
      await begin();
      const data = read();
      const member: Staff = {
        id: `stf_${data.nextId}`,
        name: input.name,
        active: true,
        ...(input.email ? { email: input.email } : {}),
        ...(input.phone ? { phone: input.phone } : {}),
        raw: { source: 'sample', seeded: false },
      };
      data.staff.push(member);
      data.nextId += 1;
      write(data);
      return member;
    },

    async updateStaff(id, input) {
      // Same reasoning as updateService: the real adapters can rely on the
      // provider to reject a blank name, but there is no provider here.
      if (input.name !== undefined && !input.name.trim()) {
        throw fail('INVALID_INPUT', 'name cannot be empty.');
      }
      await begin();
      const data = read();
      const member = data.staff.find((s) => s.id === id);
      if (!member) throw fail('NOT_FOUND', `No staff member with id "${id}".`);
      // Same rule as updateService: !== undefined, not truthy, so an explicit
      // '' actually clears the field instead of being dropped as falsy.
      Object.assign(member, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...(input.phone !== undefined ? { phone: input.phone } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
      });
      write(data);
      return member;
    },

    async setStaffActive(id, active) {
      await begin();
      const data = read();
      const member = data.staff.find((s) => s.id === id);
      if (!member) throw fail('NOT_FOUND', `No staff member with id "${id}".`);
      member.active = active;
      write(data);
      return member;
    },

    async getService(id) {
      await begin();
      const service = read().services.find((s) => s.id === id);
      if (!service) throw fail('NOT_FOUND', `No service with id "${id}".`);
      return service;
    },

    async getStaff(id) {
      await begin();
      const member = read().staff.find((s) => s.id === id);
      if (!member) throw fail('NOT_FOUND', `No staff member with id "${id}".`);
      return member;
    },

    async deleteService(id) {
      await begin();
      const data = read();
      const at = data.services.findIndex((s) => s.id === id);
      if (at === -1) throw fail('NOT_FOUND', `No service with id "${id}".`);
      data.services.splice(at, 1);
      write(data);
    },

    async deleteStaff(id) {
      await begin();
      const data = read();
      const at = data.staff.findIndex((s) => s.id === id);
      if (at === -1) throw fail('NOT_FOUND', `No staff member with id "${id}".`);
      data.staff.splice(at, 1);
      // A deleted member performs nothing any more.
      for (const sv of data.services) {
        if (sv.staffIds) sv.staffIds = sv.staffIds.filter((t) => t !== id);
      }
      write(data);
    },

    async assignStaffToService(serviceId, staffId) {
      await begin();
      const data = read();
      assertRefs(data, staffId, serviceId);
      const service = data.services.find((s) => s.id === serviceId)!;
      const current = service.staffIds ?? [];
      service.staffIds = current.includes(staffId) ? current : [...current, staffId];
      write(data);
      return service;
    },

    async unassignStaffFromService(serviceId, staffId) {
      await begin();
      const data = read();
      const service = data.services.find((s) => s.id === serviceId);
      if (!service) throw fail('NOT_FOUND', `No service with id "${serviceId}".`);
      service.staffIds = (service.staffIds ?? []).filter((t) => t !== staffId);
      write(data);
      return service;
    },

    customers: {
      async findOrCreate(customer) {
        if (!customer.email && !customer.phone && !customer.name) {
          throw fail('INVALID_INPUT', 'Give at least a name, email or phone to match on.');
        }
        await begin();
        const data = read();
        // Two sequential lookups, not one find() with an OR predicate: find()
        // returns the first ARRAY element satisfying either clause, so an
        // earlier phone match would win over a later email match even though
        // email is meant to take priority.
        const byEmail = customer.email
          ? data.customers.find((c) => c.email === customer.email)
          : undefined;
        const match =
          byEmail ??
          (customer.phone ? data.customers.find((c) => c.phone === customer.phone) : undefined);
        if (match) return match.id;
        const created = {
          id: `cus_${data.nextId}`,
          ...(customer.name ? { name: customer.name } : {}),
          ...(customer.email ? { email: customer.email } : {}),
          ...(customer.phone ? { phone: customer.phone } : {}),
        };
        data.customers.push(created);
        data.nextId += 1;
        write(data);
        return created.id;
      },

      async list(query) {
        await begin();
        const email = query?.email?.toLowerCase();
        const all = read().customers.filter(
          (c) =>
            (!email || c.email?.toLowerCase() === email) &&
            (!query?.phone || c.phone === query.phone),
        );
        const { slice, nextPageToken } = page(all, query?.limit, query?.pageToken, (m) =>
          fail('INVALID_INPUT', m),
        );
        return { customers: slice.map(asRecord), ...(nextPageToken ? { nextPageToken } : {}) };
      },

      async get(id) {
        await begin();
        const c = read().customers.find((x) => x.id === id);
        if (!c) throw fail('NOT_FOUND', `No customer with id "${id}".`);
        return asRecord(c);
      },

      async create(input) {
        if (!input.name?.trim() && !input.email && !input.phone) {
          throw fail('INVALID_INPUT', 'A customer needs at least a name, email or phone.');
        }
        await begin();
        const data = read();
        const created: SampleCustomer = {
          id: `cus_${data.nextId}`,
          ...(input.name ? { name: input.name.trim() } : {}),
          ...(input.email ? { email: input.email } : {}),
          ...(input.phone ? { phone: input.phone } : {}),
          ...(input.note ? { note: input.note } : {}),
        };
        data.customers.push(created);
        data.nextId += 1;
        write(data);
        return asRecord(created);
      },

      async update(id, input) {
        if (input.name !== undefined && !input.name.trim()) {
          throw fail('INVALID_INPUT', 'name cannot be empty.');
        }
        await begin();
        const data = read();
        const c = data.customers.find((x) => x.id === id);
        if (!c) throw fail('NOT_FOUND', `No customer with id "${id}".`);
        Object.assign(c, {
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.email !== undefined ? { email: input.email } : {}),
          ...(input.phone !== undefined ? { phone: input.phone } : {}),
          ...(input.note !== undefined ? { note: input.note } : {}),
        });
        write(data);
        return asRecord(c);
      },

      // Past bookings keep their customer details; only the record goes.
      async delete(id) {
        await begin();
        const data = read();
        const at = data.customers.findIndex((x) => x.id === id);
        if (at === -1) throw fail('NOT_FOUND', `No customer with id "${id}".`);
        data.customers.splice(at, 1);
        write(data);
      },
    },
  };
}

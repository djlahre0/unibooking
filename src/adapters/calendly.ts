import type { AvailabilitySlot, Booking, BookingStatus, Customer } from '../types';
import { asArray, asRecord, defineAdapter, reqString, unsupported } from '../adapter-kit';
import type { HttpContext } from '../http';
import { UnibookingError } from '../errors';
import { assertValidRange, endFromDuration, isInstant } from '../time';

/**
 * Calendly (API v2). Read/list/cancel have been stable; programmatic booking
 * arrived with the Scheduling API "Create Event Invitee" (Oct 2025), so
 * `createBooking` requires a paid Calendly plan.
 *
 * Calendly has NO reschedule endpoint, so `updateBooking` with a new range does
 * cancel-then-rebook (read the event's type + invitee, book the new time, cancel
 * the old) — the same re-book strategy `zenoti` uses.
 *
 * Auth: bring your own bearer (Personal Access Token or OAuth). `user` (or
 * `organization`) scopes `listBookings`; when omitted it is discovered via
 * `GET /users/me`.
 *
 * NOTE: the Scheduling API create shape is docs-derived; `CREATE_PATH` and the
 * response mapping are marked `TODO: verify against live API`.
 */
export type CalendlyCredentials = {
  token: string;
  /** Calendly user URI, used to scope `listBookings`. */
  user?: string;
  /** Calendly organization URI (alternative scope for `listBookings`). */
  organization?: string;
};

const BASE = 'https://api.calendly.com/';
// TODO: verify against live API — exact Scheduling API create endpoint.
const CREATE_PATH = 'scheduling/event_invitees';

function enc(id: string): string {
  return encodeURIComponent(id);
}

/** Calendly ids are the final path segment of a resource URI. Accept a bare id too. */
function uuidFromUri(uriOrId: string): string {
  const trimmed = uriOrId.replace(/\/+$/, '');
  const seg = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  return seg || uriOrId;
}

function mapStatus(s: unknown): BookingStatus {
  switch (String(s).toLowerCase()) {
    case 'active':
      return 'confirmed';
    case 'canceled':
    case 'cancelled':
      return 'cancelled';
    default:
      return 'unknown';
  }
}

function requireService(serviceId: string | undefined): string {
  if (!serviceId) {
    throw new UnibookingError({
      provider: 'calendly',
      code: 'INVALID_INPUT',
      message: 'Calendly requires a serviceId (the event_type URI) to book or search availability',
    });
  }
  return serviceId;
}

function toBookingFromEvent(raw: unknown): Booking {
  const ev = asRecord(raw, 'calendly', 'scheduled_event');
  const start = ev.start_time;
  const end = ev.end_time;
  if (typeof start !== 'string' || typeof end !== 'string') {
    throw new UnibookingError({
      provider: 'calendly',
      code: 'UPSTREAM',
      message: 'scheduled event is missing start_time/end_time',
    });
  }
  const uri = reqString(String(ev.uri ?? ''), 'calendly', 'scheduled_event.uri');
  return {
    id: uuidFromUri(uri),
    provider: 'calendly',
    title: typeof ev.name === 'string' && ev.name ? ev.name : 'Meeting',
    range: { start, end },
    ...(ev.event_type ? { serviceId: String(ev.event_type) } : {}),
    status: mapStatus(ev.status),
    ...(typeof ev.created_at === 'string' ? { createdAt: ev.created_at } : {}),
    ...(typeof ev.updated_at === 'string' ? { updatedAt: ev.updated_at } : {}),
    raw: ev,
  };
}

function parseCalendlyError(_status: number, body: unknown): { providerCode?: string; message?: string } {
  const b = body as any;
  const message = b?.message ?? b?.title;
  return {
    ...(typeof message === 'string' ? { message } : {}),
    ...(b?.title ? { providerCode: String(b.title) } : {}),
  };
}

async function getEvent(
  http: HttpContext<CalendlyCredentials>,
  c: CalendlyCredentials,
  id: string,
): Promise<Booking> {
  const res = await http.request(c, { path: `scheduled_events/${enc(uuidFromUri(id))}` });
  return toBookingFromEvent(res?.resource);
}

/** Book a time via the Scheduling API and return the resulting Booking. Shared by
 *  `createBooking` and the cancel+rebook path in `updateBooking`. */
async function createEventInvitee(
  http: HttpContext<CalendlyCredentials>,
  c: CalendlyCredentials,
  args: { eventType: string; start: string; customer: Customer | undefined; timezone?: string },
): Promise<Booking> {
  if (!args.customer?.email) {
    throw new UnibookingError({
      provider: 'calendly',
      code: 'INVALID_INPUT',
      message: 'Calendly requires an invitee email to create a booking',
    });
  }
  const res = await http.request(c, {
    method: 'POST',
    path: CREATE_PATH,
    body: {
      event_type: args.eventType,
      start_time: args.start,
      invitee: {
        email: args.customer.email,
        ...(args.customer.name ? { name: args.customer.name } : {}),
      },
      ...(args.timezone ? { timezone: args.timezone } : {}),
    },
  });
  const resource = asRecord(res?.resource, 'calendly', 'create.resource');
  // The create response may be the scheduled event itself, or an invitee that
  // references its event by URI — handle both.
  if (typeof resource.start_time === 'string') return toBookingFromEvent(resource);
  const eventUri = resource.event ?? resource.uri;
  return getEvent(http, c, String(eventUri ?? ''));
}

export const calendly = defineAdapter<CalendlyCredentials>({
  id: 'calendly',
  capabilities: {
    availability: true,
    staff: false,
    services: true,
    webhooks: true,
    idempotency: false,
    customers: false,
  },
  baseUrl: BASE,
  auth: (c) => ({ headers: { authorization: `Bearer ${c.token}` } }),
  parseError: parseCalendlyError,
  build: (http) => ({
    async createBooking(input) {
      assertValidRange(input.range, 'calendly');
      const c = await http.resolve();
      const eventType = requireService(input.serviceId);
      return createEventInvitee(http, c, {
        eventType,
        start: input.range.start,
        customer: input.customer,
        ...(input.range.timezone ? { timezone: input.range.timezone } : {}),
      });
    },

    getBooking(id) {
      return http.resolve().then((c) => getEvent(http, c, id));
    },

    async updateBooking(id, input) {
      const c = await http.resolve();
      if (input.range) {
        assertValidRange(input.range, 'calendly');
        // Calendly has no reschedule endpoint: cancel + rebook.
        const uuid = uuidFromUri(id);
        const current = asRecord(
          (await http.request(c, { path: `scheduled_events/${enc(uuid)}` }))?.resource,
          'calendly',
          'scheduled_event',
        );
        const eventType =
          input.serviceId ?? reqString(String(current.event_type ?? ''), 'calendly', 'scheduled_event.event_type');
        // Carry the original invitee across to the new booking.
        let customer: Customer | undefined;
        const invitees = await http.request(c, { path: `scheduled_events/${enc(uuid)}/invitees` });
        const first = asArray(invitees?.collection, 'calendly', 'invitees')[0];
        if (first?.email) {
          customer = { email: String(first.email), ...(first.name ? { name: String(first.name) } : {}) };
        }
        const rebooked = await createEventInvitee(http, c, {
          eventType,
          start: input.range.start,
          customer,
          ...(input.range.timezone ? { timezone: input.range.timezone } : {}),
        });
        await http.request(c, {
          method: 'POST',
          path: `scheduled_events/${enc(uuid)}/cancellation`,
          body: { reason: 'Rescheduled' },
          parse: 'none',
        });
        return rebooked;
      }
      if (input.status === 'cancelled') {
        const res = await http.request(c, {
          method: 'POST',
          path: `scheduled_events/${enc(uuidFromUri(id))}/cancellation`,
          body: {},
        });
        return toBookingFromEvent(res?.resource);
      }
      return unsupported(
        'calendly',
        'updateBooking without a range or cancellation (Calendly has no reschedule; change the time to cancel+rebook)',
      );
    },

    async cancelBooking(id, options) {
      const c = await http.resolve();
      await http.request(c, {
        method: 'POST',
        path: `scheduled_events/${enc(uuidFromUri(id))}/cancellation`,
        body: { ...(options?.reason ? { reason: options.reason } : {}) },
        parse: 'none',
      });
    },

    async listBookings(query) {
      assertValidRange(query.range, 'calendly');
      const c = await http.resolve();
      let userUri = c.user;
      if (!userUri && !c.organization) {
        const me = await http.request(c, { path: 'users/me' });
        userUri = reqString(String(me?.resource?.uri ?? ''), 'calendly', 'users/me.uri');
      }
      const res = await http.request(c, {
        path: 'scheduled_events',
        query: {
          ...(userUri ? { user: userUri } : {}),
          ...(c.organization ? { organization: c.organization } : {}),
          min_start_time: query.range.start,
          max_start_time: query.range.end,
          count: query.limit ?? 50,
          page_token: query.pageToken,
          ...(query.status === 'cancelled' ? { status: 'canceled' } : {}),
        },
      });
      const bookings = asArray(res?.collection, 'calendly', 'scheduled_events').map(toBookingFromEvent);
      const next = res?.pagination?.next_page_token;
      return { bookings, ...(typeof next === 'string' && next ? { nextPageToken: next } : {}) };
    },

    async searchAvailability(query): Promise<AvailabilitySlot[]> {
      assertValidRange(query.range, 'calendly');
      const eventType = requireService(query.serviceId);
      // Calendly returns start times only (no duration), so a slot size is required.
      if (typeof query.durationMinutes !== 'number' || query.durationMinutes <= 0) {
        throw new UnibookingError({
          provider: 'calendly',
          code: 'INVALID_INPUT',
          message: 'Calendly available times are start-only; pass a positive durationMinutes to size each slot',
        });
      }
      const durationMinutes = query.durationMinutes;
      const c = await http.resolve();
      const res = await http.request(c, {
        path: 'event_type_available_times',
        query: { event_type: eventType, start_time: query.range.start, end_time: query.range.end },
      });
      const times = asArray(res?.collection, 'calendly', 'available_times');
      return times.flatMap((t: any): AvailabilitySlot[] => {
        const start = t.start_time;
        if (typeof start !== 'string' || !isInstant(start)) return [];
        return [{ start, end: endFromDuration(start, durationMinutes), raw: t }];
      });
    },
  }),
});

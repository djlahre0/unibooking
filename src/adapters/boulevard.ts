import type { Booking, BookingStatus, Customer } from '../types';
import { asArray, asRecord, defineAdapter, reqString, unsupported } from '../adapter-kit';
import type { HttpContext } from '../http';
import { UnibookingError } from '../errors';
import { assertValidRange, parseOffsetMinutes } from '../time';
import { base64ToBytes, hmacSha256BytesBase64 } from '../crypto';

/**
 * Boulevard (joinblvd.com) — Admin GraphQL API (`/api/2020-01/admin`). Gated to
 * Enterprise-tier merchants. Auth is a per-request HMAC token wrapped in Basic:
 *   payload = "blvd-admin-v1" + businessId + unixSeconds
 *   mac     = base64( HMAC-SHA256( base64Decode(apiSecret), payload ) )
 *   token   = mac + payload
 *   header  = Authorization: Basic base64(apiKey + ":" + token)
 * The async HMAC is why the kit's `AuthFn` is awaitable.
 *
 * Point `options.baseUrl` at `https://sandbox.joinblvd.com/api/2020-01/` to work
 * against the sandbox tenant.
 *
 * Three things shape this adapter:
 *  - **`locationId` is required** on the `appointments` query, so it lives in
 *    credentials rather than being guessed per call.
 *  - **Filtering goes through a `QueryString` DSL**, not typed arguments. Only
 *    `id`, `startAt`, `createdAt`, `cancelled` and `staffId` are filterable —
 *    notably there is no `endAt`, so a range is expressed on `startAt` alone.
 *  - **Booking is a multi-step mutation chain**, not one call:
 *    `bookingCreate` → `bookingAddService` → `bookingComplete`. Only
 *    `bookingComplete` yields a real `Appointment`.
 *
 * Reads are UTC (`DateTime`); booking-flow writes are `NaiveDateTime` — local
 * wall-clock with no offset, resolved against the location's zone. Sending a
 * `Z`-suffixed instant to a `NaiveDateTime` field would be read as local time and
 * silently shift the booking.
 */
export type BoulevardCredentials = {
  businessId: string;
  /** Required by the `appointments` query and the booking flow. */
  locationId: string;
  apiKey: string;
  apiSecret: string;
};

const BASE = 'https://dashboard.boulevard.io/api/2020-01/';

// --- GraphQL documents -----------------------------------------------------

const APPOINTMENT_FIELDS = `
  id startAt endAt state cancelled createdAt notes duration
  cancellation { reason cancelledAt }
  client { id name email mobilePhone }
  appointmentServices { id serviceId staffId service { id name } staff { id name } }
`;

const GET_APPOINTMENT = `query GetAppointment($id: ID!) {
  appointment(id: $id) { ${APPOINTMENT_FIELDS} }
}`;

const LIST_APPOINTMENTS = `query ListAppointments($locationId: ID!, $query: QueryString, $clientId: ID, $first: Int, $after: String) {
  appointments(locationId: $locationId, query: $query, clientId: $clientId, first: $first, after: $after) {
    edges { node { ${APPOINTMENT_FIELDS} } }
    pageInfo { endCursor hasNextPage }
  }
}`;

const BOOKING_CREATE = `mutation BookingCreate($input: BookingCreateInput!) {
  bookingCreate(input: $input) {
    booking { id startTime bookingClients { id clientId } errors { code message } }
    bookingWarnings { code message }
  }
}`;

const BOOKING_ADD_SERVICE = `mutation BookingAddService($input: BookingAddServiceInput!) {
  bookingAddService(input: $input) {
    bookingService { id serviceId staffId }
    bookingWarnings { code message }
  }
}`;

const BOOKING_COMPLETE = `mutation BookingComplete($input: BookingCompleteInput!) {
  bookingComplete(input: $input) {
    bookingAppointments { appointment { ${APPOINTMENT_FIELDS} } }
    bookingWarnings { code message }
  }
}`;

const RESCHEDULE_AVAILABLE_TIMES = `mutation RescheduleTimes($input: AppointmentRescheduleAvailableTimesInput!) {
  appointmentRescheduleAvailableTimes(input: $input) {
    availableTimes { bookableTimeId startTime }
  }
}`;

const APPOINTMENT_RESCHEDULE = `mutation AppointmentReschedule($input: AppointmentRescheduleInput!) {
  appointmentReschedule(input: $input) { appointment { ${APPOINTMENT_FIELDS} } }
}`;

const UPDATE_APPOINTMENT = `mutation UpdateAppointment($input: UpdateAppointmentInput!) {
  updateAppointment(input: $input) { appointment { ${APPOINTMENT_FIELDS} } }
}`;

const CANCEL_APPOINTMENT = `mutation CancelAppointment($input: CancelAppointmentInput!) {
  cancelAppointment(input: $input) { appointment { id state cancelled } }
}`;

const FIND_CLIENTS = `query FindClients($emails: [String!]) {
  clients(first: 1, emails: $emails) { edges { node { id } } }
}`;

const CREATE_CLIENT = `mutation CreateClient($input: CreateClientInput!) {
  createClient(input: $input) { client { id } }
}`;

// --- helpers ---------------------------------------------------------------

/** Documented cancellation reasons. Anything else is rejected client-side rather
 *  than sent as free text, which the enum would reject upstream. */
const CANCELLATION_REASONS = new Set([
  'BLVD_CANCELLED',
  'CLIENT_CANCEL',
  'CLIENT_LATE_CANCEL',
  'MERGED',
  'MISTAKE',
  'NO_SHOW',
  'OFFBOARDED',
  'STAFF_CANCEL',
  'VOIDED',
]);

/** `AppointmentStateInput` excludes CANCELLED and FINAL — cancel goes through
 *  `cancelAppointment`, and FINAL is not settable. */
const SETTABLE_STATES = new Set(['ACTIVE', 'ARRIVED', 'BOOKED', 'CONFIRMED']);

function mapStatus(state: unknown, cancellationReason: unknown): BookingStatus {
  switch (String(state).toUpperCase()) {
    case 'ACTIVE':
    case 'BOOKED':
    case 'CONFIRMED':
    case 'ARRIVED':
      return 'confirmed';
    case 'FINAL':
      return 'completed';
    case 'CANCELLED':
      // NO_SHOW is a cancellation *reason*, not a state — it is the only way a
      // no-show is representable.
      return String(cancellationReason).toUpperCase() === 'NO_SHOW' ? 'no_show' : 'cancelled';
    default:
      return 'unknown';
  }
}

/** Wall-clock time as written in the caller's own offset, with the offset
 *  dropped — Boulevard's `NaiveDateTime` form. */
function toNaiveDateTime(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new UnibookingError({
      provider: 'boulevard',
      code: 'INVALID_INPUT',
      message: `not a parseable timestamp: ${iso}`,
    });
  }
  const offset = parseOffsetMinutes(iso) ?? 0;
  return new Date(ms + offset * 60_000).toISOString().slice(0, 19);
}

/** `yyyy-mm-dd` in the caller's own offset. */
function toDate(iso: string): string {
  return toNaiveDateTime(iso).slice(0, 10);
}

/** QueryString is a text DSL — apostrophes inside values must be backslash-escaped. */
function q(value: string): string {
  return `'${value.replace(/'/g, "\\'")}'`;
}

function customerOf(client: any): Customer | undefined {
  if (!client || typeof client !== 'object') return undefined;
  return {
    ...(client.id ? { id: String(client.id) } : {}),
    ...(client.name ? { name: String(client.name) } : {}),
    ...(client.email ? { email: String(client.email) } : {}),
    ...(client.mobilePhone ? { phone: String(client.mobilePhone) } : {}),
  };
}

function toBooking(raw: unknown): Booking {
  const a = asRecord(raw, 'boulevard', 'appointment');
  const start = a.startAt;
  const end = a.endAt;
  if (typeof start !== 'string' || typeof end !== 'string') {
    throw new UnibookingError({
      provider: 'boulevard',
      code: 'UPSTREAM',
      message: 'appointment is missing startAt/endAt',
    });
  }
  const svc = Array.isArray(a.appointmentServices) ? (a.appointmentServices[0] as any) : undefined;
  const customer = customerOf(a.client);
  const cancellation = a.cancellation as any;
  return {
    id: reqString(String(a.id ?? ''), 'boulevard', 'appointment.id'),
    provider: 'boulevard',
    title: svc?.service?.name ? String(svc.service.name) : 'Appointment',
    range: { start, end },
    ...(svc?.staffId ? { staffId: String(svc.staffId) } : {}),
    ...(svc?.serviceId ? { serviceId: String(svc.serviceId) } : {}),
    ...(customer ? { customer } : {}),
    status: mapStatus(a.state, cancellation?.reason),
    ...(typeof a.createdAt === 'string' ? { createdAt: a.createdAt } : {}),
    raw: a,
  };
}

/** POST a GraphQL document and return `data`, mapping a GraphQL `errors` array
 *  (which Boulevard returns with HTTP 200) to a UnibookingError. */
async function gql<T = any>(
  http: HttpContext<BoulevardCredentials>,
  c: BoulevardCredentials,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const res = await http.request(c, { method: 'POST', path: 'admin', body: { query, variables } });
  const errors = (res as any)?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0];
    throw new UnibookingError({
      provider: 'boulevard',
      code: 'UPSTREAM',
      message: first?.message ? String(first.message) : 'GraphQL error',
      ...(first?.extensions?.code ? { providerCode: String(first.extensions.code) } : {}),
    });
  }
  return (res as any)?.data as T;
}

function requireField(value: string | undefined, hint: string): string {
  if (!value) {
    throw new UnibookingError({ provider: 'boulevard', code: 'INVALID_INPUT', message: `Boulevard requires ${hint}` });
  }
  return value;
}

async function findOrCreateClient(
  http: HttpContext<BoulevardCredentials>,
  c: BoulevardCredentials,
  customer: Customer,
): Promise<string> {
  if (customer.id) return customer.id;
  if (customer.email) {
    // `clients` takes `emails: [String!]`, not a scalar `email`.
    const data = await gql(http, c, FIND_CLIENTS, { emails: [customer.email] });
    const node = data?.clients?.edges?.filter(Boolean)?.[0]?.node;
    if (node?.id) return String(node.id);
  }
  const [first, ...rest] = (customer.name ?? 'Guest').trim().split(/\s+/);
  const data = await gql(http, c, CREATE_CLIENT, {
    input: {
      firstName: first ?? 'Guest',
      lastName: rest.join(' ') || 'Guest',
      ...(customer.email ? { email: customer.email } : {}),
      ...(customer.phone ? { mobilePhone: customer.phone } : {}),
    },
  });
  return reqString(String(data?.createClient?.client?.id ?? ''), 'boulevard', 'client.id');
}

async function getAppointment(
  http: HttpContext<BoulevardCredentials>,
  c: BoulevardCredentials,
  id: string,
): Promise<Booking> {
  const data = await gql(http, c, GET_APPOINTMENT, { id });
  return toBooking(data?.appointment);
}

export const boulevard = defineAdapter<BoulevardCredentials>({
  id: 'boulevard',
  capabilities: {
    // Stateless slot search lives on the Client cart API, which uses different
    // credentials. The Admin API only exposes reschedule-scoped availability.
    availability: false,
    staff: true,
    services: true,
    webhooks: true,
    idempotency: false,
    customers: true,
  },
  baseUrl: BASE,
  auth: async (c) => {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const payload = `blvd-admin-v1${c.businessId}${timestamp}`;
    const mac = await hmacSha256BytesBase64(base64ToBytes(c.apiSecret), payload);
    const token = `${mac}${payload}`;
    return { headers: { authorization: `Basic ${btoa(`${c.apiKey}:${token}`)}` } };
  },
  build: (http) => ({
    async createBooking(input) {
      assertValidRange(input.range, 'boulevard');
      const c = await http.resolve();
      const serviceId = requireField(input.serviceId, 'a serviceId to book');
      // `bookingComplete.bookWithStaffId` is non-null, so a staff-less booking
      // is not expressible through this flow.
      const staffId = requireField(input.staffId, 'a staffId — bookingComplete requires bookWithStaffId');
      let clientId = input.customer?.id;
      if (clientId === undefined && input.customer && (input.customer.email || input.customer.phone)) {
        clientId = await findOrCreateClient(http, c, input.customer);
      }
      requireField(clientId, 'a customer — bookingAddService needs a bookingClientId');

      // Step 1 — open a pending booking. startTime is NaiveDateTime (location-local).
      const created = await gql(http, c, BOOKING_CREATE, {
        input: {
          locationId: c.locationId,
          clientId,
          startTime: toNaiveDateTime(input.range.start),
          ...input.providerOptions,
        },
      });
      const booking = created?.bookingCreate?.booking;
      const bookingId = reqString(String(booking?.id ?? ''), 'boulevard', 'booking.id');
      // bookingAddService wants the BookingClient id, not the Client id.
      const bookingClientId = reqString(
        String(booking?.bookingClients?.[0]?.id ?? ''),
        'boulevard',
        'booking.bookingClients[0].id',
      );

      // Step 2 — attach the service.
      await gql(http, c, BOOKING_ADD_SERVICE, {
        input: { bookingId, bookingClientId, serviceId, staffId },
      });

      // Step 3 — commit. Only here does a real Appointment exist.
      const completed = await gql(http, c, BOOKING_COMPLETE, {
        input: {
          bookingId,
          bookWithStaffId: staffId,
          ...(input.notify !== undefined ? { notifyClient: input.notify } : {}),
        },
      });
      const appointment = completed?.bookingComplete?.bookingAppointments?.[0]?.appointment;
      return toBooking(appointment);
    },

    getBooking(id) {
      return http.resolve().then((c) => getAppointment(http, c, id));
    },

    async updateBooking(id, input) {
      const c = await http.resolve();

      if (input.range) {
        assertValidRange(input.range, 'boulevard');
        // Reschedule is two-step: a bookableTimeId can only come from
        // appointmentRescheduleAvailableTimes — it is opaque and not constructible.
        const times = await gql(http, c, RESCHEDULE_AVAILABLE_TIMES, {
          input: {
            appointmentId: id,
            date: toDate(input.range.start),
            ...(input.range.timezone ? { tz: input.range.timezone } : {}),
          },
        });
        const available = asArray(
          times?.appointmentRescheduleAvailableTimes?.availableTimes ?? [],
          'boulevard',
          'availableTimes',
        );
        const wanted = Date.parse(input.range.start);
        const match = available.find((t: any) => Date.parse(String(t?.startTime)) === wanted);
        if (!match) {
          throw new UnibookingError({
            provider: 'boulevard',
            code: 'CONFLICT',
            message: `no bookable reschedule slot at ${input.range.start}`,
          });
        }
        const data = await gql(http, c, APPOINTMENT_RESCHEDULE, {
          input: {
            appointmentId: id,
            bookableTimeId: String((match as any).bookableTimeId),
            // Non-null in the schema, so it must always be sent.
            sendNotification: input.notify ?? false,
            ...input.providerOptions,
          },
        });
        return toBooking(data?.appointmentReschedule?.appointment);
      }

      if (input.status === 'cancelled') {
        return unsupported(
          'boulevard',
          "updateBooking({ status: 'cancelled' }) — cancelAppointment requires an explicit " +
            'reason enum; use cancelBooking(id, { reason }) instead',
        );
      }

      if (input.staffId || input.serviceId) {
        return unsupported(
          'boulevard',
          'updateBooking of staff/service (UpdateAppointmentInput accepts only notes, state and customFields)',
        );
      }

      const state = input.status ? String(input.status).toUpperCase() : undefined;
      if (state !== undefined && !SETTABLE_STATES.has(state)) {
        throw new UnibookingError({
          provider: 'boulevard',
          code: 'INVALID_INPUT',
          message: `state ${state} is not settable; allowed: ${[...SETTABLE_STATES].join(', ')}`,
        });
      }
      const data = await gql(http, c, UPDATE_APPOINTMENT, {
        input: {
          id,
          // The field is `notes`, plural.
          ...(input.title !== undefined ? { notes: input.title } : {}),
          ...(state ? { state } : {}),
          ...input.providerOptions,
        },
      });
      return toBooking(data?.updateAppointment?.appointment);
    },

    async cancelBooking(id, options) {
      const c = await http.resolve();
      // `reason` is a non-null enum — a free-text reason cannot be forwarded.
      const reason = options?.reason ? String(options.reason).toUpperCase().replace(/\s+/g, '_') : 'CLIENT_CANCEL';
      if (!CANCELLATION_REASONS.has(reason)) {
        throw new UnibookingError({
          provider: 'boulevard',
          code: 'INVALID_INPUT',
          message:
            `cancellation reason must be one of ${[...CANCELLATION_REASONS].join(', ')} ` +
            `(got ${JSON.stringify(options?.reason)})`,
        });
      }
      await gql(http, c, CANCEL_APPOINTMENT, {
        input: {
          id,
          reason,
          ...(options?.notify !== undefined ? { notifyClient: options.notify } : {}),
        },
      });
    },

    async listBookings(query) {
      assertValidRange(query.range, 'boulevard');
      const c = await http.resolve();
      // Only id/startAt/createdAt/cancelled/staffId are filterable, and there is
      // no endAt — so the range is expressed on startAt alone.
      const clauses = [
        `startAt >= ${q(query.range.start)}`,
        `startAt < ${q(query.range.end)}`,
        ...(query.staffId ? [`staffId = ${q(query.staffId)}`] : []),
        ...(query.status === 'cancelled' ? ['cancelled = true'] : []),
      ];
      const data = await gql(http, c, LIST_APPOINTMENTS, {
        locationId: c.locationId,
        query: clauses.join(' AND '),
        ...(query.customerId ? { clientId: query.customerId } : {}),
        first: query.limit ?? 50,
        ...(query.pageToken ? { after: query.pageToken } : {}),
      });
      const conn = data?.appointments ?? {};
      // edges and node are both nullable in the schema.
      const nodes = Array.isArray(conn.edges) ? conn.edges.map((e: any) => e?.node).filter(Boolean) : [];
      const bookings = nodes.map(toBooking);
      const endCursor = conn.pageInfo?.endCursor;
      const hasNext = conn.pageInfo?.hasNextPage;
      return {
        bookings,
        ...(hasNext && typeof endCursor === 'string' ? { nextPageToken: endCursor } : {}),
      };
    },

    async searchAvailability() {
      // The Admin API has no stateless slot search; bookable-time queries live on
      // the Client cart API (different credentials). Reschedule-scoped
      // availability is reachable through updateBooking({ range }).
      return unsupported('boulevard', 'availability (requires the Boulevard Client cart API)');
    },

    customers: {
      findOrCreate: async (customer) => {
        const c = await http.resolve();
        return findOrCreateClient(http, c, customer);
      },
    },
  }),
});

import type { Booking, BookingStatus, Customer } from '../types';
import { asArray, asRecord, defineAdapter, reqString, unsupported } from '../adapter-kit';
import type { HttpContext } from '../http';
import { UnibookingError } from '../errors';
import { assertValidRange } from '../time';
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
 * NOTE: shapes are docs-derived, not verified against a live tenant. In
 * particular `createBooking` here is a single `bookingCreate` mutation; a real
 * Boulevard flow may require a cart / `bookingComplete` step. Fields marked
 * `TODO: verify against live API` are the ones to confirm first.
 */
export type BoulevardCredentials = {
  businessId: string;
  apiKey: string;
  apiSecret: string;
};

const BASE = 'https://dashboard.boulevard.io/api/2020-01/';

// --- GraphQL documents (TODO: verify against live API) ---------------------

const APPOINTMENT_FIELDS = `
  id startAt endAt state createdAt
  client { id name email mobilePhone }
  appointmentServices { service { id name } staff { id } }
`;

const GET_APPOINTMENT = `query GetAppointment($id: ID!) {
  appointment(id: $id) { ${APPOINTMENT_FIELDS} }
}`;

const LIST_APPOINTMENTS = `query ListAppointments($first: Int, $after: String, $startAt: DateTime, $endAt: DateTime, $staffId: ID) {
  appointments(first: $first, after: $after, startAt: $startAt, endAt: $endAt, staffId: $staffId) {
    edges { node { ${APPOINTMENT_FIELDS} } }
    pageInfo { endCursor hasNextPage }
  }
}`;

const BOOKING_CREATE = `mutation BookingCreate($input: BookingCreateInput!) {
  bookingCreate(input: $input) { appointment { ${APPOINTMENT_FIELDS} } }
}`;

const APPOINTMENT_RESCHEDULE = `mutation AppointmentReschedule($input: AppointmentRescheduleInput!) {
  appointmentReschedule(input: $input) { appointment { ${APPOINTMENT_FIELDS} } }
}`;

const UPDATE_APPOINTMENT = `mutation UpdateAppointment($input: UpdateAppointmentInput!) {
  updateAppointment(input: $input) { appointment { ${APPOINTMENT_FIELDS} } }
}`;

const CANCEL_APPOINTMENT = `mutation CancelAppointment($input: CancelAppointmentInput!) {
  cancelAppointment(input: $input) { appointment { id state } }
}`;

const FIND_CLIENTS = `query FindClients($email: String) {
  clients(first: 1, email: $email) { edges { node { id } } }
}`;

const CREATE_CLIENT = `mutation CreateClient($input: CreateClientInput!) {
  createClient(input: $input) { client { id } }
}`;

// --- helpers ---------------------------------------------------------------

function mapStatus(s: unknown): BookingStatus {
  switch (String(s).toUpperCase()) {
    case 'CONFIRMED':
    case 'BOOKED':
    case 'ACTIVE':
      return 'confirmed';
    case 'CANCELLED':
    case 'CANCELED':
      return 'cancelled';
    case 'NO_SHOW':
    case 'NOSHOW':
      return 'no_show';
    case 'COMPLETED':
    case 'FINALIZED':
      return 'completed';
    case 'PENDING':
      return 'pending';
    default:
      return 'unknown';
  }
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
  const svc = Array.isArray(a.appointmentServices) ? a.appointmentServices[0] : undefined;
  const customer = customerOf(a.client);
  return {
    id: reqString(String(a.id ?? ''), 'boulevard', 'appointment.id'),
    provider: 'boulevard',
    title: svc?.service?.name ? String(svc.service.name) : 'Appointment',
    range: { start, end },
    ...(svc?.staff?.id ? { staffId: String(svc.staff.id) } : {}),
    ...(svc?.service?.id ? { serviceId: String(svc.service.id) } : {}),
    ...(customer ? { customer } : {}),
    status: mapStatus(a.state),
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

async function findOrCreateClient(
  http: HttpContext<BoulevardCredentials>,
  c: BoulevardCredentials,
  customer: Customer,
): Promise<string> {
  if (customer.id) return customer.id;
  if (customer.email) {
    const data = await gql(http, c, FIND_CLIENTS, { email: customer.email });
    const node = data?.clients?.edges?.[0]?.node ?? data?.clients?.nodes?.[0];
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
      let clientId = input.customer?.id;
      if (clientId === undefined && input.customer && (input.customer.email || input.customer.phone)) {
        clientId = await findOrCreateClient(http, c, input.customer);
      }
      const data = await gql(http, c, BOOKING_CREATE, {
        input: {
          ...(clientId ? { clientId } : {}),
          startAt: input.range.start,
          services: [
            {
              ...(input.serviceId ? { serviceId: input.serviceId } : {}),
              ...(input.staffId ? { staffId: input.staffId } : {}),
            },
          ],
          ...input.providerOptions,
        },
      });
      return toBooking(data?.bookingCreate?.appointment);
    },

    getBooking(id) {
      return http.resolve().then((c) => getAppointment(http, c, id));
    },

    async updateBooking(id, input) {
      const c = await http.resolve();
      if (input.range) {
        assertValidRange(input.range, 'boulevard');
        // Boulevard supports a native reschedule mutation.
        const data = await gql(http, c, APPOINTMENT_RESCHEDULE, {
          input: { id, startAt: input.range.start, ...input.providerOptions },
        });
        return toBooking(data?.appointmentReschedule?.appointment);
      }
      if (input.status === 'cancelled') {
        await gql(http, c, CANCEL_APPOINTMENT, { input: { id } });
        return getAppointment(http, c, id);
      }
      const data = await gql(http, c, UPDATE_APPOINTMENT, {
        input: {
          id,
          ...(input.staffId ? { staffId: input.staffId } : {}),
          ...(input.serviceId ? { serviceId: input.serviceId } : {}),
          ...(input.title !== undefined ? { note: input.title } : {}),
          ...input.providerOptions,
        },
      });
      return toBooking(data?.updateAppointment?.appointment);
    },

    async cancelBooking(id, options) {
      const c = await http.resolve();
      await gql(http, c, CANCEL_APPOINTMENT, {
        input: { id, ...(options?.reason ? { reason: options.reason } : {}) },
      });
    },

    async listBookings(query) {
      assertValidRange(query.range, 'boulevard');
      const c = await http.resolve();
      const data = await gql(http, c, LIST_APPOINTMENTS, {
        first: query.limit ?? 50,
        after: query.pageToken,
        startAt: query.range.start,
        endAt: query.range.end,
        staffId: query.staffId,
      });
      const conn = data?.appointments ?? {};
      const nodes = Array.isArray(conn.edges)
        ? conn.edges.map((e: any) => e?.node)
        : asArray(conn.nodes, 'boulevard', 'appointments.nodes');
      const bookings = nodes.filter(Boolean).map(toBooking);
      const endCursor = conn.pageInfo?.endCursor;
      const hasNext = conn.pageInfo?.hasNextPage;
      return {
        bookings,
        ...(hasNext && typeof endCursor === 'string' ? { nextPageToken: endCursor } : {}),
      };
    },

    async searchAvailability() {
      // The Admin API has no stateless slot search; bookable-time queries live on
      // the Client cart API (different credentials). See docs/providers/boulevard.md.
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

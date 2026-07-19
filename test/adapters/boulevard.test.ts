import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import { boulevard } from '../../src/adapters/boulevard';
import { runConformance } from '../conformance';

const JSON_HEADERS = { 'content-type': 'application/json' };
const ORIGIN = 'https://dashboard.boulevard.io';
const ADMIN = '/api/2020-01/admin';
// A valid base64 secret (base64ToBytes -> atob must not throw).
const CREDS = {
  businessId: 'biz1',
  locationId: 'urn:blvd:Location:L1',
  apiKey: 'key1',
  apiSecret: 'c2VjcmV0',
};

const APPT = {
  id: 'urn:blvd:Appointment:1',
  startAt: '2026-07-20T16:00:00Z',
  endAt: '2026-07-20T16:30:00Z',
  state: 'BOOKED',
  cancelled: false,
  createdAt: '2026-07-01T00:00:00Z',
  notes: null,
  duration: 30,
  cancellation: null,
  client: { id: 'c1', name: 'Jane Doe', email: 'jane@example.com', mobilePhone: '+15550100' },
  appointmentServices: [
    {
      id: 'as1',
      serviceId: 'svc1',
      staffId: 'st1',
      service: { id: 'svc1', name: 'Haircut' },
      staff: { id: 'st1', name: 'Sam' },
    },
  ],
};

const RANGE = { start: '2026-07-20T09:00:00-07:00', end: '2026-07-21T09:00:00-07:00' };
const makeClient = () => boulevard(CREDS);

runConformance({
  provider: 'boulevard',
  origin: ORIGIN,
  makeClient,
  errorProbe: { method: 'POST', path: ADMIN, run: (c) => c.getBooking('urn:blvd:Appointment:1') },
  cases: [
    {
      name: 'getBooking maps the appointment',
      method: 'POST',
      path: ADMIN,
      reply: { data: { appointment: APPT } },
      run: (c) => c.getBooking('urn:blvd:Appointment:1'),
      check: (b) => {
        expect(b.id).toBe('urn:blvd:Appointment:1');
        expect(b.status).toBe('confirmed');
        expect(b.title).toBe('Haircut');
        expect(b.staffId).toBe('st1');
        expect(b.serviceId).toBe('svc1');
        expect(b.customer?.email).toBe('jane@example.com');
      },
    },
    {
      name: 'listBookings maps a connection',
      method: 'POST',
      path: ADMIN,
      reply: {
        data: {
          appointments: {
            edges: [{ node: APPT }, null],
            pageInfo: { endCursor: 'cur1', hasNextPage: true },
          },
        },
      },
      run: (c) => c.listBookings({ range: RANGE }),
      check: (page) => {
        // A null edge in the connection must not blow up the mapper.
        expect(page.bookings).toHaveLength(1);
        expect(page.nextPageToken).toBe('cur1');
      },
    },
  ],
});

/** Route a GraphQL POST by operation name so multi-step flows can be mocked. */
function gqlRouter(
  agent: MockAgent,
  handlers: Record<string, unknown>,
  capture?: (op: string, vars: any) => void,
): void {
  agent
    .get(ORIGIN)
    .intercept({ path: ADMIN, method: 'POST' })
    .reply(200, (opts: any) => {
      const { query, variables } = JSON.parse(String(opts.body));
      const op = Object.keys(handlers).find((name) => query.includes(`${name}(`));
      capture?.(op ?? 'unknown', variables);
      return JSON.stringify({ data: op ? (handlers as any)[op] : {} });
    }, { headers: JSON_HEADERS })
    .persist();
}

describe('boulevard GraphQL shapes', () => {
  let agent: MockAgent;
  let previous: Dispatcher;

  beforeEach(() => {
    previous = getGlobalDispatcher();
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });
  afterEach(async () => {
    setGlobalDispatcher(previous);
    await agent.close();
  });

  it('lists with a required locationId and a startAt QueryString', async () => {
    let vars: any;
    gqlRouter(
      agent,
      { appointments: { appointments: { edges: [], pageInfo: { hasNextPage: false } } } },
      (_op, v) => (vars = v),
    );

    await makeClient().listBookings({ range: RANGE, staffId: 'st1' });

    expect(vars.locationId).toBe('urn:blvd:Location:L1');
    // No endAt filter exists — the range must ride on startAt alone.
    expect(vars.query).toContain("startAt >= '2026-07-20T09:00:00-07:00'");
    expect(vars.query).toContain("startAt < '2026-07-21T09:00:00-07:00'");
    expect(vars.query).toContain("staffId = 'st1'");
    expect(vars.query).not.toContain('endAt');
  });

  it('finds clients via emails: [String!], not a scalar email', async () => {
    let vars: any;
    gqlRouter(agent, { clients: { clients: { edges: [{ node: { id: 'c9' } }] } } }, (_op, v) => (vars = v));

    const id = await makeClient().customers!.findOrCreate({ email: 'jane@example.com' });

    expect(id).toBe('c9');
    expect(vars.emails).toEqual(['jane@example.com']);
    expect(vars.email).toBeUndefined();
  });

  it('books through the three-step chain, threading bookingClientId', async () => {
    const seen: Array<{ op: string; vars: any }> = [];
    gqlRouter(
      agent,
      {
        bookingCreate: {
          bookingCreate: {
            booking: { id: 'bk1', bookingClients: [{ id: 'bc1', clientId: 'c1' }], errors: [] },
            bookingWarnings: [],
          },
        },
        bookingAddService: {
          bookingAddService: { bookingService: { id: 'bs1', serviceId: 'svc1', staffId: 'st1' }, bookingWarnings: [] },
        },
        bookingComplete: {
          bookingComplete: { bookingAppointments: [{ appointment: APPT }], bookingWarnings: [] },
        },
      },
      (op, vars) => seen.push({ op, vars }),
    );

    const b = await makeClient().createBooking({
      title: 'Haircut',
      range: { start: '2026-07-20T09:00:00-07:00', end: '2026-07-20T09:30:00-07:00' },
      serviceId: 'svc1',
      staffId: 'st1',
      customer: { id: 'c1' },
    });

    expect(seen.map((s) => s.op)).toEqual(['bookingCreate', 'bookingAddService', 'bookingComplete']);
    // NaiveDateTime: local wall clock, no offset. Sending the UTC instant here
    // would shift the booking by the location's offset.
    expect(seen[0]!.vars.input.startTime).toBe('2026-07-20T09:00:00');
    expect(seen[0]!.vars.input.locationId).toBe('urn:blvd:Location:L1');
    // bookingAddService needs the BookingClient id, not the Client id.
    expect(seen[1]!.vars.input.bookingClientId).toBe('bc1');
    expect(seen[2]!.vars.input.bookWithStaffId).toBe('st1');
    expect(b.id).toBe('urn:blvd:Appointment:1');
  });

  it('requires a staffId — bookingComplete.bookWithStaffId is non-null', async () => {
    const err = await makeClient()
      .createBooking({
        title: 'x',
        range: { start: '2026-07-20T09:00:00-07:00', end: '2026-07-20T09:30:00-07:00' },
        serviceId: 'svc1',
        customer: { id: 'c1' },
      })
      .then(() => null)
      .catch((e: any) => e);
    expect(err?.code).toBe('INVALID_INPUT');
    expect(err?.message).toContain('bookWithStaffId');
  });

  it('reschedules by resolving a bookableTimeId first', async () => {
    const seen: Array<{ op: string; vars: any }> = [];
    gqlRouter(
      agent,
      {
        appointmentRescheduleAvailableTimes: {
          appointmentRescheduleAvailableTimes: {
            availableTimes: [
              { bookableTimeId: 'bt-early', startTime: '2026-07-20T15:00:00Z' },
              { bookableTimeId: 'bt-match', startTime: '2026-07-20T17:00:00Z' },
            ],
          },
        },
        appointmentReschedule: { appointmentReschedule: { appointment: APPT } },
      },
      (op, vars) => seen.push({ op, vars }),
    );

    await makeClient().updateBooking('urn:blvd:Appointment:1', {
      range: { start: '2026-07-20T10:00:00-07:00', end: '2026-07-20T10:30:00-07:00' },
    });

    expect(seen.map((s) => s.op)).toEqual(['appointmentRescheduleAvailableTimes', 'appointmentReschedule']);
    // 10:00-07:00 === 17:00Z — must pick the matching opaque slot id.
    expect(seen[1]!.vars.input.bookableTimeId).toBe('bt-match');
    // sendNotification is non-null in the schema, so it is always present.
    expect(seen[1]!.vars.input.sendNotification).toBe(false);
  });

  it('fails cleanly when no bookable slot matches the requested time', async () => {
    gqlRouter(agent, {
      appointmentRescheduleAvailableTimes: {
        appointmentRescheduleAvailableTimes: {
          availableTimes: [{ bookableTimeId: 'bt-early', startTime: '2026-07-20T15:00:00Z' }],
        },
      },
    });

    const err = await makeClient()
      .updateBooking('urn:blvd:Appointment:1', {
        range: { start: '2026-07-20T10:00:00-07:00', end: '2026-07-20T10:30:00-07:00' },
      })
      .then(() => null)
      .catch((e: any) => e);
    expect(err?.code).toBe('CONFLICT');
  });

  it('cancels with a documented reason enum and rejects free text', async () => {
    let vars: any;
    gqlRouter(agent, { cancelAppointment: { cancelAppointment: { appointment: APPT } } }, (_op, v) => (vars = v));

    await makeClient().cancelBooking('urn:blvd:Appointment:1', { reason: 'client cancel' });
    expect(vars.input.reason).toBe('CLIENT_CANCEL');

    const err = await makeClient()
      .cancelBooking('urn:blvd:Appointment:1', { reason: 'changed their mind' })
      .then(() => null)
      .catch((e: any) => e);
    expect(err?.code).toBe('INVALID_INPUT');
  });

  it('defaults to CLIENT_CANCEL when no reason is given', async () => {
    let vars: any;
    gqlRouter(agent, { cancelAppointment: { cancelAppointment: { appointment: APPT } } }, (_op, v) => (vars = v));
    await makeClient().cancelBooking('urn:blvd:Appointment:1');
    expect(vars.input.reason).toBe('CLIENT_CANCEL');
  });

  it('maps FINAL to completed', async () => {
    gqlRouter(agent, { appointment: { appointment: { ...APPT, state: 'FINAL' } } });
    expect((await makeClient().getBooking('x')).status).toBe('completed');
  });

  it('maps a NO_SHOW cancellation to no_show, not cancelled', async () => {
    gqlRouter(agent, {
      appointment: {
        appointment: { ...APPT, state: 'CANCELLED', cancelled: true, cancellation: { reason: 'NO_SHOW' } },
      },
    });
    expect((await makeClient().getBooking('x')).status).toBe('no_show');
  });

  it('rejects updates the Admin API cannot express', async () => {
    const client = makeClient();
    for (const patch of [{ staffId: 'st2' }, { serviceId: 'svc2' }, { status: 'cancelled' as const }]) {
      const err = await client
        .updateBooking('urn:blvd:Appointment:1', patch)
        .then(() => null)
        .catch((e: any) => e);
      expect(err?.code).toBe('UNSUPPORTED');
    }
  });

  it('writes notes, not note, on a title change', async () => {
    let vars: any;
    gqlRouter(agent, { updateAppointment: { updateAppointment: { appointment: APPT } } }, (_op, v) => (vars = v));
    await makeClient().updateBooking('urn:blvd:Appointment:1', { title: 'VIP' });
    expect(vars.input.notes).toBe('VIP');
    expect(vars.input.note).toBeUndefined();
  });
});

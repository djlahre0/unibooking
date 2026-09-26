import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import { booker } from '../../src/adapters/booker';
import { assertCanonicalBooking, assertCanonicalClassSession } from '../conformance';

const JSON_HEADERS = { 'content-type': 'application/json' };
const ORIGIN = 'https://api.booker.com';

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

function on(prefix: string, method = 'POST') {
  return agent.get(ORIGIN).intercept({ path: (p) => p.split('?')[0]!.startsWith(prefix), method });
}

/** Chicago location: one hour behind Booker's Eastern server clock. */
const client = () =>
  booker({
    accessToken: 't',
    subscriptionKey: 'sub',
    locationId: 'L1',
    timezone: 'America/Chicago',
  });

/** Eastern location: the transform must be a no-op here. */
const eastern = () =>
  booker({
    accessToken: 't',
    subscriptionKey: 'sub',
    locationId: 'L1',
    timezone: 'America/New_York',
  });

// 2026-06-11T22:00:00Z rendered in Eastern (EDT, -04:00) is 18:00 wall clock.
// That wall clock re-anchored in Chicago (CDT, -05:00) is 2026-06-11T23:00:00Z.
const DOT_NET = `/Date(${Date.UTC(2026, 5, 11, 22, 0, 0)}-0400)/`;
const DOT_NET_END = `/Date(${Date.UTC(2026, 5, 11, 23, 0, 0)}-0400)/`;

function appointment(over: Record<string, unknown> = {}) {
  return {
    ID: 900,
    StartDateTime: DOT_NET,
    EndDateTime: DOT_NET_END,
    IsCancelled: false,
    IsNoShow: false,
    CustomerID: 42,
    Customer: { FirstName: 'Dana', LastName: 'Lee', Email: 'dana@example.com' },
    Employee: { ID: 7 },
    AppointmentTreatments: [{ Treatment: { ID: 55, Name: 'Haircut' } }],
    ...over,
  };
}

describe('booker time handling', () => {
  it('reads a .NET date as Eastern wall clock re-anchored in the location zone', async () => {
    on('/v4.1/merchant/appointments').reply(200, JSON.stringify({ Results: [appointment()] }), {
      headers: JSON_HEADERS,
    });

    const { bookings } = await client().listBookings({
      range: { start: '2026-06-11T00:00:00Z', end: '2026-06-13T00:00:00Z' },
    });
    expect(bookings).toHaveLength(1);
    const b = bookings[0]!;
    assertCanonicalBooking(b, 'booker');
    // 18:00 Eastern wall clock, read as Chicago local, is 23:00Z, NOT 22:00Z.
    // Taking the epoch at face value would place the appointment an hour early.
    expect(b.range.start).toBe('2026-06-11T23:00:00Z');
    expect(b.range.end).toBe('2026-06-12T00:00:00Z');
  });

  it('is a no-op for a location already in Booker’s server zone', async () => {
    on('/v4.1/merchant/appointments').reply(200, JSON.stringify({ Results: [appointment()] }), {
      headers: JSON_HEADERS,
    });
    const { bookings } = await eastern().listBookings({
      range: { start: '2026-06-11T00:00:00Z', end: '2026-06-13T00:00:00Z' },
    });
    expect(bookings[0]!.range.start).toBe('2026-06-11T18:00:00-04:00');
  });

  it('accepts an already-ISO datetime without applying the Eastern rule twice', async () => {
    on('/v4.1/merchant/appointments').reply(
      200,
      JSON.stringify({
        Results: [
          appointment({
            StartDateTime: '2026-06-11T22:00:00Z',
            EndDateTime: '2026-06-11T23:00:00Z',
          }),
        ],
      }),
      { headers: JSON_HEADERS },
    );
    const { bookings } = await client().listBookings({
      range: { start: '2026-06-11T00:00:00Z', end: '2026-06-13T00:00:00Z' },
    });
    expect(bookings[0]!.range.start).toBe('2026-06-11T22:00:00Z');
  });

  it('round-trips an instant back into the Eastern-anchored .NET form on write', async () => {
    let sent: any;
    agent
      .get(ORIGIN)
      .intercept({
        path: (p) => p.startsWith('/v4.1/customer/appointment/create'),
        method: 'POST',
      })
      .reply(200, (opts: any) => {
        sent = JSON.parse(String(opts.body));
        return { Appointment: appointment() };
      });

    await client().createBooking({
      title: 'Haircut',
      range: { start: '2026-06-11T23:00:00Z', end: '2026-06-12T00:00:00Z' },
      serviceId: '55',
      staffId: '7',
      customer: { name: 'Dana Lee', email: 'dana@example.com' },
    });

    const slot = sent.ItineraryTimeSlotList[0].TreatmentTimeSlots[0];
    // 23:00Z is 18:00 in Chicago; sent back as 18:00 Eastern = 22:00Z epoch.
    expect(slot.StartDateTime).toBe(`/Date(${Date.UTC(2026, 5, 11, 22, 0, 0)})/`);
    expect(slot.Duration).toBe(60);
    expect(slot.TreatmentID).toBe('55');
    expect(slot.EmployeeID).toBe('7');
    expect(sent.Customer).toMatchObject({ FirstName: 'Dana', LastName: 'Lee' });
  });
});

describe('booker bookings', () => {
  it('maps status from the cancelled/no-show flags', async () => {
    for (const [over, expected] of [
      [{}, 'confirmed'],
      [{ IsCancelled: true }, 'cancelled'],
      [{ IsNoShow: true }, 'no_show'],
    ] as const) {
      on('/v4.1/merchant/appointments').reply(
        200,
        JSON.stringify({ Results: [appointment(over)] }),
        { headers: JSON_HEADERS },
      );
      const { bookings } = await client().listBookings({
        range: { start: '2026-06-11T00:00:00Z', end: '2026-06-13T00:00:00Z' },
      });
      expect(bookings[0]!.status).toBe(expected);
    }
  });

  it('cancels by ID through the customer cancel path', async () => {
    let sent: any;
    agent
      .get(ORIGIN)
      .intercept({
        path: (p) => p.startsWith('/v4.1/customer/appointment/cancel'),
        method: 'PUT',
      })
      .reply(200, (opts: any) => {
        sent = JSON.parse(String(opts.body));
        return {};
      });
    await client().cancelBooking('900');
    expect(sent).toEqual({ ID: '900' });
  });

  it('refuses updateBooking rather than silently confirming the appointment', async () => {
    await expect(client().updateBooking('900', { title: 'x' })).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
  });

  it('refuses appointment availability rather than guessing an endpoint', async () => {
    await expect(
      client().searchAvailability({
        range: { start: '2026-06-11T00:00:00Z', end: '2026-06-12T00:00:00Z' },
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(client().capabilities.availability).toBe(false);
  });
});

describe('booker catalog, staff and categories', () => {
  const treatments = {
    Results: [
      {
        ID: 55,
        Name: 'Haircut',
        Description: 'Cut and style',
        TotalDuration: 45,
        Category: 'Hair',
        EmployeeIDs: [7, 8],
        IsActive: true,
        Price: { Amount: 42.5, CurrencyCode: 'USD' },
      },
      { ID: 56, Name: 'Manicure', TotalDuration: 30, Category: 'Nails', EmployeeIDs: [8] },
    ],
  };

  it('maps treatments, including the staff link and money in minor units', async () => {
    on('/v4.1/merchant/treatments').reply(200, JSON.stringify(treatments), {
      headers: JSON_HEADERS,
    });
    const { services } = await client().listServices!();
    expect(services[0]).toMatchObject({
      id: '55',
      name: 'Haircut',
      durationMinutes: 45,
      categoryId: 'Hair',
      categoryName: 'Hair',
      staffIds: ['7', '8'],
      price: { amount: 4250, currency: 'USD' },
      active: true,
    });
  });

  it('filters services by staffId and categoryId', async () => {
    on('/v4.1/merchant/treatments').reply(200, JSON.stringify(treatments), {
      headers: JSON_HEADERS,
    });
    expect((await client().listServices!({ staffId: '7' })).services.map((s) => s.id)).toEqual([
      '55',
    ]);

    on('/v4.1/merchant/treatments').reply(200, JSON.stringify(treatments), {
      headers: JSON_HEADERS,
    });
    expect(
      (await client().listServices!({ categoryId: 'Nails' })).services.map((s) => s.id),
    ).toEqual(['56']);
  });

  it('derives de-duplicated categories whose ids join back onto categoryId', async () => {
    on('/v4.1/merchant/treatments').reply(200, JSON.stringify(treatments), {
      headers: JSON_HEADERS,
    });
    const { categories } = await client().listCategories!();
    expect(categories.map((c) => c.id)).toEqual(['Hair', 'Nails']);
    expect(categories.every((c) => c.id === c.name)).toBe(true);
  });

  it('maps employees to staff with a joined name', async () => {
    on('/v4.1/merchant/employees').reply(
      200,
      JSON.stringify({ Results: [{ ID: 7, FirstName: 'Ana', LastName: 'Diaz' }] }),
      { headers: JSON_HEADERS },
    );
    const { staff } = await client().listStaff!();
    expect(staff[0]).toMatchObject({ id: '7', name: 'Ana Diaz', active: true });
  });

  it('filters staff by serviceId using the treatment the link lives on', async () => {
    on('/v4.1/merchant/employees').reply(
      200,
      JSON.stringify({
        Results: [
          { ID: 7, FirstName: 'Ana', LastName: 'Diaz' },
          { ID: 8, FirstName: 'Bo', LastName: 'Ng' },
        ],
      }),
      { headers: JSON_HEADERS },
    );
    on('/v4.1/merchant/treatments').reply(200, JSON.stringify(treatments), {
      headers: JSON_HEADERS,
    });
    const { staff } = await client().listStaff!({ serviceId: '56' });
    expect(staff.map((s) => s.id)).toEqual(['8']);
  });
});

describe('booker business hours', () => {
  it('maps day schedules, accepting a numeric weekday', async () => {
    agent
      .get(ORIGIN)
      .intercept({
        path: (p) => p.split('?')[0]!.startsWith('/v4.1/merchant/location/L1/schedule'),
      })
      .reply(
        200,
        JSON.stringify({
          LocationDaySchedules: [
            { Weekday: 1, StartTime: '09:00:00', EndTime: '17:30:00' },
            { Weekday: 0, StartTime: '11:00:00', EndTime: '15:00:00' },
            { Weekday: 9, StartTime: '09:00:00', EndTime: '17:00:00' },
          ],
        }),
        { headers: JSON_HEADERS },
      );

    const hours = await client().getBusinessHours!();
    expect(hours.timezone).toBe('America/Chicago');
    // Monday-first ordering, seconds dropped, and Weekday 9 dropped entirely:
    // wrapping it modulo 7 would advertise Tuesday hours nobody set.
    expect(hours.periods).toEqual([
      { dayOfWeek: 'MON', start: '09:00', end: '17:30' },
      { dayOfWeek: 'SUN', start: '11:00', end: '15:00' },
    ]);
  });
});

describe('booker classes', () => {
  function classInstance(over: Record<string, unknown> = {}) {
    return {
      ID: 501,
      StartDateTime: DOT_NET,
      EndDateTime: DOT_NET_END,
      TotalCapacity: 20,
      NumReserved: 12,
      HasClassFilled: false,
      IsEnrollable: true,
      RoomName: 'Studio A',
      Teacher: { ID: 7 },
      Treatment: { ID: 55, Name: 'Vinyasa Flow' },
      ...over,
    };
  }

  it('maps a class instance with capacity', async () => {
    on('/v4.1/customer/availability/class').reply(
      200,
      JSON.stringify({ Results: [classInstance()] }),
      { headers: JSON_HEADERS },
    );
    const { classes } = await client().listClasses!({
      range: { start: '2026-06-11T00:00:00Z', end: '2026-06-13T00:00:00Z' },
    });
    const k = classes[0]!;
    assertCanonicalClassSession(k, 'booker');
    expect(k).toMatchObject({
      id: '501',
      title: 'Vinyasa Flow',
      serviceId: '55',
      staffId: '7',
      location: 'Studio A',
      capacity: 20,
      booked: 12,
      available: 8,
      full: false,
    });
    expect(k.range.start).toBe('2026-06-11T23:00:00Z');
  });

  it('trusts HasClassFilled and IsEnrollable over the counts', async () => {
    for (const over of [{ HasClassFilled: true }, { IsEnrollable: false }]) {
      on('/v4.1/customer/availability/class').reply(
        200,
        JSON.stringify({ Results: [classInstance(over)] }),
        { headers: JSON_HEADERS },
      );
      const { classes } = await client().listClasses!({
        range: { start: '2026-06-11T00:00:00Z', end: '2026-06-13T00:00:00Z' },
      });
      expect(classes[0]!.available).toBe(8);
      expect(classes[0]!.full).toBe(true);
    }
  });

  it('enrolls into an open class and tags the booking with classId', async () => {
    on('/v4.1/customer/availability/class').reply(
      200,
      JSON.stringify({ Results: [classInstance()] }),
      { headers: JSON_HEADERS },
    );
    let sent: any;
    agent
      .get(ORIGIN)
      .intercept({
        path: (p) => p.startsWith('/v4.1/customer/class_appointment/create'),
        method: 'POST',
      })
      .reply(200, (opts: any) => {
        sent = JSON.parse(String(opts.body));
        return { Appointment: appointment({ ID: 901 }) };
      });

    const b = await client().enrollInClass!({
      classId: '501',
      customer: { id: '42', name: 'Dana Lee' },
    });
    expect(sent).toMatchObject({ LocationID: 'L1', ClassInstanceID: '501' });
    expect(b.classId).toBe('501');
    expect(b.status).toBe('confirmed');
    expect(b.title).toBe('Vinyasa Flow');
  });

  it('conflicts on a full class, and says Booker has no waitlist', async () => {
    on('/v4.1/customer/availability/class').reply(
      200,
      JSON.stringify({ Results: [classInstance({ HasClassFilled: true })] }),
      { headers: JSON_HEADERS },
    );
    // No create interceptor: reaching the write would fail outright, so this
    // also proves nothing was written.
    await expect(
      client().enrollInClass!({
        classId: '501',
        customer: { id: '42' },
        allowWaitlist: true,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(client().capabilities.classWaitlist).toBe(false);
  });
});

describe('booker auth headers', () => {
  it('sends the bearer token and the subscription key Booker requires', async () => {
    let headers: any;
    agent
      .get(ORIGIN)
      .intercept({ path: (p) => p.startsWith('/v4.1/merchant/location/L1'), method: 'GET' })
      .reply(200, (opts: any) => {
        headers = opts.headers;
        return { Location: { ID: 'L1', Name: 'Downtown' } };
      });

    const status = await client().checkConnection();
    expect(status.ok).toBe(true);
    const flat = JSON.stringify(headers).toLowerCase();
    expect(flat).toContain('bearer t');
    expect(flat).toContain('ocp-apim-subscription-key');
  });
});

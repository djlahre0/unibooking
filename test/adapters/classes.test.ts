import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import { mindbody } from '../../src/adapters/mindbody';
import { acuity } from '../../src/adapters/acuity';
import { UnibookingError } from '../../src/errors';
import { assertCanonicalClassSession } from '../conformance';
import type { BookingClient } from '../../src/types';

const JSON_HEADERS = { 'content-type': 'application/json' };
const MB_ORIGIN = 'https://api.mindbodyonline.com';
const AC_ORIGIN = 'https://acuityscheduling.com';

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

function path(origin: string, prefix: string, method = 'GET') {
  return agent.get(origin).intercept({
    path: (p) => p.split('?')[0]!.startsWith(prefix),
    method,
  });
}

// --- Mindbody --------------------------------------------------------------

const mbClient = (): BookingClient =>
  mindbody({
    apiKey: 'k',
    siteId: '-99',
    accessToken: 't',
    timezone: 'America/Los_Angeles',
  });

/** A Mindbody class as the v6 API shapes it: site-local, offset-less times. */
function mbClass(over: Record<string, unknown> = {}) {
  return {
    Id: 501,
    StartDateTime: '2030-06-11T18:00:00',
    EndDateTime: '2030-06-11T19:00:00',
    MaxCapacity: 20,
    TotalBooked: 12,
    WebCapacity: 5,
    TotalBookedWaitlist: 1,
    IsAvailable: true,
    IsCanceled: false,
    ClassDescription: { Id: 77, Name: 'Vinyasa Flow', Description: 'All levels' },
    Staff: { Id: 9, Name: 'Ana' },
    Location: { Name: 'Studio A' },
    ...over,
  };
}

describe('mindbody classes', () => {
  it('maps a class to the canonical shape, anchoring site-local times in the site zone', async () => {
    path(MB_ORIGIN, '/public/v6/class/classes').reply(
      200,
      JSON.stringify({ Classes: [mbClass()] }),
      { headers: JSON_HEADERS },
    );

    const { classes } = await mbClient().listClasses!();
    expect(classes).toHaveLength(1);
    const k = classes[0]!;
    assertCanonicalClassSession(k, 'mindbody');
    expect(k.id).toBe('501');
    expect(k.title).toBe('Vinyasa Flow');
    expect(k.serviceId).toBe('77');
    expect(k.staffId).toBe('9');
    expect(k.location).toBe('Studio A');
    // 18:00 America/Los_Angeles in June is PDT (UTC-7) -> 01:00Z next day.
    expect(k.range.start).toBe('2030-06-12T01:00:00Z');
    expect(k.capacity).toBe(20);
    expect(k.booked).toBe(12);
    expect(k.available).toBe(8);
    expect(k.full).toBe(false);
    expect(k.waitlistCapacity).toBe(5);
    expect(k.waitlistCount).toBe(1);
    expect(k.status).toBe('scheduled');
  });

  it('trusts IsAvailable over the numbers when they disagree', async () => {
    // Spots remain, but Mindbody says the class cannot be booked. Deriving
    // `full` from capacity - booked would call this bookable and the enroll
    // would then fail upstream for no visible reason.
    path(MB_ORIGIN, '/public/v6/class/classes').reply(
      200,
      JSON.stringify({ Classes: [mbClass({ IsAvailable: false })] }),
      { headers: JSON_HEADERS },
    );

    const { classes } = await mbClient().listClasses!();
    expect(classes[0]!.available).toBe(8);
    expect(classes[0]!.full).toBe(true);
  });

  it('reports a cancelled class as cancelled', async () => {
    path(MB_ORIGIN, '/public/v6/class/classes').reply(
      200,
      JSON.stringify({ Classes: [mbClass({ IsCanceled: true })] }),
      { headers: JSON_HEADERS },
    );
    const { classes } = await mbClient().listClasses!();
    expect(classes[0]!.status).toBe('cancelled');
  });

  it('enrolls a client and returns a booking that carries classId', async () => {
    path(MB_ORIGIN, '/public/v6/class/classes').reply(
      200,
      JSON.stringify({ Classes: [mbClass()] }),
      { headers: JSON_HEADERS },
    );
    path(MB_ORIGIN, '/public/v6/class/addclienttoclass', 'POST').reply(
      200,
      JSON.stringify({ Class: mbClass({ TotalBooked: 13 }) }),
      { headers: JSON_HEADERS },
    );

    const booking = await mbClient().enrollInClass!({
      classId: '501',
      customer: { id: 'client-1', name: 'Dana' },
    });

    expect(booking.classId).toBe('501');
    expect(booking.status).toBe('confirmed');
    expect(booking.title).toBe('Vinyasa Flow');
    expect(booking.customer?.id).toBe('client-1');
    // The id must carry what RemoveClientFromClass needs, not the visit id.
    expect(booking.id).toBe('class:501:client-1');
  });

  it('refuses to enroll into a full class without allowWaitlist', async () => {
    path(MB_ORIGIN, '/public/v6/class/classes').reply(
      200,
      JSON.stringify({ Classes: [mbClass({ TotalBooked: 20 })] }),
      { headers: JSON_HEADERS },
    );

    // No POST interceptor is registered: reaching the write would throw a
    // connect error instead, so this also proves the write never happened.
    await expect(
      mbClient().enrollInClass!({ classId: '501', customer: { id: 'c1' } }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('joins the waitlist when the class is full and allowWaitlist is set', async () => {
    path(MB_ORIGIN, '/public/v6/class/classes').reply(
      200,
      JSON.stringify({ Classes: [mbClass({ TotalBooked: 20 })] }),
      { headers: JSON_HEADERS },
    );
    let sent: any;
    agent
      .get(MB_ORIGIN)
      .intercept({
        path: (p) => p.startsWith('/public/v6/class/addclienttoclass'),
        method: 'POST',
      })
      .reply(200, (opts: any) => {
        sent = JSON.parse(String(opts.body));
        return { Class: mbClass() };
      });

    const booking = await mbClient().enrollInClass!({
      classId: '501',
      customer: { id: 'c1' },
      allowWaitlist: true,
    });

    expect(sent.Waitlist).toBe(true);
    expect(booking.status).toBe('waitlisted');
  });

  it('refuses to enroll into a cancelled class even with allowWaitlist', async () => {
    path(MB_ORIGIN, '/public/v6/class/classes').reply(
      200,
      JSON.stringify({ Classes: [mbClass({ IsCanceled: true, TotalBooked: 20 })] }),
      { headers: JSON_HEADERS },
    );

    await expect(
      mbClient().enrollInClass!({
        classId: '501',
        customer: { id: 'c1' },
        allowWaitlist: true,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('cancelBooking routes a tagged enrollment id to removeclientfromclass', async () => {
    let sent: any;
    agent
      .get(MB_ORIGIN)
      .intercept({
        path: (p) => p.startsWith('/public/v6/class/removeclientfromclass'),
        method: 'POST',
      })
      .reply(200, (opts: any) => {
        sent = JSON.parse(String(opts.body));
        return {};
      });

    await mbClient().cancelBooking('class:501:client-1');
    expect(sent).toMatchObject({ ClassId: 501, ClientId: 'client-1' });
    agent.assertNoPendingInterceptors();
  });

  it('cancelBooking still routes a plain appointment id to the appointment path', async () => {
    let hit = false;
    agent
      .get(MB_ORIGIN)
      .intercept({
        path: (p) => p.startsWith('/public/v6/appointment/updateappointment'),
        method: 'POST',
      })
      .reply(200, () => {
        hit = true;
        return {};
      });

    await mbClient().cancelBooking('12345');
    expect(hit).toBe(true);
  });

  it('rejects a malformed enrollment id rather than guessing', async () => {
    await expect(mbClient().cancelBooking('class:')).rejects.toBeInstanceOf(UnibookingError);
    await expect(mbClient().cancelBooking('class:501')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('getClass surfaces a missing class as NOT_FOUND', async () => {
    path(MB_ORIGIN, '/public/v6/class/classes').reply(200, JSON.stringify({ Classes: [] }), {
      headers: JSON_HEADERS,
    });
    await expect(mbClient().getClass!('999')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

// --- Acuity ----------------------------------------------------------------

const acClient = (): BookingClient => acuity({ userId: 'u', apiKey: 'k', currency: 'USD' });

function acClass(over: Record<string, unknown> = {}) {
  return {
    time: '2030-06-11T18:00:00-0700',
    duration: '60',
    slots: 20,
    slotsAvailable: 8,
    appointmentTypeID: 77,
    calendarID: 9,
    calendar: 'Studio A',
    name: 'Vinyasa Flow',
    price: '25.00',
    ...over,
  };
}

describe('acuity classes', () => {
  it('maps a class, normalising the offset and deriving the end from duration', async () => {
    path(AC_ORIGIN, '/api/v1/availability/classes').reply(200, JSON.stringify([acClass()]), {
      headers: JSON_HEADERS,
    });

    const { classes } = await acClient().listClasses!({ serviceId: '77' });
    expect(classes).toHaveLength(1);
    const k = classes[0]!;
    assertCanonicalClassSession(k, 'acuity');
    // Acuity's -0700 must become RFC3339 -07:00.
    expect(k.range.start).toBe('2030-06-11T18:00:00-07:00');
    expect(k.range.end).toBe('2030-06-11T19:00:00-07:00');
    expect(k.capacity).toBe(20);
    expect(k.available).toBe(8);
    expect(k.booked).toBe(12);
    expect(k.full).toBe(false);
    expect(k.price).toEqual({ amount: 2500, currency: 'USD' });
    // The id must carry both halves the enroll write needs.
    expect(k.id).toBe('77@2030-06-11T18:00:00-07:00');
  });

  it('marks a class with no remaining slots as full', async () => {
    path(AC_ORIGIN, '/api/v1/availability/classes').reply(
      200,
      JSON.stringify([acClass({ slotsAvailable: 0 })]),
      { headers: JSON_HEADERS },
    );
    const { classes } = await acClient().listClasses!({ serviceId: '77' });
    expect(classes[0]!.full).toBe(true);
    expect(classes[0]!.booked).toBe(20);
  });

  it('enumerates only class-flagged appointment types when no serviceId is given', async () => {
    path(AC_ORIGIN, '/api/v1/appointment-types').reply(
      200,
      JSON.stringify([
        { id: 77, name: 'Vinyasa Flow', class: true },
        { id: 78, name: 'Haircut', class: false },
      ]),
      { headers: JSON_HEADERS },
    );
    // Exactly one classes call is registered; a second (for the non-class type)
    // would fail with no interceptor.
    path(AC_ORIGIN, '/api/v1/availability/classes').reply(200, JSON.stringify([acClass()]), {
      headers: JSON_HEADERS,
    });

    const { classes } = await acClient().listClasses!();
    expect(classes).toHaveLength(1);
    agent.assertNoPendingInterceptors();
  });

  it('filters out classes that fall outside the requested window', async () => {
    path(AC_ORIGIN, '/api/v1/availability/classes').reply(
      200,
      JSON.stringify([
        acClass({ time: '2030-06-11T18:00:00-0700' }),
        acClass({ time: '2030-06-25T18:00:00-0700' }),
      ]),
      { headers: JSON_HEADERS },
    );

    const { classes } = await acClient().listClasses!({
      serviceId: '77',
      range: { start: '2030-06-10T00:00:00Z', end: '2030-06-13T00:00:00Z' },
    });
    expect(classes).toHaveLength(1);
    expect(classes[0]!.range.start).toBe('2030-06-11T18:00:00-07:00');
  });

  it('enrolls and tags the returned booking with classId', async () => {
    path(AC_ORIGIN, '/api/v1/availability/classes').reply(200, JSON.stringify([acClass()]), {
      headers: JSON_HEADERS,
    });
    path(AC_ORIGIN, '/api/v1/appointments', 'POST').reply(
      200,
      JSON.stringify({
        id: 900,
        datetime: '2030-06-11T18:00:00-0700',
        duration: '60',
        appointmentTypeID: 77,
        calendarID: 9,
        firstName: 'Dana',
        lastName: 'Lee',
        email: 'dana@example.com',
        type: 'Vinyasa Flow',
      }),
      { headers: JSON_HEADERS },
    );

    const booking = await acClient().enrollInClass!({
      classId: '77@2030-06-11T18:00:00-07:00',
      customer: { name: 'Dana Lee', email: 'dana@example.com' },
    });

    expect(booking.id).toBe('900');
    expect(booking.classId).toBe('77@2030-06-11T18:00:00-07:00');
    expect(booking.status).toBe('confirmed');
  });

  it('refuses a full class, and says so even when a waitlist was requested', async () => {
    path(AC_ORIGIN, '/api/v1/availability/classes').reply(
      200,
      JSON.stringify([acClass({ slotsAvailable: 0 })]),
      { headers: JSON_HEADERS },
    );

    await expect(
      acClient().enrollInClass!({
        classId: '77@2030-06-11T18:00:00-07:00',
        customer: { name: 'Dana Lee', email: 'd@example.com' },
        allowWaitlist: true,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('rejects a malformed class id', async () => {
    await expect(acClient().getClass!('77')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

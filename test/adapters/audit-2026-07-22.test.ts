import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import { acuity } from '../../src/adapters/acuity';
import { bookeo } from '../../src/adapters/bookeo';
import { calendly } from '../../src/adapters/calendly';
import { microsoftBookings } from '../../src/adapters/microsoft_bookings';
import { square } from '../../src/adapters/square';
import { verifyGraphClientState } from '../../src/webhooks/outlook';
import { verifyCalendlySignature } from '../../src/webhooks/calendly';
import { verifyRs256Jwt } from '../../src/crypto';
import { isUnibookingError } from '../../src/errors';

/**
 * Regression tests for the bugs found in the 2026-07-22 audit. Each asserts the
 * corrected behavior so the fix can't silently regress.
 */

const JSON_HEADERS = { 'content-type': 'application/json' };

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

const code = async (p: Promise<unknown>): Promise<string | undefined> => {
  const e = await p.then(() => undefined).catch((err) => err);
  return isUnibookingError(e) ? e.code : undefined;
};

// ---------------------------------------------------------------------------
// Microsoft Bookings — getStaffAvailability response shape
// ---------------------------------------------------------------------------
describe('AUDIT microsoft_bookings: searchAvailability', () => {
  const RANGE = { start: '2026-07-20T08:00:00Z', end: '2026-07-20T18:00:00Z' };

  function mockAvailability(items: unknown[]): void {
    const pool = agent.get('https://graph.microsoft.com');
    pool
      .intercept({ path: (p) => p.includes('/staffMembers'), method: 'GET' })
      .reply(200, JSON.stringify({ value: [{ id: 'staff-1' }] }), { headers: JSON_HEADERS });
    pool
      .intercept({ path: (p) => p.includes('/getStaffAvailability'), method: 'POST' })
      .reply(
        200,
        // Documented wrapper is `staffAvailabilityItem`, NOT the usual OData
        // `value` — reading `value` returned an empty list for every business.
        JSON.stringify({
          staffAvailabilityItem: [{ staffId: 'staff-1', availabilityItems: items }],
        }),
        { headers: JSON_HEADERS },
      );
  }

  it('reads the staffAvailabilityItem wrapper instead of returning nothing', async () => {
    mockAvailability([
      {
        status: 'available',
        startDateTime: { dateTime: '2026-07-20T09:00:00.0000000', timeZone: 'UTC' },
        endDateTime: { dateTime: '2026-07-20T09:30:00.0000000', timeZone: 'UTC' },
      },
    ]);
    const slots = await microsoftBookings({ accessToken: 't', businessId: 'b@x.com' }).searchAvailability({
      range: RANGE,
    });
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({ start: '2026-07-20T09:00:00Z', staffId: 'staff-1' });
  });

  it('keeps slotsAvailable windows (1:n group services still have capacity)', async () => {
    mockAvailability([
      {
        status: 'slotsAvailable',
        startDateTime: { dateTime: '2026-07-20T11:00:00.0000000', timeZone: 'UTC' },
        endDateTime: { dateTime: '2026-07-20T11:30:00.0000000', timeZone: 'UTC' },
      },
      {
        status: 'busy',
        startDateTime: { dateTime: '2026-07-20T12:00:00.0000000', timeZone: 'UTC' },
        endDateTime: { dateTime: '2026-07-20T12:30:00.0000000', timeZone: 'UTC' },
      },
    ]);
    const slots = await microsoftBookings({ accessToken: 't', businessId: 'b@x.com' }).searchAvailability({
      range: RANGE,
    });
    expect(slots.map((s) => s.start)).toEqual(['2026-07-20T11:00:00Z']);
  });

  it('resolves a Windows display-name timezone instead of mislabelling it UTC', async () => {
    // Bookings returns "(UTC-08:00) Pacific Time (US & Canada)" with offset-less
    // dateTimes; neither the IANA map nor Intl can parse it, so an unhandled
    // value silently became 8 hours wrong.
    mockAvailability([
      {
        status: 'available',
        startDateTime: {
          dateTime: '2026-07-20T09:00:00.0000000',
          timeZone: '(UTC-08:00) Pacific Time (US & Canada)',
        },
        endDateTime: {
          dateTime: '2026-07-20T09:30:00.0000000',
          timeZone: '(UTC-08:00) Pacific Time (US & Canada)',
        },
      },
    ]);
    const slots = await microsoftBookings({ accessToken: 't', businessId: 'b@x.com' }).searchAvailability({
      range: RANGE,
    });
    expect(slots[0]!.start).toBe('2026-07-20T17:00:00Z');
  });

  it('rejects a status update instead of silently no-op-ing the cancel', async () => {
    const client = microsoftBookings({ accessToken: 't', businessId: 'b@x.com' });
    expect(await code(client.updateBooking('a1', { status: 'cancelled' }))).toBe('INVALID_INPUT');
  });
});

// ---------------------------------------------------------------------------
// Calendly — the create endpoint requires invitee.timezone
// ---------------------------------------------------------------------------
describe('AUDIT calendly: createBooking', () => {
  it('always sends invitee.timezone (the API requires it; range.timezone is optional)', async () => {
    let body: any;
    const pool = agent.get('https://api.calendly.com');
    pool.intercept({ path: '/invitees', method: 'POST' }).reply(
      201,
      (opts: any) => {
        body = JSON.parse(String(opts.body));
        return JSON.stringify({ resource: { uri: 'https://api.calendly.com/invitees/i1', event: 'https://api.calendly.com/scheduled_events/e1' } });
      },
      { headers: JSON_HEADERS },
    );
    pool.intercept({ path: (p) => p.startsWith('/scheduled_events/e1'), method: 'GET' }).reply(
      200,
      JSON.stringify({
        resource: {
          uri: 'https://api.calendly.com/scheduled_events/e1',
          name: 'Intro',
          status: 'active',
          start_time: '2026-07-20T09:00:00Z',
          end_time: '2026-07-20T09:30:00Z',
        },
      }),
      { headers: JSON_HEADERS },
    );

    await calendly({ token: 't' }).createBooking({
      title: 'Intro',
      range: { start: '2026-07-20T09:00:00Z', end: '2026-07-20T09:30:00Z' },
      serviceId: 'https://api.calendly.com/event_types/et1',
      customer: { email: 'jane@example.com' },
    });
    expect(body.invitee.timezone).toBe('UTC');
  });

  it('honors a credential-level defaultTimezone', async () => {
    let body: any;
    const pool = agent.get('https://api.calendly.com');
    pool.intercept({ path: '/invitees', method: 'POST' }).reply(
      201,
      (opts: any) => {
        body = JSON.parse(String(opts.body));
        return JSON.stringify({
          resource: {
            uri: 'https://api.calendly.com/scheduled_events/e2',
            status: 'active',
            start_time: '2026-07-20T09:00:00Z',
            end_time: '2026-07-20T09:30:00Z',
          },
        });
      },
      { headers: JSON_HEADERS },
    );
    await calendly({ token: 't', defaultTimezone: 'America/New_York' }).createBooking({
      title: 'Intro',
      range: { start: '2026-07-20T09:00:00Z', end: '2026-07-20T09:30:00Z' },
      serviceId: 'et1',
      customer: { email: 'jane@example.com' },
    });
    expect(body.invitee.timezone).toBe('America/New_York');
  });

  it('maps a confirmed status filter to active and clamps count to the documented max', async () => {
    let path = '';
    agent
      .get('https://api.calendly.com')
      .intercept({ path: (p) => p.startsWith('/scheduled_events'), method: 'GET' })
      .reply(
        200,
        (opts: any) => {
          path = String(opts.path);
          return JSON.stringify({ collection: [], pagination: {} });
        },
        { headers: JSON_HEADERS },
      );
    await calendly({ token: 't', user: 'https://api.calendly.com/users/u1' }).listBookings({
      range: { start: '2026-07-20T00:00:00Z', end: '2026-07-21T00:00:00Z' },
      status: 'confirmed',
      limit: 500,
    });
    expect(path).toContain('status=active');
    expect(path).toContain('count=100');
  });
});

// ---------------------------------------------------------------------------
// Square / Acuity write-path fidelity
// ---------------------------------------------------------------------------
describe('AUDIT square', () => {
  it('sends the title as customer_note on create (it was dropped entirely)', async () => {
    let body: any;
    agent
      .get('https://connect.squareup.com')
      .intercept({ path: '/v2/bookings', method: 'POST' })
      .reply(
        200,
        (opts: any) => {
          body = JSON.parse(String(opts.body));
          return JSON.stringify({
            booking: {
              id: 'B1',
              start_at: '2026-07-20T22:00:00Z',
              status: 'ACCEPTED',
              appointment_segments: [{ duration_minutes: 30 }],
            },
          });
        },
        { headers: JSON_HEADERS },
      );
    await square({ accessToken: 't', locationId: 'L' }).createBooking({
      title: 'Haircut — Jane',
      range: { start: '2026-07-20T22:00:00Z', end: '2026-07-20T22:30:00Z' },
    });
    expect(body.booking.customer_note).toBe('Haircut — Jane');
  });

  it('rejects a status update rather than issuing a PUT that changes nothing', async () => {
    const client = square({ accessToken: 't', locationId: 'L' });
    expect(await code(client.updateBooking('B1', { status: 'cancelled' }))).toBe('INVALID_INPUT');
  });
});

describe('AUDIT acuity', () => {
  const APPT = {
    id: 55,
    datetime: '2026-07-20T09:00:00-0700',
    duration: '30',
    type: 'Cut',
  };

  it('trims list results to the requested instants (minDate/maxDate are whole days)', async () => {
    agent
      .get('https://acuityscheduling.com')
      .intercept({ path: (p) => p.startsWith('/api/v1/appointments'), method: 'GET' })
      .reply(
        200,
        JSON.stringify([
          { ...APPT, id: 1, datetime: '2026-07-20T08:00:00-0700' }, // before the window
          { ...APPT, id: 2, datetime: '2026-07-20T11:00:00-0700' }, // inside
          { ...APPT, id: 3, datetime: '2026-07-20T20:00:00-0700' }, // after
        ]),
        { headers: JSON_HEADERS },
      );
    const res = await acuity({ userId: 'u', apiKey: 'k' }).listBookings({
      range: { start: '2026-07-20T10:00:00-07:00', end: '2026-07-20T17:00:00-07:00' },
    });
    expect(res.bookings.map((b) => b.id)).toEqual(['2']);
  });

  it('rejects the edits Acuity would silently discard instead of reporting success', async () => {
    const client = acuity({ userId: 'u', apiKey: 'k' });
    expect(await code(client.updateBooking('55', { status: 'cancelled' }))).toBe('INVALID_INPUT');
    expect(await code(client.updateBooking('55', { serviceId: 'svc2' }))).toBe('UNSUPPORTED');
    expect(await code(client.updateBooking('55', { staffId: 'cal2' }))).toBe('UNSUPPORTED');
  });
});

describe('AUDIT bookeo', () => {
  it('rejects update fields its PUT would quietly discard', async () => {
    const client = bookeo({ apiKey: 'k', secretKey: 's' });
    expect(await code(client.updateBooking('B1', { status: 'cancelled' }))).toBe('INVALID_INPUT');
    expect(await code(client.updateBooking('B1', { title: 'New name' }))).toBe('UNSUPPORTED');
    expect(await code(client.updateBooking('B1', { serviceId: 'p2' }))).toBe('UNSUPPORTED');
  });
});

// ---------------------------------------------------------------------------
// Webhook + crypto hardening
// ---------------------------------------------------------------------------
describe('AUDIT webhooks', () => {
  it('rejects a Graph notification when the expected clientState is empty', () => {
    // A missing env var must not turn every forged payload into a valid one.
    expect(verifyGraphClientState({ value: [{ clientState: '' }] }, '')).toBe(false);
    expect(verifyGraphClientState({ value: [{ clientState: 's3cret' }] }, 's3cret')).toBe(true);
  });

  it('rejects a replayed Calendly delivery once a tolerance is set', async () => {
    const key = 'whsec';
    const body = '{"event":"invitee.created"}';
    const t = 1_800_000_000; // unix seconds
    const { createHmac } = await import('node:crypto');
    const v1 = createHmac('sha256', key).update(`${t}.${body}`).digest('hex');
    const input = { signingKey: key, body, signatureHeader: `t=${t},v1=${v1}` };

    expect(await verifyCalendlySignature(input)).toBe(true);
    expect(
      await verifyCalendlySignature({ ...input, toleranceMs: 180_000, now: () => t * 1000 + 60_000 }),
    ).toBe(true);
    expect(
      await verifyCalendlySignature({ ...input, toleranceMs: 180_000, now: () => t * 1000 + 600_000 }),
    ).toBe(false);
  });

  it('returns null (not a rejection) for a JWT whose signature is not base64url', async () => {
    const pem = '-----BEGIN PUBLIC KEY-----\nnot-a-real-key\n-----END PUBLIC KEY-----';
    await expect(verifyRs256Jwt('eyJhbGciOiJSUzI1NiJ9.eyJhIjoxfQ.!!!', pem)).resolves.toBeNull();
  });
});

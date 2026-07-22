import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import { createRegistry, isUnibookingError } from '../src/index';
import { google } from '../src/adapters/google';
import { square } from '../src/adapters/square';

/**
 * End-to-end walkthrough against mocked HTTP — the assertion-backed companion to
 * examples/usage.ts. Guards the headline correctness fixes.
 */
describe('end-to-end (mocked)', () => {
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

  const jsonHeaders = { 'content-type': 'application/json' };

  it('a Square booking has a real (non-zero) end derived from duration', async () => {
    agent
      .get('https://connect.squareup.com')
      .intercept({ path: '/v2/bookings', method: 'POST' })
      .reply(
        200,
        JSON.stringify({
          booking: {
            id: 'B1',
            start_at: '2026-07-20T22:00:00Z',
            status: 'ACCEPTED',
            appointment_segments: [{ duration_minutes: 30 }],
          },
        }),
        { headers: jsonHeaders },
      );

    const client = createRegistry([google, square]).get('square')({
      accessToken: 't',
      locationId: 'L',
    });
    const booking = await client.createBooking({
      title: 'Cut',
      range: { start: '2026-07-20T22:00:00Z', end: '2026-07-20T22:30:00Z' },
    });
    expect(booking.range.end).toBe('2026-07-20T22:30:00Z');
    expect(Date.parse(booking.range.end)).toBeGreaterThan(Date.parse(booking.range.start));
  });

  it('a 404 surfaces as NOT_FOUND', async () => {
    agent
      .get('https://connect.squareup.com')
      .intercept({ path: (p) => p.startsWith('/v2/bookings'), method: 'GET' })
      .reply(404, JSON.stringify({ errors: [{ code: 'NOT_FOUND', detail: 'nope' }] }), {
        headers: jsonHeaders,
      });
    const client = square({ accessToken: 't', locationId: 'L' });
    const err = await client.getBooking('missing').catch((e) => e);
    expect(isUnibookingError(err) && err.code).toBe('NOT_FOUND');
  });

  it('a 409 surfaces as CONFLICT', async () => {
    agent
      .get('https://connect.squareup.com')
      .intercept({ path: '/v2/bookings', method: 'POST' })
      .reply(409, JSON.stringify({ errors: [{ code: 'CONFLICT', detail: 'slot taken' }] }), {
        headers: jsonHeaders,
      });
    const client = square({ accessToken: 't', locationId: 'L' });
    const err = await client
      .createBooking({
        title: 'x',
        range: { start: '2026-07-20T22:00:00Z', end: '2026-07-20T22:30:00Z' },
      })
      .catch((e) => e);
    expect(isUnibookingError(err) && err.code).toBe('CONFLICT');
  });
});

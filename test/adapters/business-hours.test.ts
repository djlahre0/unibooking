import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import { square } from '../../src/adapters/square';

const JSON_HEADERS = { 'content-type': 'application/json' };
const ORIGIN = 'https://connect.squareup.com';

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

const client = () => square({ accessToken: 't', locationId: 'L1' });

function reply(location: unknown) {
  agent
    .get(ORIGIN)
    .intercept({ path: (p) => p.split('?')[0]!.startsWith('/v2/locations/L1'), method: 'GET' })
    .reply(200, JSON.stringify({ location }), { headers: JSON_HEADERS });
}

describe('square business hours', () => {
  it('maps periods to canonical HH:MM and carries the location timezone', async () => {
    reply({
      id: 'L1',
      timezone: 'America/Los_Angeles',
      business_hours: {
        periods: [
          { day_of_week: 'MON', start_local_time: '09:00:00', end_local_time: '17:30:00' },
          { day_of_week: 'SAT', start_local_time: '10:00:00', end_local_time: '14:00:00' },
        ],
      },
    });

    const hours = await client().getBusinessHours!();
    expect(hours.provider).toBe('square');
    expect(hours.timezone).toBe('America/Los_Angeles');
    // Seconds are dropped — the canonical form is HH:MM.
    expect(hours.periods).toEqual([
      { dayOfWeek: 'MON', start: '09:00', end: '17:30' },
      { dayOfWeek: 'SAT', start: '10:00', end: '14:00' },
    ]);
  });

  it('sorts Monday-first, then by start time, whatever order Square sent', async () => {
    reply({
      id: 'L1',
      business_hours: {
        periods: [
          { day_of_week: 'SUN', start_local_time: '11:00:00', end_local_time: '15:00:00' },
          { day_of_week: 'MON', start_local_time: '14:00:00', end_local_time: '18:00:00' },
          { day_of_week: 'MON', start_local_time: '09:00:00', end_local_time: '12:00:00' },
        ],
      },
    });

    const hours = await client().getBusinessHours!();
    expect(hours.periods.map((p) => `${p.dayOfWeek} ${p.start}`)).toEqual([
      'MON 09:00',
      'MON 14:00',
      'SUN 11:00',
    ]);
  });

  it('keeps a split shift as two periods on the same day', async () => {
    reply({
      id: 'L1',
      business_hours: {
        periods: [
          { day_of_week: 'TUE', start_local_time: '09:00:00', end_local_time: '12:00:00' },
          { day_of_week: 'TUE', start_local_time: '13:00:00', end_local_time: '17:00:00' },
        ],
      },
    });
    const hours = await client().getBusinessHours!();
    expect(hours.periods).toHaveLength(2);
    expect(hours.periods.every((p) => p.dayOfWeek === 'TUE')).toBe(true);
  });

  it('drops a malformed period rather than emitting a window nobody can place', async () => {
    reply({
      id: 'L1',
      business_hours: {
        periods: [
          { day_of_week: 'MON', start_local_time: '09:00:00', end_local_time: '17:00:00' },
          { day_of_week: 'NOTADAY', start_local_time: '09:00:00', end_local_time: '17:00:00' },
          { day_of_week: 'WED', start_local_time: 'garbage', end_local_time: '17:00:00' },
          { day_of_week: 'THU', start_local_time: '25:00:00', end_local_time: '17:00:00' },
          { day_of_week: 'FRI', end_local_time: '17:00:00' },
        ],
      },
    });

    const hours = await client().getBusinessHours!();
    expect(hours.periods).toEqual([{ dayOfWeek: 'MON', start: '09:00', end: '17:00' }]);
    // Nothing is lost: the dropped periods are still in raw.
    expect((hours.raw as any).business_hours.periods).toHaveLength(5);
  });

  it('returns an empty period list, not an error, when the location has no hours set', async () => {
    reply({ id: 'L1', timezone: 'UTC' });
    const hours = await client().getBusinessHours!();
    expect(hours.periods).toEqual([]);
    expect(hours.timezone).toBe('UTC');
  });

  it('omits timezone rather than guessing when Square does not report one', async () => {
    reply({ id: 'L1', business_hours: { periods: [] } });
    const hours = await client().getBusinessHours!();
    expect(hours.timezone).toBeUndefined();
  });

  it('accepts HH:MM without seconds', async () => {
    reply({
      id: 'L1',
      business_hours: {
        periods: [{ day_of_week: 'FRI', start_local_time: '08:30', end_local_time: '16:45' }],
      },
    });
    const hours = await client().getBusinessHours!();
    expect(hours.periods).toEqual([{ dayOfWeek: 'FRI', start: '08:30', end: '16:45' }]);
  });
});

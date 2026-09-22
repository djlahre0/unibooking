import { describe, it, expect, beforeEach } from 'vitest';
import { instantToZoned } from 'unibooking';
import { sampleClient } from './client';
import { armFailure } from './failure';
import { resetSample } from './store';
import { weekdayOf } from './seed';

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  } as Storage;
}

const TZ = 'America/New_York';

describe('sampleClient searchAvailability', () => {
  let client: ReturnType<typeof sampleClient>;
  let storage: Storage;

  beforeEach(() => {
    armFailure(null);
    storage = fakeStorage();
    // Pin the dataset so slot expectations do not drift with the real date.
    resetSample('2026-11-02', TZ, storage); // a Monday
    client = sampleClient({ storage, latencyMs: 0 });
  });

  it('offers slots inside business hours only', async () => {
    const slots = await client.searchAvailability({
      range: { start: '2026-11-10T00:00:00-05:00', end: '2026-11-11T00:00:00-05:00' },
      serviceId: 'svc_1',
    });
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      expect(instantToZoned(slot.start, TZ).time >= '09:00').toBe(true);
      expect(instantToZoned(slot.end, TZ).time <= '18:00').toBe(true);
      expect(Date.parse(slot.end)).toBeGreaterThan(Date.parse(slot.start));
    }
  });

  it('offers nothing on a closed day', async () => {
    const sunday = '2026-11-08'; // Sunday
    expect(weekdayOf(sunday)).toBe(0);
    const slots = await client.searchAvailability({
      range: { start: `${sunday}T00:00:00-05:00`, end: `${sunday}T23:59:00-05:00` },
      serviceId: 'svc_1',
    });
    expect(slots).toHaveLength(0);
  });

  it('gives each slot the service duration', async () => {
    const slots = await client.searchAvailability({
      range: { start: '2026-11-10T00:00:00-05:00', end: '2026-11-11T00:00:00-05:00' },
      serviceId: 'svc_2', // Colour, 90 minutes
      staffId: 'stf_1',
    });
    for (const slot of slots) {
      expect(Date.parse(slot.end) - Date.parse(slot.start)).toBe(90 * 60_000);
    }
  });

  it('lets an explicit query duration override the service default', async () => {
    // Pins the chosen precedence (query wins over the service's own duration)
    // so it cannot silently flip -- the library itself is inconsistent here
    // (mindbody.ts lets the query win, vagaro.ts lets the provider win).
    const slots = await client.searchAvailability({
      range: { start: '2026-11-10T00:00:00-05:00', end: '2026-11-11T00:00:00-05:00' },
      serviceId: 'svc_2', // Colour, 90 minutes
      durationMinutes: 30,
    });
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      expect(Date.parse(slot.end) - Date.parse(slot.start)).toBe(30 * 60_000);
    }
  });

  it('excludes time a staff member is already booked', async () => {
    const booked = await client.createBooking({
      title: 'Blocks the slot',
      range: { start: '2026-11-10T10:00:00-05:00', end: '2026-11-10T11:00:00-05:00' },
      staffId: 'stf_1',
    });
    const slots = await client.searchAvailability({
      range: { start: '2026-11-10T00:00:00-05:00', end: '2026-11-11T00:00:00-05:00' },
      serviceId: 'svc_1',
      staffId: 'stf_1',
    });
    const overlaps = slots.filter(
      (s) =>
        Date.parse(s.start) < Date.parse(booked.range.end) &&
        Date.parse(booked.range.start) < Date.parse(s.end),
    );
    expect(overlaps).toHaveLength(0);
  });

  it('names a free staff member when none was asked for', async () => {
    const slots = await client.searchAvailability({
      range: { start: '2026-11-10T00:00:00-05:00', end: '2026-11-11T00:00:00-05:00' },
      serviceId: 'svc_1',
    });
    expect(slots.every((s) => typeof s.staffId === 'string')).toBe(true);
    // stf_4 is inactive and must never be offered.
    expect(slots.some((s) => s.staffId === 'stf_4')).toBe(false);
  });

  it('rejects an unknown service and a backwards range', async () => {
    await expect(
      client.searchAvailability({
        range: { start: '2026-11-10T00:00:00-05:00', end: '2026-11-11T00:00:00-05:00' },
        serviceId: 'svc_nope',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await expect(
      client.searchAvailability({
        range: { start: '2026-11-11T00:00:00-05:00', end: '2026-11-10T00:00:00-05:00' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

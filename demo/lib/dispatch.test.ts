import { describe, it, expect } from 'vitest';
import type { BookingClient } from 'unibooking';
import { dispatch } from './dispatch';

/**
 * Google's freeBusy endpoint returns busy intervals, not bookable slots, so
 * its adapter refuses an availability query without a positive
 * `durationMinutes` ("pass a positive durationMinutes to size each slot").
 * The demo never forwarded the field, so Search Availability against Google
 * could not succeed from the UI at all: it failed INVALID_INPUT every time.
 */
function capturing() {
  const seen: { query?: Record<string, unknown> } = {};
  const client = {
    id: 'google',
    searchAvailability: async (q: Record<string, unknown>) => {
      seen.query = q;
      return { slots: [] };
    },
  } as unknown as BookingClient;
  return { client, seen };
}

describe('dispatch: searchAvailability', () => {
  it('forwards a positive durationMinutes', async () => {
    const { client, seen } = capturing();
    await dispatch(client, 'searchAvailability', {
      start: '2026-09-22T00:00:00Z',
      end: '2026-09-23T00:00:00Z',
      durationMinutes: 30,
    });
    expect(seen.query).toMatchObject({ durationMinutes: 30 });
  });

  it('omits durationMinutes entirely when it is absent', async () => {
    const { client, seen } = capturing();
    await dispatch(client, 'searchAvailability', {
      start: '2026-09-22T00:00:00Z',
      end: '2026-09-23T00:00:00Z',
    });
    expect(seen.query).not.toHaveProperty('durationMinutes');
  });

  it('omits a non-positive or non-numeric duration rather than passing it on', async () => {
    // A blank form field arrives as '' and Number('') is 0; sending 0 would
    // trip the adapter's own "must be positive" guard with a confusing error.
    for (const bad of [0, -15, Number.NaN, 'abc']) {
      const { client, seen } = capturing();
      await dispatch(client, 'searchAvailability', {
        start: '2026-09-22T00:00:00Z',
        end: '2026-09-23T00:00:00Z',
        durationMinutes: bad,
      });
      expect(seen.query, `durationMinutes: ${String(bad)}`).not.toHaveProperty('durationMinutes');
    }
  });
});

/* ═══════════════════════════════════════════════════════════
   Classes
   ═══════════════════════════════════════════════════════════ */

function classClient(over: Partial<Record<string, unknown>> = {}) {
  const seen: { query?: unknown; enroll?: unknown; classId?: string } = {};
  const client = {
    id: 'mindbody',
    listClasses: async (q: unknown) => {
      seen.query = q;
      return { classes: [] };
    },
    getClass: async (id: string) => {
      seen.classId = id;
      return { id, full: false };
    },
    enrollInClass: async (input: unknown) => {
      seen.enroll = input;
      return { id: 'b1', classId: (input as { classId: string }).classId };
    },
    ...over,
  } as unknown as BookingClient;
  return { client, seen };
}

describe('dispatch: classes', () => {
  it('builds a range only when both ends are present', async () => {
    const { client, seen } = classClient();
    await dispatch(client, 'listClasses', {
      start: '2026-09-22T00:00:00Z',
      end: '2026-09-23T00:00:00Z',
    });
    expect(seen.query).toMatchObject({
      range: { start: '2026-09-22T00:00:00Z', end: '2026-09-23T00:00:00Z' },
    });

    // A half-filled range would be a malformed query; omit it instead so the
    // adapter applies its own default window.
    const half = classClient();
    await dispatch(half.client, 'listClasses', { start: '2026-09-22T00:00:00Z' });
    expect(half.seen.query).not.toHaveProperty('range');
  });

  it('forwards optional filters only when set', async () => {
    const { client, seen } = classClient();
    await dispatch(client, 'listClasses', { staffId: 's1' });
    expect(seen.query).toMatchObject({ staffId: 's1' });
    expect(seen.query).not.toHaveProperty('serviceId');
  });

  it('passes allowWaitlist through only when truthy', async () => {
    const on = classClient();
    await dispatch(on.client, 'enrollInClass', {
      classId: 'c1',
      customerId: 'cust1',
      allowWaitlist: true,
    });
    expect(on.seen.enroll).toMatchObject({ classId: 'c1', allowWaitlist: true });

    const off = classClient();
    await dispatch(off.client, 'enrollInClass', { classId: 'c1', customerId: 'cust1' });
    expect(off.seen.enroll).not.toHaveProperty('allowWaitlist');
  });

  it('assembles the customer from the flat form fields', async () => {
    const { client, seen } = classClient();
    await dispatch(client, 'enrollInClass', {
      classId: 'c1',
      customerName: 'Dana Lee',
      customerEmail: 'dana@example.com',
    });
    expect(seen.enroll).toMatchObject({
      customer: { name: 'Dana Lee', email: 'dana@example.com' },
    });
  });

  it('reports UNSUPPORTED rather than crashing when the provider has no classes', async () => {
    const bare = { id: 'google' } as unknown as BookingClient;
    for (const op of ['listClasses', 'getClass', 'enrollInClass'] as const) {
      const err = await dispatch(bare, op, { classId: 'c1' })
        .then(() => null)
        .catch((e: { code?: string }) => e);
      expect(err?.code, `${op} should be UNSUPPORTED`).toBe('UNSUPPORTED');
    }
  });
});

/* ═══════════════════════════════════════════════════════════
   Categories, business hours and assignment filters
   ═══════════════════════════════════════════════════════════ */

describe('dispatch: categories and business hours', () => {
  it('forwards the assignment filters onto listServices and listStaff', async () => {
    const seen: Record<string, unknown> = {};
    const client = {
      id: 'square',
      listServices: async (q: unknown) => {
        seen.services = q;
        return { services: [] };
      },
      listStaff: async (q: unknown) => {
        seen.staff = q;
        return { staff: [] };
      },
    } as unknown as BookingClient;

    await dispatch(client, 'listServices', { staffId: 'tm_1', categoryId: 'cat_1' });
    expect(seen.services).toMatchObject({ staffId: 'tm_1', categoryId: 'cat_1' });

    await dispatch(client, 'listStaff', { serviceId: 'var_2' });
    expect(seen.staff).toMatchObject({ serviceId: 'var_2' });
  });

  it('omits the filters entirely when they are blank', async () => {
    let q: unknown;
    const client = {
      id: 'square',
      listServices: async (query: unknown) => {
        q = query;
        return { services: [] };
      },
    } as unknown as BookingClient;
    await dispatch(client, 'listServices', { limit: 5 });
    expect(q).not.toHaveProperty('staffId');
    expect(q).not.toHaveProperty('categoryId');
  });

  it('calls listCategories and getBusinessHours when present', async () => {
    let hit = 0;
    const client = {
      id: 'square',
      listCategories: async () => {
        hit++;
        return { categories: [] };
      },
      getBusinessHours: async () => {
        hit++;
        return { provider: 'square', periods: [], raw: {} };
      },
    } as unknown as BookingClient;
    await dispatch(client, 'listCategories', {});
    await dispatch(client, 'getBusinessHours', {});
    expect(hit).toBe(2);
  });

  it('reports UNSUPPORTED rather than crashing when the provider lacks them', async () => {
    const bare = { id: 'google' } as unknown as BookingClient;
    for (const op of ['listCategories', 'getBusinessHours'] as const) {
      const err = await dispatch(bare, op, {})
        .then(() => null)
        .catch((e: { code?: string }) => e);
      expect(err?.code, `${op} should be UNSUPPORTED`).toBe('UNSUPPORTED');
    }
  });
});

describe('listCalendars', () => {
  it('follows page tokens so a calendar past the first page is found', async () => {
    const pages: Record<string, { calendars: { id: string }[]; nextPageToken?: string }> = {
      '': { calendars: [{ id: 'a' }], nextPageToken: 'p2' },
      p2: { calendars: [{ id: 'b' }] },
    };
    const client = {
      id: 'google',
      listCalendars: async (q?: { pageToken?: string }) => pages[q?.pageToken ?? ''],
    } as unknown as BookingClient;
    const out = (await dispatch(client, 'listCalendars', {})) as { calendars: { id: string }[] };
    expect(out.calendars.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('reports UNSUPPORTED when the provider has no calendar list', async () => {
    const bare = { id: 'square' } as unknown as BookingClient;
    const err = await dispatch(bare, 'listCalendars', {})
      .then(() => null)
      .catch((e: { code?: string }) => e);
    expect(err?.code).toBe('UNSUPPORTED');
  });
});

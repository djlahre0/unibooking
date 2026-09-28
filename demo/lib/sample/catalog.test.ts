import { describe, it, expect, beforeEach } from 'vitest';
import { sampleClient } from './client';
import { armFailure } from './failure';

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

describe('sampleClient catalog, customers and connection', () => {
  let client: ReturnType<typeof sampleClient>;
  beforeEach(() => {
    armFailure(null);
    client = sampleClient({ storage: fakeStorage(), latencyMs: 0 });
  });

  it('lists services and staff, inactive entries included', async () => {
    const services = await client.listServices!();
    expect(services.services).toHaveLength(6);
    const staff = await client.listStaff!();
    // There is no activeOnly filter in the canonical query types, so an
    // inactive member is returned with active: false, as real adapters do.
    expect(staff.staff.some((s) => !s.active)).toBe(true);
  });

  it('pages the catalog with the same cursor scheme as bookings', async () => {
    const first = await client.listServices!({ limit: 4 });
    expect(first.services).toHaveLength(4);
    expect(first.nextPageToken).toBeDefined();
    const second = await client.listServices!({ limit: 4, pageToken: first.nextPageToken! });
    expect(second.services).toHaveLength(2);
    expect(second.nextPageToken).toBeUndefined();
  });

  it('creates a service with explicit money and reads it back', async () => {
    const created = await client.createService!({
      name: 'Hot towel shave',
      durationMinutes: 25,
      price: { amount: 3000, currency: 'USD' },
    });
    expect(created.id).toMatch(/^svc_/);
    expect(created.active).toBe(true);
    expect(created.raw).toBeDefined();
    const all = await client.listServices!();
    expect(all.services.map((s) => s.id)).toContain(created.id);
  });

  it('deactivates without destroying', async () => {
    const off = await client.setServiceActive!('svc_1', false);
    expect(off.active).toBe(false);
    const all = await client.listServices!();
    expect(all.services.map((s) => s.id)).toContain('svc_1');
  });

  it('renames a service and clears an optional field with an empty string', async () => {
    const created = await client.createService!({ name: 'Trial', description: 'temp note' });
    const renamed = await client.updateService!(created.id, { name: 'Trial Cut' });
    expect(renamed.name).toBe('Trial Cut');
    // Like UpdateBookingInput's description/location, a truthy check would
    // silently no-op an explicit clear -- must actually apply ''.
    const cleared = await client.updateService!(created.id, { description: '' });
    expect(cleared.description).toBe('');
  });

  it('rejects an empty name on update, before mutating anything', async () => {
    // Service.name is a required non-empty string, and createService already
    // rejects a blank one -- update must not be able to sneak one past that.
    const created = await client.createService!({ name: 'Keep Me' });
    await expect(client.updateService!(created.id, { name: '   ' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    const all = await client.listServices!();
    expect(all.services.find((s) => s.id === created.id)?.name).toBe('Keep Me');
  });

  it('reports NOT_FOUND for unknown catalog ids', async () => {
    await expect(client.updateService!('svc_nope', { name: 'x' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(client.setStaffActive!('stf_nope', false)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('rejects a service with no name before mutating', async () => {
    const before = (await client.listServices!()).services.length;
    await expect(client.createService!({ name: '  ' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect((await client.listServices!()).services).toHaveLength(before);
  });

  it('creates and updates staff', async () => {
    const created = await client.createStaff!({ name: 'Eve Tan', email: 'eve@example.salon' });
    expect(created.active).toBe(true);
    const renamed = await client.updateStaff!(created.id, { name: 'Eve Tan-Ng' });
    expect(renamed.name).toBe('Eve Tan-Ng');
  });

  it('rejects an empty name on staff update, before mutating anything', async () => {
    // Same rule as updateService: Staff.name is required and non-empty, and
    // createStaff already rejects a blank one.
    const created = await client.createStaff!({ name: 'Keep Me Too' });
    await expect(client.updateStaff!(created.id, { name: '   ' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    const all = await client.listStaff!();
    expect(all.staff.find((s) => s.id === created.id)?.name).toBe('Keep Me Too');
  });

  it('clears an optional staff field with an empty string', async () => {
    const created = await client.createStaff!({ name: 'Fay Ito', email: 'fay@example.salon' });
    // A truthy spread would silently drop this clear, same bug class as
    // updateBooking's description/location -- the empty string must land.
    const cleared = await client.updateStaff!(created.id, { email: '' });
    expect(cleared.email).toBe('');
  });

  it('findOrCreate matches an existing customer by email', async () => {
    const id = await client.customers!.findOrCreate({ email: 'priya1@example.com' });
    const again = await client.customers!.findOrCreate({
      name: 'Priya R',
      email: 'priya1@example.com',
    });
    expect(again).toBe(id);
  });

  it('findOrCreate creates one when nothing matches', async () => {
    const id = await client.customers!.findOrCreate({
      name: 'Brand New',
      email: 'new@example.com',
    });
    expect(id).toMatch(/^cus_/);
    const same = await client.customers!.findOrCreate({ email: 'new@example.com' });
    expect(same).toBe(id);
  });

  it('findOrCreate prefers an email match over an earlier phone match', async () => {
    // Two distinct customers, the phone-only one added FIRST so it sits
    // earlier in the array than the email-only one. A single find() with an
    // OR predicate would return whichever record it reaches first regardless
    // of which field matched -- email must win even though phone comes first.
    const phoneOnlyId = await client.customers!.findOrCreate({
      name: 'Phone Only',
      phone: '+19995550001',
    });
    const emailOnlyId = await client.customers!.findOrCreate({
      name: 'Email Only',
      email: 'email-only@example.com',
    });
    const matched = await client.customers!.findOrCreate({
      phone: '+19995550001',
      email: 'email-only@example.com',
    });
    expect(matched).toBe(emailOnlyId);
    expect(matched).not.toBe(phoneOnlyId);
  });

  it('findOrCreate needs something to match on', async () => {
    await expect(client.customers!.findOrCreate({})).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('reports a healthy connection, and an unhealthy one without throwing', async () => {
    expect(await client.checkConnection()).toMatchObject({ ok: true });
    armFailure('AUTH');
    const status = await client.checkConnection();
    expect(status.ok).toBe(false);
    expect(status.reason).toBe('AUTH');
  });

  it('still throws from checkConnection for a genuine fault', async () => {
    armFailure('UPSTREAM');
    // A transient fault is not "your credentials are dead", so it must throw
    // rather than be reported as a clean negative.
    await expect(client.checkConnection()).rejects.toMatchObject({ code: 'UPSTREAM' });
  });
});

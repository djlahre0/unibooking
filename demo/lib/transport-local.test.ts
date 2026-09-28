import { describe, it, expect } from 'vitest';
import { runLocal } from './transport-local';
import { isLocal, PROVIDER_META, PROXY_PROVIDERS, DIRECT_PROVIDERS, ADAPTERS } from './providers';
import { getCapabilities } from './call';

describe('local transport', () => {
  it('classifies sample as local and nothing else', () => {
    expect(isLocal('sample')).toBe(true);
    expect(isLocal('square')).toBe(false);
  });

  it('never exposes sample to the proxy or to the adapter registry', () => {
    // The proxy allowlist is a security boundary: a fake provider must not be
    // relayable, and it has no host to relay to.
    expect(PROXY_PROVIDERS.has('sample')).toBe(false);
    expect(DIRECT_PROVIDERS.has('sample')).toBe(false);
    expect(Object.hasOwn(ADAPTERS, 'sample')).toBe(false);
  });

  it('offers it in the picker with no credential fields', () => {
    expect(PROVIDER_META.sample).toBeDefined();
    expect(PROVIDER_META.sample!.fields).toHaveLength(0);
  });

  it('runs an op and returns an ok envelope', async () => {
    const result = await runLocal('listBookings', {
      start: '2020-01-01T00:00:00Z',
      end: '2030-01-01T00:00:00Z',
    });
    expect(result.ok).toBe(true);
    expect((result.data as { bookings: unknown[] }).bookings.length).toBeGreaterThan(0);
  });

  it('serializes a domain error into the shared envelope', async () => {
    // dispatch reads args.bookingId for this op (lib/dispatch.ts), not args.id.
    const result = await runLocal('getBooking', { bookingId: 'bkg_nope' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('NOT_FOUND');
    expect(result.error?.retryable).toBe(false);
  });

  it('answers getCapabilities locally, without an adapter', async () => {
    const result = await getCapabilities('sample');
    expect(result.ok).toBe(true);
    expect(
      (result.data as { capabilities: { availability: boolean } }).capabilities.availability,
    ).toBe(true);
  });
});

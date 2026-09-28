import { describe, expect, it } from 'vitest';
import {
  ADAPTERS,
  DIRECT_PROVIDERS,
  LOCAL_PROVIDERS,
  PROVIDER_META,
  PROXY_PROVIDERS,
} from './providers';
import { ENVIRONMENTS } from './environments';

/**
 * Every adapter the library ships must be fully wired into the demo. A provider
 * that is present in one map and absent from another does not fail loudly: it
 * silently vanishes from the picker, or reaches a transport that refuses it, and
 * looks to the visitor like the provider simply is not supported.
 *
 * These are the joins that must hold, asserted rather than eyeballed.
 */

const adapterIds = Object.keys(ADAPTERS).sort();
const metaIds = Object.keys(PROVIDER_META)
  .filter((id) => !LOCAL_PROVIDERS.has(id))
  .sort();

describe('every shipped adapter is wired into the demo', () => {
  it('has credential metadata, so it renders in the Connect picker', () => {
    // ConnectPanel renders Object.entries(PROVIDER_META); anything missing here
    // is invisible in the UI no matter how complete its adapter is.
    const missing = adapterIds.filter((id) => !Object.hasOwn(PROVIDER_META, id));
    expect(missing, `adapters with no PROVIDER_META entry: ${missing.join(', ')}`).toEqual([]);
  });

  it('has no metadata entry without a backing adapter', () => {
    const orphan = metaIds.filter((id) => !Object.hasOwn(ADAPTERS, id));
    expect(orphan, `PROVIDER_META entries with no adapter: ${orphan.join(', ')}`).toEqual([]);
  });

  it('belongs to exactly one transport group', () => {
    // page.tsx builds the provider rail from these three sets. In neither set a
    // provider never appears; in both, it renders twice and the transport
    // picker's answer depends on evaluation order.
    for (const id of adapterIds) {
      const groups = [
        LOCAL_PROVIDERS.has(id) && 'local',
        DIRECT_PROVIDERS.has(id) && 'direct',
        PROXY_PROVIDERS.has(id) && 'proxy',
      ].filter(Boolean);
      expect(groups, `${id} must be in exactly one transport group`).toHaveLength(1);
    }
  });

  it('has at least one credential field, so Connect can actually collect one', () => {
    for (const id of adapterIds) {
      expect(
        PROVIDER_META[id]!.fields.length,
        `${id} has no credential fields to fill in`,
      ).toBeGreaterThan(0);
    }
  });

  it('has a production environment entry, so the transport has a base URL', () => {
    const missing = adapterIds.filter((id) => !Object.hasOwn(ENVIRONMENTS, id));
    expect(missing, `adapters with no ENVIRONMENTS entry: ${missing.join(', ')}`).toEqual([]);
  });

  it('keeps Bookeo and Booker as separate providers', () => {
    // Two different companies with confusingly similar names: Bookeo
    // (bookeo.com) and Mindbody's Booker (booker.com). Conflating them, or
    // assuming one covers the other, is the mistake this guards.
    expect(PROVIDER_META.booker?.label).toBe('Booker');
    expect(PROVIDER_META.bookeo?.label).toBe('Bookeo');
    expect(Object.hasOwn(ADAPTERS, 'booker')).toBe(true);
    expect(PROXY_PROVIDERS.has('booker')).toBe(true);
    expect(ENVIRONMENTS.booker?.prod).toContain('booker.com');
    expect(ENVIRONMENTS.bookeo?.prod).toContain('bookeo.com');
    expect(Object.hasOwn(ADAPTERS, 'bookeo')).toBe(true);
    expect(PROVIDER_META.bookeo?.label).toBe('Bookeo');
    expect(PROVIDER_META.bookeo!.fields.map((f) => f.key)).toEqual(['apiKey', 'secretKey']);
    expect(PROXY_PROVIDERS.has('bookeo')).toBe(true);
    expect(ENVIRONMENTS.bookeo?.prod).toBeTruthy();
  });

  it('covers all 17 shipped adapters', () => {
    expect(adapterIds).toEqual([
      'acuity',
      'apple',
      'bookeo',
      'booker',
      'boulevard',
      'calendly',
      'google',
      'mangomint',
      'microsoft_bookings',
      'mindbody',
      'outlook',
      'phorest',
      'setmore',
      'square',
      'vagaro',
      'wix',
      'zenoti',
    ]);
  });
});

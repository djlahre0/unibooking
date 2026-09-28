import { describe, expect, it } from 'vitest';
import { PROVIDER_CREDENTIALS } from 'unibooking';
import { PROVIDER_META, ADAPTERS } from './providers';

/**
 * The demo's credential fields are derived from the library schema rather than
 * restated, so these assert the derivation stays faithful -- not that two
 * hand-written lists happen to agree.
 */
describe('demo credential fields vs the library schema', () => {
  it('carries every provider the library declares, plus the demo-only sample', () => {
    for (const id of Object.keys(PROVIDER_CREDENTIALS)) {
      expect(PROVIDER_META[id], `${id} missing from the demo picker`).toBeDefined();
    }
    expect(PROVIDER_META.sample).toBeDefined();
    expect(PROVIDER_CREDENTIALS).not.toHaveProperty('sample');
  });

  it('shows exactly the library\'s fields, in order, for each provider', () => {
    for (const [id, sets] of Object.entries(PROVIDER_CREDENTIALS)) {
      const expected = (sets[0]?.fields ?? []).map((f) => f.key);
      expect(PROVIDER_META[id]!.fields.map((f) => f.key), id).toEqual(expected);
    }
  });

  it('never unmasks a field the library calls secret', () => {
    // The direction that leaks: a credential rendered in plain text.
    for (const [id, sets] of Object.entries(PROVIDER_CREDENTIALS)) {
      for (const field of sets[0]?.fields ?? []) {
        if (!field.secret) continue;
        const shown = PROVIDER_META[id]!.fields.find((f) => f.key === field.key);
        expect(shown?.secret, `${id}.${field.key} is unmasked in the demo`).toBe(true);
      }
    }
  });

  it('hides exactly the optional fields behind "Advanced"', () => {
    for (const [id, sets] of Object.entries(PROVIDER_CREDENTIALS)) {
      for (const field of sets[0]?.fields ?? []) {
        const shown = PROVIDER_META[id]!.fields.find((f) => f.key === field.key);
        expect(!!shown?.advanced, `${id}.${field.key}`).toBe(!field.required);
      }
    }
  });

  it('has an adapter for every provider it offers credentials for', () => {
    for (const id of Object.keys(PROVIDER_CREDENTIALS)) {
      expect(ADAPTERS[id], `${id} has fields but no adapter`).toBeDefined();
    }
  });
});

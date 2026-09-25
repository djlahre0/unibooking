import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PROVIDER_CREDENTIALS,
  authKinds,
  isSecretField,
  matchCredentialSet,
  requiredCredentials,
  type CredentialField,
} from '../src/credentials';
import type { ProviderId } from '../src/types';

const PROVIDERS = Object.keys(PROVIDER_CREDENTIALS) as ProviderId[];

/** Every field across every set, for the whole-schema sweeps below. */
function allFields(): Array<{ provider: ProviderId; field: CredentialField }> {
  return PROVIDERS.flatMap((provider) =>
    PROVIDER_CREDENTIALS[provider].flatMap((set) =>
      set.fields.map((field) => ({ provider, field })),
    ),
  );
}

describe('credential schema', () => {
  it('covers every ProviderId', () => {
    // The adapters directory is the list that matters: a provider added there
    // without a schema entry would leave a consumer unable to connect it.
    const src = readFileSync(fileURLToPath(new URL('../src/types.ts', import.meta.url)), 'utf8');
    const union = src.slice(
      src.indexOf('export type ProviderId ='),
      src.indexOf(';', src.indexOf('export type ProviderId =')),
    );
    const declared = [...union.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(0);
    for (const id of declared) {
      expect(PROVIDERS, `${id} has no credential schema`).toContain(id);
    }
    expect(PROVIDERS.length).toBe(declared.length);
  });

  it('gives every provider at least one set, with at least one required field', () => {
    for (const p of PROVIDERS) {
      const sets = PROVIDER_CREDENTIALS[p];
      expect(sets.length, `${p} has no credential set`).toBeGreaterThan(0);
      for (const set of sets) {
        expect(set.fields.length, `${p}/${set.kind} has no fields`).toBeGreaterThan(0);
        expect(
          set.fields.some((f) => f.required),
          `${p}/${set.kind} requires nothing -- a set with no required field matches everything`,
        ).toBe(true);
      }
    }
  });

  it('never repeats a key within one set', () => {
    for (const p of PROVIDERS) {
      for (const set of PROVIDER_CREDENTIALS[p]) {
        const keys = set.fields.map((f) => f.key);
        expect(new Set(keys).size, `${p}/${set.kind} repeats a key`).toBe(keys.length);
      }
    }
  });

  it('marks tokens, keys, passwords and secrets as secret', () => {
    // The direction that matters: a credential wrongly marked non-secret gets
    // rendered in plain text and written to a log.
    const sensitive = /token|password|secret|apikey|key$/i;
    for (const { provider, field } of allFields()) {
      if (sensitive.test(field.key) && field.key !== 'subscriptionKey') {
        expect(field.secret, `${provider}.${field.key} must be secret`).toBe(true);
      }
    }
  });

  it('does not mark plain identifiers, urls or timezones as secret', () => {
    const notSensitive = [
      'userId',
      'siteId',
      'businessId',
      'locationId',
      'branchId',
      'centerId',
      'calendarId',
      'calendarUrl',
      'timezone',
      'utcOffset',
      'region',
      'currency',
      'username',
    ];
    for (const { provider, field } of allFields()) {
      if (notSensitive.includes(field.key)) {
        expect(field.secret, `${provider}.${field.key} should not be masked`).toBe(false);
      }
    }
  });

  it('holds metadata only -- no value ever lives in the schema', () => {
    // The package ships no credential. A `value`/`default` on a field would be
    // exactly how one got committed.
    for (const { provider, field } of allFields()) {
      expect(Object.keys(field).sort()).not.toContain('value');
      expect(Object.keys(field), `${provider}.${field.key}`).not.toContain('default');
    }
  });

  it("matches the adapters' own optional/required markers", () => {
    // Spot-checks against the credential types, which are the source of truth.
    // `calendarId?` on Google, `locationId` (no ?) on Square.
    const req = (p: ProviderId) =>
      requiredCredentials(p)
        .map((f) => f.key)
        .sort();
    expect(req('google')).toEqual(['accessToken']);
    expect(req('square')).toEqual(['accessToken', 'locationId']);
    expect(req('outlook')).toEqual(['accessToken']);
    expect(req('bookeo')).toEqual(['apiKey', 'secretKey']);
    expect(req('phorest')).toEqual(['branchId', 'businessId', 'password', 'username']);
    expect(req('apple')).toEqual(['appPassword', 'username']);
    expect(req('mindbody')).toEqual(['accessToken', 'apiKey', 'siteId']);
  });
});

describe('providers with more than one way to authenticate', () => {
  it('gives Acuity both HTTP Basic and OAuth', () => {
    expect(authKinds('acuity')).toEqual(['keys', 'oauth']);
  });

  it('every other provider has exactly one', () => {
    for (const p of PROVIDERS) {
      if (p === 'acuity') continue;
      expect(authKinds(p).length, `${p} unexpectedly has alternatives`).toBe(1);
    }
  });

  it('resolves Acuity by which set was actually supplied', () => {
    expect(matchCredentialSet('acuity', { userId: 'u', apiKey: 'k' })?.kind).toBe('keys');
    expect(matchCredentialSet('acuity', { accessToken: 't' })?.kind).toBe('oauth');
  });

  it('matches nothing when a required field is missing or blank', () => {
    expect(matchCredentialSet('acuity', { userId: 'u' })).toBeUndefined();
    expect(matchCredentialSet('square', { accessToken: 't' })).toBeUndefined();
    // An empty string is absence, not a value -- a blank form field must not
    // satisfy a requirement.
    expect(matchCredentialSet('square', { accessToken: 't', locationId: '' })).toBeUndefined();
  });

  it('ignores optional fields when matching', () => {
    expect(matchCredentialSet('google', { accessToken: 't' })?.kind).toBe('oauth');
  });
});

describe('isSecretField', () => {
  it('reports what the schema says', () => {
    expect(isSecretField('google', 'accessToken')).toBe(true);
    expect(isSecretField('google', 'calendarId')).toBe(false);
  });

  it('treats an unknown key as secret', () => {
    // Guessing "not secret" is the mistake that leaks; guessing "secret" only
    // over-masks.
    expect(isSecretField('google', 'somethingNew')).toBe(true);
  });
});

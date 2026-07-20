import { describe, it, expect } from 'vitest';
import { ADAPTERS } from './providers';
import { ENVIRONMENTS, allowedHosts, assertSafeBaseUrl, resolveBaseUrl } from './environments';

describe('ENVIRONMENTS table', () => {
  it('covers every adapter the demo ships', () => {
    // Guards against adding an adapter and forgetting its hosts, which would
    // make the proxy reject every call for it.
    expect(Object.keys(ENVIRONMENTS).sort()).toEqual(Object.keys(ADAPTERS).sort());
  });

  it('declares the three providers that have a real sandbox host', () => {
    const withSandbox = Object.entries(ENVIRONMENTS)
      .filter(([, e]) => e.sandbox)
      .map(([id]) => id)
      .sort();
    expect(withSandbox).toEqual(['boulevard', 'phorest', 'square']);
  });

  it('uses a different registrable domain for Boulevard sandbox than prod', () => {
    // Boulevard prod is dashboard.boulevard.io but sandbox is sandbox.joinblvd.com.
    // Deriving one from the other by pattern would be wrong.
    expect(ENVIRONMENTS.boulevard.prod).toContain('dashboard.boulevard.io');
    expect(ENVIRONMENTS.boulevard.sandbox).toContain('sandbox.joinblvd.com');
  });

  it('omits China from MS Bookings but keeps it for Outlook', () => {
    // Graph hosts the same globally, but Bookings is unsupported on 21Vianet.
    expect(allowedHosts('outlook')).toContain('microsoftgraph.chinacloudapi.cn');
    expect(allowedHosts('microsoft_bookings')).not.toContain('microsoftgraph.chinacloudapi.cn');
  });
});

describe('allowedHosts', () => {
  it('returns prod, sandbox and every region host', () => {
    expect(allowedHosts('square').sort()).toEqual(
      ['connect.squareup.com', 'connect.squareupsandbox.com'].sort(),
    );
    expect(allowedHosts('phorest').sort()).toEqual(
      ['api-gateway-dev.phorest.com', 'platform-us.phorest.com', 'platform.phorest.com'].sort(),
    );
  });

  it('returns an empty list for an unknown provider', () => {
    expect(allowedHosts('nope')).toEqual([]);
  });
});

describe('resolveBaseUrl', () => {
  it('resolves prod, sandbox and region keys', () => {
    expect(resolveBaseUrl('square', 'prod')).toBe('https://connect.squareup.com/v2/');
    expect(resolveBaseUrl('square', 'sandbox')).toBe('https://connect.squareupsandbox.com/v2/');
    expect(resolveBaseUrl('phorest', 'us')).toBe(
      'https://platform-us.phorest.com/third-party-api-server/api/',
    );
  });

  it('returns undefined for an env the provider does not have', () => {
    expect(resolveBaseUrl('google', 'sandbox')).toBeUndefined();
  });
});

describe('assertSafeBaseUrl', () => {
  it('accepts the production host', () => {
    const url = 'https://connect.squareup.com/v2/';
    expect(assertSafeBaseUrl('square', url)).toBe(url);
  });

  it('accepts the sandbox host', () => {
    const url = 'https://connect.squareupsandbox.com/v2/';
    expect(assertSafeBaseUrl('square', url)).toBe(url);
  });

  it('rejects another provider\'s host', () => {
    expect(() => assertSafeBaseUrl('square', 'https://api.bookeo.com/v2/')).toThrow(/not permitted/i);
  });

  it('rejects non-https schemes', () => {
    expect(() => assertSafeBaseUrl('square', 'http://connect.squareup.com/v2/')).toThrow(/https/i);
  });

  it('rejects the credential-in-URL trick (userinfo, not host)', () => {
    // The real host is evil.com; connect.squareup.com is only the username.
    expect(() => assertSafeBaseUrl('square', 'https://connect.squareup.com@evil.com/')).toThrow(
      /not permitted/i,
    );
  });

  it('rejects a look-alike suffix', () => {
    expect(() => assertSafeBaseUrl('square', 'https://connect.squareup.com.evil.com/')).toThrow(
      /not permitted/i,
    );
  });

  it('rejects a subdomain of an allowed host (exact match only)', () => {
    // Exact-match, not suffix-match: a subdomain takeover must not become our problem.
    expect(() => assertSafeBaseUrl('square', 'https://evil.connect.squareup.com/')).toThrow(
      /not permitted/i,
    );
  });

  it('rejects internal and metadata hosts', () => {
    expect(() => assertSafeBaseUrl('square', 'https://169.254.169.254/latest/meta-data/')).toThrow(
      /not permitted/i,
    );
    expect(() => assertSafeBaseUrl('square', 'https://localhost/')).toThrow(/not permitted/i);
  });

  it('rejects empty and non-string input', () => {
    expect(() => assertSafeBaseUrl('square', '')).toThrow(/required/i);
    expect(() => assertSafeBaseUrl('square', undefined)).toThrow(/required/i);
    expect(() => assertSafeBaseUrl('square', 123)).toThrow(/required/i);
  });

  it('rejects an unparseable URL', () => {
    expect(() => assertSafeBaseUrl('square', 'not a url')).toThrow(/valid/i);
  });

  it('is case-insensitive on the host', () => {
    expect(assertSafeBaseUrl('square', 'https://Connect.SquareUp.com/v2/')).toContain('squareup.com');
  });

  it('rejects any base URL for an unknown provider', () => {
    expect(() => assertSafeBaseUrl('nope', 'https://connect.squareup.com/')).toThrow(/not permitted/i);
  });
});

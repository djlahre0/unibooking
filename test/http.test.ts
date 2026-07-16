import { describe, expect, it } from 'vitest';
import { createHttp } from '../src/http';
import { codeForStatus } from '../src/errors';

type Creds = { token: string };

function httpWith(fetchImpl: typeof fetch, timeoutMs = 5000) {
  return createHttp<Creds>({
    provider: 'square',
    baseUrl: 'https://api.test/v1/',
    creds: { token: 'secret' },
    auth: (c) => ({ headers: { authorization: `Bearer ${c.token}` } }),
    options: { fetch: fetchImpl, timeoutMs },
  });
}

describe('codeForStatus mapping', () => {
  const table: Array<[number, string]> = [
    [400, 'INVALID_INPUT'],
    [422, 'INVALID_INPUT'],
    [401, 'AUTH'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [410, 'NOT_FOUND'],
    [409, 'CONFLICT'],
    [429, 'RATE_LIMIT'],
    [500, 'UPSTREAM'],
    [502, 'UPSTREAM'],
  ];
  for (const [status, code] of table) {
    it(`${status} -> ${code}`, () => expect(codeForStatus(status)).toBe(code));
  }
});

describe('http client', () => {
  it('applies auth headers and parses JSON', async () => {
    let seenAuth: string | null = null;
    const fetchImpl: typeof fetch = async (_url, init) => {
      seenAuth = new Headers(init?.headers).get('authorization');
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const http = httpWith(fetchImpl);
    const res = await http.request(await http.resolve(), { path: 'ping' });
    expect(res).toEqual({ ok: true });
    expect(seenAuth).toBe('Bearer secret');
  });

  it('maps a network failure to NETWORK', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const http = httpWith(fetchImpl);
    const err = await http
      .request(await http.resolve(), { path: 'ping' })
      .then(() => null)
      .catch((e) => e);
    expect(err.code).toBe('NETWORK');
  });

  it('maps an abort to TIMEOUT', async () => {
    const fetchImpl: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    const http = httpWith(fetchImpl, 20);
    const err = await http
      .request(await http.resolve(), { path: 'slow' })
      .then(() => null)
      .catch((e) => e);
    expect(err.code).toBe('TIMEOUT');
  });

  it('surfaces a non-JSON success body as UPSTREAM', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response('<html>nope</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    const http = httpWith(fetchImpl);
    const err = await http
      .request(await http.resolve(), { path: 'ping' })
      .then(() => null)
      .catch((e) => e);
    expect(err.code).toBe('UPSTREAM');
  });

  it('awaits an async auth function (e.g. per-request HMAC signing)', async () => {
    let seenAuth: string | null = null;
    const http = createHttp<Creds>({
      provider: 'boulevard',
      baseUrl: 'https://api.test/v1/',
      creds: { token: 'secret' },
      // An async AuthFn — Boulevard computes an HMAC token per request.
      auth: async (c) => ({ headers: { authorization: `Signed ${c.token}` } }),
      options: {
        fetch: async (_url, init) => {
          seenAuth = new Headers(init?.headers).get('authorization');
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        },
      },
    });
    await http.request(await http.resolve(), { path: 'ping' });
    expect(seenAuth).toBe('Signed secret');
  });

  it('resolves credentials from an async function every call (refresh)', async () => {
    let calls = 0;
    const http = createHttp<Creds>({
      provider: 'square',
      baseUrl: 'https://api.test/v1/',
      creds: async () => {
        calls += 1;
        return { token: `t${calls}` };
      },
      auth: (c) => ({ headers: { authorization: `Bearer ${c.token}` } }),
      options: {
        fetch: async (_url, init) =>
          new Response(JSON.stringify({ auth: new Headers(init?.headers).get('authorization') }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      },
    });
    const first = await http.request(await http.resolve(), { path: 'a' });
    const second = await http.request(await http.resolve(), { path: 'b' });
    expect(first.auth).toBe('Bearer t1');
    expect(second.auth).toBe('Bearer t2');
  });
});

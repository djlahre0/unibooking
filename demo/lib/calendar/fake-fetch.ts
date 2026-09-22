import { vi } from 'vitest';

/**
 * Test-only fetch router, installed with `vi.stubGlobal('fetch', …)` — the same
 * way the proxy route's tests keep the suite offline. Every adapter and OAuth
 * client in the demo uses the global fetch, so this sees all of it.
 *
 * Routes match on method and URL prefix and are consumed in order; an
 * unmatched request throws, which is this suite's `disableNetConnect`.
 */
export interface Recorded {
  method: string;
  url: string;
  headers: Headers;
  body: string;
}

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };

export function fakeFetch() {
  const routes: Array<{ method: string; prefix: string; reply: Reply; used: boolean }> = [];
  const calls: Recorded[] = [];

  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const body =
      typeof init?.body === 'string'
        ? init.body
        : init?.body instanceof URLSearchParams
          ? init.body.toString()
          : '';
    calls.push({ method, url, headers: new Headers(init?.headers), body });
    const route = routes.find((r) => !r.used && r.method === method && url.startsWith(r.prefix));
    if (!route) throw new TypeError(`fake fetch: no route for ${method} ${url}`);
    route.used = true;
    const { status = 200, body: payload = {}, headers = {} } = route.reply;
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return new Response(status === 204 ? null : text, {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  });

  return {
    fn,
    calls,
    on(method: string, prefix: string, reply: Reply = {}) {
      routes.push({ method, prefix, reply, used: false });
      return this;
    },
    pending(): string[] {
      return routes.filter((r) => !r.used).map((r) => `${r.method} ${r.prefix}`);
    },
  };
}

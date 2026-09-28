import { describe, expect, it } from 'vitest';
import { isLoopbackRequest, localhostOnly } from './http';

/**
 * `isLoopbackRequest` gates the operator's OAuth app setup route.
 *
 * It reads the request's raw `Host` header, not `req.url` -- confirmed by
 * logging both side by side against a real `next start` server: a Route
 * Handler's `req.url` is always this app's own configured origin (e.g.
 * `http://localhost:3141`, whatever it was started on), completely
 * independent of what a client actually connected to or sent, while
 * `req.headers.get('host')` reliably carries the exact value of THIS
 * request's Host header (see isLoopbackRequest's doc comment on http.ts for
 * the full account). These tests build `Request`s with an explicit `host`
 * header for that reason -- the bare `Request` constructor never populates
 * one on its own (also confirmed directly), unlike what a real Next.js
 * request carries.
 *
 * These are also the regression guard for the exact threat the task called
 * out: a spoofed `X-Forwarded-For: 127.0.0.1` (or any other *forwarded*
 * header) must never grant access -- only the request's own Host does.
 */
function req(host: string, headers: Record<string, string> = {}): Request {
  // The URL's own host is deliberately left generic/unrelated -- confirmed
  // live that Next.js's Route Handler `req.url` does NOT reflect the real
  // request host, so isLoopbackRequest must not (and does not) look at it.
  return new Request('http://ignored.internal/api/calendar/setup', {
    headers: { host, ...headers },
  });
}

describe('isLoopbackRequest', () => {
  it('is true for localhost, 127.0.0.1 and ::1 as the request Host header', () => {
    expect(isLoopbackRequest(req('localhost:3000'))).toBe(true);
    expect(isLoopbackRequest(req('127.0.0.1:3000'))).toBe(true);
    expect(isLoopbackRequest(req('[::1]:3000'))).toBe(true);
  });

  it('is true regardless of port, and case-insensitively', () => {
    expect(isLoopbackRequest(req('LOCALHOST:8080'))).toBe(true);
    expect(isLoopbackRequest(req('localhost'))).toBe(true); // no port at all
  });

  it('is false for a real hostname, even one that looks local-ish', () => {
    expect(isLoopbackRequest(req('demo.example.com'))).toBe(false);
    expect(isLoopbackRequest(req('localhost.evil.example'))).toBe(false);
    expect(isLoopbackRequest(req('192.168.1.5:3000'))).toBe(false); // a real LAN address, not loopback
  });

  it('is false when there is no Host header at all', () => {
    expect(isLoopbackRequest(new Request('http://ignored.internal/x'))).toBe(false);
  });

  it('a spoofed X-Forwarded-For: 127.0.0.1 does NOT grant loopback access for a remote Host', () => {
    expect(isLoopbackRequest(req('demo.example.com', { 'x-forwarded-for': '127.0.0.1' }))).toBe(
      false,
    );
  });

  it('other client-supplied forwarding headers are ignored the same way', () => {
    expect(
      isLoopbackRequest(
        req('demo.example.com', {
          'x-forwarded-host': 'localhost',
          'x-real-ip': '127.0.0.1',
          forwarded: 'for=127.0.0.1;host=localhost',
        }),
      ),
    ).toBe(false);
  });
});

describe('localhostOnly', () => {
  it('is a 403 FORBIDDEN response that explains the deployment must be configured locally', async () => {
    const res = localhostOnly();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('FORBIDDEN');
    expect(body.error.message).toMatch(/localhost/i);
  });
});

import { describe, expect, it } from 'vitest';
import { clearCookie, parseCookies, readCookie, seal, unseal, writeCookie } from './session';

const SECRET = 's'.repeat(40);
const NOW = 1_800_000_000_000;

describe('seal / unseal', () => {
  it('round-trips a payload', async () => {
    const v = await seal(SECRET, 'ub_cal', { a: 1, b: 'two' }, 60, NOW);
    expect(v).toMatch(/^v1\.[\w-]+\.[\w-]+$/);
    expect(await unseal(SECRET, 'ub_cal', v, NOW)).toEqual({ a: 1, b: 'two' });
  });

  it('uses a fresh IV every time', async () => {
    const a = await seal(SECRET, 'ub_cal', { a: 1 }, 60, NOW);
    const b = await seal(SECRET, 'ub_cal', { a: 1 }, 60, NOW);
    expect(a).not.toBe(b);
  });

  it('rejects tampering, a wrong secret, another cookie name, expiry and garbage', async () => {
    const v = await seal(SECRET, 'ub_cal', { a: 1 }, 60, NOW);
    const [ver, iv, ct] = v.split('.');
    const flipped = `${ver}.${iv}.${ct!.slice(0, -2)}${ct!.endsWith('AA') ? 'BB' : 'AA'}`;
    expect(await unseal(SECRET, 'ub_cal', flipped, NOW)).toBeNull();
    expect(await unseal('t'.repeat(40), 'ub_cal', v, NOW)).toBeNull();
    expect(await unseal(SECRET, 'ub_oauth', v, NOW)).toBeNull();
    expect(await unseal(SECRET, 'ub_cal', v, NOW + 61_000)).toBeNull();
    expect(await unseal(SECRET, 'ub_cal', 'garbage', NOW)).toBeNull();
    expect(await unseal(SECRET, 'ub_cal', undefined, NOW)).toBeNull();
  });
});

describe('cookies', () => {
  it('parses a Cookie header', () => {
    expect(parseCookies('a=1; ub_cal.0=v1.x.y;  b = 2 ')).toEqual({
      a: '1',
      'ub_cal.0': 'v1.x.y',
      b: '2',
    });
    expect(parseCookies(null)).toEqual({});
  });

  it('splits a large value into chunks and joins them back', () => {
    const big = 'x'.repeat(9000);
    const headers = writeCookie('ub_cal', big, { maxAge: 60, secure: true, existing: {} });
    expect(headers).toHaveLength(3);
    expect(headers[0]).toBe(
      `ub_cal.0=${'x'.repeat(3800)}; Path=/api/calendar; HttpOnly; SameSite=Lax; Max-Age=60; Secure`,
    );
    const cookies = parseCookies(headers.map((h) => h.split(';')[0]).join('; '));
    expect(readCookie(cookies, 'ub_cal')).toBe(big);
  });

  it('deletes the stale chunks a previously longer value left behind', () => {
    const headers = writeCookie('ub_cal', 'small', {
      maxAge: 60,
      secure: false,
      existing: { 'ub_cal.0': 'a', 'ub_cal.1': 'b', 'ub_cal.2': 'c', other: 'x' },
    });
    const deleted = headers.filter((h) => h.includes('Max-Age=0')).map((h) => h.split('=')[0]);
    expect(deleted).toEqual(['ub_cal.1', 'ub_cal.2']);
    expect(headers[0]).not.toContain('Secure');
  });

  it('clears every chunk the request carried', () => {
    const headers = clearCookie('ub_cal', { 'ub_cal.0': 'a', 'ub_cal.1': 'b' });
    expect(headers.map((h) => h.split('=')[0])).toEqual(['ub_cal.0', 'ub_cal.1']);
    expect(headers.every((h) => h.includes('Max-Age=0'))).toBe(true);
  });

  it('reads nothing when there is no chunk 0', () => {
    expect(readCookie({ 'ub_cal.1': 'orphan' }, 'ub_cal')).toBeUndefined();
  });
});

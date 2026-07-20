import { describe, it, expect } from 'vitest';
import { assertSafeCalendarUrl } from './validate-caldav';

describe('assertSafeCalendarUrl', () => {
  it('accepts a genuine iCloud CalDAV URL', () => {
    const url = 'https://p01-caldav.icloud.com/1234567/calendars/home/';
    expect(assertSafeCalendarUrl(url)).toBe(url);
  });

  it('accepts the apex icloud.com over https', () => {
    expect(assertSafeCalendarUrl('https://icloud.com/')).toBe('https://icloud.com/');
  });

  it('rejects non-https schemes', () => {
    expect(() => assertSafeCalendarUrl('http://p01-caldav.icloud.com/')).toThrow(/https/);
  });

  it('rejects a foreign host', () => {
    expect(() => assertSafeCalendarUrl('https://evil.com/cal')).toThrow(/icloud/i);
  });

  it('rejects an explicit non-default port on an otherwise-allowed host', () => {
    expect(() => assertSafeCalendarUrl('https://p01-caldav.icloud.com:8443/x')).toThrow(/port/i);
  });

  it('accepts an explicit :443 on https (the parser normalizes it away)', () => {
    const url = 'https://p01-caldav.icloud.com:443/x';
    expect(assertSafeCalendarUrl(url)).toBe('https://p01-caldav.icloud.com/x');
  });

  it('accepts a URL with no explicit port', () => {
    const url = 'https://p01-caldav.icloud.com/x';
    expect(assertSafeCalendarUrl(url)).toBe(url);
  });

  it('rejects the credential-in-URL trick (userinfo, not host)', () => {
    // The real host here is evil.com; icloud.com is only the username.
    expect(() => assertSafeCalendarUrl('https://p01-caldav.icloud.com@evil.com/')).toThrow(
      /icloud/i,
    );
  });

  it('rejects a look-alike suffix', () => {
    expect(() => assertSafeCalendarUrl('https://icloud.com.evil.com/')).toThrow(/icloud/i);
  });

  it('rejects a look-alike prefix (no dot boundary)', () => {
    expect(() => assertSafeCalendarUrl('https://evil-icloud.com/')).toThrow(/icloud/i);
  });

  it('rejects internal/loopback hosts', () => {
    expect(() => assertSafeCalendarUrl('https://169.254.169.254/latest/meta-data/')).toThrow(
      /icloud/i,
    );
    expect(() => assertSafeCalendarUrl('https://localhost/')).toThrow(/icloud/i);
  });

  it('rejects empty / non-string input', () => {
    expect(() => assertSafeCalendarUrl('')).toThrow(/required/i);
    expect(() => assertSafeCalendarUrl(undefined)).toThrow(/required/i);
    expect(() => assertSafeCalendarUrl(123)).toThrow(/required/i);
  });

  it('rejects an unparseable URL', () => {
    expect(() => assertSafeCalendarUrl('not a url')).toThrow(/valid/i);
  });

  it('is case-insensitive on the host', () => {
    expect(assertSafeCalendarUrl('https://P01-CalDAV.iCloud.com/x')).toContain('icloud.com');
  });
});

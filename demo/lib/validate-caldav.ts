/**
 * SSRF guard for the one user-supplied URL in the whole demo: Apple/CalDAV's
 * `calendarUrl`, which the adapter fetches directly. Without this, the proxy
 * would fetch any attacker-chosen host with attacker-supplied auth headers.
 *
 * We check the PARSED `url.hostname` (not the raw string) so credential-in-URL
 * tricks like `https://p01-caldav.icloud.com@evil.com/` are rejected — the
 * parser assigns `evil.com` to hostname. Allowlisting *.icloud.com has no
 * DNS-rebinding hole: nobody else can register a subdomain of icloud.com.
 */
export function assertSafeCalendarUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('calendarUrl is required for Apple / CalDAV.');
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('calendarUrl must be a valid absolute URL.');
  }

  if (url.protocol !== 'https:') {
    throw new Error('calendarUrl must use https.');
  }

  if (url.port !== '') {
    throw new Error('calendarUrl must not specify an explicit port.');
  }

  const host = url.hostname.toLowerCase();
  if (host !== 'icloud.com' && !host.endsWith('.icloud.com')) {
    throw new Error(
      'This demo only supports iCloud CalDAV (*.icloud.com). For self-hosted or other CalDAV servers, use the unibooking library directly on your own server.',
    );
  }

  return url.toString();
}

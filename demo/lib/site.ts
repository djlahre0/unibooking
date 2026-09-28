/**
 * Site-wide identity for metadata, the sitemap and social cards. The public
 * origin comes from APP_URL, the same variable the calendar routes use for a
 * deployment behind a proxy; without it the site describes itself as
 * localhost, which is right for `npm run dev` and harmless in previews.
 */
export const SITE_NAME = 'unibooking';

export const SITE_TAGLINE = 'One TypeScript API for 17 booking and calendar providers';

export const SITE_DESCRIPTION =
  'unibooking is a stateless TypeScript library with one API for Google Calendar, Outlook, Apple iCloud, Square, Acuity, Calendly, Mindbody and 10 more booking and calendar providers. Try every call in the browser and read the setup guides.';

export function siteUrl(): URL {
  const raw = process.env.APP_URL?.trim();
  try {
    if (raw) return new URL(raw);
  } catch {
    // A malformed APP_URL must not break every page's metadata.
  }
  return new URL('http://localhost:3000');
}

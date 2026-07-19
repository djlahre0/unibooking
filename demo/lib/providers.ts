/* ── Adapter imports (all 16) ── */
import { google } from 'unibooking/adapters/google';
import { outlook } from 'unibooking/adapters/outlook';
import { microsoftBookings } from 'unibooking/adapters/microsoft_bookings';
import { square } from 'unibooking/adapters/square';
import { acuity } from 'unibooking/adapters/acuity';
import { bookeo } from 'unibooking/adapters/bookeo';
import { mindbody } from 'unibooking/adapters/mindbody';
import { wix } from 'unibooking/adapters/wix';
import { calendly } from 'unibooking/adapters/calendly';
import { vagaro } from 'unibooking/adapters/vagaro';
import { zenoti } from 'unibooking/adapters/zenoti';
import { boulevard } from 'unibooking/adapters/boulevard';
import { phorest } from 'unibooking/adapters/phorest';
import { setmore } from 'unibooking/adapters/setmore';
import { mangomint } from 'unibooking/adapters/mangomint';
import { apple } from 'unibooking/adapters/apple';

import type { BookingClient, AdapterFactory } from 'unibooking';

/**
 * The single source of truth for provider metadata + transport classification.
 *
 * Transport split is empirical (tested from a real browser): the DIRECT
 * providers permit cross-origin (CORS) calls, so the visitor's token goes
 * straight from their browser to the provider and never touches our server.
 * The PROXY providers reject browser calls, so they route through /api/call.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ADAPTERS: Record<string, AdapterFactory<any>> = {
  google,
  outlook,
  microsoft_bookings: microsoftBookings,
  square,
  acuity,
  bookeo,
  mindbody,
  wix,
  calendly,
  vagaro,
  zenoti,
  boulevard,
  phorest,
  setmore,
  mangomint,
  apple,
};

/** Providers whose APIs allow browser (CORS) calls — run entirely client-side. */
export const DIRECT_PROVIDERS = new Set<string>([
  'google',
  'outlook',
  'microsoft_bookings',
  'calendly',
  'zenoti',
  'phorest',
  'wix',
]);

/** Providers that block browser calls — routed through the demo's proxy. */
export const PROXY_PROVIDERS = new Set<string>([
  'square',
  'acuity',
  'bookeo',
  'mindbody',
  'boulevard',
  'setmore',
  'vagaro',
  'mangomint',
  'apple',
]);

export function isDirect(provider: string): boolean {
  return DIRECT_PROVIDERS.has(provider);
}

/** Build a BookingClient. `Object.hasOwn` guard avoids prototype-key lookups. */
export function makeClient(provider: string, creds: Record<string, string>): BookingClient {
  if (!Object.hasOwn(ADAPTERS, provider)) throw new Error(`Unknown provider: ${provider}`);
  return ADAPTERS[provider](creds, { timeoutMs: 10_000 });
}

/* ═══════════════════════════════════════════════════════════
   Credential field metadata (UI).
   `secret` defaults to masked; opt OUT with `secret: false` for
   genuinely non-sensitive fields (ids, timezones, hostnames).
   ═══════════════════════════════════════════════════════════ */
export type CredField = { key: string; label: string; placeholder: string; secret?: boolean };
export type ProviderMeta = { label: string; fields: CredField[] };

export const PROVIDER_META: Record<string, ProviderMeta> = {
  google: {
    label: 'Google Calendar',
    fields: [
      { key: 'accessToken', label: 'Access Token', placeholder: 'OAuth2 access token' },
      { key: 'calendarId', label: 'Calendar ID', placeholder: 'primary', secret: false },
    ],
  },
  outlook: {
    label: 'Outlook / M365',
    fields: [
      { key: 'accessToken', label: 'Access Token', placeholder: 'OAuth2 bearer token' },
      { key: 'userId', label: 'User ID', placeholder: 'me (optional)', secret: false },
      { key: 'calendarId', label: 'Calendar ID', placeholder: 'default (optional)', secret: false },
    ],
  },
  microsoft_bookings: {
    label: 'MS Bookings',
    fields: [
      { key: 'accessToken', label: 'Access Token', placeholder: 'OAuth2 bearer token' },
      { key: 'businessId', label: 'Business ID', placeholder: 'contoso@contoso.onmicrosoft.com', secret: false },
    ],
  },
  square: {
    label: 'Square',
    fields: [
      { key: 'accessToken', label: 'Access Token', placeholder: 'Square access token' },
      { key: 'locationId', label: 'Location ID', placeholder: 'LXXX...', secret: false },
    ],
  },
  acuity: {
    label: 'Acuity',
    fields: [
      { key: 'userId', label: 'User ID', placeholder: 'Acuity user ID', secret: false },
      { key: 'apiKey', label: 'API Key', placeholder: 'Acuity API key' },
    ],
  },
  bookeo: {
    label: 'Bookeo',
    fields: [
      { key: 'apiKey', label: 'API Key', placeholder: 'Bookeo API key' },
      { key: 'secretKey', label: 'Secret Key', placeholder: 'Bookeo secret key' },
    ],
  },
  mindbody: {
    label: 'Mindbody',
    fields: [
      { key: 'apiKey', label: 'API Key', placeholder: 'Mindbody API key' },
      { key: 'siteId', label: 'Site ID', placeholder: 'Site ID', secret: false },
      { key: 'accessToken', label: 'Access Token', placeholder: 'Staff/user token' },
      { key: 'locationId', label: 'Location ID', placeholder: 'Optional', secret: false },
      { key: 'timezone', label: 'Timezone', placeholder: 'America/Los_Angeles', secret: false },
    ],
  },
  wix: {
    label: 'Wix Bookings',
    fields: [{ key: 'accessToken', label: 'Access Token', placeholder: 'Wix OAuth access token' }],
  },
  calendly: {
    label: 'Calendly',
    fields: [
      { key: 'token', label: 'Token', placeholder: 'Personal access token / OAuth' },
      { key: 'user', label: 'User URI', placeholder: 'Optional', secret: false },
      { key: 'organization', label: 'Org URI', placeholder: 'Optional', secret: false },
    ],
  },
  vagaro: {
    label: 'Vagaro',
    fields: [
      { key: 'region', label: 'Region', placeholder: 'Account subdomain, e.g. us04', secret: false },
      { key: 'businessId', label: 'Business ID', placeholder: 'From POST /{region}/api/v2/locations', secret: false },
      { key: 'accessToken', label: 'Access Token', placeholder: 'From generate-access-token' },
    ],
  },
  zenoti: {
    label: 'Zenoti',
    fields: [
      { key: 'apiKey', label: 'API Key', placeholder: 'Zenoti API key' },
      { key: 'centerId', label: 'Center ID', placeholder: 'Center UUID', secret: false },
    ],
  },
  boulevard: {
    label: 'Boulevard',
    fields: [
      { key: 'businessId', label: 'Business ID', placeholder: 'Boulevard business ID', secret: false },
      { key: 'locationId', label: 'Location ID', placeholder: 'urn:blvd:Location:...', secret: false },
      { key: 'apiKey', label: 'API Key', placeholder: 'Boulevard API key' },
      { key: 'apiSecret', label: 'API Secret', placeholder: 'Boulevard API secret' },
    ],
  },
  phorest: {
    label: 'Phorest',
    fields: [
      { key: 'username', label: 'Username', placeholder: 'global/api@salon.com', secret: false },
      { key: 'password', label: 'Password', placeholder: 'Phorest password' },
      { key: 'businessId', label: 'Business ID', placeholder: 'Business ID', secret: false },
      { key: 'branchId', label: 'Branch ID', placeholder: 'Branch ID', secret: false },
    ],
  },
  setmore: {
    label: 'Setmore',
    fields: [{ key: 'accessToken', label: 'Access Token', placeholder: 'Setmore bearer token' }],
  },
  mangomint: {
    label: 'Mangomint',
    fields: [{ key: 'apiKey', label: 'API Key', placeholder: 'Mangomint API key' }],
  },
  apple: {
    label: 'Apple / CalDAV',
    fields: [
      { key: 'username', label: 'Username', placeholder: 'iCloud email', secret: false },
      { key: 'appPassword', label: 'App Password', placeholder: 'App-specific password' },
      { key: 'calendarUrl', label: 'Calendar URL', placeholder: 'https://p01-caldav.icloud.com/...', secret: false },
    ],
  },
};

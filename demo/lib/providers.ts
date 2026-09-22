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

/** Runs entirely in the browser against localStorage — no credentials, no host.
 *  Deliberately absent from ADAPTERS and from the proxy allowlist: it is not a
 *  library adapter and must never be relayable through /api/call. */
export const LOCAL_PROVIDERS = new Set<string>(['sample']);

export function isLocal(provider: string): boolean {
  return LOCAL_PROVIDERS.has(provider);
}

export function isDirect(provider: string): boolean {
  return DIRECT_PROVIDERS.has(provider);
}

/** Build a BookingClient. `Object.hasOwn` guard avoids prototype-key lookups. */
export function makeClient(
  provider: string,
  creds: Record<string, string>,
  baseUrl?: string,
): BookingClient {
  if (!Object.hasOwn(ADAPTERS, provider)) throw new Error(`Unknown provider: ${provider}`);
  return ADAPTERS[provider](creds, { timeoutMs: 10_000, ...(baseUrl ? { baseUrl } : {}) });
}

/* ═══════════════════════════════════════════════════════════
   Credential field metadata (UI).
   `secret` defaults to masked; opt OUT with `secret: false` for
   genuinely non-sensitive fields (ids, timezones, hostnames).
   ═══════════════════════════════════════════════════════════ */
export type CredField = {
  key: string;
  label: string;
  placeholder: string;
  secret?: boolean;
  /** Where this value comes from, one short line shown under the label.
   *  Sourced from docs/PROVIDERS.md §3 (each adapter's own credentials
   *  note) -- never invented. When a field has none, ConnectPanel falls
   *  back to showing its placeholder as that line instead. */
  help?: string;
  /** A link to the provider's own page, set only where docs/PROVIDERS.md
   *  itself gives an absolute URL for this value. */
  helpHref?: string;
  /** True only where docs/PROVIDERS.md documents a working default or says
   *  the field is genuinely optional (e.g. Google's `calendarId`, which
   *  defaults to `'primary'`; Outlook's `userId`, defaulting to `'me'`, and
   *  `calendarId`, defaulting to the account's default calendar). Never set
   *  on a field the provider actually requires. Drives ConnectPanel's
   *  "Advanced" disclosure -- undefined/false means "show it up front". */
  advanced?: boolean;
};
export type ProviderMeta = { label: string; fields: CredField[] };

export const PROVIDER_META: Record<string, ProviderMeta> = {
  sample: {
    // No "(no account needed)" suffix here: this label renders unconditionally
    // in the picker regardless of which provider is selected, so putting that
    // phrase here would make it appear even when a credentialed provider is
    // selected -- the phrase belongs in the selection-scoped TrustBanner copy
    // instead (see ConnectPanel.tsx), where it actually describes the choice
    // the visitor just made.
    label: 'Sample Data',
    fields: [],
  },
  google: {
    label: 'Google Calendar',
    fields: [
      {
        key: 'accessToken',
        label: 'Access Token',
        placeholder: 'OAuth2 access token',
        help: "OAuth2 access token with the '…/auth/calendar' scope, minted via unibooking/oauth/google.",
      },
      {
        key: 'calendarId',
        label: 'Calendar ID',
        placeholder: 'primary',
        secret: false,
        help: "Defaults to 'primary'. Use an id from listCalendars() to target a different calendar.",
        advanced: true,
      },
    ],
  },
  outlook: {
    label: 'Outlook / M365',
    fields: [
      {
        key: 'accessToken',
        label: 'Access Token',
        placeholder: 'OAuth2 bearer token',
        help: "OAuth2 bearer token with the 'Calendars.ReadWrite' scope, minted via unibooking/oauth/microsoft.",
      },
      {
        key: 'userId',
        label: 'User ID',
        placeholder: 'me (optional)',
        secret: false,
        help: "Defaults to 'me'. Availability search needs a UPN here instead -- 'me' is not accepted for that call.",
        advanced: true,
      },
      {
        key: 'calendarId',
        label: 'Calendar ID',
        placeholder: 'default (optional)',
        secret: false,
        help: "Defaults to the account's default calendar. Use an id from listCalendars() for another one.",
        advanced: true,
      },
    ],
  },
  microsoft_bookings: {
    label: 'MS Bookings',
    fields: [
      {
        key: 'accessToken',
        label: 'Access Token',
        placeholder: 'OAuth2 bearer token',
        help: "OAuth2 bearer token with the 'Bookings.ReadWrite.All' application scope, minted via unibooking/oauth/microsoft.",
      },
      {
        key: 'businessId',
        label: 'Business ID',
        placeholder: 'contoso@contoso.onmicrosoft.com',
        secret: false,
      },
    ],
  },
  square: {
    label: 'Square',
    fields: [
      {
        key: 'accessToken',
        label: 'Access Token',
        placeholder: 'Square access token',
        help: 'Square access token with Appointments scopes, minted via unibooking/oauth/square.',
      },
      { key: 'locationId', label: 'Location ID', placeholder: 'LXXX...', secret: false },
    ],
  },
  acuity: {
    label: 'Acuity',
    fields: [
      { key: 'userId', label: 'User ID', placeholder: 'Acuity user ID', secret: false },
      {
        key: 'apiKey',
        label: 'API Key',
        placeholder: 'Acuity API key',
        help: 'Acuity API key -- or use an OAuth access token instead, minted via unibooking/oauth/acuity.',
      },
    ],
  },
  bookeo: {
    label: 'Bookeo',
    fields: [
      { key: 'apiKey', label: 'API Key', placeholder: 'Bookeo API key' },
      {
        key: 'secretKey',
        label: 'Secret Key',
        placeholder: 'Bookeo secret key',
        help: 'Paired with the API key above; Bookeo has no OAuth helper.',
      },
    ],
  },
  mindbody: {
    label: 'Mindbody',
    fields: [
      { key: 'apiKey', label: 'API Key', placeholder: 'Mindbody API key' },
      { key: 'siteId', label: 'Site ID', placeholder: 'Site ID', secret: false },
      {
        key: 'accessToken',
        label: 'Access Token',
        placeholder: 'Staff/user token',
        help: "Staff/user token issued by Mindbody's /usertoken/issue endpoint.",
      },
      { key: 'locationId', label: 'Location ID', placeholder: 'Optional', secret: false },
      {
        key: 'timezone',
        label: 'Timezone',
        placeholder: 'America/Los_Angeles',
        secret: false,
        help: 'IANA zone, preferred over a fixed offset -- it alone handles daylight saving.',
      },
    ],
  },
  wix: {
    label: 'Wix Bookings',
    fields: [
      {
        key: 'accessToken',
        label: 'Access Token',
        placeholder: 'Wix OAuth access token',
        help: 'Wix OAuth access token, minted via unibooking/oauth/wix (partial helper).',
      },
    ],
  },
  calendly: {
    label: 'Calendly',
    fields: [
      {
        key: 'token',
        label: 'Token',
        placeholder: 'Personal access token / OAuth',
        help: 'Personal access token or OAuth token, minted via unibooking/oauth/calendly.',
      },
      {
        key: 'user',
        label: 'User URI',
        placeholder: 'Optional',
        secret: false,
        help: 'Optional -- looked up automatically from GET /users/me when left blank.',
      },
      {
        key: 'organization',
        label: 'Org URI',
        placeholder: 'Optional',
        secret: false,
        help: 'Optional -- scopes listBookings to the organization instead of just the user.',
      },
    ],
  },
  vagaro: {
    label: 'Vagaro',
    fields: [
      {
        key: 'region',
        label: 'Region',
        placeholder: 'Account subdomain, e.g. us04',
        secret: false,
      },
      {
        key: 'businessId',
        label: 'Business ID',
        placeholder: 'From POST /{region}/api/v2/locations',
        secret: false,
      },
      {
        key: 'accessToken',
        label: 'Access Token',
        placeholder: 'From generate-access-token',
        help: 'Valid for 1 hour with no refresh token -- mint a new one with the same call when it expires.',
      },
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
      {
        key: 'businessId',
        label: 'Business ID',
        placeholder: 'Boulevard business ID',
        secret: false,
      },
      {
        key: 'locationId',
        label: 'Location ID',
        placeholder: 'urn:blvd:Location:...',
        secret: false,
      },
      {
        key: 'apiKey',
        label: 'API Key',
        placeholder: 'Boulevard API key',
        help: 'Paired with the API secret below to HMAC-sign each request; Boulevard has no OAuth helper.',
      },
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
    fields: [
      {
        key: 'accessToken',
        label: 'Access Token',
        placeholder: 'Setmore bearer token',
        help: 'Lasts two hours -- refresh it via unibooking/oauth/setmore (refresh-only helper).',
      },
    ],
  },
  mangomint: {
    label: 'Mangomint',
    fields: [
      {
        key: 'apiKey',
        label: 'API Key',
        placeholder: 'Mangomint API key',
        help: 'MangoMint publishes no API documentation; every call currently throws UNSUPPORTED, this key included.',
      },
    ],
  },
  apple: {
    label: 'Apple / CalDAV',
    fields: [
      { key: 'username', label: 'Username', placeholder: 'iCloud email', secret: false },
      {
        key: 'appPassword',
        label: 'App Password',
        placeholder: 'App-specific password',
        help: 'An iCloud app-specific password, not your Apple ID password.',
      },
      {
        key: 'calendarUrl',
        label: 'Calendar URL',
        placeholder: 'https://p01-caldav.icloud.com/...',
        secret: false,
        help: "Optional -- found automatically with listCalendars(). Defaults to iCloud's CalDAV host.",
        helpHref: 'https://caldav.icloud.com/',
      },
    ],
  },
};

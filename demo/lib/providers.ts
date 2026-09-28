/* ── Adapter imports (all 16) ── */
import { google } from 'unibooking/adapters/google';
import { outlook } from 'unibooking/adapters/outlook';
import { microsoftBookings } from 'unibooking/adapters/microsoft_bookings';
import { square } from 'unibooking/adapters/square';
import { acuity } from 'unibooking/adapters/acuity';
import { bookeo } from 'unibooking/adapters/bookeo';
import { booker } from 'unibooking/adapters/booker';
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
  booker,
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

/** Providers whose APIs allow browser (CORS) calls: run entirely client-side. */
export const DIRECT_PROVIDERS = new Set<string>([
  'google',
  'outlook',
  'microsoft_bookings',
  'calendly',
  'zenoti',
  'phorest',
  'wix',
]);

/** Providers that block browser calls: routed through the demo's proxy. */
export const PROXY_PROVIDERS = new Set<string>([
  'square',
  'acuity',
  'bookeo',
  'booker',
  'mindbody',
  'boulevard',
  'setmore',
  'vagaro',
  'mangomint',
  'apple',
]);

/** Runs entirely in the browser against localStorage, no credentials, no host.
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

   Derived from the library's own PROVIDER_CREDENTIALS rather than
   restated here: that schema is generated from each adapter's
   credential type and tested against it, so a second copy in the
   demo could only ever drift out of date. The demo adds the two
   things that are purely its own -- a display label, and the
   "Advanced" disclosure -- and nothing else.
   ═══════════════════════════════════════════════════════════ */
import { PROVIDER_CREDENTIALS, type CredentialField } from 'unibooking';

export type CredField = {
  key: string;
  label: string;
  placeholder: string;
  secret?: boolean;
  /** Where this value comes from, one short line shown under the label.
   *  Carried through from the library schema, which sources it from
   *  docs/PROVIDERS.md -- never invented. When a field has none,
   *  ConnectPanel falls back to showing its placeholder instead. */
  help?: string;
  /** A link to the provider's own page, set only where docs/PROVIDERS.md
   *  itself gives an absolute URL for this value. */
  helpHref?: string;
  /** Behind ConnectPanel's "Advanced" disclosure. This is exactly the
   *  library's `required: false` -- a field with a working default or one
   *  that is genuinely optional -- so the two cannot disagree. */
  advanced?: boolean;
};
export type ProviderMeta = { label: string; fields: CredField[] };

/** Display names. The library schema is deliberately label-free per provider:
 *  what to call Outlook in a picker is a product decision, not a credential. */
const LABELS: Record<string, string> = {
  google: 'Google Calendar',
  outlook: 'Outlook / M365',
  microsoft_bookings: 'MS Bookings',
  square: 'Square',
  acuity: 'Acuity',
  bookeo: 'Bookeo',
  booker: 'Booker',
  mindbody: 'Mindbody',
  wix: 'Wix Bookings',
  calendly: 'Calendly',
  vagaro: 'Vagaro',
  zenoti: 'Zenoti',
  boulevard: 'Boulevard',
  phorest: 'Phorest',
  setmore: 'Setmore',
  mangomint: 'Mangomint',
  apple: 'Apple / CalDAV',
};

function toCredField(f: CredentialField): CredField {
  return {
    key: f.key,
    label: f.label,
    placeholder: f.placeholder ?? '',
    secret: f.secret,
    ...(f.help ? { help: f.help } : {}),
    ...(f.helpHref ? { helpHref: f.helpHref } : {}),
    // Optional in the library == "Advanced" in this UI.
    ...(f.required ? {} : { advanced: true }),
  };
}

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
  ...Object.fromEntries(
    Object.entries(PROVIDER_CREDENTIALS).map(([id, sets]) => [
      id,
      {
        label: LABELS[id] ?? id,
        // The first set is the one to offer by default. Only Acuity has a
        // second (an OAuth token instead of the user id + API key pair), and
        // its API-key help line already says so.
        fields: (sets[0]?.fields ?? []).map(toCredField),
      },
    ]),
  ),
};

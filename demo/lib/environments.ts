/**
 * The single source of truth for provider hosts. The Connect tab renders its
 * environment control from this table and the proxy route derives its SSRF
 * allowlist from the same export, so the UI can never offer a host the server
 * will reject.
 *
 * Hosts verified against official provider documentation on 2026-07-20 —
 * see docs/audits/2026-07-20-provider-environments.md for per-provider sources.
 * `prod` values must equal each adapter's built-in default; environments-drift
 * .test.ts proves that by observing real requests.
 *
 * Only THREE providers publish a genuinely separate sandbox hostname. Several
 * others advertise a "sandbox" that is an account-level setting on the
 * production host — those are deliberately absent here:
 *   - Calendly: the portal's Sandbox toggle is an OAuth app designation that
 *     only relaxes the redirect-URI scheme rule. No separate host.
 *   - Mindbody: sandbox is site ID -99 sent in the SiteId header.
 *   - Wix: SANDBOX is a CMS data-environment value, a request-level setting.
 */
export type ProviderEnvironments = {
  /** Default base URL. Must match the adapter's built-in default. */
  prod: string;
  /** Only where the provider publishes a separate sandbox HOSTNAME. */
  sandbox?: string;
  /** Region key → base URL, for providers with data-residency hosts. */
  regions?: Record<string, string>;
  /**
   * False when overriding the base URL has no effect. Apple/CalDAV derives its
   * host from the user's `calendarUrl`, so a base URL override is a no-op and
   * the field is disabled rather than silently ignored.
   */
  baseUrlEditable?: boolean;
};

export const ENVIRONMENTS: Record<string, ProviderEnvironments> = {
  google: { prod: 'https://www.googleapis.com/calendar/v3/' },

  // Graph's alternate hosts are network-isolated national clouds, not latency
  // regions — tokens are NOT interchangeable between them.
  outlook: {
    prod: 'https://graph.microsoft.com/v1.0/',
    regions: {
      'us-gov-high': 'https://graph.microsoft.us/v1.0/',
      'us-gov-dod': 'https://dod-graph.microsoft.us/v1.0/',
      china: 'https://microsoftgraph.chinacloudapi.cn/v1.0/',
    },
  },

  // Same Graph hosts as Outlook MINUS China: Bookings is explicitly unsupported
  // on 21Vianet, so sharing Outlook's list would promise something that 404s.
  microsoft_bookings: {
    prod: 'https://graph.microsoft.com/v1.0/',
    regions: {
      'us-gov-high': 'https://graph.microsoft.us/v1.0/',
      'us-gov-dod': 'https://dod-graph.microsoft.us/v1.0/',
    },
  },

  square: {
    prod: 'https://connect.squareup.com/v2/',
    sandbox: 'https://connect.squareupsandbox.com/v2/',
  },

  acuity: { prod: 'https://acuityscheduling.com/api/v1/' },
  bookeo: { prod: 'https://api.bookeo.com/v2/' },
  mindbody: { prod: 'https://api.mindbodyonline.com/public/v6/' },
  wix: { prod: 'https://www.wixapis.com/' },
  calendly: { prod: 'https://api.calendly.com/' },

  // The region (e.g. us04) is a PATH parameter on this fixed host, not a
  // subdomain — it already lives in the adapter's credentials.
  vagaro: { prod: 'https://api.vagaro.com/' },

  // Third-party guides cite api.zenoti.eu / api.zenoti.com.au, but neither
  // appears on a Zenoti-owned page. Excluded until confirmed: an unverified
  // host in an allowlist is a guess with security consequences.
  zenoti: { prod: 'https://api.zenoti.com/v1/' },

  // Production and sandbox are on DIFFERENT registrable domains.
  boulevard: {
    prod: 'https://dashboard.boulevard.io/api/2020-01/',
    sandbox: 'https://sandbox.joinblvd.com/api/2020-01/',
  },

  // US and AUS share platform-us; there is no platform-aus host.
  phorest: {
    prod: 'https://platform.phorest.com/third-party-api-server/api/',
    sandbox: 'https://api-gateway-dev.phorest.com/third-party-api-server/api/',
    regions: {
      eu: 'https://platform.phorest.com/third-party-api-server/api/',
      'us-aus': 'https://platform-us.phorest.com/third-party-api-server/api/',
    },
  },

  setmore: { prod: 'https://developer.setmore.com/' },

  // Mangomint publishes no public endpoint documentation; this host matches the
  // adapter's built-in default and is observed to respond, but is not
  // documentation-confirmed. Prod-only, no override offered beyond it.
  mangomint: { prod: 'https://api.mangomint.com/' },

  // CalDAV requests go to the user's `calendarUrl` (already guarded by
  // assertSafeCalendarUrl), so overriding baseUrl does nothing.
  apple: { prod: 'https://caldav.icloud.com/', baseUrlEditable: false },
};

function hostOf(url: string): string {
  return new URL(url).hostname.toLowerCase();
}

/** Every host this provider may legitimately be pointed at. */
export function allowedHosts(provider: string): string[] {
  const env = ENVIRONMENTS[provider];
  if (!env) return [];
  const urls = [env.prod, env.sandbox, ...Object.values(env.regions ?? {})];
  return [...new Set(urls.filter((u): u is string => Boolean(u)).map(hostOf))];
}

/** Resolve a named environment to its base URL, or undefined if absent. */
export function resolveBaseUrl(provider: string, env: string): string | undefined {
  const e = ENVIRONMENTS[provider];
  if (!e) return undefined;
  if (env === 'prod') return e.prod;
  if (env === 'sandbox') return e.sandbox;
  return e.regions?.[env];
}

/**
 * SSRF guard for the base URL, mirroring assertSafeCalendarUrl.
 *
 * We compare the PARSED `url.hostname` (never the raw string) so
 * `https://connect.squareup.com@evil.com/` is rejected — the parser assigns
 * `evil.com` to hostname. Matching is EXACT, not suffix-based: a subdomain
 * takeover on a provider's domain must not automatically become our problem.
 */
export function assertSafeBaseUrl(provider: string, raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('baseUrl is required when overriding the provider host.');
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('baseUrl must be a valid absolute URL.');
  }

  if (url.protocol !== 'https:') {
    throw new Error('baseUrl must use https.');
  }

  if (url.port !== '') {
    throw new Error('baseUrl must not specify an explicit port.');
  }

  const permitted = allowedHosts(provider);
  const host = url.hostname.toLowerCase();
  if (!permitted.includes(host)) {
    throw new Error(
      `Base URL host "${host}" is not permitted for provider "${provider}". ` +
        `Allowed: ${permitted.join(', ') || '(none)'}.`,
    );
  }

  return url.toString();
}

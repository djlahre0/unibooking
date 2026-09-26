import type { ProviderId } from './types';

/**
 * What each provider requires to connect, as data.
 *
 * This is metadata only: field names, labels and whether a value is secret.
 * It holds no credential, and the package ships none: every value described
 * here is supplied by the consumer, from their own environment or their own
 * users. Nothing in this module is browser-unsafe, so it lives at the package
 * root rather than behind `unibooking/connections` (which pulls in the
 * server-only `src/oauth/*`).
 *
 * `required` mirrors the adapter's own credential type: a property the type
 * marks optional is `required: false` here, and the two are kept in step by
 * `test/credentials.test.ts`.
 */

/** How a set of fields authenticates. */
export type AuthKind =
  /** A token minted by an OAuth flow: see `unibooking/oauth/*`. */
  | 'oauth'
  /** An API key, or a key pair, issued from the provider's dashboard. */
  | 'keys'
  /** Apple only: an app-specific password, not the Apple ID password. */
  | 'app-password';

export interface CredentialField {
  /** The property name on the adapter's credential object. */
  key: string;
  /** Human label for a consumer's own connect form. */
  label: string;
  /** Mask it in a UI, never log it, never put it in an error message. */
  secret: boolean;
  /** False where the adapter's credential type marks the property optional. */
  required: boolean;
  placeholder?: string;
  /** Where the value comes from. Sourced from docs/PROVIDERS.md, not invented. */
  help?: string;
  /** Only where PROVIDERS.md gives an absolute URL for this value. */
  helpHref?: string;
}

/**
 * One way to authenticate with a provider. Most providers have exactly one.
 * Acuity has two, HTTP Basic or an OAuth bearer, and a flat field list
 * cannot express "either these or that one", which is why this is a set
 * rather than a single array.
 */
export interface CredentialSet {
  kind: AuthKind;
  fields: CredentialField[];
}

/** Shorthand builders. `secret` is spelled out per field rather than defaulted:
 *  a field that is secret by accident is the failure that matters. */
const secret = (
  key: string,
  label: string,
  rest: Partial<CredentialField> = {},
): CredentialField => ({ key, label, secret: true, required: true, ...rest });

const plain = (
  key: string,
  label: string,
  rest: Partial<CredentialField> = {},
): CredentialField => ({ key, label, secret: false, required: true, ...rest });

export const PROVIDER_CREDENTIALS: Record<ProviderId, CredentialSet[]> = {
  google: [
    {
      kind: 'oauth',
      fields: [
        secret('accessToken', 'Access Token', {
          placeholder: 'OAuth2 access token',
          help: "OAuth2 access token with the '…/auth/calendar' scope, minted via unibooking/oauth/google.",
        }),
        plain('calendarId', 'Calendar ID', {
          required: false,
          placeholder: 'primary',
          help: "Defaults to 'primary'. Use an id from listCalendars() to target a different calendar.",
        }),
      ],
    },
  ],
  outlook: [
    {
      kind: 'oauth',
      fields: [
        secret('accessToken', 'Access Token', {
          placeholder: 'OAuth2 bearer token',
          help: "OAuth2 bearer token with the 'Calendars.ReadWrite' scope, minted via unibooking/oauth/microsoft.",
        }),
        plain('userId', 'User ID', {
          required: false,
          placeholder: 'me',
          help: "Defaults to 'me'. Availability search needs a UPN here instead -- 'me' is not accepted for that call.",
        }),
        plain('calendarId', 'Calendar ID', {
          required: false,
          help: "Defaults to the account's default calendar. Use an id from listCalendars() for another one.",
        }),
      ],
    },
  ],
  microsoft_bookings: [
    {
      kind: 'oauth',
      fields: [
        secret('accessToken', 'Access Token', {
          placeholder: 'OAuth2 bearer token',
          help: "OAuth2 bearer token with the 'Bookings.ReadWrite.All' application scope, minted via unibooking/oauth/microsoft.",
        }),
        plain('businessId', 'Business ID', {
          placeholder: 'contoso@contoso.onmicrosoft.com',
        }),
      ],
    },
  ],
  square: [
    {
      kind: 'oauth',
      fields: [
        secret('accessToken', 'Access Token', {
          placeholder: 'Square access token',
          help: 'Square access token with Appointments scopes, minted via unibooking/oauth/square.',
        }),
        plain('locationId', 'Location ID', { placeholder: 'LXXX...' }),
      ],
    },
  ],
  // Two genuine alternatives, per AcuityCredentials' union.
  acuity: [
    {
      kind: 'keys',
      fields: [
        plain('userId', 'User ID', { placeholder: 'Acuity user ID' }),
        secret('apiKey', 'API Key', { placeholder: 'Acuity API key' }),
        plain('currency', 'Currency', {
          required: false,
          placeholder: 'USD',
          help: 'ISO-4217 code. Without it Service.price is left undefined rather than guessed.',
        }),
      ],
    },
    {
      kind: 'oauth',
      fields: [
        secret('accessToken', 'Access Token', {
          help: 'OAuth2 access token for an app acting on a connected account, minted via unibooking/oauth/acuity.',
        }),
        plain('currency', 'Currency', {
          required: false,
          placeholder: 'USD',
          help: 'ISO-4217 code. Without it Service.price is left undefined rather than guessed.',
        }),
      ],
    },
  ],
  bookeo: [
    {
      kind: 'keys',
      fields: [
        secret('apiKey', 'API Key', { placeholder: 'Bookeo API key' }),
        secret('secretKey', 'Secret Key', {
          placeholder: 'Bookeo secret key',
          help: 'Paired with the API key above; Bookeo has no OAuth helper.',
        }),
      ],
    },
  ],
  booker: [
    {
      kind: 'keys',
      fields: [
        secret('accessToken', 'Access Token', {
          placeholder: 'Bearer token',
          help: 'Bearer token from POST /v5/auth/connect/token (client_credentials).',
        }),
        secret('subscriptionKey', 'Subscription Key', {
          placeholder: 'Ocp-Apim-Subscription-Key',
          help: 'Sent as the Ocp-Apim-Subscription-Key header; Booker rejects calls without it.',
        }),
        plain('locationId', 'Location ID', { placeholder: 'Booker location ID' }),
        plain('timezone', 'Timezone', {
          required: false,
          placeholder: 'America/Chicago',
          help: "The location's IANA zone. Booker's server always speaks Eastern, so without this every time is off by the difference.",
        }),
      ],
    },
  ],
  mindbody: [
    {
      kind: 'keys',
      fields: [
        secret('apiKey', 'API Key', { placeholder: 'Mindbody API key' }),
        plain('siteId', 'Site ID', { placeholder: 'Site ID' }),
        secret('accessToken', 'Access Token', {
          placeholder: 'Staff/user token',
          help: "Staff/user token issued by Mindbody's /usertoken/issue endpoint.",
        }),
        plain('locationId', 'Location ID', { required: false }),
        plain('timezone', 'Timezone', {
          required: false,
          placeholder: 'America/Los_Angeles',
          help: 'IANA zone, preferred over utcOffset -- it alone handles daylight saving.',
        }),
        plain('utcOffset', 'UTC Offset', {
          required: false,
          placeholder: '-08:00',
          help: 'Used only when timezone is absent. A fixed offset ignores DST.',
        }),
      ],
    },
  ],
  wix: [
    {
      kind: 'oauth',
      fields: [
        secret('accessToken', 'Access Token', {
          placeholder: 'Wix OAuth access token',
          help: 'Wix OAuth access token, minted via unibooking/oauth/wix (partial helper -- the grant keys on an instanceId).',
        }),
      ],
    },
  ],
  calendly: [
    {
      kind: 'oauth',
      fields: [
        secret('token', 'Token', {
          placeholder: 'Personal access token / OAuth',
          help: 'Personal access token or OAuth token, minted via unibooking/oauth/calendly.',
        }),
        plain('user', 'User URI', {
          required: false,
          help: 'Looked up automatically from GET /users/me when left blank.',
        }),
        plain('organization', 'Org URI', {
          required: false,
          help: 'Scopes listBookings to the organization instead of just the user.',
        }),
        plain('defaultTimezone', 'Default Timezone', {
          required: false,
          placeholder: 'America/New_York',
        }),
      ],
    },
  ],
  vagaro: [
    {
      kind: 'keys',
      fields: [
        plain('region', 'Region', { placeholder: 'Account subdomain, e.g. us04' }),
        plain('businessId', 'Business ID', {
          placeholder: 'From POST /{region}/api/v2/locations',
        }),
        secret('accessToken', 'Access Token', {
          placeholder: 'From generate-access-token',
          help: 'Valid for 1 hour with no refresh token -- mint a new one with the same call when it expires.',
        }),
      ],
    },
  ],
  zenoti: [
    {
      kind: 'keys',
      fields: [
        secret('apiKey', 'API Key', { placeholder: 'Zenoti API key' }),
        plain('centerId', 'Center ID', { placeholder: 'Center UUID' }),
      ],
    },
  ],
  boulevard: [
    {
      kind: 'keys',
      fields: [
        plain('businessId', 'Business ID', { placeholder: 'Boulevard business ID' }),
        plain('locationId', 'Location ID', { placeholder: 'urn:blvd:Location:...' }),
        secret('apiKey', 'API Key', {
          placeholder: 'Boulevard API key',
          help: 'Paired with the API secret below to HMAC-sign each request; Boulevard has no OAuth helper.',
        }),
        secret('apiSecret', 'API Secret', { placeholder: 'Boulevard API secret' }),
      ],
    },
  ],
  phorest: [
    {
      kind: 'keys',
      fields: [
        plain('username', 'Username', { placeholder: 'global/api@salon.com' }),
        secret('password', 'Password', { placeholder: 'Phorest password' }),
        plain('businessId', 'Business ID', { placeholder: 'Business ID' }),
        plain('branchId', 'Branch ID', { placeholder: 'Branch ID' }),
        plain('currency', 'Currency', { required: false, placeholder: 'EUR' }),
      ],
    },
  ],
  setmore: [
    {
      kind: 'oauth',
      fields: [
        secret('accessToken', 'Access Token', {
          placeholder: 'Setmore bearer token',
          help: 'Lasts two hours -- refresh it via unibooking/oauth/setmore (refresh-only helper; there is no authorization-code flow).',
        }),
        plain('currency', 'Currency', {
          required: false,
          placeholder: 'USD',
          help: 'ISO-4217 code. Without it Service.price is left undefined rather than guessed.',
        }),
      ],
    },
  ],
  mangomint: [
    {
      kind: 'keys',
      fields: [
        secret('apiKey', 'API Key', {
          placeholder: 'Mangomint API key',
          help: 'MangoMint publishes no API documentation; every call currently throws UNSUPPORTED, this key included.',
        }),
      ],
    },
  ],
  apple: [
    {
      kind: 'app-password',
      fields: [
        plain('username', 'Username', { placeholder: 'iCloud email' }),
        secret('appPassword', 'App Password', {
          placeholder: 'App-specific password',
          help: 'An iCloud app-specific password, not your Apple ID password.',
        }),
        plain('calendarUrl', 'Calendar URL', {
          required: false,
          placeholder: 'https://p01-caldav.icloud.com/...',
          help: "Found automatically with listCalendars(). Defaults to iCloud's CalDAV host.",
          helpHref: 'https://caldav.icloud.com/',
        }),
      ],
    },
  ],
};

/** The ways this provider can authenticate. More than one only for Acuity. */
export function authKinds(provider: ProviderId): AuthKind[] {
  return PROVIDER_CREDENTIALS[provider].map((s) => s.kind);
}

/**
 * The fields that must be supplied. With no `kind`, the provider's first
 * credential set is used: the one a consumer should offer by default.
 */
export function requiredCredentials(provider: ProviderId, kind?: AuthKind): CredentialField[] {
  const sets = PROVIDER_CREDENTIALS[provider];
  const set = kind ? sets.find((s) => s.kind === kind) : sets[0];
  return set ? set.fields.filter((f) => f.required) : [];
}

/**
 * The first credential set whose required fields are all present in `fields`.
 * This is how a provider with alternatives (Acuity) is resolved: whichever
 * complete set the consumer actually supplied. Undefined when none is
 * satisfied, which the caller turns into an error naming what is missing.
 */
export function matchCredentialSet(
  provider: ProviderId,
  fields: Readonly<Record<string, string | undefined>>,
): CredentialSet | undefined {
  return PROVIDER_CREDENTIALS[provider].find((set) =>
    set.fields.every((f) => !f.required || !!fields[f.key]),
  );
}

/** Whether a given key is secret for this provider. Unknown keys are treated
 *  as secret: guessing "not secret" is the mistake that leaks. */
export function isSecretField(provider: ProviderId, key: string): boolean {
  for (const set of PROVIDER_CREDENTIALS[provider]) {
    const field = set.fields.find((f) => f.key === key);
    if (field) return field.secret;
  }
  return true;
}

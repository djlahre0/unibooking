/**
 * Setup guides, one per provider: how to get access, what to collect, and
 * what to know before relying on it. The credential FIELDS are not restated
 * here: provider pages read them from the library's `PROVIDER_CREDENTIALS`,
 * which is tested against each adapter's own type. This file adds only what
 * a schema cannot hold: the steps, the links and the caveats.
 *
 * Sources: the adapter module docs in `src/adapters/`, docs/PROVIDERS.md and
 * the README's provider table. Strings use a small inline markup rendered by
 * `lib/docs/inline.tsx`: `code`, **bold** and [text](https://…).
 */

export type ProviderGuide = {
  name: string;
  kind: 'calendar' | 'booking';
  /** One line, for cards, search results and the page lead. */
  summary: string;
  /** How a developer gets API access at all. */
  access: 'Self-serve' | 'Paid plan' | 'Partner approval' | 'Not available';
  /** The authentication scheme, in a few words. */
  auth: string;
  /** How far the adapter has been exercised (see the README's "Is it production ready?"). */
  maturity: 'established' | 'validate' | 'planned';
  docsUrl: string;
  portal?: { label: string; href: string };
  /** "Get your credentials", in order. */
  steps: string[];
  oauth?: { fn: string; module: string; note?: string };
  webhook?: { fns: string[]; module: string; note?: string };
  /** Behaviour worth knowing before production. */
  notes: string[];
};

export const PROVIDER_ORDER = [
  'google',
  'outlook',
  'apple',
  'square',
  'acuity',
  'calendly',
  'microsoft_bookings',
  'wix',
  'mindbody',
  'booker',
  'bookeo',
  'setmore',
  'vagaro',
  'phorest',
  'zenoti',
  'boulevard',
  'mangomint',
] as const;

export type GuideId = (typeof PROVIDER_ORDER)[number];

export const PROVIDER_GUIDES: Record<GuideId, ProviderGuide> = {
  google: {
    name: 'Google Calendar',
    kind: 'calendar',
    summary: 'Events on any Google calendar, with free/busy availability and push sync.',
    access: 'Self-serve',
    auth: 'OAuth 2.0',
    maturity: 'established',
    docsUrl: 'https://developers.google.com/workspace/calendar/api/guides/overview',
    portal: { label: 'Google Cloud console', href: 'https://console.cloud.google.com/' },
    steps: [
      'In the Google Cloud console, create or pick a project and enable the **Google Calendar API**.',
      'Configure the **OAuth consent screen** and add the scopes `…/auth/calendar` and `…/auth/calendar.events`. While the app is in _Testing_, add the accounts that may sign in as test users.',
      'Create an **OAuth client ID** of type _Web application_ and register your callback URL as an authorized redirect URI, e.g. `https://app.example.com/oauth/google/callback`.',
      'On your server, use `googleOAuth` to send each user to consent and exchange the returned code for tokens. Store the tokens yourself.',
      'Create the client with the access token. Leave `calendarId` out for the primary calendar, or pick one from `listCalendars()`.',
    ],
    oauth: {
      fn: 'googleOAuth',
      module: 'unibooking/oauth/google',
      note: '`access_type=offline` and `prompt=consent` are always sent, without them Google issues no refresh token.',
    },
    webhook: {
      fns: ['verifyGoogleChannelToken', 'parseGoogleNotification'],
      module: 'unibooking/webhooks/google',
      note: 'Open a channel with `watchBookings()`; a notification carries no body, so answer it with `syncBookings()`.',
    },
    notes: [
      'The `calendar` scope is _sensitive_: Google requires app verification before sign-in is open to the public.',
      '`searchAvailability` derives free slots from free/busy and needs a positive `durationMinutes`.',
      'Recurring events are expanded into instances; each has its own `id` and the series is `seriesId`.',
      'Versioned writes: pass `Booking.version` as `ifVersion` to fail with `CONFLICT` instead of overwriting a change.',
    ],
  },
  outlook: {
    name: 'Outlook / Microsoft 365',
    kind: 'calendar',
    summary: 'Outlook and Microsoft 365 calendars through Microsoft Graph.',
    access: 'Self-serve',
    auth: 'OAuth 2.0 (Microsoft identity platform)',
    maturity: 'established',
    docsUrl: 'https://learn.microsoft.com/en-us/graph/api/resources/event?view=graph-rest-1.0',
    portal: { label: 'Microsoft Entra admin center', href: 'https://entra.microsoft.com/' },
    steps: [
      'In the Entra admin center, open **App registrations → New registration**. For work, school and personal accounts choose _Accounts in any organizational directory and personal Microsoft accounts_ (the `common` tenant).',
      'Add a **Web** platform redirect URI for your callback, e.g. `https://app.example.com/oauth/microsoft/callback`.',
      'Under **Certificates & secrets**, create a client secret and copy its value.',
      'Under **API permissions**, add the delegated permissions `offline_access`, `User.Read` and `Calendars.ReadWrite`.',
      'Use `outlookOAuth` for consent and code exchange (pass `tenant` to restrict sign-in to one directory), then create the client with the access token.',
    ],
    oauth: {
      fn: 'outlookOAuth',
      module: 'unibooking/oauth/microsoft',
      note: '`offline_access` is added to any scope list you pass, so refresh always works.',
    },
    webhook: {
      fns: ['graphValidationToken', 'verifyGraphClientState', 'parseGraphNotifications'],
      module: 'unibooking/webhooks/outlook',
      note: 'Your endpoint must echo Graph’s `validationToken` before `watchBookings()` can create the subscription.',
    },
    notes: [
      '`pageToken` and `syncToken` are full Graph URLs. The library only ever sends credentials to the Graph host you configured, so a forged token cannot leak them.',
      'Availability reads the calendar’s own events. For other mailboxes pass `providerOptions.schedules` (work or school accounts only).',
      'Cancel with `cancelBooking()`; Graph cannot set `isCancelled` through an update.',
      'National clouds (US Gov, China) are supported through `options.baseUrl`.',
    ],
  },
  apple: {
    name: 'Apple iCloud / CalDAV',
    kind: 'calendar',
    summary: 'iCloud and any CalDAV server, Fastmail, Nextcloud, Baïkal, over WebDAV.',
    access: 'Self-serve',
    auth: 'App-specific password (HTTP Basic)',
    maturity: 'validate',
    docsUrl: 'https://www.rfc-editor.org/rfc/rfc4791.html',
    portal: { label: 'Apple Account', href: 'https://account.apple.com/' },
    steps: [
      'Sign in to your Apple Account and open **Sign-In and Security → App-Specific Passwords**. Generate one; your normal Apple ID password will not work.',
      'Use the Apple ID email as `username` and the generated password as `appPassword`.',
      'Call `listCalendars()`: it discovers the account’s calendars from the server root. Each `Calendar.id` is a collection URL.',
      'Pass the chosen `Calendar.id` as `calendarUrl` for every event operation.',
      'For another CalDAV server, point `options.baseUrl` at its root, e.g. `https://caldav.fastmail.com/`.',
    ],
    notes: [
      'There is no OAuth for third-party calendar access on iCloud; app-specific passwords are Apple’s supported route.',
      'No availability, staff or services: CalDAV is a plain calendar.',
      'Writes are guarded with ETags: a concurrent edit fails as `CONFLICT` rather than being overwritten.',
      'Change sync uses `syncBookings()` (RFC 6578 sync-collection); there are no push webhooks.',
    ],
  },
  square: {
    name: 'Square Appointments',
    kind: 'booking',
    summary: 'The reference adapter: bookings, availability, catalog, team and customers.',
    access: 'Self-serve',
    auth: 'OAuth 2.0 or personal access token',
    maturity: 'established',
    docsUrl: 'https://developer.squareup.com/reference/square/bookings-api',
    portal: { label: 'Square Developer console', href: 'https://developer.squareup.com/apps' },
    steps: [
      'Create an application in the Square Developer console.',
      'For your own account, copy the **access token** (Sandbox or Production). For other merchants, set up OAuth with `squareOAuth` and your app’s redirect URL.',
      'Find the **location ID** under Locations in the Seller Dashboard, or with `GET /v2/locations`.',
      'Make sure the merchant has **Square Appointments**. Reads work on the free plan; creating, updating and cancelling bookings needs a paid plan.',
      'For the sandbox, pass `options.baseUrl: \'https://connect.squareupsandbox.com/v2/\'`.',
    ],
    oauth: {
      fn: 'squareOAuth',
      module: 'unibooking/oauth/square',
      note: 'Default scopes are read-only for the catalog; add `SQUARE_WRITE_SCOPES` for service and staff writes.',
    },
    webhook: {
      fns: ['verifySquareSignature'],
      module: 'unibooking/webhooks/square',
      note: 'Subscribe to booking events in the Developer console; verify with your webhook signature key and the exact notification URL.',
    },
    notes: [
      '`Service.id` is the catalog **variation** id: the id Square’s booking API accepts.',
      'Plan limits surface as `UNSUPPORTED` with a remedy, never as `AUTH`, so a healthy connection is never mistaken for a revoked one.',
      '`createBooking` needs `serviceId` and `staffId`; the catalog version is read for you.',
      'Customers are deduplicated by email (then phone) before one is created.',
    ],
  },
  acuity: {
    name: 'Acuity Scheduling',
    kind: 'booking',
    summary: 'Appointments, availability, classes and calendars (staff) on Acuity.',
    access: 'Paid plan',
    auth: 'API key (HTTP Basic) or OAuth 2.0',
    maturity: 'established',
    docsUrl: 'https://developers.acuityscheduling.com/reference/quick-start',
    portal: {
      label: 'Acuity developer docs',
      href: 'https://developers.acuityscheduling.com/',
    },
    steps: [
      'In Acuity, open **Integrations → API** to see your **User ID** and **API Key**. API access requires an eligible paid plan.',
      'For an app that connects many Acuity accounts, register an OAuth client with Acuity and use `acuityOAuth`; pass `{ accessToken }` instead of the key pair.',
      'Set `currency` (ISO-4217, e.g. `USD`) if you want service prices: Acuity returns amounts without a currency.',
    ],
    oauth: { fn: 'acuityOAuth', module: 'unibooking/oauth/acuity' },
    webhook: {
      fns: ['verifyAcuitySignature'],
      module: 'unibooking/webhooks/acuity',
      note: 'Acuity signs the raw body with your API key.',
    },
    notes: [
      'Acuity “calendars” are staff; “appointment types” are services.',
      '`listBookings` returns at most `limit` (default 100) appointments and has no next page: keep windows narrow on busy accounts.',
      'Availability is one request per day, up to 31 days, and needs `durationMinutes`.',
      'Status cannot be written; cancel with `cancelBooking()`.',
    ],
  },
  calendly: {
    name: 'Calendly',
    kind: 'booking',
    summary: 'Scheduled events, event types and available times on Calendly.',
    access: 'Self-serve',
    auth: 'Personal access token or OAuth 2.0',
    maturity: 'established',
    docsUrl: 'https://developer.calendly.com/api-docs',
    portal: { label: 'Calendly developer portal', href: 'https://developer.calendly.com/' },
    steps: [
      'For your own account, create a **personal access token** under Integrations & apps → API and webhooks.',
      'For other users, register an OAuth application in the developer portal and use `calendlyOAuth`.',
      'Pass the token as `token` (not `accessToken`). `user` is looked up from `GET /users/me` when omitted.',
      'Use an event type URI from `listServices()` as `serviceId` to search availability or book.',
    ],
    oauth: {
      fn: 'calendlyOAuth',
      module: 'unibooking/oauth/calendly',
      note: 'Calendly rotates refresh tokens: persist every refreshed token (see OAuth & token refresh).',
    },
    webhook: {
      fns: ['verifyCalendlySignature'],
      module: 'unibooking/webhooks/calendly',
      note: 'Pass `toleranceMs` (Calendly suggests 180000) to reject replays.',
    },
    notes: [
      'Creating bookings uses the Scheduling API and requires a **paid** Calendly plan.',
      'There is no reschedule endpoint: an update with a new range books the new time, then cancels the old. The returned booking has a new id.',
      'Availability ranges are capped at 31 days and need `durationMinutes`.',
    ],
  },
  microsoft_bookings: {
    name: 'Microsoft Bookings',
    kind: 'booking',
    summary: 'Booking businesses in Microsoft 365: appointments, services, staff and customers.',
    access: 'Self-serve',
    auth: 'OAuth 2.0 (Microsoft identity platform)',
    maturity: 'validate',
    docsUrl:
      'https://learn.microsoft.com/en-us/graph/api/resources/booking-api-overview?view=graph-rest-1.0',
    portal: { label: 'Microsoft Entra admin center', href: 'https://entra.microsoft.com/' },
    steps: [
      'Register an app in Entra (as for Outlook) and grant `Bookings.ReadWrite.All`.',
      'Find the booking business id, its email-style id, e.g. `contoso@contoso.onmicrosoft.com`, with `GET /solutions/bookingBusinesses`.',
      'Use `microsoftBookingsOAuth` for delegated sign-in, then create the client with the token and `businessId`.',
    ],
    oauth: { fn: 'microsoftBookingsOAuth', module: 'unibooking/oauth/microsoft' },
    notes: [
      '`searchAvailability` calls `getStaffAvailability`, which Graph allows only with **application** permissions: a delegated token fails for that one call.',
      'No webhooks: Graph v1.0 has no subscriptions on Bookings resources.',
      'Status cannot be written; cancel with `cancelBooking()`.',
    ],
  },
  wix: {
    name: 'Wix Bookings',
    kind: 'booking',
    summary: 'Bookings, services, staff and contacts on a Wix site.',
    access: 'Self-serve',
    auth: 'Wix app OAuth (instance-based)',
    maturity: 'validate',
    docsUrl:
      'https://dev.wix.com/docs/rest/business-solutions/bookings/bookings/about-the-bookings-apis',
    portal: { label: 'Wix Dev Center', href: 'https://dev.wix.com/' },
    steps: [
      'Create an app in the Wix Dev Center and grant it the Bookings and Contacts permissions.',
      'Install the app on a site. The install delivers an `instanceId` to your app’s redirect endpoint.',
      'Exchange it with `wixOAuth(…).exchangeCode(instanceId)`: Wix has no user-redirect authorize step.',
      'Pass the access token as-is; the adapter sends it without a `Bearer` prefix, as Wix expects.',
    ],
    oauth: {
      fn: 'wixOAuth',
      module: 'unibooking/oauth/wix',
      note: 'Partial helper: `authorizationUrl` is unsupported because the grant is keyed on the install.',
    },
    webhook: {
      fns: ['verifyWixWebhook'],
      module: 'unibooking/webhooks/wix',
      note: 'Events arrive as an RS256-signed JWT; verify with your app’s public key.',
    },
    notes: [
      'Availability is local time: `range.timezone` (IANA) is required.',
      'Updates only reschedule or cancel; the booking’s `revision` is read for you.',
      '`Staff.id` is the staff member’s `resourceId`: the id bookings reference.',
    ],
  },
  mindbody: {
    name: 'Mindbody',
    kind: 'booking',
    summary: 'Appointments, classes with waitlists, session types and staff on Mindbody.',
    access: 'Partner approval',
    auth: 'API key + site id + staff token',
    maturity: 'validate',
    docsUrl: 'https://api.mindbodyonline.com/public/v6/swagger/index',
    portal: { label: 'Mindbody developer portal', href: 'https://developers.mindbodyonline.com/' },
    steps: [
      'Create a developer account on the Mindbody developer portal and request an **API key**. Use sandbox site `-99` while building.',
      'Ask each site owner to activate your integration for their **site id**.',
      'Issue a staff **user token** with `POST /usertoken/issue` using a staff login, and pass it as `accessToken`.',
      'Set `timezone` to the site’s IANA zone: Mindbody returns local times without an offset.',
    ],
    webhook: {
      fns: ['verifyMindbodySignature'],
      module: 'unibooking/webhooks/mindbody',
    },
    notes: [
      'Without `timezone` (or `utcOffset`) every time is read as UTC.',
      'Creating an appointment needs a client id, staff, session type and `locationId`.',
      'Validate against sandbox site `-99` before production; the adapter has not been run against a live site.',
    ],
  },
  booker: {
    name: 'Booker',
    kind: 'booking',
    summary: 'Mindbody Booker salons and spas: appointments, treatments, staff and classes.',
    access: 'Partner approval',
    auth: 'Client-credentials token + subscription key',
    maturity: 'validate',
    docsUrl: 'https://developers.mindbodyonline.com/ui/documentation/booker-api',
    portal: {
      label: 'Booker API documentation',
      href: 'https://developers.mindbodyonline.com/ui/documentation/booker-api',
    },
    steps: [
      'Request Booker API access to receive a client id, client secret and an API **subscription key**.',
      'Mint a token with `POST https://api.booker.com/v5/auth/connect/token` (form-encoded `grant_type=client_credentials`, your client id, secret and scope, plus the `Ocp-Apim-Subscription-Key` header).',
      'Pass the token as `accessToken`, the key as `subscriptionKey`, and the `locationId`.',
      'Set `timezone` to the location’s IANA zone. The token has no refresh: use the function credential form to mint a new one when it expires.',
    ],
    notes: [
      'Booker’s server speaks US Eastern time; `timezone` is what makes non-Eastern locations correct.',
      'Appointment availability and edits are `UNSUPPORTED` (undocumented endpoints); classes are supported.',
      'Built from the long-running `booker_ruby` client: validate against a live location first.',
    ],
  },
  bookeo: {
    name: 'Bookeo',
    kind: 'booking',
    summary: 'Tours, activities and classes on Bookeo.',
    access: 'Self-serve',
    auth: 'API key + secret key',
    maturity: 'validate',
    docsUrl: 'https://www.bookeo.com/api/',
    portal: { label: 'Bookeo API', href: 'https://www.bookeo.com/api/' },
    steps: [
      'Register as a Bookeo developer and create an API application to receive your **secret key**.',
      'Have each Bookeo account authorise your application; that gives you an **API key** for the account.',
      'List people categories with `GET /settings/peoplecategories`: bookings need `providerOptions.participants` with a `peopleCategoryId`.',
    ],
    webhook: {
      fns: ['verifyBookeoSignature'],
      module: 'unibooking/webhooks/bookeo',
      note: 'Pass `toleranceMs` (Bookeo suggests 120000) to reject replays.',
    },
    notes: [
      'Bookeo authenticates with query parameters, so the secret key appears in request URLs: keep it out of logs.',
      '`listBookings` ranges are capped at 31 days; availability reads one page of up to 300 slots.',
      'Updates only reschedule; cancel with `cancelBooking()`.',
    ],
  },
  setmore: {
    name: 'Setmore',
    kind: 'booking',
    summary: 'Appointments, services, staff and customers on Setmore.',
    access: 'Partner approval',
    auth: 'Refresh token → 2-hour bearer token',
    maturity: 'validate',
    docsUrl: 'https://developers.setmore.com/',
    portal: { label: 'Setmore developer docs', href: 'https://developers.setmore.com/' },
    steps: [
      'API access needs a paid Setmore Pro account and approval: email **api@setmore.com**.',
      'Once approved, the account owner generates a long-lived **refresh token** in their Setmore settings.',
      'Exchange it with `setmoreOAuth().refresh(refreshToken)` for an access token that lasts two hours.',
    ],
    oauth: {
      fn: 'setmoreOAuth',
      module: 'unibooking/oauth/setmore',
      note: 'Refresh-only: there is no authorization-code flow.',
    },
    notes: [
      '`getBooking` is `UNSUPPORTED`, neither API generation has fetch-by-id; use `listBookings`.',
      'Reschedule and cancel use Setmore’s v2 API, whose bodies are inferred; confirm on a throwaway account.',
      'Availability needs `staffId`, `durationMinutes` and `range.timezone`.',
    ],
  },
  vagaro: {
    name: 'Vagaro',
    kind: 'booking',
    summary: 'Salon and spa appointments on Vagaro’s Enterprise API.',
    access: 'Partner approval',
    auth: 'Client id + secret → 1-hour access token',
    maturity: 'validate',
    docsUrl: 'https://docs.vagaro.com/public/reference/api-introduction',
    portal: { label: 'Vagaro API docs', href: 'https://docs.vagaro.com/public/reference/api-introduction' },
    steps: [
      'Request Enterprise API access from Vagaro to receive a client id and client secret key.',
      'Your `region` is the subdomain of the account’s Vagaro URL, e.g. `us04`.',
      'Mint a token with `POST /{region}/api/v2/merchants/generate-access-token`. It lasts one hour with no refresh: use the function credential form.',
      'Find the `businessId` with `POST /{region}/api/v2/locations`.',
    ],
    webhook: {
      fns: ['verifyVagaroToken'],
      module: 'unibooking/webhooks/vagaro',
      note: 'Vagaro sends a static shared token, not a signature.',
    },
    notes: [
      '`listBookings` requires `customerId`: Vagaro has no date-range list.',
      'Writes are business-local time; the wall clock of your range’s own offset is sent.',
      'Cancelling deletes the appointment.',
    ],
  },
  phorest: {
    name: 'Phorest',
    kind: 'booking',
    summary: 'Salon appointments, services, staff and clients on Phorest.',
    access: 'Partner approval',
    auth: 'HTTP Basic (API user)',
    maturity: 'validate',
    docsUrl: 'https://developer.phorest.com/docs/getting-started',
    portal: { label: 'Phorest developer docs', href: 'https://developer.phorest.com/' },
    steps: [
      'Request third-party API credentials from Phorest for the salon. You receive a username (starting `global/`) and password.',
      'Collect the salon’s `businessId` and `branchId`.',
      'For US or Australian salons, pass `options.baseUrl: \'https://platform-us.phorest.com/third-party-api-server/api/\'`.',
      'Set `currency` if you want service prices.',
    ],
    notes: [
      'No webhooks: Phorest recommends polling with `updated_from` / `updated_to`.',
      '`listBookings` ranges are capped at 31 days.',
      'Only `confirmed` and `cancelled` can be written as a status.',
    ],
  },
  zenoti: {
    name: 'Zenoti',
    kind: 'booking',
    summary: 'Spa and salon appointments, services, therapists and guests on Zenoti.',
    access: 'Partner approval',
    auth: 'API key',
    maturity: 'validate',
    docsUrl: 'https://docs.zenoti.com/reference',
    portal: { label: 'Zenoti API reference', href: 'https://docs.zenoti.com/reference' },
    steps: [
      'Have the organisation’s Zenoti admin generate an **API key** for your integration.',
      'Find the `centerId` with `GET /v1/centers`.',
      'Express ranges in the center’s own UTC offset: booking slots come back as center-local time.',
    ],
    notes: [
      'Booking is multi-step (create → reserve slot → confirm); rescheduling moves the appointment in place.',
      '`cancelBooking` cancels the appointment’s whole invoice, including other services on it.',
      'Availability needs `providerOptions.guestId` and `durationMinutes`, one date at a time.',
    ],
  },
  boulevard: {
    name: 'Boulevard',
    kind: 'booking',
    summary: 'Enterprise salons on Boulevard’s Admin GraphQL API.',
    access: 'Partner approval',
    auth: 'API key + secret (HMAC-signed per request)',
    maturity: 'validate',
    docsUrl: 'https://developers.joinblvd.com/2020-01/admin-api/overview',
    portal: { label: 'Boulevard developer docs', href: 'https://developers.joinblvd.com/' },
    steps: [
      'Request Admin API access from Boulevard (Enterprise merchants). You receive an API key and a base64 API secret.',
      'Collect the `businessId` and the `locationId` you will book against.',
      'Build against the sandbox with `options.baseUrl: \'https://sandbox.joinblvd.com/api/2020-01/\'`.',
    ],
    webhook: {
      fns: ['verifyBoulevardSignature'],
      module: 'unibooking/webhooks/boulevard',
      note: 'Your endpoint must accept `PING` and must never answer 410: Boulevard treats that as unsubscribe.',
    },
    notes: [
      'Availability is `UNSUPPORTED`: slot search lives on Boulevard’s separate Client API.',
      'Cancelling needs a `reason` from Boulevard’s enum, e.g. `CLIENT_CANCEL`.',
      'Only notes, state and custom fields can be updated.',
    ],
  },
  mangomint: {
    name: 'Mangomint',
    kind: 'booking',
    summary: 'Planned. Mangomint publishes no public API documentation yet.',
    access: 'Not available',
    auth: 'Unknown',
    maturity: 'planned',
    docsUrl: 'https://www.mangomint.com/',
    steps: [
      'There is nothing to set up yet: every method throws `UNSUPPORTED`. The adapter exists so the provider id is stable when an API is published.',
    ],
    notes: ['Watch the changelog for an implementation.'],
  },
};

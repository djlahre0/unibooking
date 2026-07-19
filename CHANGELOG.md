# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.5] - 2026-07-19

### Fixed

- **Provider-audit follow-ups** (extends the 0.1.4 audit; verified against current
  docs, pending live-credential confirmation):
  - **Apple/CalDAV now expands recurring events.** `listBookings` requests CalDAV
    `<C:expand>` (RFC 4791 §9.6.5), so a repeating series returns one booking per
    in-window occurrence with the correct instance time (was: the unexpanded master
    at a possibly out-of-window time). Instances of one series share a DAV resource
    (and thus a booking `id`); use `raw`'s `RECURRENCE-ID` to disambiguate.
  - **Wix rewritten to the documented Bookings V2 contract.** `getBooking`/
    `listBookings` now POST the Query Extended Bookings endpoint (Reader V2 has no
    GET-by-id) and unwrap `.booking`; `searchAvailability` uses Time Slots V2
    (`fromLocalDate`/`toLocalDate`/`timeZone`, mapping offset-less local times back
    to instants — now requires `range.timezone`); `createBooking` sends the required
    participant count and `reschedule`/`cancel` send the required `revision`.
  - **Square** `createBooking` routes `providerOptions.service_variation_version`
    onto the appointment segment (where Square needs it).
  - **Setmore** default host switched to the documented `developer.setmore.com`
    (override via `options.baseUrl`).
  - **Acuity `searchAvailability` now spans a multi-day range.** Acuity's
    `availability/times` is single-date, so the adapter pages one call per day the
    range overlaps (capped at 31 days) and keeps only in-window slots — a multi-day
    query previously returned only the first day.

### Added

- **`notify?: boolean` on `CreateBookingInput`/`UpdateBookingInput`.** Wired into
  the Google adapter (`notify: true` → `sendUpdates=all` so attendees are emailed
  on create/update, `false` → `none`, omitted → Google's default). Ignored by
  providers that don't support it.

## [0.1.4] - 2026-07-19

### Fixed

- **Full provider audit (2026-07-19)** — all 16 adapters reviewed and verified
  against each vendor's *current* API docs (Square, Microsoft Graph/Bookings,
  Acuity, Calendly, Wix, Mindbody, Bookeo, Zenoti, and the gated tier). Report:
  [docs/audits/2026-07-19-booking-providers.md](./docs/audits/2026-07-19-booking-providers.md).
  - **Microsoft Bookings was broken on every read/write.** The `bookingAppointment`
    resource carries its times as `start`/`end` (`dateTimeTimeZone`), but the
    adapter read and sent `startDateTime`/`endDateTime` — so every
    `getBooking`/`listBookings` threw "appointment is missing start/end times" and
    create/update sent fields Graph ignores. Now uses `start`/`end`. `updateBooking`
    also handles the `204 No Content` Graph returns on PATCH by re-GETting the
    appointment (it was trying to parse an empty body).
  - **Mindbody `updateBooking` used `PUT`; the v6 method is `POST`** on
    `appointment/updateappointment`. Also, `LocationId` is **required** by
    `AddAppointment` (was only sent when set) — `createBooking` now rejects a
    missing `locationId` client-side, and the `Requested` status maps to `pending`
    (was `unknown`).
  - **Calendly `createBooking` posted to a non-existent path.** The Scheduling API
    "Create Event Invitee" is `POST /invitees`, and `name`/`timezone` belong
    *inside* the `invitee` object. Fixed the path and placement; `providerOptions`
    now flows into the create body so event types that require a `location` can
    supply one.
  - **Acuity silently dropped `notes` on non-reschedule updates** — Acuity only
    lets an admin write `notes`, so that PUT now sends `admin=true`. And
    `createBooking` sends `admin=true` **only** when a `staffId` (calendarID) is
    present, because Acuity rejects admin-mode creates without a calendarID.
  - **Square `cancelBooking` sent an invalid `seller_note`** field (not part of
    CancelBooking) — removed. Square's cancel endpoint carries no reason field.
  - **Wix created CRM contacts with the wrong name shape** — Contacts v4
    `info.name` is `{ first, last }`, not `{ firstName, lastName }`, so a new
    contact's name was silently dropped.

### Documented

- Confirmed-against-docs limitations now called out in the provider docs + report:
  **the Wix adapter's `getBooking`/`listBookings`/`searchAvailability` use
  endpoints/shapes that don't match the current Bookings V2 API** (Reader V2 has
  no GET-by-id; availability is Time Slots V2 with local-time fields), and
  create/reschedule/cancel omit the required `totalParticipants`/`revision` — it
  needs a live-tenant rewrite; **Square** appointment creates require a `staffId`
  (team_member_id) plus a service-variation version; **Bookeo** creates require
  `participants` (and `eventId` for fixed products) via `providerOptions`;
  **Acuity** `listBookings` truncates at `max` (no cursor) and availability is
  single-date. **Zenoti**, **Vagaro** (read-only), and the **Mangomint** stub were
  verified correct; **Boulevard**/**Phorest**/**Setmore** carry small unverified
  notes (mutation casing, cancel-param shape, and API host, respectively).

## [0.1.3] - 2026-07-19

### Fixed

- **Calendar-integration audit (2026-07-19).** Findings verified against the
  current Google Calendar v3, Microsoft Graph v1.0, and CalDAV (RFC 4791 / RFC
  5545) specs. See [docs/audits/2026-07-19-calendar.md](./docs/audits/2026-07-19-calendar.md).
  - **HTTP `412 Precondition Failed` now maps to `CONFLICT`, not `UPSTREAM`.**
    412 is how CalDAV signals an `If-Match` (lost-update) or `If-None-Match:*`
    (create-collision) failure. Mapping it to the retryable `UPSTREAM` meant
    `withRetry` would silently re-run the write and clobber the concurrent edit
    the Apple/CalDAV `ETag` guard was there to protect. `CONFLICT` is
    non-retryable, so the optimistic-concurrency guard now holds under retry.
  - **iCalendar `DURATION` week form (`P1W`) is now parsed.** A valid RFC 5545
    week-form duration previously failed to match, collapsing the event to a
    zero-length range (`end === start`); it now sizes correctly (`P1W` = 7 days).
  - **Google `updateBooking` now maps a canonical `status`.** `pending` →
    `tentative` and `confirmed`/`completed` → `confirmed` on the event `status`
    field (previously only `cancelled` was honored; other statuses were dropped),
    matching how the Outlook and Apple adapters already map status on update.

### Documented

- Known limitations surfaced by the audit (behavior unchanged, now called out in
  the provider docs): Apple/CalDAV `listBookings` returns recurring events as the
  **unexpanded master** (its `DTSTART` can fall outside the queried window, and a
  series yields one booking, not one per instance) — Google and Outlook expand
  recurrences; Outlook `cancelBooking` with `notify`/`reason` uses Graph's
  organizer-only `/cancel` action, which returns `400` for a non-organizer or an
  attendee-less personal event; Google/Outlook do not notify attendees on
  `createBooking` by default.

## [0.1.2] - 2026-07-19

### Added

- Interactive **demo app** (`demo/`) — a Next.js "Try-It" explorer that exercises
  all 16 adapters against the published package: direct client-side calls for
  CORS-friendly providers, and a strict-allowlist `/api/call` proxy (with an SSRF
  guard on the Apple/CalDAV URL) for the ones that block browser calls. It lives
  in the repo only and is not shipped in the npm tarball.

The library's public API, types, and runtime behavior are unchanged from 0.1.1.

## [0.1.1] - 2026-07-16

### Changed

- **Minimum Node is now 20** (was 18). The library is built on the Web Crypto
  global (`globalThis.crypto`), which is only available by default on Node 19+ —
  so 0.1.0's `engines.node: ">=18"` was wrong and `crypto.subtle`/`randomUUID`
  threw on Node 18 (now end-of-life). Edge runtimes, Deno, Bun, and browsers are
  unaffected. CI now runs on Node 20, 22, and 24.

## [0.1.0] - 2026-07-16

### Added

- New adapters: `wix` (Wix Bookings V2 — full lifecycle, Time Slots V2, CRM
  contacts), `calendly` (API v2 — create via the Scheduling API, read/cancel,
  available times; `updateBooking` does cancel+rebook since Calendly has no
  reschedule endpoint), and `setmore` (gated beta — full appointment CRUD, slots,
  customers).
- `boulevard` is now a **real adapter** (Enterprise GraphQL Admin API) replacing
  the stub: create/read/reschedule/cancel/list + `customers.findOrCreate` +
  webhooks. `searchAvailability` throws `UNSUPPORTED` (bookable-time queries live
  on Boulevard's separate Client cart API).
- Webhook signature verifiers: `verifyCalendlySignature` (HMAC-SHA256 hex),
  `verifyMindbodySignature` (HMAC-SHA256 base64), `verifyWixWebhook` (RS256 signed
  JWT), and best-effort `verifyBoulevardSignature` (salted HMAC). Mindbody's
  `webhooks` capability is now `true`.
- Crypto helpers: `hmacSha256Hex`, `hmacSha256BytesBase64`, `base64ToBytes`, and
  `verifyRs256Jwt` (Web Crypto, no deps).
- Tier-2 provider adapters: `phorest` and `zenoti` (full CRUD), `vagaro` (read-only)
  with a `verifyVagaroToken` webhook helper. `mangomint` is registered
  as a stub (methods throw `UNSUPPORTED`) pending a public API.
- Core library: `Booking`/`TimeRange`/`Customer` canonical model, discriminated `UnibookingError`,
  typed `Capabilities`, bound-client factory API with refreshable credentials.
- Portable HTTP layer (injectable `fetch`, timeout, `Retry-After`, status→code mapping,
  and an `onResponse` request hook for reading response headers e.g. CalDAV `ETag`).
- Time utilities (RFC3339 parsing/validation, end-from-duration, `end > start` invariant).
- `createRegistry`, `withRetry`, and `listAll` helpers.
- Adapters: Google Calendar, Square Appointments, Outlook (Microsoft Graph), Microsoft Bookings,
  Acuity Scheduling, Bookeo, Mindbody, Apple/CalDAV.
- Webhook signature verifiers (Square, Outlook, Acuity, Google, Vagaro) built on Web Crypto.
- Shared adapter conformance test suite.
- `AvailabilityQuery.providerOptions` — a typed escape hatch for provider-specific
  availability inputs (e.g. Zenoti's booking-scoped `guestId`).

### Changed

- Adapter-kit `AuthFn` may now return a `Promise` (its result is awaited), so an
  adapter can sign each request asynchronously (Boulevard's per-request HMAC).
  Backward-compatible — existing synchronous `AuthFn`s are unaffected.
- **BREAKING:** `assertValidRange` now rejects offset-less timestamps. Canonical
  `TimeRange.start`/`end` must carry an explicit UTC offset (`Z` or `±HH:MM`); an
  offset-less string is ambiguous and was previously accepted, then reinterpreted
  in the host timezone by downstream date math.
- `withRetry` no longer auto-retries `customers.findOrCreate` (a non-idempotent
  create could duplicate a customer on a network retry), and now caps a
  server-supplied `Retry-After` at `maxDelayMs`.
- The shared conformance suite is stricter: it asserts `end > start` (no
  zero-length ranges), requires offset-bearing instants, and covers `410`/`422`
  error mapping.

### Fixed

- **Apple/CalDAV `updateBooking` no longer discards event data.** It now patches
  the fetched VCALENDAR in place (new `ical.patchICS`) instead of rebuilding from
  the lean model, so `RRULE` (recurrence), `LOCATION`, `DESCRIPTION`, extra
  `ATTENDEE`s, `VALARM`s, and `VTIMEZONE` survive an edit. A status update with no
  iCal form (e.g. `no_show`) now leaves the existing `STATUS` untouched rather than
  erasing it.
- **Apple/CalDAV addresses resources by their DAV href, not the UID.** `listBookings`
  now sets each booking `id` from the resource href (via `ical.parseCalendarEntries`),
  so `getBooking`/`updateBooking`/`cancelBooking` work for events a server stored
  under a name that isn't the iCal UID (common for externally-created events). The
  parser also keeps the first `ATTENDEE` as the canonical customer (was: the last).
- **Acuity no longer emits zero-length ranges/slots.** A booking with no positive
  `duration` raises `UPSTREAM` (matching Square), and `searchAvailability` requires a
  positive `durationMinutes` (matching Calendly/Zenoti/Setmore) instead of returning
  `end === start`.
- **Mindbody**: credentials accept an IANA `timezone` (e.g. `America/Los_Angeles`),
  which is DST-correct; the fixed `utcOffset` still works but is wrong for half the
  year in DST zones. `timezone` takes precedence when both are set.
- **Vagaro** `searchAvailability` skips a slot it can't size (no `endTime` and no
  `durationMinutes`) rather than emitting a zero-length range. **Phorest** raises
  `UPSTREAM` for a same-instant start/end. **Setmore** maps an unrecognized status
  to `unknown` instead of assuming `confirmed`. **Square** `listBookings` forwards
  the `customerId` filter.
- iCalendar/Apple: Windows/Exchange `TZID` names (e.g. `Eastern Standard Time`) are
  resolved instead of throwing an uncaught `RangeError` that could fail an entire
  `listBookings`; all-day/`DTEND`-less events derive an RFC5545 default end; line
  folding is octet-based (no split multibyte characters); `ATTENDEE;CN` is quoted.
- Apple/CalDAV: optimistic concurrency via `If-Match` (update) and `If-None-Match:*`
  (create); full canonical↔iCal `STATUS` mapping.
- Microsoft Graph: non-UTC (`timeZone`) datetimes are resolved rather than assumed
  UTC; pagination follows the full `@odata.nextLink` so `$skip` paging works.
- Outlook: `responseStatus`/`showAs` drive status (declined/tentative no longer
  surface as `confirmed`); `cancelBooking` honors `notify`/`reason`.
- Square: `updateBooking` maps `staffId`/`serviceId`/`title`; availability requires a
  `serviceId` and validates the range; phone-only customers are de-duplicated;
  bookings with no derivable duration raise `UPSTREAM` instead of a zero-length range.
- Acuity: `noShow` maps to `no_show`; `timezone` is populated; availability validates
  the range; a non-reschedule update maps `title` → notes.
- Bookeo: `listBookings` paginates via `pageNavigationToken`; numeric provider error
  codes are captured. Mindbody: `Completed` → `completed`; list/availability windows
  are sent as site-local. Phorest: `updateBooking` sends both `startTime` and
  `endTime`. Zenoti: bookings use the wall-clock date (fixes spurious near-midnight
  `CONFLICT`s); availability is reachable via the typed API and sizes slots properly.
- Pagination: `listAll` guards against multi-step token cycles, not just immediate repeats.

# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

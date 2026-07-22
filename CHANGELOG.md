# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

Provider capabilities the vendors document but the adapters had not yet exposed
— each verified against the provider's published API, none against a live
tenant.

- **Google and Outlook now support `searchAvailability`.** Both are plain
  calendars with no native slot search, so availability is derived from their
  free/busy APIs — Google `freeBusy`, Outlook `getSchedule` — via a shared,
  unit-tested `freeSlots` helper (range minus busy, sliced by `durationMinutes`).
  A positive `durationMinutes` is required; Outlook additionally needs the
  mailbox address in `providerOptions.schedules` (or a UPN-form `userId`), since
  `getSchedule` cannot resolve the `me` alias.
- **Microsoft Bookings now exposes `customers.findOrCreate`** via the
  `bookingCustomer` API — matches an existing customer by email (following
  pagination) or creates one.
- **Acuity accepts OAuth2 bearer credentials** (`{ accessToken }`) alongside the
  existing Basic auth (`{ userId, apiKey }`) — the recommended mode for
  multi-account apps.
- **Calendly `updateBooking({ status: 'no_show' })`** marks the event's invitee
  a no-show via `/invitee_no_shows`, instead of throwing `UNSUPPORTED`.
- **Square `createBooking` now attaches a name-only customer** (previously it
  resolved a customer only when an email or phone was present, silently dropping
  a name-only one).

## [0.2.0] - 2026-07-22

The last published release is 0.1.5. This version carries **two** audit passes:
the provider API audit of 2026-07-20 (which was version-bumped but never
published) and the follow-up pass below. Upgrading from 0.1.5 means taking both
— read both Breaking sections.

### Second audit pass (2026-07-22)

Again diffing each adapter against its provider's current published
documentation, plus RFC 4791/5545 for the CalDAV stack. Nine adapters had
defects that produced silently wrong results rather than errors.

#### Breaking

- **`SETMORE_MAX_PAGE_SIZE` is removed** from `unibooking/adapters/setmore`. It
  documented a 150-appointment cap that `listBookings` never actually applied
  (no page-size parameter is sent), so it described behavior the adapter did not
  have. Nothing in the package referenced it.
- **Several `updateBooking` calls that silently did nothing now throw.** Square,
  Acuity, Mindbody and Microsoft Bookings cannot write a booking `status`, and
  Acuity cannot change a service (or reassign staff outside a reschedule). These
  previously returned a healthy-looking `Booking` while the provider ignored the
  field. Use `cancelBooking()` to cancel. Setmore likewise rejects `status`, and
  Wix rejects `listBookings({ staffId })` — Wix exposes no staff filter, so the
  old behavior sent a filter that was ignored or rejected upstream.
- **Bookeo `createBooking` requires `providerOptions.participants`** with a
  `peopleCategoryId`. The previous hard-coded participants block omitted that
  required field, so every create failed upstream anyway; there is no safe
  default to infer, so it now fails client-side with a message naming the field.
- **Phorest `createBooking` requires `staffId`** — `ServiceSchedule.staffId` is
  required by the spec, so a create without it was a guaranteed 400.
- **Bookeo `updateBooking` rejects `title`/`staffId`/`serviceId`/`status`.** Its
  PUT is not a documented partial-update contract, so only a reschedule is safe
  to send; these fields were previously accepted and dropped.
- **Zenoti `searchAvailability` rejects a multi-day range,** and `listBookings`
  rejects a `pageToken`. Both previously accepted the input and silently
  returned partial results. Availability stays single-day deliberately: each
  query creates a transient upstream booking, so fanning out per day would leave
  a throwaway booking behind for every day in the range.
- **Vagaro and Setmore availability ranges are capped** (31 and 62 days) with a
  clear error, replacing a silent truncation to a partial slot list.

#### Fixed

- **Microsoft Bookings `searchAvailability` returned nothing.** It read the
  OData `value` wrapper, but `getStaffAvailability` returns its collection under
  `staffAvailabilityItem`. It also dropped `slotsAvailable` windows (bookable
  capacity on 1:n group services) and truncated businesses with more than one
  page of staff members.
- **Microsoft Bookings availability times could be 8 hours off.** Bookings
  labels offset-less times with a Windows *display* name
  (`"(UTC-08:00) Pacific Time (US & Canada)"`), which resolves via neither the
  IANA map nor `Intl`; the value silently fell back to UTC. The `(UTC±HH:MM)`
  prefix is now parsed as a last-resort offset.
- **Microsoft Bookings `updateBooking` silently swallowed `status` and `title`,**
  and omitted the `@odata.type` annotation its own create path sends. A
  `status: 'cancelled'` update now throws and points at `cancelBooking()`.
- **Calendly `createBooking` failed whenever `range.timezone` was unset.** The
  Create Event Invitee API requires `invitee.timezone`, but the canonical
  `TimeRange.timezone` is optional and display-only. It now falls back to a new
  `defaultTimezone` credential, then `UTC`. The cancel-and-rebook path also
  carries the original invitee's timezone across.
- **Calendly `listBookings` ignored `status: 'confirmed'`** (which maps to
  `active`) and forwarded a `limit` above the documented `count` max of 100.
- **iCalendar: a VALARM overwrote its event.** `parseICS` had no
  component-nesting guard, so an EMAIL alarm's `SUMMARY`, `ATTENDEE` and
  `DURATION` became the booking's title, customer and end time.
- **iCalendar: rescheduling a DURATION-sized event produced an invalid object.**
  `patchICS` inserted a `DTEND` while leaving the existing `DURATION`, which
  RFC 5545 §3.6.1 forbids in the same VEVENT.
- **CalDAV: `listBookings` could return nothing at all.** XML numeric character
  references were never decoded, so servers that escape the CR of a folded line
  as `&#13;` (sabre-based: Nextcloud, Baïkal) yielded ICS lines ending in a
  literal `&#13;` — `BEGIN:VEVENT` never matched.
- **iCalendar: a DQUOTEd `TZID` was dropped on reschedule,** flattening a zoned
  series to a fixed UTC offset that drifts an hour at every DST transition.
- **iCalendar: a CRLF in `uid` or the attendee email could inject arbitrary
  properties.** Both are now sanitized (they are opaque tokens, not TEXT).
- **CalDAV `getBooking`/`updateBooking` could act on the wrong occurrence.**
  Both used the first VEVENT; override-before-master ordering is legal, so they
  now select the component with no `RECURRENCE-ID`. `parseICS` exposes
  `recurrenceId`, and requests now send CalDAV-appropriate `accept` headers
  instead of the shared `application/json` default.
- **Acuity never reported a no-show.** `noShow` rides on top of `canceled` in
  Acuity's model, so testing `canceled` first made `'no_show'` unreachable.
- **Acuity `listBookings` returned bookings outside the requested range,** since
  `minDate`/`maxDate` are whole dates; results are now trimmed to the instants.
- **Acuity `updateBooking` silently discarded `status`, `serviceId`, and a
  `staffId` without a range.** Acuity ignores non-white-listed fields, so these
  now throw rather than report a success that never happened.
- **Square `createBooking` dropped the title** — it is written as
  `customer_note`, which is what reads back as the title.
- **Square `updateBooking` accepted a `status` it cannot apply** (the field is
  read-only); it now throws and points at `cancelBooking()`.
- **`verifyGraphClientState` accepted forged payloads when the expected
  `clientState` was empty** (e.g. an unset env var). Matches the guard the
  Google and Vagaro verifiers already had.
- **`verifyRs256Jwt` rejected instead of returning `null`** for a token whose
  signature segment is not valid base64url — the decode ran outside the guarded
  `verify()`, so a malformed Wix webhook threw instead of cleanly failing.
- **`createRegistry` suggested an import that does not exist** for
  `microsoft_bookings` (the export is `microsoftBookings`).
- **Mindbody `getBooking` only worked for appointments happening today.** It sent
  `AppointmentIds` alone, but `StartDate` defaults to today and `EndDate` to
  `StartDate` — so any other booking came back empty and surfaced as `NOT_FOUND`.
- **Mindbody `updateBooking` turned every reschedule into a resize.** It omitted
  `EndDateTime`, which defaults to the staff member's default duration, silently
  discarding `range.end`. It also dropped `serviceId` and `title`, and accepted a
  `status` it cannot write.
- **Mindbody `searchAvailability` reported a whole shift as one slot.** An
  `Availabilities[]` entry is a staff availability *window*, not a bookable slot;
  it is now sliced by `durationMinutes` (or the session type's default length),
  honoring `BookableEndDateTime` as the last permitted start.
- **Mindbody `createBooking` discarded the title** even though `toBooking` reads
  it back from `Notes`, so every created booking returned titled "Appointment".
- **Bookeo creates were schema-invalid.** The participants block hard-coded
  `{ number: 1 }` without the required `peopleCategoryId`. There is no safe
  default, so `createBooking` now fails client-side with a message naming the
  field, rather than sending a request the API always rejects.
- **Bookeo never returned a customer.** `expandCustomer` defaults to false and
  was never sent, so `booking.customer` was always undefined. It also ignored
  `customer.id` (the documented way to book an existing customer), reported
  no-shows and unaccepted bookings as `confirmed`, and never set `updatedAt`.
- **Wix `searchAvailability` sent an invalid request and returned unbookable
  slots.** `serviceId` is required (it was conditional), `bookable: true` was
  never sent (the default returns un-bookable slots too), and the staff id was
  read from a list that is empty unless resources are explicitly requested.
- **Wix reschedule and cancel could send a request guaranteed to fail.**
  `revision` is required on both; when it could not be resolved the field was
  simply omitted. They now fail fast client-side.
- **Wix `createBooking` could not reach its own top-level parameters.**
  `providerOptions` was merged into the `booking` object, making
  `participantNotification`, `flowControlSettings`, `sendSmsReminder` and
  `formSubmission` unreachable and silently dropping `notify`.
- **Phorest `searchAvailability` could never return a slot.** It expected a
  top-level array, but the endpoint returns `{data: [...]}` with `endTime` and
  `staffId` nested under `clientSchedules[].serviceSchedules[]` — so the guard
  filtered out 100% of results and the call threw `UPSTREAM`.
- **Phorest `createBooking` always threw.** Its post-processing read an
  `appointmentId` that the create response does not carry, then fell back to
  filtering by `group_booking_id` (a different field from the `bookingId` it
  was given), and finally mapped the booking envelope as if it were an
  appointment. The id is read from `clientAppointmentSchedules[]` instead.
- **Phorest reschedule sent the wrong time type and could not cross days.**
  `startTime`/`endTime` are `LocalTime` paired with a separate `appointmentDate`,
  but full ISO instants were sent — and inconsistently, since the backfill path
  copied the provider's already-correct `LocalTime`.
- **Phorest `listBookings` returned an extra day and could shift the window.**
  `to_date` is inclusive, and the dates were sliced off the offset-local string
  although Phorest dates are UTC. It also ignored `status` entirely (cancelled
  bookings need `fetch_canceled`) and forwarded an unclamped `size` past the
  documented maximum of 100.
- **Phorest `updateBooking` silently dropped `status`;** it now routes to the
  documented cancel/confirm transitions and rejects statuses with no equivalent.
- **Phorest basic auth threw on non-Latin-1 credentials** — `btoa` now receives
  UTF-8 bytes.
- **Setmore `updateBooking({ status })` failed with a misleading error** about a
  missing title, because the unsupported-field guard did not check `status`. Its
  availability fan-out also truncated ranges past 62 days silently, and computed
  the last day using the start's offset for both endpoints.
- **Zenoti had cancelled and no-show inverted,** plus four more values wrong
  against the documented status enum (`NoShow = -2, Cancelled = -1, New = 0,
  Closed = 1, Checkin = 2, Confirm = 4, Voided = 21`). `Closed` was reported as
  `pending` rather than `completed`, `Confirm` as `completed` rather than
  `confirmed`, `Voided` fell through to `unknown`, and three branches matched
  values Zenoti never sends.
- **Zenoti `listBookings` returned nothing for a same-day range.** Both endpoints
  were sliced to a date, but the API requires `start_date` and `end_date` to
  differ and treats the end as exclusive — so a 09:00–17:00 window collapsed to
  an empty one. It also silently dropped `status`, `limit` and `pageToken`, and
  could never return cancellations (`include_no_show_cancel` was never sent).
- **Zenoti availability fabricated a UTC offset.** Slot `Time` values are
  center-local without an offset, but one code path appended `Z` while another
  treated the same value as wall-clock, so the two disagreed and
  `AvailabilitySlot.start` claimed an instant it was not.
- **Zenoti usually lost the guest phone** — it read `mobile.number`, which the
  documented sample shows as null, ignoring the populated `display_number`.
- **Boulevard reschedule failed every time** with a spurious `CONFLICT`.
  `appointmentRescheduleAvailableTimes` returns a *list* of payloads, but
  `.availableTimes` was read off the array itself, yielding `undefined` and an
  empty candidate set.
- **Boulevard retried failures that can never succeed.** GraphQL errors arrive as
  HTTP 200 with an `errors[]` body and were all mapped to `UPSTREAM`, which
  `withRetry` treats as retryable — re-issuing non-idempotent mutations. They are
  now classified from `extensions.code` (falling back to the message) into
  `NOT_FOUND`/`AUTH`/`FORBIDDEN`/`CONFLICT`/`INVALID_INPUT`. A missing booking
  also returned `UPSTREAM` instead of `NOT_FOUND`, because GraphQL answers a bad
  id with `data.appointment: null` and HTTP 200.
- **Boulevard ignored the booking errors it asked for.** `bookingCreate` selected
  `booking { errors { code message } }` but never read them, so a booking that
  came back with errors proceeded to add a service and complete regardless.
- **Vagaro `listBookings` ignored the requested range entirely** — never
  validated, never filtered — returning the customer's whole history. It could
  also emit a `nextPageToken` forever (`rows.length >= rows.length` is always
  true), so paginating to exhaustion never terminated.
- **Vagaro `searchAvailability` returned only the first day** of a multi-day
  range and never filtered slots to the window; it now iterates days, capped at
  31 with a clear error beyond it.
- **Vagaro `updateBooking` could omit a field it documents as required**
  (`serviceProviderId` resolved to `undefined` and was dropped by
  `JSON.stringify`), and silently discarded `title`.
- **Wix `listBookings` filtered staff on an undocumented field.** Wix exposes no
  staff/resource filter on extended-bookings, so `staffId` now throws
  `UNSUPPORTED` instead of sending a filter that 400s or is ignored. `status` and
  `customerId` are now forwarded, and the page limit is clamped to 100.

#### Added

- `verifyCalendlySignature` accepts `toleranceMs` (and an injectable `now`) to
  reject replayed deliveries, as Calendly's docs recommend — the same opt-in
  shape the Bookeo verifier already had.
- `CalendlyCredentials.defaultTimezone`.
- Square `searchAvailability` honors `query.providerOptions`.
- Acuity honors `notify: false` on create and reschedule (`noEmail`).
- Mindbody honors `notify` on create (`SendEmail`), and forwards `customerId`
  (`ClientId`) and the site location on `listBookings`.
- Bookeo honors `notify` on create and cancel (`notifyCustomer`/`notifyUsers`),
  returns cancelled bookings when asked (`includeCanceled`), and rejects a range
  wider than the documented 31-day maximum client-side.
- Wix maps `notify` and a cancellation `reason` onto `participantNotification`,
  and passes `scheduleId`/`sessionId`/`timezone` through on reschedule.
- Apple/CalDAV `listBookings` honors `query.limit` and `query.status`
  client-side (CalDAV has no server-side paging or status filter).
- `AuthResult` is exported from the package root; it was reachable only as the
  return type of the already-exported `AuthFn`.
- 60+ additional Windows/Exchange timezone ids, all validated against `Intl`.

#### Changed

- **The README's verification claims were overstated and are now accurate.** It
  said the conformance suite asserts "URL, headers and request body"; it matches
  on request path and method only, and never inspects headers or bodies. It also
  implied adapters with open sandboxes are exercised live — none are. No adapter
  is verified against a live tenant; correctness rests on spec diffs like this
  one.

#### Removed

- `BuildVEventInput.status` and the `STATUS` branch in `buildICS` — no caller.
- Mindbody's `AppointmentTypeId` fallback (not a field in v6) and Wix's
  `availabilityTimeSlots`/`startDate`/`endDate`/`resource` response branches
  (none exist on the documented Time Slots V2 shape).
- Vestigial `export` on `extractCalendarData` and `WINDOWS_TO_IANA`; a no-op
  fractional-seconds strip in `instantToICalUTC`; five unreferenced Next.js
  template SVGs in the demo; and several stale comments (a Node 18 floor that is
  now 20, a "live integration tests" note for tests that do not exist, a
  resolved Calendly `TODO`).

### First audit pass (2026-07-20)

Every adapter was diffed against its provider's current published API
documentation. Three were non-functional and eleven had wire-format defects. All
findings below are grounded in a first-party specification — an OpenAPI/Swagger
document, a GraphQL introspection schema, or an official reference page.

> **Verification status.** These fixes match the published specifications. They
> are **not** confirmed against live tenants — no adapter in this package is.
> The exception is the Bookeo webhook verifier, which reproduces the vendor's
> own published test vector. (An earlier wording claimed the tests assert
> headers and request bodies across the board; they do not — see Changed above.)

#### Breaking

- **`VagaroCredentials` requires `businessId`.** Every appointment call needs it;
  it is discoverable via `POST /{region}/api/v2/locations`.
  ```ts
  // before
  vagaro({ region: 'us04', accessToken })
  // after
  vagaro({ region: 'us04', businessId: 'biz_123', accessToken })
  ```
- **`BoulevardCredentials` requires `locationId`.** The `appointments` query
  declares it non-null, and the booking flow needs it.
  ```ts
  boulevard({ businessId, locationId: 'urn:blvd:Location:…', apiKey, apiSecret })
  ```
- **Setmore `searchAvailability` requires `range.timezone`** (an IANA name). Slot
  times arrive as bare wall-clock strings with no date and no offset; inferring a
  zone from the caller's range misplaces every slot across a DST boundary.
- **Setmore `getBooking` and `cancelBooking` now throw `UNSUPPORTED`.** Neither
  endpoint exists — the Booking API is 11 routes with no fetch-by-id and no
  cancel or delete. Read bookings via `listBookings` over a date range. Setmore
  `updateBooking` accepts only a title (label); time, staff and service changes
  throw.
- **Vagaro `listBookings` requires `query.customerId`.** Vagaro has no
  date-range list; `POST /appointments` accepts `appointmentId` or `customerId`.
- **Acuity `createBooking` validates required customer fields up front**, raising
  `INVALID_INPUT` instead of surfacing an opaque upstream 400. `customer.name` is
  always required; `customer.email` is required except on admin bookings (i.e.
  when a `staffId` is supplied).
- **Boulevard `createBooking` requires a `staffId`** — `bookingComplete`
  declares `bookWithStaffId` non-null, so a staff-less booking is not
  expressible. `updateBooking` no longer accepts staff or service changes
  (`UpdateAppointmentInput` covers only notes, state and custom fields), and
  cancellation requires one of the documented reason enum values.
- **Outlook and Microsoft Bookings reject a non-URL `pageToken`.** It was
  previously forwarded as `$skiptoken`; see Fixed below.

#### Fixed

Adapters that could not work at all:

- **Vagaro** authenticated with `Authorization: Bearer` where the spec declares
  an apiKey scheme using a raw `accessToken` header — every request returned 401.
  A spurious `merchants/` path segment 404'd the two implemented methods, and
  `createBooking`/`updateBooking`/`cancelBooking`/`listBookings` were marked
  UNSUPPORTED on the false claim that no such endpoints exist. All are now
  implemented. Writes emit business-local wall clock while reads stay UTC;
  round-tripping a fetched instant into a write previously shifted the booking by
  the location's offset. `parseError` read `errorCode`/`code`, neither of which
  Vagaro sends — now `responseCode`.
- **Setmore** had six of eight paths wrong, and two operations addressed
  endpoints that do not exist. All three date encodings are corrected
  (`dd-mm-yyyy` list, `DD/MM/YYYY` slots, `yyyy-MM-ddTHH:mm` create), slots is a
  POST rather than a GET, dot-separated slot times parse, `cell_no` is now the
  documented `cell_phone` (phone numbers were silently dropped), and a
  `response: false` body raises even on HTTP 200.
- **Boulevard**'s webhook verifier omitted the colon separator and keyed the HMAC
  with the undecoded base64 secret, so **every genuine webhook was rejected**. It
  also accepted a hex signature Boulevard never emits. GraphQL operations now use
  the real argument shapes: `appointments` takes a required `locationId` and a
  `QueryString` filter (there is no `endAt` field, so ranges use `startAt`),
  booking is the documented three-step `bookingCreate` → `bookingAddService` →
  `bookingComplete` chain, reschedule resolves an opaque `bookableTimeId` first,
  and `clients` takes `emails: [String!]`.

Breaking defects in otherwise-working adapters:

- **Wix** `getBooking`, `listBookings` and `currentRevision` 404'd — the
  extended-bookings path was missing a segment (`bookings/reader/v2` →
  `bookings/bookings-reader/v2`). Because cancel and reschedule both resolve a
  revision first, most of the adapter was down.
- **Mindbody** `cancelBooking` threw UNSUPPORTED claiming no cancel endpoint
  exists. There is no cancel *path*, but cancellation is a documented action on
  `updateappointment` (`Execute: 'cancel'`). `createBooking` also dropped
  `range.end`, so a 90-minute request silently became the staff default duration.
  `searchAvailability` now pages instead of truncating at the first 100 results.
- **Calendly** `updateBooking({ status: 'cancelled' })` always threw `UPSTREAM`:
  the cancellation endpoint returns a Cancellation resource with no
  `uri`/`start_time`/`end_time`, which was fed to the booking mapper.
  Availability ranges are checked against the documented 31-day cap.
- **Bookeo** `createBooking` omitted the required `participants` field, failing
  for essentially every product. `parseError` read `code`/`errorCode`; the
  documented field is `errorId`, so `providerCode` was always `undefined`.
  `itemsPerPage` is clamped to the documented maximum of 100.
- **Zenoti** nested the service as a flat `service_id`; the spec requires
  `item: { id, item_type }`. `updateBooking` now uses the first-class reschedule
  (carrying `invoice_id` and `invoice_item_id`) rather than booking fresh and
  cancelling the old invoice — which changed the booking id, orphaned a cancelled
  invoice and could trigger cancellation fees. Slots flagged `Available: false`
  are no longer offered as bookable.
- **Phorest** `updateBooking` omitted `staffId` and `startTime`, both marked
  required, so any partial patch was rejected. They are now backfilled from
  current state. Note that Phorest recomputes duration from the new staff or
  service and ignores `endTime` on such a change.
- **Outlook / Microsoft Bookings** forwarded a non-URL `pageToken` as
  `$skiptoken`. `calendarView` pages via `$skip` and Graph ignores unrecognized
  query parameters silently, so callers received page 1 indefinitely and looped.
  `$top` is now range-checked against the documented 1–1000.
- **Apple / iCal**: `unescapeText` expanded the escaped-newline sequence before
  the escaped-backslash sequence, so a literal backslash followed by `n` decoded
  to a line feed. `escapeText` emitted bare CRs, for which RFC 5545 defines no
  escape and which re-split the content line. `patchICS` flattened
  `TZID`-anchored events to UTC, converting a recurring wall-clock series into a
  fixed-offset one that drifts an hour at every DST transition and orphans the
  `VTIMEZONE`. All three are covered by tests that fail against the previous
  implementation.

#### Added

- **Bookeo webhook verification** (`unibooking/webhooks/bookeo`). Bookeo signs
  deliveries with HMAC-SHA256 (hex) over
  `timestamp + messageId + webhookUrl + rawBody`, contradicting a code comment
  claiming otherwise. Verified against Bookeo's published test vector, which
  ships as a test. Supports the documented ±120s timestamp freshness check.
- **Microsoft Bookings `searchAvailability`** via `getStaffAvailability`, which
  is GA in Graph v1.0. Note it is **application-permission only** — a delegated
  user token works for every other call on that adapter but not this one.
- **Outlook immutable event ids** (`Prefer: IdType="ImmutableId"`). Graph event
  ids otherwise change when an item moves between calendars, breaking the
  persist-the-id contract this library is built on.
- **Acuity `cancelBooking` sends `admin=true`**, so cancellations succeed past
  the account's client-cancellation window.
- A test asserting the README's provider table against the adapters' real
  `capabilities` objects — it had silently drifted twice.

#### Changed

- **Square API version pinned to `2026-07-15`** (was `2025-10-16`, four releases
  behind). Square's changelog records no Bookings changes across that span.
- Provider names in the README table now link to their official API
  documentation. The notes distinguish *platform limitations* (the provider
  cannot do this) from *adapter gaps* (it can; unibooking has not modelled it) —
  previously a single dash meant both.

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
  `docs/audits/2026-07-19-booking-providers.md`.
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
  5545) specs. See `docs/audits/2026-07-19-calendar.md`.
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

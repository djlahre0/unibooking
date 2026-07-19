# Provider audit — booking platforms — 2026-07-19

Companion to [2026-07-19-calendar.md](./2026-07-19-calendar.md) (Google, Outlook,
Apple/CalDAV). This pass covers the **remaining 13 adapters** — the booking /
scheduling platforms — reviewed at the code level and verified against each
vendor's *current* (2026) API documentation.

Method: each adapter's endpoints, field names, status enums, pagination, and
error mapping were extracted from the source and checked against the official
spec. Findings are labelled **FIXED** (a code change shipped this pass),
**DOCUMENTED** (a confirmed limitation now called out, no safe code change), or
**VERIFIED** (checked and correct).

The mocked conformance suite guarantees the canonical contract (offset instants,
`end > start`, status enum, error mapping) but — because the mocks are authored
alongside the adapter — it cannot catch a wrong endpoint or field name. That gap
is exactly what this audit closed.

---

## Fixed (shipped with regression tests)

### Microsoft Bookings — was broken on every call (severity: critical)

The Graph `bookingAppointment` resource exposes its times as **`start`/`end`**
(each a `dateTimeTimeZone`), but the adapter read and wrote
`startDateTime`/`endDateTime`. Consequences:

- `getBooking`/`listBookings` threw `"appointment is missing start/end times"` on
  **every** appointment (`graphToInstant` got `undefined`).
- `createBooking`/`updateBooking` sent time fields Graph ignores.
- `updateBooking` additionally parsed the PATCH response, but Graph returns
  **`204 No Content`** — so it threw on the empty body.

**Fix:** read/write `start`/`end`; `updateBooking` PATCHes (`parse: 'none'`) then
re-GETs the appointment. The test previously mocked the *same* wrong field names,
hiding the bug — the mock was corrected to `start`/`end`. (Verified correct:
endpoints, `@odata.type`, `customers[]`/`bookingCustomerInformation`, cancel
`cancellationMessage`, calendarView `start`/`end` params, `Bookings.ReadWrite.All`.)

### Mindbody — wrong update verb + missing required field

- **`updateBooking` used `PUT`; v6 is `POST`** on `appointment/updateappointment`
  (confirmed three ways). The `PUT` never hit the documented method.
- **`LocationId` is required** by `AddAppointment`, but was sent only when set —
  `createBooking` now rejects a missing `locationId` client-side.
- `Requested` status now maps to `pending` (was `unknown`).

(Verified correct: base URL, the three auth headers, `addappointment`/
`staffappointments`/`bookableitems` paths, `SessionTypeId`, `Appointments`/
`Availabilities` keys, `Offset`/`Limit` + `PaginationResponse.TotalResults`, the
site-local time model, and the "no cancel endpoint → `UNSUPPORTED`" decision.)

### Calendly — create posted to a non-existent endpoint

The Scheduling API "Create Event Invitee" (GA Oct 2025) is
**`POST https://api.calendly.com/invitees`**, not `scheduling/event_invitees`,
and **`name` + `timezone` live inside the `invitee` object** (both effectively
required). Fixed the path and placement; `providerOptions` now flows into the
create body so event types that require a `location: { kind }` can supply it.

(Verified correct: get/cancel/list/invitees endpoints and wrappers,
`event_type_available_times` (future-only, ≤7-day, start-only), `users/me`,
`active`/`canceled` status mapping.)

### Acuity — notes silently dropped; admin-mode create could fail

- **`notes` may only be written by an admin**, so the non-reschedule
  `updateBooking` PUT now sends `admin=true` (it was silently dropping the note).
- **`admin=true` requires a valid `calendarID`**, so `createBooking` now sends it
  **only** when a `staffId` (calendarID) is present; otherwise Acuity picks the
  calendar and validates availability normally.

### Square — invalid field on cancel

`cancelBooking` sent `seller_note`, which is **not** a field on Square's
CancelBooking (its body is `{ idempotency_key, booking_version }`). Removed. A
cancellation reason isn't supported by the cancel endpoint (you'd `UpdateBooking`
a `seller_note` separately). (Verified correct: base URL, create/get/update
envelopes, `version` optimistic concurrency, list filters incl. `team_member_id`,
`start_at_max`, `search-availability` incl. the `segment_filters` requirement,
and the full `BookingStatus` enum.)

### Wix — rewritten to the documented Bookings V2 contract

The first pass fixed the CRM contact name shape (`info.name = { first, last }`,
not `{ firstName, lastName }` — a new contact's name was silently dropped). A
follow-up pass then rewrote the endpoints/shapes that verification had flagged as
not matching the live API (see the former "Documented" note below):

- `getBooking`/`listBookings` now POST `bookings/reader/v2/extended-bookings/query`
  (Reader V2 has no GET-by-id) and unwrap each result's `.booking`.
- `searchAvailability` rewritten to **Time Slots V2**: sends `fromLocalDate`/
  `toLocalDate`/`timeZone` and maps the offset-less `localStartDate`/`localEndDate`
  back to instants (so it now requires `range.timezone`, else `INVALID_INPUT` —
  previously it returned `[]`).
- `createBooking` sends the required participant count (`totalParticipants: 1` by
  default); `reschedule`/`cancel` now read and send the required `revision`.

⚠️ **Still needs live-tenant verification.** The exact public gateway paths for the
extended-bookings query and Time Slots V2, and the list date-filter field, are
docs-derived and remain marked `TODO: verify against live API`.

---

## Documented (confirmed limitations, no safe blind fix)

### Square — create needs staff + a service-variation version

Square's `AppointmentSegment` requires `team_member_id`, and an appointment
booking also needs the service **variation version**. Pass a `staffId`, and supply
`providerOptions: { service_variation_version }` — the adapter now routes that key
onto the segment (rather than requiring you to override the whole
`appointment_segments` array). `Square-Version` stays pinned to `2025-10-16`
(valid, non-deprecated, though not the latest `2026-07-15`).

### Bookeo — create needs participants (and eventId for fixed products)

`createBooking` omits the required `participants`; `fixed`/`fixedCourse` products
also require an `eventId` (and ignore `startTime`). Supply both via
`providerOptions`. `updateBooking` PUTs only `{ startTime, endTime }`, which isn't
a documented partial-update contract and likely won't reschedule fixed products.
(Verified correct: base URL/auth, create/get/cancel/list endpoints + pagination,
and that `GET /availability/slots` **does** exist.)

### Acuity — pagination + availability shape

`listBookings` has **no cursor** — Acuity's `max` only caps the count (default
100), so a wide window silently truncates; narrow the date range or raise `max`.
`searchAvailability` (`availability/times`) is **single-date**; a follow-up pass
now pages it one call per day across the range (capped at 31 days) and windows the
slots, so a multi-day range works. The top-level `canceled` boolean isn't in the
documented appointment schema (the adapter reads it defensively; cancel state is
also expressed via the `canceled=true` list filter and `noShow`).

---

## Verified correct (no change)

- **Zenoti** — every endpoint, the `Authorization: apikey` scheme, the multi-step
  booking flow (`/bookings` → `/slots` → `/reserve` → `/confirm`), the 7-day
  appointment-list cap, and invoice-based cancel are confirmed against the docs.
- **Vagaro** — the "read + webhooks only, no appointment writes" design is
  accurate; writes correctly throw `UNSUPPORTED`.
- **Mangomint** — no public/documented API exists; the `UNSUPPORTED` stub is the
  right call (don't confuse it with *MangoApps*, a different company).
- **Boulevard** — endpoint host + `2020-01` version confirmed. Small unverified
  note: the SDL couldn't be read, so mutation casing (`cancelAppointment` vs
  `appointmentCancel`) should be confirmed against a live schema.
- **Phorest** — host + endpoints + UTC times confirmed. Small unverified notes:
  `POST /appointment/cancel` may take a *list* of ids (adapter sends one), and
  `appointments/availability` may be GET rather than POST.
- **Setmore** — access model + `bookingapi/*` paths + bearer auth confirmed. The
  default host was switched to the documented **`developer.setmore.com`** (was
  `api.setmore.com`); still verify against a live call (override via
  `options.baseUrl` if your account differs).

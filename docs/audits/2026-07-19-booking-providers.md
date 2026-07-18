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

### Wix — wrong CRM contact name shape

`customers.findOrCreate` sent `info.name = { firstName, lastName }`, but Contacts
v4 uses **`info.name = { first, last }`** — so a new contact's name was silently
dropped. (The `{ firstName, lastName }` shape is correct for `booking.contactDetails`,
which is why the two got conflated.) Fixed with a dedicated `contactName` helper.

---

## Documented (confirmed limitations, no safe blind fix)

### Wix — multiple endpoints don't match the current V2 API ⚠️

Beyond the contact-name fix, verification confirmed the Wix adapter's other
methods are built on shapes that don't match the current Bookings V2 API. These
were **not** blind-rewritten (the exact public gateway paths and filter fields
can't be confirmed without a live tenant, and a wrong rewrite would be worse):

- `getBooking` — Reader V2 has **no GET-by-id**; you must Query Extended Bookings
  with `filter: { id }` (results under `extendedBookings`, each wrapping `booking`).
- `listBookings` — should POST `.../reader/v2/extended-bookings/query`; results
  are under `extendedBookings`, not `bookings`.
- `searchAvailability` — Time Slots V2 is a different endpoint whose request uses
  `fromLocalDate`/`toLocalDate`/`timeZone` and whose slots expose
  `localStartDate`/`localEndDate` — so today it returns `[]` in practice.
- `createBooking` omits the required `totalParticipants`/`participantsChoices`;
  `reschedule`/`cancel` omit the required `revision`. Supply these via
  `providerOptions` until the adapter is rewritten against a live tenant.

**Recommendation:** treat the Wix adapter as needing a live-tenant rewrite; it is
flagged as such in [docs/providers/wix.md](../providers/wix.md).

### Square — create needs staff + a service-variation version

Square's `AppointmentSegment` requires `team_member_id`, and an appointment
booking also needs the service **variation version**. The canonical model carries
neither implicitly — pass a `staffId` and inject `appointment_segments` (with
`service_variation_version`) via `providerOptions` for a real create. Also:
`Square-Version` is pinned to `2025-10-16` (valid, non-deprecated, but not the
latest `2026-07-15`).

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
`searchAvailability` (`availability/times`) is **single-date** — a multi-day range
only returns `range.start`'s day. The top-level `canceled` boolean isn't in the
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
  official host appears to be `developer.setmore.com`, not `api.setmore.com` —
  verify against a live call (override via `options.baseUrl` if needed).

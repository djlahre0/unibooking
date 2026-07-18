# Acuity Scheduling

```ts
import { acuity } from 'unibooking/adapters/acuity';
const client = acuity({ userId, apiKey });
```

**Credentials:** `{ userId, apiKey }` (HTTP Basic auth). Find them in Acuity under
Integrations → API.

**Capabilities:** availability, staff (Acuity "calendars"), services
(appointment types).

**Gotchas**
- `createBooking` and `searchAvailability` require a `serviceId`
  (`appointmentTypeID`) — they throw `INVALID_INPUT` without one.
- `staffId` maps to Acuity's `calendarID`.
- Acuity returns offsets like `-0700` (no colon); the adapter normalizes them to
  RFC3339. Booking `end` is derived from the appointment `duration`; an appointment
  with no positive duration raises `UPSTREAM` rather than a zero-length range.
- `searchAvailability` returns start times for a **single date** (from
  `range.start`) and **requires** a positive `durationMinutes` to size each slot —
  it throws `INVALID_INPUT` without one. A multi-day range only returns the first
  day; loop days yourself if you need more.
- `updateBooking` with a `range` calls the reschedule endpoint. A non-reschedule
  update (e.g. `title → notes`) sends `admin=true`, because Acuity only lets an
  admin write `notes`.
- `createBooking` sends `admin=true` (bypass availability validation) **only when
  a `staffId`/calendarID is given** — Acuity requires a calendarID in admin mode.
- `listBookings` has **no pagination cursor**; `max` (default 100) only caps the
  count, so a wide window silently truncates — narrow the date range or raise `max`.

**Webhooks:** `unibooking/webhooks/acuity → verifyAcuitySignature` (HMAC-SHA256
of the raw body with your API key, header `X-Acuity-Signature`).

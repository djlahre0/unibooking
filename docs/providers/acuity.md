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
- `searchAvailability` returns start times for a single date (from `range.start`)
  and **requires** a positive `durationMinutes` to size each slot — it throws
  `INVALID_INPUT` without one (start-only slots can't be sized otherwise).
- `updateBooking` with a `range` calls the reschedule endpoint.

**Webhooks:** `unibooking/webhooks/acuity → verifyAcuitySignature` (HMAC-SHA256
of the raw body with your API key, header `X-Acuity-Signature`).

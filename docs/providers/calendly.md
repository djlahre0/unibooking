# Calendly

> **Corrected 2026-07-20.** `updateBooking({ status: 'cancelled' })` always threw: the cancellation endpoint returns a Cancellation resource, not an event. See CHANGELOG 0.2.0.

Tier-1 (self-serve). Calendly API v2.

## Credentials
```ts
import { calendly } from 'unibooking/adapters/calendly';

// Personal Access Token or OAuth bearer. `user` (or `organization`) scopes
// listBookings; when omitted it is discovered via GET /users/me.
const client = calendly({ token, user: 'https://api.calendly.com/users/ABC123' });
```

## Capabilities
Availability (event-type available times), services (event types), and webhooks.
Read, create, and cancel scheduled events. **No `staff`** and **no `customers`**
find-or-create (invitees aren't a CRUD store).

## Notes
- **Booking-create needs a paid plan.** `createBooking` uses the Scheduling API's
  "Create Event Invitee" (`POST /invitees`, GA Oct 2025); it requires a `serviceId`
  (the event-type URI) and an invitee email (a `name` and `timezone` are also
  required by the API and are sent *inside* the invitee). Before Oct 2025 Calendly
  was read+cancel only. **Event types that specify a location** require a
  `location: { kind, ... }` on create — pass it through `providerOptions`.
- **No reschedule endpoint.** `updateBooking` with a new `range` does
  **cancel+rebook**: it reads the event's type and invitee, books the new time
  via the Scheduling API, then cancels the original. `updateBooking` with
  `status: 'cancelled'` cancels; any other field-only edit throws `UNSUPPORTED`.
- `searchAvailability` returns start times only, so pass `durationMinutes` to
  size each slot (otherwise `INVALID_INPUT`).
- Ids are the trailing segment of a Calendly resource URI; the adapter accepts a
  bare id or a full URI.
- The create path (`POST /invitees`) and request body were corrected in the
  2026-07-19 audit to match the current Scheduling API docs; the exact create
  *response* wrapper is still best confirmed against a live paid-plan call (the
  adapter falls back to fetching the event by URI, so this is low-risk).
- **Webhooks:** `unibooking/webhooks/calendly → verifyCalendlySignature`
  (HMAC-SHA256 hex over `"<t>.<rawBody>"`, header `Calendly-Webhook-Signature:
  t=..,v1=..`). The Webhook API requires a paid plan.

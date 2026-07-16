# Calendly

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
  "Create Event Invitee" (launched Oct 2025); it requires a `serviceId` (the
  event-type URI) and an invitee email. Before Oct 2025 Calendly was read+cancel
  only.
- **No reschedule endpoint.** `updateBooking` with a new `range` does
  **cancel+rebook**: it reads the event's type and invitee, books the new time
  via the Scheduling API, then cancels the original. `updateBooking` with
  `status: 'cancelled'` cancels; any other field-only edit throws `UNSUPPORTED`.
- `searchAvailability` returns start times only, so pass `durationMinutes` to
  size each slot (otherwise `INVALID_INPUT`).
- Ids are the trailing segment of a Calendly resource URI; the adapter accepts a
  bare id or a full URI.
- **Not yet verified against a live tenant.** The Scheduling API create path
  (`CREATE_PATH`) and response shape are docs-derived and marked
  `TODO: verify against live API`.
- **Webhooks:** `unibooking/webhooks/calendly → verifyCalendlySignature`
  (HMAC-SHA256 hex over `"<t>.<rawBody>"`, header `Calendly-Webhook-Signature:
  t=..,v1=..`). The Webhook API requires a paid plan.

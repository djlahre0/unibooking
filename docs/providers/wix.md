# Wix Bookings

Tier-1 (self-serve). Wix's headless REST API — Bookings Writer/Reader **V2**.
(Bookings V1 was removed on 2024-12-31.)

## Credentials
```ts
import { wix } from 'unibooking/adapters/wix';

// Bring your own Wix OAuth access token (app instance / member / user token).
// Use the function form so it is fetched fresh (refresh handled by you).
const client = wix(() => ({ accessToken: getFreshWixToken() }));
```

The token is sent verbatim in the `Authorization` header (no `Bearer` prefix),
which is how Wix expects app tokens. Third-party apps must use OAuth — Wix API
keys are for a site's own backend only.

## Capabilities
Availability (Time Slots V2), staff (resources), services, customers (via the
CRM Contacts v4 API), and webhooks. Full booking lifecycle: create, get, query,
reschedule, cancel.

## Notes
- `updateBooking` with a `range` calls Wix's native **reschedule**; with
  `status: 'cancelled'` it cancels; other field-only edits throw `UNSUPPORTED`.
- `createBooking` with `customer: { email }` resolves (or creates) a CRM contact
  first; `customer: { id }` is used directly.
- **Not yet verified against a live tenant.** Endpoint paths (Reader V2 get,
  Time Slots V2, Contacts query filter) and the query filter operators are
  docs-derived and marked `TODO: verify against live API`.
- Time Slots that Wix returns as `localStartDate` (no offset) are skipped rather
  than emitted as ambiguous instants — read `raw` if you need them.
- **Webhooks:** Wix delivers events as an RS256-signed JWT (the raw body is the
  JWT). Verify with `unibooking/webhooks/wix → verifyWixWebhook`, passing your
  app's public key; it returns the decoded payload or `null`.

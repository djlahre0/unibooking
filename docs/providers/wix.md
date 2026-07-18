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

## ⚠️ Status: needs a live-tenant rewrite

The 2026-07-19 audit verified this adapter against the current Bookings V2 docs
and found several methods built on endpoints/shapes that **don't match the live
API**. The `customers.findOrCreate` contact-name shape was fixed
(`info.name = { first, last }`), but these remain and are **not** safe to
blind-rewrite without a real Wix tenant:

- `getBooking` — Reader V2 has **no GET-by-id**; you must Query Extended Bookings
  with `filter: { id }` (results under `extendedBookings`, wrapping `booking`).
- `listBookings` — should POST `.../reader/v2/extended-bookings/query`; results
  come back under `extendedBookings`, not `bookings`.
- `searchAvailability` — Time Slots V2 is a different endpoint whose request uses
  `fromLocalDate`/`toLocalDate`/`timeZone` and whose slots expose
  `localStartDate`/`localEndDate`; in its current form it returns `[]`.
- `createBooking` omits the required `totalParticipants`/`participantsChoices`;
  `reschedule`/`cancel` omit the required `revision`. Supply these via
  `providerOptions` for now.

See [docs/audits/2026-07-19-booking-providers.md](../audits/2026-07-19-booking-providers.md).

## Notes
- `updateBooking` with a `range` calls Wix's native **reschedule**; with
  `status: 'cancelled'` it cancels; other field-only edits throw `UNSUPPORTED`.
- `createBooking` with `customer: { email }` resolves (or creates) a CRM contact
  first; `customer: { id }` is used directly.
- Time Slots that Wix returns as `localStartDate` (no offset) are skipped rather
  than emitted as ambiguous instants — read `raw` if you need them.
- **Webhooks:** Wix delivers events as an RS256-signed JWT (the raw body is the
  JWT). Verify with `unibooking/webhooks/wix → verifyWixWebhook`, passing your
  app's public key; it returns the decoded payload or `null`.

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

## ⚠️ Status: rewritten to the documented contract, not yet live-verified

The 2026-07-19 audit found several methods built on endpoints/shapes that didn't
match the current Bookings V2 docs. They have since been **rewritten to the
documented shapes** (below), but the exact public paths still need confirmation
against a real Wix tenant — a few are marked `TODO: verify against live API`.

- `getBooking`/`listBookings` — Reader V2 has **no GET-by-id**, so both POST
  `bookings/reader/v2/extended-bookings/query` (`getBooking` with `filter: { id }`)
  and unwrap each result's `.booking` from `extendedBookings`.
- `searchAvailability` — rewritten to Time Slots V2 (`fromLocalDate`/`toLocalDate`/
  `timeZone`), mapping `localStartDate`/`localEndDate` back to instants.
- `createBooking` now sends the required participant count; `reschedule`/`cancel`
  now read and send the required `revision`.

See [docs/audits/2026-07-19-booking-providers.md](../audits/2026-07-19-booking-providers.md).

## Notes
- **Reads use Query Extended Bookings** (no GET-by-id in Reader V2): `getBooking`
  and `listBookings` POST `bookings/reader/v2/extended-bookings/query` and unwrap
  `.booking`.
- `updateBooking` with a `range` calls Wix's native **reschedule**; with
  `status: 'cancelled'` it cancels; other field-only edits throw `UNSUPPORTED`.
  Both reschedule and cancel first read the booking's current `revision` (pass
  `providerOptions.revision` on a reschedule to skip that lookup).
- `createBooking` defaults `totalParticipants` to 1 (Wix requires a participant
  count) — override via `providerOptions.totalParticipants`/`participantsChoices`.
  `customer: { email }` resolves (or creates) a CRM contact first (contact name
  uses the Contacts v4 `{ first, last }` shape); `customer: { id }` is used directly.
- **`searchAvailability` is local-time (Time Slots V2)** — it requires
  `range.timezone` (an IANA zone) and throws `INVALID_INPUT` without one; Wix
  returns offset-less `localStartDate`/`localEndDate`, which the adapter converts
  back to instants using that zone.
- **Webhooks:** Wix delivers events as an RS256-signed JWT (the raw body is the
  JWT). Verify with `unibooking/webhooks/wix → verifyWixWebhook`, passing your
  app's public key; it returns the decoded payload or `null`.

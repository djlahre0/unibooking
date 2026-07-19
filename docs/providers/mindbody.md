# Mindbody (public API v6)

> **Corrected 2026-07-20.** `cancelBooking` previously threw UNSUPPORTED on the claim that no cancel endpoint exists. There is no cancel *path*, but cancellation is a documented action on `updateappointment` (`Execute: cancel`). `createBooking` also dropped `range.end`. See CHANGELOG 0.2.0.

```ts
import { mindbody } from 'unibooking/adapters/mindbody';
const client = mindbody({ apiKey, siteId, accessToken, locationId?, timezone: 'America/Los_Angeles' });
```

**Credentials:** `{ apiKey, siteId, accessToken, locationId?, timezone?, utcOffset? }`.
Auth is three headers: `Api-Key`, `SiteId`, and the staff/user token as
`Authorization`. Obtain the user token via `/usertoken/issue` yourself and pass
it in (this package never stores it — a refresh function works well here).

**Capabilities:** availability, staff, services.

**Gotchas**
- ⚠️ **Site-local times.** Mindbody returns datetimes without an offset. Provide
  the site's IANA `timezone` (e.g. `America/Los_Angeles`) so canonical instants
  are correct year-round — it is DST-aware. A fixed `utcOffset` (e.g. `-08:00`) is
  also accepted, but it is wrong for half the year in DST-observing zones; prefer
  `timezone`. With neither, times are treated as UTC. (`timezone` wins if both are set.)
- `createBooking` requires `customer.id` (ClientId), `staffId` (StaffId),
  `serviceId` (SessionTypeId), **and `locationId` (LocationId is required by
  Mindbody's `AddAppointment`)** — a missing `locationId` is rejected client-side.
- `updateBooking` calls `POST appointment/updateappointment` (Mindbody's
  UpdateAppointment is a POST, not a PUT).
- The public API has **no appointment-cancel endpoint**, so `cancelBooking`
  throws `UNSUPPORTED` (cancellation is observable only via the
  `appointmentBooking.cancelled` webhook).
- Note: since Sep 2025, `AddAppointment` deduplicates rapid duplicate creates
  server-side; validate endpoint shapes against a live sandbox before production.

**Webhooks:** Mindbody webhooks are a separate subscription product
(`capabilities.webhooks` is `true`). Verify signatures with
`verifyMindbodySignature` from `unibooking/webhooks/mindbody` — it HMAC-SHA256s
the raw request body against your webhook signature key.

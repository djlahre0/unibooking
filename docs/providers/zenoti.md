# Zenoti

> **Corrected 2026-07-20.** The create body nested the service as a flat `service_id`; the spec requires `item: { id, item_type }`. `updateBooking` now uses the first-class reschedule instead of booking fresh and cancelling the old invoice. See CHANGELOG 0.2.0.

Tier-2 (gated). API key generated per-tenant.

## Access
A business admin creates a backend app in **Admin > Setup > Apps** and copies the
generated **API Key**. You must already have a Zenoti tenant; there is no public
sandbox provisioning.

## Credentials
```ts
import { zenoti } from 'unibooking/adapters/zenoti';

const client = zenoti({ apiKey: '...', centerId: '...' });
```

## Notes
- **Auth:** `Authorization: apikey <key>`. `center_id` scopes every call.
- **Booking is multi-step.** `createBooking` runs create → get slots → reserve →
  confirm internally. If the requested `range.start` doesn't match a slot, it throws
  `CONFLICT`.
- **Reschedule** (`updateBooking` with a new `range`) re-books at the new time and
  cancels the old invoice — a multi-call operation. Non-range updates aren't supported.
- **Availability** has no stateless endpoint: `searchAvailability` creates a transient
  (unconfirmed) booking to read its slots, so it needs `providerOptions.guestId` and a
  `serviceId`. Zenoti expires the transient booking.
- **List range** is capped at 7 days.
- **Times:** the adapter reads the `*_utc` fields and appends `Z`.
- **Base host:** only `api.zenoti.com` is confirmed; override regional hosts via
  `options.baseUrl`.
- **Webhooks:** signature scheme is undocumented, so no verifier is shipped.
- **Reschedule fields:** `updateBooking` honors `range`, `staffId`, and `serviceId` on
  the re-book; no other input fields are applied.
- **Phone mapping is best-effort:** `customer.phone` is read from the appointment
  guest's `mobile.number` or `mobile_phone.number` field; the exact field name is
  unconfirmed against the live API. `customers.findOrCreate` looks up an existing
  guest by email only.
- **Slot matching is wall-clock based:** booking/reschedule matches the requested time
  against slot `Time` values without full timezone conversion — express the requested
  time in the center's local offset. Full timezone-awareness (needs the center's IANA
  tz) is a known limitation.

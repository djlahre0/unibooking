# Square Appointments

```ts
import { square } from 'unibooking/adapters/square';
const client = square({ accessToken, locationId });
```

**Credentials:** `{ accessToken, locationId }`.

**OAuth scopes:** `APPOINTMENTS_READ`, `APPOINTMENTS_WRITE`,
`APPOINTMENTS_ALL_READ`/`_WRITE` (for staff-wide access), plus
`CUSTOMERS_READ`/`CUSTOMERS_WRITE` if you use `customers.findOrCreate`.

**Capabilities:** everything — availability, staff, services, webhooks,
idempotency, customers.

> **Write access is plan-gated.** Reads work on the free Appointments plan, but
> booking **writes** (create/update/cancel) require the connected seller to be on
> **Square Appointments Plus or Premium**. Before writing on a seller's behalf,
> check `support_seller_level_writes` on their business booking profile — a
> write attempt without the subscription (or the `APPOINTMENTS_ALL_WRITE` scope
> for cross-staff calendars) fails.

**Gotchas**
- Booking `end` is derived from the segment `duration_minutes` (Square returns
  only `start_at`).
- `createBooking` always sends an `idempotency_key` — your `idempotencyKey` if
  provided, otherwise a generated one — so a retry can't double-book.
- Square attaches customers by id. Passing `customer: { email }` triggers a
  find-or-create; passing `customer: { id }` uses it directly. You can also call
  `client.customers.findOrCreate(...)` yourself.
- `updateBooking` needs the booking `version` (optimistic concurrency). Provide
  it via `providerOptions.version` to skip an extra GET; otherwise the adapter
  fetches the current version first.
- **A real `createBooking` needs a `staffId` and the service-variation version.**
  Square's `appointment_segments` require `team_member_id`, and an appointment
  booking needs `service_variation_version` — pass a `staffId` and inject the full
  `appointment_segments` (with `service_variation_version`) via `providerOptions`.
- `cancelBooking` takes **no reason** — Square's CancelBooking body carries only
  `idempotency_key`/`booking_version`, so `options.reason`/`notify` are ignored
  (set a seller note via `updateBooking` instead).
- `listBookings` forwards `staffId` as `team_member_id` and `customerId` as
  `customer_id` (both are supported Square list filters).
- The adapter pins `Square-Version: 2025-10-16` (valid and non-deprecated, though
  not the latest `2026-07-15`). It's a fixed header in the adapter.

**Webhooks:** `unibooking/webhooks/square → verifySquareSignature` (HMAC-SHA256
over `notificationUrl + rawBody`, header `x-square-hmacsha256-signature`).

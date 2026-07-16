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
- `listBookings` forwards `staffId` as `team_member_id`. `customerId` is not a
  supported Square list filter and is ignored.

**Webhooks:** `unibooking/webhooks/square → verifySquareSignature` (HMAC-SHA256
over `notificationUrl + rawBody`, header `x-square-hmacsha256-signature`).

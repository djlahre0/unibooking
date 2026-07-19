# Microsoft Bookings (Microsoft Graph)

> **Added 2026-07-20.** `searchAvailability` is implemented via `getStaffAvailability` (GA in Graph v1.0). Note it is **application-permission only**, unlike every other call on this adapter. See CHANGELOG 0.2.0.

```ts
import { microsoftBookings } from 'unibooking/adapters/microsoft_bookings';
const client = microsoftBookings({ accessToken, businessId });
```

**Credentials:** `{ accessToken, businessId }`. `businessId` is the booking
business id (e.g. `contoso@contoso.onmicrosoft.com`).

**OAuth scope:** `Bookings.ReadWrite.All`.

**Capabilities:** real `staff` and `services`. Availability search is not
modeled (`searchAvailability` throws `UNSUPPORTED`).

**Gotchas**
- Times use Graph's `start`/`end` (`dateTimeTimeZone`) and are normalized to UTC
  instants via `Prefer: outlook.timezone="UTC"`.
- `createBooking` maps `staffId → staffMemberIds`, `serviceId → serviceId`, and
  `customer → customers[0]` (a `bookingCustomerInformation`).
- `updateBooking` PATCHes (Graph returns `204 No Content`), then re-GETs the
  appointment to return it.
- `listBookings` uses `calendarView` (its `start`/`end` query window is governed
  by the offsets you pass, not the `Prefer` header); `cancelBooking` posts to
  `/cancel` with a `cancellationMessage` (from `options.reason`).

**Webhooks:** shares the Graph verifiers — see
[outlook.md](./outlook.md) (`unibooking/webhooks/outlook`).

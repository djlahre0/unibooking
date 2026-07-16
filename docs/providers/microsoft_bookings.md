# Microsoft Bookings (Microsoft Graph)

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
- Times are normalized to UTC instants via `Prefer: outlook.timezone="UTC"`.
- `createBooking` maps `staffId → staffMemberIds`, `serviceId → serviceId`, and
  `customer → customers[0]`.
- `listBookings` uses `calendarView`; `cancelBooking` posts to `/cancel` with a
  `cancellationMessage` (from `options.reason`).

**Webhooks:** shares the Graph verifiers — see
[outlook.md](./outlook.md) (`unibooking/webhooks/outlook`).

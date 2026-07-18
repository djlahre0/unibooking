# Bookeo

```ts
import { bookeo } from 'unibooking/adapters/bookeo';
const client = bookeo({ apiKey, secretKey });
```

**Credentials:** `{ apiKey, secretKey }` — sent as query params on every request.

**Capabilities:** availability, services (Bookeo "products").

**Gotchas**
- `createBooking` and `searchAvailability` require a `serviceId` (`productId`).
- **`createBooking` needs a `participants` object** (Bookeo requires it for any
  product with people categories), and a **fixed/course product also needs an
  `eventId`** (`startTime` is ignored for those). `searchAvailability` uses
  `/availability/slots` (product + range, no participants) and each returned slot
  keeps Bookeo's `eventId` in `slot.raw.eventId`. Pass that `eventId` and a
  `participants` object through `createBooking`'s `providerOptions`. (flexibleTime
  products take a `startTime` and can use `/availability/matchingslots` — call it
  manually.) `updateBooking` PUTs only the new times, which may not reschedule
  fixed/course products (they key off `eventId`).
- `listBookings` paginates via Bookeo's `pageNavigationToken` + `pageNumber`,
  packed into the opaque `nextPageToken` (`token|page`) — pass it straight back.
- Bookeo webhooks are unsigned (security via a secret URL), so no verifier is
  shipped and `capabilities.webhooks` is `false`.

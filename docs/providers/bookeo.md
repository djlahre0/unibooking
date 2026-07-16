# Bookeo

```ts
import { bookeo } from 'unibooking/adapters/bookeo';
const client = bookeo({ apiKey, secretKey });
```

**Credentials:** `{ apiKey, secretKey }` — sent as query params on every request.

**Capabilities:** availability, services (Bookeo "products").

**Gotchas**
- `createBooking` and `searchAvailability` require a `serviceId` (`productId`).
- **Booking a fixed/course product needs participant counts and an `eventId`.**
  `searchAvailability` uses `/availability/slots` (product + range, no
  participants) and each returned slot keeps Bookeo's `eventId` in
  `slot.raw.eventId`. Pass that `eventId` and a `participants` object through
  `createBooking`'s `providerOptions`. (flexibleTime products instead take a
  `startTime` and need `/availability/matchingslots` — call it manually.)
- `listBookings` returns a single page (`itemsPerPage`); multi-page navigation
  (Bookeo's `pageNavigationToken` + `pageNumber`) is not modeled, so no
  `nextPageToken` is returned.
- Bookeo webhooks are unsigned (security via a secret URL), so no verifier is
  shipped and `capabilities.webhooks` is `false`.

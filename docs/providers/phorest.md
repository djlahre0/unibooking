# Phorest

> **Corrected 2026-07-20.** `updateBooking` omitted `staffId` and `startTime`, both required, so partial patches were rejected. They are now backfilled from current state. See CHANGELOG 0.2.0.

Tier-2 (gated). Phorest issues Basic-auth credentials manually.

## Access
Email Phorest support from an email address associated with the business, including
your Phorest **Account Number**, to request API credentials. Third-party vendors may
be subject to integration charges. There is no self-serve signup.

## Credentials
```ts
import { phorest } from 'unibooking/adapters/phorest';

const client = phorest({
  username: 'global/api@salon.com', // includes the `global/` prefix Phorest provides
  password: '...',
  businessId: '...',
  branchId: '...',
});
```

## Notes
- **Region:** default host is EU (`platform.phorest.com`). US/AUS businesses pass
  `options.baseUrl = 'https://platform-us.phorest.com/third-party-api-server/api/'`.
- **Times:** responses split time into `appointmentDate` + UTC LocalTime; the adapter
  recombines them into RFC3339. Request bodies send UTC ISO-8601.
- **Updates** use optimistic locking — the adapter reads the current `version` before
  a `PUT`; a stale version surfaces as a `CONFLICT` error.
- **List range** is capped at one month by Phorest.
- **Webhooks:** not supported; poll `listBookings` (Phorest suggests `updated_from`).
- Capabilities: availability, staff, services, customers. No idempotency, no webhooks.

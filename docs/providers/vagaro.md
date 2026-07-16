# Vagaro

Tier-2 (gated), **read-only**. Vagaro's public API exposes reads and webhooks but
no appointment write endpoints.

## Access
Request access in the Vagaro business account under **Settings > All Settings >
Developers > APIs & Webhooks** (desktop only). Requests are manually reviewed
(~5–7 business days). Prerequisites: a paid plan, **active Vagaro Credit Card
Processing**, and a non-suspended billing cycle.

## Credentials
```ts
import { vagaro } from 'unibooking/adapters/vagaro';

// You perform the OAuth2 client-credentials exchange and pass the bearer token.
// Use the function form so the token is fetched fresh (refresh handled by you).
const client = vagaro(() => ({ region: 'usa03', accessToken: getFreshVagaroToken() }));
```

## Notes
- **Read-only.** `createBooking`, `updateBooking`, `cancelBooking`, and `listBookings`
  throw `UNSUPPORTED` — the Vagaro API has no such endpoints. Ingest appointment
  changes via webhooks instead.
- `getBooking` and `searchAvailability` are implemented; the availability path is
  marked with a `TODO` pending live confirmation.
- **Webhooks:** verify the `X-Vagaro-Signature` header with `verifyVagaroToken` from
  `unibooking/webhooks/vagaro`. This is a **static shared token compare**, not an HMAC
  signature.
- `region` is a per-business path segment (read from the business's browser URL, e.g.
  `usa03`).

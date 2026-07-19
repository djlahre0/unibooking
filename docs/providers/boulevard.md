# Boulevard

Tier-2 (gated, **Enterprise-tier only**). GraphQL Admin API (`/api/2020-01/admin`).

> **Corrected 2026-07-20.** The webhook verifier signed the wrong payload (it
> omitted the colon separator and keyed the HMAC with the undecoded base64
> secret), so every genuine webhook was rejected. Most GraphQL argument shapes
> were also wrong — `appointments` needs a required `locationId`, booking is a
> three-step mutation chain, and cancellation needs a reason enum. See CHANGELOG
> 0.2.0.

## Access
Boulevard exposes the Admin, Client, and Tokenization APIs to **Enterprise-tier**
customers only. Create a sandbox account and an API application (API key, secret,
business id) via the developer portal.

## Credentials
```ts
import { boulevard } from 'unibooking/adapters/boulevard';

const client = boulevard({ businessId, locationId, apiKey, apiSecret });
```

Auth is a per-request HMAC token wrapped in HTTP Basic (this is why the kit's
`AuthFn` is awaitable):

```
payload = "blvd-admin-v1" + businessId + unixSeconds
mac     = base64( HMAC-SHA256( base64Decode(apiSecret), payload ) )
token   = mac + payload
header  = Authorization: Basic base64(apiKey + ":" + token)
```

## Capabilities
Create / read / reschedule / cancel / list, plus `customers.findOrCreate` and
webhooks. **No `searchAvailability`** — it throws `UNSUPPORTED`. Bookable-time
queries live on Boulevard's separate **Client cart API** (different credentials
and flow), which this Admin-API adapter does not cover.

## Notes
- `updateBooking` uses the native `appointmentReschedule` mutation for time
  changes (no cancel+rebook needed).
- GraphQL errors are returned with HTTP 200; the adapter maps a non-empty
  `errors` array to `UnibookingError('UPSTREAM')`.
- **Not yet verified against a live tenant.** The GraphQL documents (field names,
  `bookingCreate` input, whether a `bookingComplete`/cart step is required) are
  docs-derived and marked `TODO: verify against live API` in the adapter.
- **Webhooks:** `unibooking/webhooks/boulevard → verifyBoulevardSignature`.
  Boulevard sends `x-blvd-hmac-salt` + `x-blvd-hmac-sha256`; the helper HMACs
  `salt + rawBody`. Confirm the exact scheme against a live webhook.

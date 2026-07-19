# Setmore

Tier-2 (gated). Setmore Booking API — a long-running beta.

> **Corrected 2026-07-20.** The Booking API is 11 routes total. It has **no**
> fetch-by-id and **no** cancel or delete endpoint; `getBooking` and
> `cancelBooking` previously called paths that do not exist and now throw
> UNSUPPORTED. `updateBooking` accepts only a label. Six of eight paths were
> wrong, as were all three date encodings. `searchAvailability` now requires an
> IANA `range.timezone` because slot times carry no date or offset. See CHANGELOG
> 0.2.0.

## Access
Requires a paid **Setmore Pro** account, then email **api@setmore.com** with your
name, registered email, and use case to be granted API credentials. There is
**no sandbox** — all calls hit live accounts, so test with a throwaway account.

## Credentials
```ts
import { setmore } from 'unibooking/adapters/setmore';

// Setmore issues a long-lived refresh token; you exchange it for a short-lived
// access token yourself and pass the bearer (use the function form for refresh).
const client = setmore(() => ({ accessToken: getFreshSetmoreToken() }));
```

## Capabilities
Availability (per-day slots), staff, services, customers, and full appointment
CRUD (create / get / update-reschedule / cancel / list). No webhooks.

## Notes
- `createBooking` requires `staffId` (staff_key) and `serviceId` (service_key);
  `customer: { email }` resolves or creates a customer first.
- `updateBooking` reschedules in place (native) — pass a `range` and/or field
  edits.
- `searchAvailability` returns start times only, so pass `durationMinutes`. Setmore
  slots come back as local `HH:mm` for the selected date; the adapter combines
  them with the **offset of your `range.start`** to form canonical instants — so
  express availability queries in the business's local offset (as with Zenoti).
- **Host:** defaults to the documented `developer.setmore.com` (paths under
  `/api/v1/bookingapi/…`). If your account is provisioned on a different host,
  override it with `options.baseUrl`.
- **Not yet verified against a live account.** The host, response envelope, the
  appointment time format (ISO vs epoch — both are handled), and the slot format
  are docs-derived and marked `TODO: verify against live API`.

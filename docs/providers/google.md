# Google Calendar

```ts
import { google } from 'unibooking/adapters/google';
const cal = google({ accessToken, calendarId: 'primary' });
```

**Credentials:** `{ accessToken, calendarId? }`. `calendarId` defaults to `primary`.

**OAuth scope:** `https://www.googleapis.com/auth/calendar` (read/write). Token
acquisition and refresh are your responsibility — pass a value or an async
function that returns a fresh token.

**Capabilities:** plain calendar — no `availability`, `staff`, or `services`.
`searchAvailability` throws `UNSUPPORTED`.

**Gotchas**
- `listBookings` sets `singleEvents=true&orderBy=startTime`, so recurring events
  are returned as expanded instances (not the recurring master).
- `cancelBooking` deletes the event (Google has no soft-cancel for plain events).
  Pass `{ notify: true | false }` to control `sendUpdates`.
- `idempotency` is false: Google only accepts client-supplied event ids in a
  restricted format. Provide one via `providerOptions.id` if you need it.
- All-day (date-only) events are represented with midnight-UTC instants.

**Webhooks:** push notifications aren't HMAC-signed — set a channel `token` on
the watch and verify `X-Goog-Channel-Token` with
`unibooking/webhooks/google → verifyGoogleChannelToken`.

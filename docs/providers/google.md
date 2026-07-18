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
  are returned as expanded instances (not the recurring master). `timeMin`/`timeMax`
  select events that *overlap* the window (Google filters `timeMin` against an
  event's end and `timeMax` against its start), so an event that straddles a
  boundary is included.
- `updateBooking` maps a canonical `status` onto the event `status` field:
  `pending` → `tentative`, `confirmed`/`completed` → `confirmed`, `cancelled` →
  `cancelled`. A status with no Google form (e.g. `no_show`) leaves it untouched.
- `cancelBooking` deletes the event (Google has no soft-cancel for plain events).
  Pass `{ notify: true | false }` to control `sendUpdates`.
- **Attendees are not notified on `createBooking`/`updateBooking`.** Google's API
  sends no invitations unless the `sendUpdates` *query* parameter is set — unlike
  the Calendar web UI. The adapter only wires `sendUpdates` on cancel (via
  `cancelBooking({ notify })`); create/update currently have no notify toggle
  (`providerOptions` is merged into the request body, not the query, so it can't
  carry `sendUpdates`). Send the invite out-of-band if you need guests emailed.
- `idempotency` is false: Google only accepts client-supplied event ids in a
  restricted format. Provide one via `providerOptions.id` if you need it.
- All-day (date-only) events are represented with midnight-UTC instants.

**Webhooks:** push notifications aren't HMAC-signed — set a channel `token` on
the watch and verify `X-Goog-Channel-Token` with
`unibooking/webhooks/google → verifyGoogleChannelToken`.
